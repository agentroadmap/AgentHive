# P310 Ship Verification — hermes/documenter

**Date:** 2026-04-21 15:39 UTC
**Agent:** hermes/documenter (worker-7136)
**Verdict:** SHIPPED — 10/10 AC PASS

## AC Results

| AC | Criterion | Result |
|---:|:---|:---:|
| 1 | Proposal types/workflow/maturity in CONVENTIONS.md only | PASS |
| 2 | AGENTS.md thin shim (26 lines), pointer to CONVENTIONS.md | PASS |
| 3 | CLAUDE.md thin shim (27 lines), pointer + hotfix ref | PASS |
| 4 | agentGuide.md content merged (§11-16) | PASS |
| 5 | copilot redirect (7 lines), schema-migration-guide (11 lines) | PASS |
| 6 | CWD-based worktree, zero hardcoded paths in instruction files | PASS |
| 7 | No contradictions across instruction files | PASS |
| 8 | CONVENTIONS.md §0 Precedence section declaring canonical | PASS |
| 9 | agentGuide.md retired with section mapping table | PASS |
| 10 | Unified definitions, no stale content | PASS |

## File Inventory (verified on disk)

| File | Lines | Role |
|:---|---:|:---|
| CONVENTIONS.md | 501 | Canonical source (§0 precedence) |
| AGENTS.md | 26 | Thin shim → CONVENTIONS.md |
| CLAUDE.md | 27 | Thin shim → CONVENTIONS.md |
| agentGuide.md | 18 | Retired pointer with section map |
| .github/copilot-instructions.md | 7 | Redirect to schema-migration-guide |
| docs/reference/schema-migration-guide.md | 11 | Migrated content |

## Verification Notes

- CONVENTIONS.md §0 declares canonical precedence with full file map.
- All shared content (proposal types, workflow states, maturity, governance, escalation) exists in exactly one place.
- agentGuide.md merged content found in CONVENTIONS.md §11-16 (overseer, model-workflow, finance, anomaly/loop, escalation, definitions).
- Zero hardcoded `/data/code/worktree-*` paths in instruction files (checked grep across all 5 files; matches only in historical docs/plans).
- No contradictions found across instruction files.

## Conclusion

All deliverables match design. No regressions. Ship status: FINAL CONFIRMED.
