# P310 Ship Verification — Reconcile and Deduplicate 5 Instruction Files

**Date:** 2026-04-21
**Verifying:** worker-5897 (pillar-researcher)
**Status:** COMPLETE
**Commits:** 6b7969d (main), d1ebef4 (fix: model names in §12)

## Acceptance Criteria Verification

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | CONVENTIONS.md has precedence section declaring it canonical | PASS | §0 "Precedence and Instruction File Map" — declares canonical, lists all 5 files with roles |
| 2 | agentGuide.md unique content merged into CONVENTIONS.md | PASS | Sections 11-16: Overseer (§11), Model-to-Workflow (§12), Financial Governance (§13), Anomaly Detection (§14), Escalation Matrix (§15), Definitions (§16) |
| 3 | AGENTS.md/CLAUDE.md shared content merged into CONVENTIONS.md | PASS | §5 contains: RFC workflow states, maturity definitions, proposal types — single copy, not duplicated |
| 4 | Worktree path convention fixed (CWD-based) | PASS | §7 "Git and Worktree Best Practices" uses CWD convention, no hardcoded paths |
| 5 | AGENTS.md rewritten as thin shim | PASS | 26 lines — pointer to CONVENTIONS.md, Codex-specific notes, repo context |
| 6 | CLAUDE.md rewritten as thin shim | PASS | 27 lines — pointer to CONVENTIONS.md, Claude-specific notes (host policy, hotfix reference), repo context |
| 7 | copilot-instructions.md moved to docs/reference/ | PASS | `.github/copilot-instructions.md` is redirect (5 lines). `docs/reference/schema-migration-guide.md` created |
| 8 | agentGuide.md retired | PASS | 18 lines — "RETIRED" header, section mapping table, pointer to CONVENTIONS.md |
| 9 | Cross-references updated throughout | PASS | §1 removes agentGuide.md from reading list, notes it's retired. All thin shims point to CONVENTIONS.md |
| 10 | No contradictions remain between files | PASS | All files consistent: MCP port 6421, CWD worktree, proposal workflow DRAFT→COMPLETE |

## Post-Merge Fix Applied

Skeptic review (d1ebef4) caught hardcoded unavailable model names in §12 (copied from retired agentGuide.md). Fix: removed specific model names, added NOTE that `model_routes` table is authoritative, added host constraint note.

## Deliverables Summary

| File | Lines | Role |
|------|-------|------|
| CONVENTIONS.md | 500 | Canonical source (§0-§17) |
| AGENTS.md | 26 | Thin shim for Codex |
| CLAUDE.md | 27 | Thin shim for Claude Code |
| agentGuide.md | 18 | Retired (pointer only) |
| .github/copilot-instructions.md | ~5 | Redirect to docs/reference/ |
| docs/reference/schema-migration-guide.md | ~6 | Schema migration context |

## Verdict

All 10 design requirements delivered. No contradictions between files. Ship.
