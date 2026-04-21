# P310 Re-verification — Reconcile and Deduplicate 5 Instruction Files

**Date:** 2026-04-21 04:42 UTC
**Status:** SHIPPED — confirmed stable
**Verifier:** hermes (documenter, worker-5522)
**Proposal:** P310 — Reconcile and deduplicate 5 instruction files
**DB State:** status=COMPLETE, maturity=obsolete

---

## AC Re-verification (all 10 ACs)

| AC | Description | Result |
| :--- | :--- | :--- |
| AC-1 | Proposal types, RFC workflow states, maturity exist in CONVENTIONS.md only — no duplication | PASS |
| AC-2 | AGENTS.md is thin shim (1224 chars) with pointer to CONVENTIONS.md, Codex-specific only | PASS |
| AC-3 | CLAUDE.md is thin shim (1247 chars) with pointer to CONVENTIONS.md, Claude-specific only | PASS |
| AC-4 | agentGuide.md content (overseer, governance, loop detection, escalation) merged into CONVENTIONS.md §§10-16 | PASS |
| AC-5 | copilot-instructions.md redirected to docs/reference/schema-migration-guide.md (thin redirect at .github/copilot-instructions.md) | PASS |
| AC-6 | CWD-based worktree convention everywhere — zero hardcoded /data/code/worktree-* paths | PASS |
| AC-7 | No contradictions between instruction files | PASS |
| AC-8 | CONVENTIONS.md §0 File Precedence declares it canonical source | PASS |
| AC-9 | agentGuide.md retired with section mapping table and pointer | PASS |
| AC-10 | No contradictions: CWD paths, consistent maturity, unified escalation | PASS |

## File State Summary

| File | Lines | Size | Role |
| :--- | :--- | :--- | :--- |
| CONVENTIONS.md | 500 | 25,377 chars | Canonical source — all shared rules |
| AGENTS.md | 26 | 1,224 chars | Thin shim — Codex-specific + pointer |
| CLAUDE.md | 27 | 1,247 chars | Thin shim — Claude-specific + pointer |
| agentGuide.md | 18 | 659 chars | Retired — pointer to CONVENTIONS.md |
| .github/copilot-instructions.md | 7 | 281 chars | Redirect to schema-migration-guide.md |
| docs/reference/schema-migration-guide.md | 11 | 646 chars | Schema migration context |

## Regression Check

- No duplicated proposal-type tables in AGENTS.md or CLAUDE.md
- No hardcoded worktree paths in any instruction file
- Precedence section present and unambiguous
- Hotfix workflow in CONVENTIONS.md §5, referenced by CLAUDE.md
- Model-to-phase mapping in CONVENTIONS.md §12 (design-intent reference, DB is source of truth)

## Verdict

**ALL 10 ACs PASS. No regressions. Ship confirmed stable.**

No code changes — documentation-only verification. Zero impact on runtime, MCP, or DB.
