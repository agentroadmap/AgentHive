# P269 Ship Verification — Stale-row reaper at startup

| Field | Value |
|-------|-------|
| Proposal | P269 |
| Title | Stale-row reaper at startup for transitions, leases, and dispatches |
| Phase | COMPLETE |
| Agent | worker-8857 (documenter) |
| Commit | 153f4e3 |
| Verification date | 2026-04-21 |

## Scope

After abrupt stops (SIGKILL, OOM, host reboot), three classes of orphans accumulate:
1. `transition_queue.status='processing'` — stuck transitions
2. `proposal_lease.released_at IS NULL` past `expires_at` — leaked leases
3. `squad_dispatch.dispatch_status IN ('assigned','active')` past `assigned_at` — zombie dispatches

P269 adds a `reapStaleRows()` helper that runs at boot, before LISTEN handlers register, to clean all three.

## Implementation

### File: `src/core/pipeline/reap-stale-rows.ts` (163 lines)

Exports `reapStaleRows(pool, logger, tag?)` returning `ReapResult {transitions, leases, dispatches, sequencesRealigned}`.

**Three core reap blocks (per original design):**

| Target table | Stale filter | Recovery action | Threshold |
|---|---|---|---|
| `roadmap.transition_queue` | `status='processing' AND processing_at IS NOT NULL` | Reset to `status='pending'`, clear `processing_at`, annotate `last_error` | 15 min |
| `roadmap_proposal.proposal_lease` | `released_at IS NULL AND expires_at IS NOT NULL` | Set `released_at=now()`, annotate `release_reason` | 10 min |
| `roadmap_workforce.squad_dispatch` | `dispatch_status IN ('assigned','active') AND completed_at IS NULL` | Set `dispatch_status='cancelled'`, set `completed_at`, annotate `metadata` | 20 min |

**Additional blocks beyond original design:**

| Block | Purpose | Source |
|---|---|---|
| `dispatch_status='blocked' AND completed_at IS NOT NULL` | Clean up blocked+completed dispatches that escape the primary dispatch reap | P309 (lines 104-122) |
| `fn_realign_identity_sequences(schema)` | Realign IDENTITY sequences that drifted during downtime | Tasks #24/#28 (lines 128-147) |

### Wiring (before LISTEN handlers)

| Service | File | Line | Tag |
|---|---|---|---|
| Orchestrator | `scripts/orchestrator.ts` | 1261 | `Orchestrator.Reaper` |
| Gate Pipeline | `scripts/start-gate-pipeline.ts` | 89 | `GatePipeline.Reaper` |

Both services call `reapStaleRows()` after pool init, before `LISTEN` / `cron.run()`. Idempotent — concurrent boot is safe.

## Verification

### Design vs. Implementation

| Design element | Implemented | Notes |
|---|---|---|
| Reap `transition_queue` processing >15m | PASS | `processing_at IS NOT NULL` filter added (hardened vs original design) |
| Reap `proposal_lease` expired >10m | PASS | Uses `expires_at` as designed |
| Reap `squad_dispatch` assigned/active >20m | PASS | Uses `assigned_at IS NOT NULL` (hardened) |
| Wired before LISTEN | PASS | Both orchestrator and gate-pipeline |
| Idempotent concurrent boot | PASS | Each UPDATE is self-contained |
| Log row counts | PASS | Logs count per category; "no stale rows" when clean |

### Live verification

Both services log cleanly on fresh boot:
```
[Orchestrator.Reaper] no stale rows
[GatePipeline.Reaper] no stale rows
```

### Code quality

- Each reap block wrapped in try/catch — failure of one does not block others
- Uses parameterized queries (`$1` placeholders) — no SQL injection risk
- `RETURNING id` for accurate row counts
- Metadata annotations preserve audit trail (why row was reaped)

## Schema notes

The original proposal referenced `last_heartbeat_at` and `host_id` which do not exist in the live schema. Implementation correctly uses:
- `transition_queue.processing_at` (not `last_heartbeat_at`)
- `squad_dispatch.assigned_at` (no `started_at` or `host_id`)
- `squad_dispatch.metadata` JSONB (not `notes` column) for reap annotations

## Acceptance criteria

No formal AC were recorded in `proposal_acceptance_criteria`. The discussion body from the skeptic agent confirms verification of the three core reaps and the live boot behavior.

## Verdict

**PASS** — P269 is fully implemented, wired into both entry points, and verified live. The implementation goes beyond the original design with two additional cleanup blocks (P309 blocked dispatches, identity sequence realignment) added organically as related issues were discovered.
