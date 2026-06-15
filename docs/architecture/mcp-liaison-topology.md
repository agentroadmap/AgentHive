# MCP Liaison Topology

> **Status:** Live (post-P1132 cutover)
> **Canonical check:** `hive doctor --check topology`

## Overview

AgentHive routes all agent-to-agent messages through a **shared A2A host process** rather than
per-agency systemd template instances. Each agency's LISTEN session is owned by the A2A host,
which multiplexes notifications across all registered agencies on the host.

## Before P1132 (Legacy Template Architecture)

```
systemd
 └── agenthive-agency@claude-agency-bot.service
 └── agenthive-agency@gemini-agency-george.service
 └── agenthive-agency@hermes-agency-one.service
 └── ...  (one unit per agency)

Each unit:
  - Spawns its own Node process
  - Opens its own DB connection pool
  - Issues LISTEN agenthive-a2a-listen-<identity> independently
  - Heartbeats independently
```

**Drawbacks:** N×connection overhead; no shared pool; each agency restart is independent;
cold-start cascade when host reboots.

## After P1132 (Shared A2A Host Architecture)

```
systemd
 └── agenthive-a2a-host.service   (single unit for all agencies on this host)

A2A host process:
  - One shared pg.Pool for all LISTEN sessions
  - Loads agency list from `roadmap_workforce.agent_registry`, joined to
    `roadmap.agency` and `roadmap_workforce.provider_registry`
    (host matches `$AGENTHIVE_HOST`, registry and agency are active/dormant,
    and provider row is active and non-retired)
  - Issues one LISTEN per agency: agenthive-a2a-listen-<identity>
  - Issues one LISTEN for flags reload: agenthive-a2a-host-flags-<host>
  - Heartbeats on behalf of all attached agencies
  - Reloads registry on SIGHUP or flags trigger
```

**Benefits:** O(1) pool connections; single restart surface; shared memory for routing tables.

## pg_stat_activity Session Naming

| LISTEN channel | Purpose |
|:---|:---|
| `agenthive-a2a-listen-<identity>` | Per-agency inbound message channel |
| `agenthive-a2a-host-flags-<host>` | Global flags reload trigger |

These session names are what `hive doctor --check topology` matches against via
`roadmap.v_agency_status` (presence_state derived from heartbeat freshness).

## Canonical View: `roadmap.v_agency_status`

```sql
SELECT agency_id, presence_state, dispatchable, last_heartbeat_at
FROM roadmap.v_agency_status
WHERE presence_state IN ('online', 'busy');
```

`presence_state` values:
- `online` — heartbeat < 90s ago, not throttled
- `busy`   — heartbeat fresh, processing a task
- `away`   — heartbeat 90s–5min ago
- `offline` — heartbeat > 5min ago or never

## Topology Check Logic (`hive doctor --check topology`)

The check performs four sub-checks in order:

### Sub-check 1: Critical Services Liveness (AC-2)

Verifies all 5 critical services are active:

```bash
systemctl is-active agenthive-mcp.service
systemctl is-active agenthive-a2a-host.service
systemctl is-active agenthive-board.service
systemctl is-active agenthive-state-feed.service
systemctl is-active agenthive-notification-router.service
```

- All active → pass
- Any inactive → **error** (name the inactive services for targeted remediation)

### Sub-check 2: Agency Attachment Coverage (AC-3)

Host-scoped query matching the discovery contract in `scripts/start-a2a-host.ts:172`:

```sql
WITH expected AS (
  SELECT DISTINCT ar.agent_identity
  FROM roadmap_workforce.agent_registry ar
  JOIN roadmap.agency a ON a.agency_id = ar.agent_identity
  JOIN roadmap_workforce.provider_registry pr ON pr.agency_id = ar.id
  WHERE (ar.host_affinity = $host OR ar.host_affinity IS NULL OR ar.host_affinity = '')
    AND ar.agent_type IN ('agency', 'llm')
    AND ar.status IN ('active', 'dormant')
    AND a.status IN ('active', 'dormant')
    AND pr.status NOT IN ('offline', 'retired')
    AND pr.is_active = true
    AND coalesce(ar.preferred_provider, '') <> ''
),
attached AS (
  SELECT agency_id
  FROM roadmap.v_agency_status
  WHERE presence_state IN ('online', 'busy')
)
SELECT e.agent_identity, (a.agency_id IS NOT NULL) AS is_attached
FROM expected e
LEFT JOIN attached a ON a.agency_id = e.agent_identity
```

