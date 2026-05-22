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
  - Loads agency list from roadmap_workforce.agent_registry
    (WHERE host_affinity = $AGENTHIVE_HOST AND agent_type='agency'
           AND status IN ('active','dormant'))
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

The check performs three sub-checks in order:

### Sub-check A: A2A Host Service Liveness

```bash
systemctl is-active agenthive-a2a-host.service
```

- `active` → pass
- anything else → **error** (all agency routing is down)

### Sub-check B: Agency Attachment Coverage

```sql
WITH expected AS (
  SELECT agent_identity
  FROM roadmap_workforce.agent_registry
  WHERE host_affinity = $host
    AND agent_type = 'agency'
    AND status IN ('active', 'dormant')
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

- All attached → ok
- Any unattached → **error** (dispatch gaps; restart a2a-host)
- DB query fails → **warn** (service may be fine, but can't verify)

### Sub-check C: Legacy Template Instance Cleanup

```bash
systemctl list-units 'agenthive-agency@*.service' --state=active --no-pager --no-legend
```

- Zero running instances → ok
- Any running → **warn** (template file may remain installed; running instances create
  duplicate LISTEN sessions and double-consume messages)

## Check Output Shape

```json
{
  "name": "topology",
  "severity": "ok|warn|error",
  "message": "...",
  "remediation": "...",
  "details": {
    "host": "bot",
    "a2a_host_service": "active",
    "expected_agencies": 20,
    "attached_agencies": 20,
    "unattached": [],
    "legacy_template_instances": []
  }
}
```

## Operator Quick Reference

| Symptom | Command |
|:---|:---|
| a2a-host not running | `sudo systemctl start agenthive-a2a-host.service` |
| Agencies not attaching | `sudo systemctl restart agenthive-a2a-host.service` |
| Legacy instances running | `sudo systemctl stop agenthive-agency@<name>.service` |
| Reload agency list | `sudo systemctl kill -s HUP agenthive-a2a-host.service` |
| Check topology | `hive doctor --check topology --verbose` |
| Full JSON output | `hive doctor --check topology --json` |

## Related Proposals

- **P1132** — A2A host implementation (COMPLETE); introduces the shared host + per-agency LISTEN model
- **P1095** — Original doctor topology check proposal; this doc fulfills its AC-9 documentation requirement
- **P1135** — P1095 child: hive doctor topology check implementation (this work)
