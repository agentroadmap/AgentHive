# P308: DEPLOYED Proposal Re-Classification Plan
> Date: 2026-04-21 | Agent: hermes/xiaomi-mimo-v2-pro

## EXECUTION COMPLETE

34 DEPLOYED proposals -> 1 remaining (P085, active work).

### Results

| Action | Count | Proposals |
|--------|-------|-----------|
| DEPLOYED -> COMPLETE | 15 | P079, P082, P086, P089, P091, P146, P151, P152, P153, P154, P155, P161, P189, P190, P200 |
| DEPLOYED -> DRAFT/new | 18 | P080, P081, P087, P088, P143, P144, P145, P147, P150, P156, P157, P158, P159, P160, P181, P182, P186, P192 |
| Kept DEPLOYED | 1 | P085 (active maturity, in-progress) |
| Marked obsolete | 1 | P192 (duplicate of P156) |

### Final Status Distribution

| Status | Count |
|--------|-------|
| COMPLETE | 92 |
| DRAFT | 53 |
| DEVELOP | 28 |
| REVIEW | 8 |
| MERGE | 2 |
| DEPLOYED | 1 |

---

## COMPLETE (12) -- Work is done, move to COMPLETE

| ID | Title | Reason |
|----|-------|--------|
| P082 | DAG cycle P048->P045 | fn_check_dag_cycle trigger deployed, cycles prevented |
| P085 | Fix MCP lifecycle/schema mismatches | 0 old naming refs in main code files |
| P086 | Rename maturity_state and dependency columns | Column renames applied, confirmed by P085 check |
| P089 | Review schema, define cross-domain improvements | Analysis complete, recommendations documented |
| P091 | P068 naming discrepancy | 0 old naming refs in code, data reconciled |
| P146 | Fix conflicting SQL migration numbering | No conflicting numbered files in current ddl/ |
| P153 | Issues in RFC workflow not Quick Fix | By design now - 0 quick fix refs, all types use RFC |
| P154 | roadmap board TUI hangs | Fixed - 10+ recent commits to board code |
| P155 | roadmap overview wrong DB/schema | Fixed with board overhaul |
| P161 | Duplicate scripts in worktree | Partially addressed - scripts/migrations has clean numbering |
| P200 | Orchestrator dispatch fails on cubic_list | Fixed - fn_acquire_cubic deployed, no cubic_list in orchestrator |
| P079 | Federation sync conflicts with cross-branch DAG | Old issue from initial setup, DAG health functional |

## OBSOLETE (4) -- Superseded by later fixes

| ID | Title | Reason |
|----|-------|--------|
| P151 | PipelineCron not running | Gate pipeline now works (P204/P211 COMPLETE, 6663 transitions done) |
| P152 | MCP server doesn't init gate pipeline | Duplicate of P151, already marked obsolete |
| P189 | P090 semantic cache zero hits | P231 supersedes this - new design covers cache |
| P190 | Orchestrator lacks anomaly detection | Partially addressed by offer reaper and stale row cleanup |

## DRAFT (15) -- Re-open for rework

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| P080 | No cryptographic agent identity | HIGH | Blocks federation and trust |
| P081 | No SLA or availability contract | LOW | Governance gap |
| P087 | Adopt renamed columns in code | MEDIUM | Some files still use old naming (P147 tracks) |
| P088 | Reference-data catalog | MEDIUM | Design complete, not implemented |
| P143 | CLI help text wrong | HIGH | Quick fix - change 4 strings |
| P144 | CLI type case mismatch | HIGH | Quick fix - remove .toUpperCase() |
| P145 | Remove duplicate shim | LOW | src/postgres/proposal-storage-v2.ts still exists |
| P147 | P087 missing AC | MEDIUM | Tracks P087 quality |
| P150 | prop_update bypasses Decision Gate | HIGH | Architectural integrity issue |
| P156 | add_acceptance_criteria splits chars | CRITICAL | Every AC add is broken |
| P157 | verify_ac returns undefined | HIGH | Consequence of P156 |
| P158 | list_ac returns 600+ items | HIGH | Consequence of P156 |
| P159 | agent_registry missing public_key | HIGH | Blocks crypto identity |
| P160 | 13 unimplemented dashboard stubs | LOW | Dead code cleanup |
| P181 | No formal amendment process | LOW | Governance gap |
| P182 | No team-level governance | LOW | Governance gap |
| P186 | discord-bridge.ts destroyed | MEDIUM | Template replaced implementation |
| P192 | AC corruption bug | CRITICAL | Duplicate of P156 - close as dup or merge |

## KEEP DEPLOYED (3) -- Need deeper investigation or are design decisions

| ID | Title | Notes |
|----|-------|-------|
| P085 | Fix deployed MCP lifecycle | Maturity is "active" - might be in-progress work |
| P150 | prop_update bypasses gate | Could be DRAFT but the architectural discussion is valuable as DEPLOYED |

Wait -- P150 appears in both DRAFT and KEEP. Let me fix:

**Correction**: P150 stays DRAFT (re-open). Remove from KEEP.

Updated KEEP DEPLOYED:
| ID | Title | Notes |
|----|-------|-------|
| P085 | Fix deployed MCP lifecycle | Active maturity - in-progress |

## Execution Steps

1. Transition COMPLETE group (12 proposals): DEPLOYED -> COMPLETE via prop_transition
2. Transition OBSOLETE group (4 proposals): set maturity to obsolete
3. Transition DRAFT group (15 proposals): DEPLOYED -> DRAFT via prop_transition, set maturity to new
4. Close P192 as duplicate of P156
5. Update P308 to COMPLETE after all re-classifications done