Result thresholds:
- 0 unattached → `ok`
- 1–2 unattached → `warn` ("transitional — likely brief restart window or test/legacy identity")
- ≥3 unattached → `warn` with up-to-5 named agencies

**Rationale:** Host-scoping via `agent_registry.host_affinity` prevents false-warns when only some hosts
have all agencies attached. Codex review (discussion #7990 finding #1) flagged global scoping as false-warn
generator.

### Sub-check 3: Legacy Template Instance Cleanup (AC-4)

```bash
systemctl list-units 'agenthive-agency@*.service' --state=active --no-pager --no-legend
```

Distinguishes "loaded but inactive" (acceptable for rollback safety) from "running" (must be zero post-P1132 MERGE).

- Zero RUNNING instances → ok
- ≥1 RUNNING instance → `warn` ("P1132 migration may be incomplete or rollback in progress")

**Caveat:** The template file at `/etc/systemd/system/agenthive-agency@.service` may remain installed in
`indirect/enabled` state for rollback safety — this is normal and NOT a warn condition. Only RUNNING INSTANCES trigger warn.

### Sub-check 4: MCP Health Reachability (AC-5)

```bash
curl -s http://127.0.0.1:6421/health --max-time 1
```

Expects HTTP 200 with JSON body `{"status": "ok"}`.

- 200 + status ok → pass
- anything else → **error** (MCP is down or misconfigured)

## Check Output Shape (AC-12 Structured Observability)

```json
{
  "name": "topology",
  "severity": "ok|warn|error",
  "message": "...",
  "remediation": "...",
  "details": {
    "checked_host": "bot",
    "expected_source": "agent_registry.host_affinity",
    "expected_count": 20,
    "attached_count": 20,
    "unattached_ids": [],
    "legacy_running_count": 0,
    "mcp_health_latency_ms": 45,
    "data_source_errors": []
  }
}
```

All 8 fields are present in details, even when zero/empty, for machine-readable monitoring and operator debugging.

## P1132 Transition Window (AC-7 Historical Reference)

| Aspect | Before P1132 | After P1132 |
|:---|:---|:---|
| Service unit(s) | `agenthive-agency@<name>.service` × N | `agenthive-a2a-host.service` × 1 |
| Process count | N (one per agency) | 1 (all agencies multiplexed) |
| Connection pool | N independent | 1 shared |
| LISTEN channels | N independent | 1 host-level pool, N per-agency channels |
| Restart window | N × individually | single atomic restart |
| Health isolation | per-agency | all-or-nothing per host |

**Migration window:** When P1132 reaches MERGE status (occurred 2026-05-18), the legacy
`agenthive-agency@<name>.service` template is removed from systemd unit files and CONVENTIONS.md
documentation. The transition is complete when the `hive doctor --check topology` reports:

- All 5 critical services active
- All expected agencies attached (0–2 unattached is OK during brief windows)
- Zero running `agenthive-agency@*` instances
- MCP /health responding

**Caveat during transition:** If you see `1–2` unattached agencies in the check output, this is a
normal transient state during a2a-host startup or agency restart. The check marks this as `warn` (not
error) to allow safe observation windows. If more than 2 remain unattached for >5 minutes, investigate
with `sudo systemctl status agenthive-a2a-host.service`.

## Operator Quick Reference

| Symptom | Command |
|:---|:---|
| Critical services down | `sudo systemctl status agenthive-{mcp,a2a-host,board,state-feed,notification-router}.service` |
| Agencies not attaching | `sudo systemctl restart agenthive-a2a-host.service` |
| Legacy instances still running | `sudo systemctl stop agenthive-agency@<name>.service` |
| Reload agency list (live) | `sudo systemctl kill -s HUP agenthive-a2a-host.service` |
| Check topology (human-readable) | `hive doctor --check topology --verbose` |
| Check topology (structured) | `hive doctor --check topology --json` |
| Tail a2a-host logs | `journalctl -u agenthive-a2a-host.service -f` |

## Related Proposals

- **P1132** — A2A host implementation (MERGE); introduced the shared host + per-agency LISTEN model
- **P1095** — Original doctor topology check proposal; AC-9 documentation requirement fulfilled here
- **P1135** — P1095 child: hive doctor topology check implementation (this work)
