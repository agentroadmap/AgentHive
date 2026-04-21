# P310 Ship Verification — pillar-researcher worker-6228

**Date:** 2026-04-21 09:38 UTC
**Agent:** hermes/worker-6228 (pillar-researcher)
**Phase:** ship
**Status:** COMPLETE
**Maturity:** obsolete

## AC Verification (10/10 PASS)

Independent re-verification against on-disk files:

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | Single canonical copy of proposal types, RFC workflow, maturity levels in CONVENTIONS.md | PASS — CONVENTIONS.md §5 has proposal types table, RFC states, hotfix states, maturity levels |
| AC-2 | AGENTS.md thin shim with pointer + Codex-specific only | PASS — 26 lines, clear pointer to CONVENTIONS.md, no duplicated tables |
| AC-3 | CLAUDE.md thin shim with pointer + Claude-specific only | PASS — 27 lines, clear pointer, host policy + DB notes only |
| AC-4 | agentGuide.md unique content merged into CONVENTIONS.md | PASS — overseer §11, governance §13, loop detection §14, escalation §15, model mapping §12 |
| AC-5 | copilot-instructions.md moved to docs/reference/ | PASS — redirect at .github/copilot-instructions.md (7 lines), schema-migration-guide.md exists (11 lines) |
| AC-6 | CWD-based worktree convention everywhere | PASS — grep for /data/code/worktree- in instruction files: zero hits |
| AC-7 | No contradictions across instruction files | PASS — all thin shims reference CONVENTIONS.md, no conflicting content |
| AC-8 | CONVENTIONS.md File Precedence section | PASS — §0 declares canonical, maps all 5 files with roles |
| AC-9 | agentGuide.md retired with pointer | PASS — 18-line redirect with section mapping table |
| AC-10 | No contradictions: paths, maturity, escalation unified | PASS — maturity definitions consistent in §128-135, escalation unified in §452-478 |

## File State

| File | Lines | Status |
|------|-------|--------|
| CONVENTIONS.md | 500 | Canonical — sections 0-16, all shared content absorbed |
| AGENTS.md | 26 | Thin shim — Codex quirks + pointer |
| CLAUDE.md | 27 | Thin shim — Claude memory + pointer |
| agentGuide.md | 18 | Retired — redirect with section mapping |
| .github/copilot-instructions.md | 7 | Redirect to schema-migration-guide |
| docs/reference/schema-migration-guide.md | 11 | Archived migration context + pointers |

## Content Audit Notes

- CONVENTIONS.md §12 (Model-to-Workflow Phase Mapping) correctly marks model table as "design intent" with DB as source of truth — addresses skeptic S3.
- CONVENTIONS.md §117-126 (Hotfix Workflow) uses correct SMDL states (TRIAGE/FIX/DEPLOYED) per skeptic S1 — not the outdated Triage/Fixing/Done.
- CONVENTIONS.md §79 uses CWD-based worktree convention — no hardcoded paths.
- No code, DB, or MCP risk. Documentation-only change.

## Prior Reviews

- architecture-reviewer: approve
- skeptic-alpha: request_changes (S1-S4, all resolved in final state)
- hermes-andy: approve — comprehensive 5-file audit

## Verdict

**SHIP CONFIRMED.** P310 is COMPLETE/obsolete. All 10 ACs verified. Single-source-of-truth architecture established — CONVENTIONS.md is canonical, all other files are thin shims or redirects. Zero duplicated content across instruction files.
