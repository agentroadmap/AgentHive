# Gate Decisions — 2026-04-11

## AgentHive RFC Gate Evaluator Run — 04:15 UTC

### TRIAGE → FIX
No proposals in TRIAGE state.

### DRAFT → REVIEW
No proposals in DRAFT state.

### REVIEW → DEVELOP

| Proposal | Decision | Reason |
|----------|----------|--------|
| P162 | ⏸️ HOLD | Solid description with detailed spec, but NO acceptance criteria registered. Must add structural AC before advancing to DEVELOP. |

### FIX → DEPLOYED

| Proposal | Decision | Reason |
|----------|----------|--------|
| P079 | ⏸️ HOLD | No evidence of fix in codebase. Federation sync conflict resolution not implemented. |
| P086 | ⏸️ HOLD | Partial work (migration 012-013), but TS code still references `maturity_state` extensively. |
| P087 | ⏸️ HOLD | Depends on P086. Multiple TS files still reference old `maturity_state` column. |
| P089 | ⏸️ HOLD | No commits or code changes found. Schema review not complete. |
| P091 | ⏸️ HOLD | Naming discrepancy P068/MCP/Web Dashboard not resolved. |
| P147 | ⏸️ HOLD | Blocked by P087. ~12 code files still reference old column. |
| P154 | ⏸️ HOLD | Roadmap board TUI hang not fixed. No commits found. |
| P155 | ⏸️ HOLD | Roadmap overview schema mismatch not fixed. No commits found. |
| P159 | ⏸️ HOLD | Migration 018 exists but no TS code uses `public_key` yet. Partial. |
| P160 | ⏸️ HOLD | 13 dashboard-web page stubs still unimplemented. |
| P161 | ⏸️ HOLD | Duplicate scripts in worktree not cleaned up. |

### DEVELOP → MERGE

| Proposal | Decision | Reason |
|----------|----------|--------|
| P044 (mature) | ⏸️ HOLD | Core product — still in active development. Premature to advance. |
| P051 (mature) | ⏸️ HOLD | Autonomous pipeline — active development. |
| P054 (mature) | ⏸️ HOLD | Agent identity — active development. |
| P056 (mature) | ⏸️ HOLD | Lease protocol — active development. |
| P057 (mature) | ⏸️ HOLD | Zero-trust ACL — active development. |
| P060 (mature) | ⏸️ HOLD | Financial governance — active development. |
| P064 (mature) | ⏸️ HOLD | OpenClaw CLI — active development. |
| P065 (mature) | ⏸️ HOLD | MCP server tools — active development. |
| P045-P048 (active) | ⏸️ HOLD | Pillar components — active development. |
| P066-P068 (active) | ⏸️ HOLD | Dashboard/document/federation — active development. |

### MERGE → COMPLETE

| Proposal | Decision | Reason |
|----------|----------|--------|
| P149 | ✅ ADVANCE | Code merged to main (commit 3bfd5ed). Feature fully implemented: `channel_subscription` table, `fn_message_notify` trigger, `msg_subscribe` tool, pg_notify push notifications. AC verified (all pass). Transitioned MERGE → COMPLETE. |

## Summary
- **Advanced:** 1 (P149 MERGE → COMPLETE)
- **Held:** 11 FIX + 1 REVIEW + 15 DEVELOP = 27 held
- **No action:** 37 (COMPLETE/DEPLOYED terminal states)
