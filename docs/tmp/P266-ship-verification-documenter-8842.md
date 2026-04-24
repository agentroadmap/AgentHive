# P266 Ship Verification — worker-8842 (documenter)

**Date:** 2026-04-21
**Phase:** COMPLETE / Ship
**Agent:** worker-8842 (documenter)
**Proposal:** P266 — Track in-flight dispatches in orchestrator shutdown path

## Problem Summary

`scripts/orchestrator.ts` shutdown handler ran `pgClient.release(); await pool.end(); process.exit(0)`
without awaiting active `dispatchImplicitGate` calls (each up to 600s). On SIGTERM, spawned cubic
agents became orphans and `squad_dispatch` rows stayed in 'active' status indefinitely.

## Solution

In-flight tracking with bounded graceful drain:

1. **Tracking primitive:** `Set<Promise>` (`inFlight`) + helper `trackInFlight<T>(p)` that adds on entry,
   removes on settle. Applied at all four dispatch call sites.
2. **Shutdown gate:** `stopping` flag prevents new dispatches from starting after signal receipt.
3. **Bounded drain:** On SIGTERM/SIGINT, stop pollers, `Promise.allSettled(inFlight)` raced against
   configurable timeout `AGENTHIVE_ORCHESTRATOR_DRAIN_MS` (default 240s, < `TimeoutStopSec=300`).
4. **Force-cancel:** If timeout expires with pending dispatches, UPDATE `squad_dispatch` rows with
   `dispatch_status='cancelled'` + metadata tagging (signal + timestamp) so next boot sees clean slate.
5. **Clean exit:** Release pgClient, end pool, `process.exit(0)` — same as before but only after drain.

## Implementation Verification

| Check | Evidence | Status |
|-------|----------|--------|
| `inFlight` Set declared (line 39) | `const inFlight = new Set<Promise<unknown>>();` | PASS |
| `trackInFlight` helper (lines 40-44) | Adds on call, deletes in `.finally()` | PASS |
| `SHUTDOWN_DRAIN_MS` configurable (lines 45-47) | `process.env.AGENTHIVE_ORCHESTRATOR_DRAIN_MS ?? 240_000` | PASS |
| `stopping` flag set before drain (line 1378) | `stopping = true` is first action in shutdown | PASS |
| Pollers cleared (lines 1383-1384) | `clearInterval(pollTimer)` + `clearInterval(implicitGateTimer)` | PASS |
| `Promise.allSettled` bounded race (lines 1387-1394) | drain vs timeout, winner logged | PASS |
| Force-cancel UPDATE (lines 1403-1414) | `squad_dispatch` rows → 'cancelled' with metadata | PASS |
| `drainImplicitGateReady` checks `stopping` (line 987) | `if (stopping) return;` before each dispatch | PASS |
| All 4 dispatch sites wrapped with `trackInFlight` | lines 988, 1290, 1308, 1341 | PASS |
| systemd `TimeoutStopSec=300` | Confirmed in unit file, 60s margin above drain | PASS |
| Deployed commit | `328adbf` P266+P267: SIGTERM drain | PASS |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGENTHIVE_ORCHESTRATOR_DRAIN_MS` | `240000` (240s) | Max drain wait before force-cancel. Must be < `TimeoutStopSec`. |

## Operational Notes

- **SIGTERM** (systemd stop/restart): expected behavior — graceful drain.
- **SIGINT** (Ctrl-C / manual): same path, same drain logic.
- **Drain too slow:** Increase `AGENTHIVE_ORCHESTRATOR_DRAIN_MS` (but keep < `TimeoutStopSec`).
  If dispatches genuinely hang > 240s, investigate the cubic agent, not the drain timer.
- **Force-cancelled rows:** Visible in DB as `dispatch_status='cancelled'` with metadata
  `shutdown_cancelled_at` and `shutdown_signal`. Next boot's reaper ignores these (already terminal).
- **Clean restart indicator:** Boot log should show "no stale rows" then "Listening for state changes."

## Verification on Restart (from deploy)

Discussion entry by claude-opus (2026-04-18):
> Deployed via commit 328adbf and verified on agenthive-orchestrator restart: graceful 4s drain
> from SIGTERM to clean exit, fresh boot logs "no stale rows" then "Listening for state changes."

## Artifacts

- Implementation: `scripts/orchestrator.ts` lines 36-47, 1375-1448
- Systemd unit: `/etc/systemd/system/agenthive-orchestrator.service` (TimeoutStopSec=300)
- Commit: `328adbf` — "P266+P267: SIGTERM drain for orchestrator and a2a-dispatcher"
- Companion: P267 (a2a-dispatcher drain, same pattern)
