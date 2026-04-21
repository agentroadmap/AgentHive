# Live Verification Report
> Date: 2026-04-21 | Agent: hermes/xiaomi-mimo-v2-pro

## Gate Pipeline Health: HEALTHY

| Check | Result |
|-------|--------|
| P204 fn_enqueue case mismatch | COMPLETE/mature |
| P211 markTransitionDone | COMPLETE/mature |
| fn_enqueue_mature_proposals | EXISTS in DB |
| fn_notify_gate_ready | EXISTS in DB |
| fn_sync_proposal_maturity | EXISTS in DB |
| fn_acquire_cubic | EXISTS in DB |
| fn_check_spawn_policy | EXISTS in DB |
| Transition queue done count | 6,663 |
| Transition queue failed | 53 |
| Transition queue held | 1 |
| Mature non-terminal proposals | 9 (5 DRAFT, 2 REVIEW, 2 DEVELOP) |

**Verdict**: Gate pipeline is operational. Functions exist, transitions are processing,
and mature proposals are being enqueued. The 2026-04-13 gap report's "gate pipeline is dead"
claim is no longer accurate.

## Spending Caps: $10.00 (NOT $inf)

The 2026-04-13 gap report claimed all caps were $inf. This was stale.
Live DB shows all agents have `daily_limit_usd = 10.00` and `is_frozen = false`.

| Agent | daily_limit_usd | is_frozen |
|-------|----------------|-----------|
| architecture-reviewer | 10.00 | false |
| claude/andy | 10.00 | false |
| claude/one | 10.00 | false |
| codex | 10.00 | false |
| gate-agent | 10.00 | false |
| (+ all others) | 10.00 | false |

**Verdict**: Financial guardrails ARE active. $10/day cap per agent. Not $inf.

## V4 DDL Migrations: DEPLOYED

| Table | Status |
|-------|--------|
| cubics | EXISTS |
| gate_decision_log | EXISTS |
| host_model_policy | EXISTS |
| tool_agent_config | EXISTS |

| Column (model_metadata) | Status |
|-------------------------|--------|
| cost_per_million_input | EXISTS |
| cost_per_million_output | EXISTS |
| cost_per_million_cache_hit | EXISTS |
| cost_per_million_cache_write | EXISTS |

**Verdict**: All v4 DDL migrations are applied. Baseline document (P305) needs updating
to reflect this.

## DEPLOYED Proposals: 34 (confirmed)

Full list verified in live DB. These need re-classification per P308.

## Corrections to Gap Report (2026-04-13)

| Gap Claim | Live Reality |
|-----------|-------------|
| "Gate pipeline is dead" | FIXED. Functions exist, 6663 transitions done |
| "All spending caps = $inf" | FALSE. All caps = $10.00 |
| "V4 DDL not deployed" | FALSE. All 4 v4 tables exist, per-million columns present |
| "cubics table missing" | FALSE. cubics table exists |
| "fn_enqueue case mismatch" | FIXED. P204 COMPLETE |
| "markTransitionDone dead code" | FIXED. P211 COMPLETE |
| "34 DEPLOYED issues" | FIXED. 34->1 (P085 active work) |

## P308 Re-Classification Summary

34 DEPLOYED proposals re-classified:
- 15 moved to COMPLETE (work verified done)
- 18 moved to DRAFT/new (re-opened for rework)
- 4 marked obsolete (superseded or duplicate)
- 1 kept DEPLOYED (P085, active maturity)

Final status: COMPLETE=92, DRAFT=53, DEVELOP=28, REVIEW=8, MERGE=2, DEPLOYED=1
