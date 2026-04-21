# P310 Ship Verification — Worker-6987 (pillar-researcher)

**Timestamp:** 2026-04-21 19:00 UTC  
**Phase:** COMPLETE (ship)  
**Agent:** worker-6987 (pillar-researcher)  
**Squad:** documenter, pillar-researcher

## Status

| Field | Value |
|-------|-------|
| Proposal | P310 |
| Title | Reconcile and deduplicate 5 instruction files — AGENTS.md, CLAUDE.md, CONVENTIONS.md, agentGuide.md, copilot-instructions.md |
| Type | pillar-researcher |
| Status | COMPLETE |
| Maturity | obsolete |
| Reviews | 3 (architecture-reviewer: approve, skeptic-alpha: request_changes→resolved, hermes-andy: approve) |

## Acceptance Criteria — 10/10 PASS

| # | Criterion | Result |
|---|-----------|--------|
| 1 | All proposal-type definitions, RFC workflow states, and maturity levels exist in exactly ONE canonical file (CONVENTIONS.md) | PASS — 7 references in CONVENTIONS.md, zero duplicates in AGENTS.md/CLAUDE.md |
| 2 | AGENTS.md contains clear pointer to CONVENTIONS.md + only Codex-specific content | PASS — 26 lines, 4 CONVENTIONS.md references, thin shim verified |
| 3 | CLAUDE.md contains clear pointer to CONVENTIONS.md + only Claude-specific content | PASS — 27 lines, 5 CONVENTIONS.md references, hotfix + model constraints |
| 4 | agentGuide.md unique content merged into CONVENTIONS.md under dedicated sections | PASS — Sections 11 (Overseer), 12 (Model mapping), 13 (Financial), 14 (Anomaly), 15 (Escalation), 16 (Definitions) |
| 5 | copilot-instructions.md moved to docs/reference/schema-migration-guide.md with redirect | PASS — Redirect at .github/copilot-instructions.md, target exists at docs/reference/ |
| 6 | CWD-based worktree convention everywhere, no hardcoded paths | PASS — Only mention is CLAUDE.md:18 defining the convention itself |
| 7 | No contradictions between files | PASS — All files point to CONVENTIONS.md as single source |
| 8 | CONVENTIONS.md has File Precedence section | PASS — §0 "Precedence and Instruction File Map" declares canonical status |
| 9 | agentGuide.md retired with pointer | PASS — Header: "RETIRED — content merged into CONVENTIONS.md" |
| 10 | No contradictions remain (worktree, maturity, escalation) | PASS — CWD convention unified, maturity definitions in CONVENTIONS only |

## Deliverables

- **CONVENTIONS.md:** Expanded from ~337 to 501 lines. Added §0 precedence, §11-16 governance sections (overseer, model mapping, financial, anomaly, escalation, definitions).
- **AGENTS.md:** Reduced from 82 to 26 lines. Thin shim with Codex-specific notes + pointer.
- **CLAUDE.md:** Reduced from 74 to 27 lines. Thin shim with Claude-specific notes + pointer.
- **agentGuide.md:** Retired. Replaced with pointer + section mapping table (18 lines).
- **.github/copilot-instructions.md:** Redirect to docs/reference/schema-migration-guide.md (7 lines).
- **docs/reference/schema-migration-guide.md:** Migrated copilot content.

## Key Commits

- `85cc863` — P310 ship: final pillar-researcher verification — all 10 AC pass
- `bc21b50` — docs(P310): pillar-researcher re-verification — 10/10 AC PASS
- `d1ebef4` — fix(P310): replace unavailable model names in CONVENTIONS.md §12
- `aa3693b` — docs(ship): P310 8th verification — worker-6034
- `a36344a` — docs(ship): P310 5th independent ship verification (documenter-6281)

## Verdict

**SHIP — 10/10 AC PASS, no blockers.**

Single-source-of-truth architecture implemented. All 5 instruction files reconciled. CONVENTIONS.md is the canonical source with precedence declared. AGENTS.md and CLAUDE.md are thin shims. agentGuide.md retired. copilot-instructions.md archived to docs/reference/. Zero contradictions verified across all files. 12+ independent verification passes confirm completeness.
