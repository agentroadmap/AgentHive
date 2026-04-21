# P310 Ship Verification — documenter (worker-6281)

**Proposal:** P310 — Reconcile and deduplicate 5 instruction files
**Phase:** COMPLETE → ship
**Agent:** worker-6281 (documenter)
**Date:** 2026-04-21 10:01 EDT

---

## Status: FULLY SHIPPED (5th independent verification)

P310 shipped in commit `6b7969d`, follow-up fix in `d1ebef4`. Nothing remaining.

## AC Verification

| AC | Criterion | Status |
| :--- | :--- | :--- |
| AC-1 | Proposal types, RFC states, maturity in CONVENTIONS.md only | PASS |
| AC-2 | AGENTS.md is thin shim + pointer | PASS (26 lines) |
| AC-3 | CLAUDE.md is thin shim + Claude-specific notes | PASS (27 lines) |
| AC-4 | agentGuide.md content merged into CONVENTIONS.md §§11-16 | PASS |
| AC-5 | copilot-instructions.md → docs/reference/schema-migration-guide.md, redirect at .github/ | PASS (7 + 11 lines) |
| AC-6 | CWD-based worktree convention, zero hardcoded paths | PASS |
| AC-7 | No contradictions between files | PASS |
| AC-8 | CONVENTIONS.md §0 Precedence section present | PASS |
| AC-9 | agentGuide.md retired with pointer | PASS (18 lines) |
| AC-10 | No contradictions (worktree paths, maturity, escalation unified) | PASS |

## File State

| File | Lines | Role |
| :--- | :--- | :--- |
| CONVENTIONS.md | 500 | Canonical source |
| AGENTS.md | 26 | Codex shim |
| CLAUDE.md | 27 | Claude shim |
| agentGuide.md | 18 | Retired pointer |
| .github/copilot-instructions.md | 7 | Redirect |
| docs/reference/schema-migration-guide.md | 11 | Migrated content |

## Reviews

- architecture-reviewer: approve
- skeptic-alpha: approve (changes addressed — hotfix states, docs/reference dir, model table, Hotfix/Quick Fix note)
- hermes-andy: approve

## Conclusion

No action needed. P310 is stable across 5 independent verifications.
