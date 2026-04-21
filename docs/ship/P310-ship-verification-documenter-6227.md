# P310 Ship Verification — documenter worker-6227

**Date:** 2026-04-21 09:38 UTC
**Agent:** hermes/worker-6227 (documenter)
**Phase:** ship
**Maturity:** obsolete
**Status:** COMPLETE

## AC Verification (10/10 PASS)

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | Single canonical copy of proposal types, RFC workflow, maturity levels in CONVENTIONS.md | PASS |
| AC-2 | AGENTS.md is thin shim with pointer to CONVENTIONS.md + Codex-specific content only | PASS — 26 lines, no duplicated tables |
| AC-3 | CLAUDE.md is thin shim with pointer to CONVENTIONS.md + Claude-specific content only | PASS — 27 lines, hotfix reference correct |
| AC-4 | agentGuide.md unique content merged into CONVENTIONS.md sections 10-16 | PASS — overseer, governance, escalation all present |
| AC-5 | copilot-instructions.md moved to docs/reference/schema-migration-guide.md, redirect remains | PASS — both files exist |
| AC-6 | Worktree path convention is CWD-based everywhere | PASS — no hardcoded paths |
| AC-7 | No contradictions across instruction files | PASS — all files verified |
| AC-8 | CONVENTIONS.md has File Precedence section (section 0) | PASS — declares canonical, lists all 5 files |
| AC-9 | agentGuide.md retired with pointer to CONVENTIONS.md | PASS — 18-line redirect with section mapping |
| AC-10 | No contradictions: CWD paths, consistent maturity, unified escalation | PASS |

## File State

| File | Lines | Role |
|------|-------|------|
| CONVENTIONS.md | 500 | Canonical source — sections 0-16 |
| AGENTS.md | 26 | Thin shim, Codex-specific |
| CLAUDE.md | 27 | Thin shim, Claude-specific |
| agentGuide.md | 18 | Retired redirect |
| .github/copilot-instructions.md | Exists | Redirect to schema-migration-guide |
| docs/reference/schema-migration-guide.md | Exists | Actual migration content |

## Prior Reviews

- architecture-reviewer: approve
- skeptic-alpha: request_changes (4 sub-items, all addressed)
- hermes-andy: approve — comprehensive file audit, all 5 files compared

## Verdict

**SHIP CONFIRMED.** P310 is COMPLETE/obsolete. All 10 ACs verified against on-disk files. Single-source-of-truth architecture in place — CONVENTIONS.md is canonical, all other files are thin shims or redirects. No duplicated content remains across instruction files. Documentation-only change, zero code/DB/MCP risk.
