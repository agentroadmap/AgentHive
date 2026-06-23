# P4663/AC-11: RAISE Condition Map — Migration 319

Maps every RAISE condition R(M) from prior gate-guard writers to the canonical
`fn_guard_gate_advance` in migration 319.

| Prior Writer | Mig | RAISE Condition | Canonical Location (319) |
|:---|:---|:---|:---|
| P181/fn_check_proposal_gate | 189 | Non-terminal gate requires gate decision | `v_is_nonterminal` branch — `RAISE EXCEPTION '...gate_decision_log...'` |
| P181/fn_check_proposal_gate | 189 | Terminal gate requires review/gate decision | Terminal branch — dual-check `v_has_decision` RAISE |
| P3566 | 270 | Non-terminal direct UPDATE refused (gate_decision_log required) | `v_is_nonterminal` RAISE |
| P3566 | 270 | Terminal gate: no gate_decision_log AND no proposal_reviews within 10min | Terminal branch dual-check RAISE |
| P3566 | 289 | Same as 270 (re-write, same semantics) | Preserved in 319 |
| P3563 (draft) | 291 | Zero ACs on MERGE→COMPLETE (P_termAC) | `v_ac_count = 0` RAISE |
| P3563 (draft) | 291 | Unwaived pending/fail/blocked ACs on MERGE→COMPLETE | `status IN ('pending','fail','blocked')` RAISE |
| P3929 | 299 | Non-terminal bypass via app.gate_bypass REMOVED (bypass only terminal-scoped) | P4663/319: bypass REMOVED entirely (P_noBypass) |

## New RAISE conditions introduced in 319 (P4663)

| Pillar | RAISE Condition |
|:---|:---|
| P_noBypass | `app.gate_bypass` is never consulted (structural: no reference in function body) |
| P_govEdges | DRAFT→DELIBERATION and DELIBERATION→REVIEW added to guarded edge list |
| P_gov48h (non-terminal) | DELIBERATION→REVIEW refused when `now() - OLD.state_changed_at < INTERVAL '48 hours'` |
| P_govHuman | governance-amendment MERGE→COMPLETE requires `agent_type = 'human'` decider |
| P_gov48h (terminal) | governance-amendment terminal gate refused when `now() - NEW.created_at < INTERVAL '48 hours'` |
| P_termIndep | RAISE when `v_decider = v_author` (resolved from audit JSON `Activity='Created'` or earliest discussion fallback) |
| P_failClosed | RAISE when author cannot be resolved to a non-system identity |

## Precedence note

Migration 319 supersedes the terminal-gate logic in migs 270, 289, 291, 299 for
`fn_guard_gate_advance`. The non-terminal path from 299 (bypass scoped to terminal-only)
is superseded by P_noBypass (bypass removed completely). `fn_apply_gate_advance` from
mig 299 is unchanged (bypass already removed there; 319 does not touch it).

## Verification

Run `npm run check:gate-invariants` to verify all pillars are present in the live function.
