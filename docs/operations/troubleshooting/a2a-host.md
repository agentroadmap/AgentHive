> **Type:** reference
> **MCP-tracked:** P1138 (PG reconnect hotfix) + P1132 (parent A2A host service)
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` rows P1132, P1138

# Troubleshooting: agenthive-a2a-host.service

The A2A host runtime is the per-host process that discovers active local agencies via `roadmap_workforce.agent_registry.host_affinity = $AGENTHIVE_HOST`, holds one PostgreSQL LISTEN session per agency on the `a2a_msg_<identity>` channel, and dispatches inbound messages through the existing `runLiaisonAgent` code path. It replaced the per-agency `agenthive-agency@<id>.service` template in P1132 (MERGE 2026-05-18).

This document covers the operational scenarios you are likeliest to hit during a normal week and the diagnostic commands that resolve them.

## Scenario 1: PG disconnect → systemd restart

**Symptom:** journal shows a `[a2a-host] FATAL pool error — exiting for systemd restart: ...` line followed by `Started agenthive-a2a-host.service`. Brief presence flap (agencies stay `presence_state='online'` for ~15-30 seconds during the restart window) before all reconnect.

**Cause:** the pg pool emitted a terminal error event. Common triggers:
- PostgreSQL server restart (planned or crash)
- PgBouncer restart (if running through a pooler)
- Network partition between A2A and PG (only relevant in multi-host setups)
- Manual `pg_terminate_backend()` (e.g., from chaos tests)

**Expected behavior (P1138 Phase 1):**
1. Pool emits `error` event
2. Process exits with code 1 (`pool.on("error")` handler)
3. systemd detects exit-on-failure
4. After `RestartSec=15` (15 seconds), systemd starts a fresh process
5. New process re-runs `loadActiveAgencies()` + `attachListener()` per identity
6. `fn_pulse(identity, 'online')` fires per successful re-attach
7. Total recovery window: ~15-30 seconds end-to-end

**Diagnostics:**
```bash
# Confirm the fatal log line + the restart
sudo journalctl -u agenthive-a2a-host.service --since "5 minutes ago" --no-pager | \
  grep -E "FATAL pool|Started agenthive-a2a-host"

# Verify the re-attached LISTEN sessions
psql "$DATABASE_URL" -c "
  SELECT application_name FROM pg_stat_activity
  WHERE application_name LIKE 'a2a-listen-%' OR application_name LIKE '%a2a-host%'
  ORDER BY application_name
"

# Verify presence_state has refreshed
psql "$DATABASE_URL" -c "
  SELECT presence_state, count(*) FROM roadmap.v_agency_status
  GROUP BY 1 ORDER BY 2 DESC
"
```

**When to escalate:**
- Service restart cycle (4+ restarts/minute sustained for 5+ minutes) — likely indicates PG itself is broken or unreachable; check `agenthive-mcp.service` and `systemctl status postgresql.service`
- Presence stuck stale ≥60 seconds after the restart line — file an incident, the per-host presence-refresh timer may be failing

## Scenario 2: Single agency stuck offline

**Symptom:** one specific `agent_identity` reports `presence_state='offline'` indefinitely while other agencies on the same host are online.

**Diagnostics:**
```bash
# Is the identity actually expected on this host?
psql "$DATABASE_URL" -c "
  SELECT agent_identity, host_affinity, agent_type, status
  FROM roadmap_workforce.agent_registry
  WHERE agent_identity = '<identity>'
"

# Did the LISTEN attach? Search the journal for the boot line
sudo journalctl -u agenthive-a2a-host.service --since "1 hour ago" --no-pager | \
  grep -E "<identity>"

# Force a re-discovery by rebooting the A2A host
sudo systemctl restart agenthive-a2a-host.service
```

**Common causes:**
- `agent_registry.host_affinity` mismatch — the identity is registered on a different host
- `agent_type != 'agency'` — only `agent_type='agency'` rows are picked up
- `status NOT IN ('active','dormant')` — retired identities are not attached

## Scenario 3: Multi-host (FUTURE — blocked on P1138 Phase 2)

The current A2A host is single-host. PG disconnect is mitigated by localhost co-location (the pool's terminal error is rare on loopback). Multi-host expansion is BLOCKED on:
- An in-process reconnect with backoff (P1138 Phase 2, deferred) so transient network blips don't bounce the runtime
- Inbound HTTP receiver + nested HMAC envelope (P1132 appendix follow-on)
- `core.host` endpoint discovery + per-provider credential vault (P1132 appendix follow-on)

Don't deploy A2A across hosts until those land. Track via the `roadmap_proposal.proposal_dependencies` graph rooted at P1132.

## Scenario 4: Verifying the cutover state

**Confirm per-agency template is retired:**
```bash
# Should return "0 loaded units listed"
sudo systemctl list-units 'agenthive-agency@*.service' --state=active --no-pager
```

**Confirm A2A host is the active per-host service:**
```bash
sudo systemctl is-active agenthive-a2a-host.service  # expects: active
```

**Confirm the topology document is current:**
- Canonical doc: [`docs/architecture/mcp-liaison-topology.md`](../../architecture/mcp-liaison-topology.md) (P1095)
- Cross-referenced in [`CONVENTIONS.md`](../../../CONVENTIONS.md) §3

## Chaos test reference

The P1138 chaos test exercises Scenario 1 end-to-end:
```bash
sudo scripts/chaos/a2a-pg-disconnect.sh
```
Output: PASS/FAIL with timing breakdown. Use this to verify the recovery loop after upgrading the A2A runtime or after suspected PG-related outages.

## Related proposals

- **P1132** (MERGE/new) — Parent A2A Host Service Consolidation. Canonical design at `/home/gary/.claude/plans/silly-sleeping-hippo.md`.
- **P1138** (this proposal, DEVELOP/new) — PG reconnect hotfix. Phase 1: exit-on-pool-error + systemd restart. Phase 2 (in-process reconnect) deferred.
- **P1135** (DEVELOP/new) — `hive doctor --check topology` runtime verification of agency-to-host attachment. When this lands, `hive doctor` will surface drift in the agency-coverage and legacy-template-retirement sub-checks automatically.
- **P1123** (DEVELOP/new) — Pool poisoning sentinel + watchdog. Distinct from this hotfix: P1123 prevents stray `closePool()` calls in long-running services; P1138 handles terminal pool errors that the pg library cannot recover from internally.
