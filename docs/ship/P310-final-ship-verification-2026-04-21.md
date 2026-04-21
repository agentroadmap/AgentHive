# P310 Ship Verification — Final Independent Recheck

**Date:** 2026-04-21
**Agent:** worker-6589 (documenter)
**Phase:** COMPLETE — Ship Verification

## Acceptance Criteria

| AC | Criterion | Result |
| :--- | :--- | :--- |
| AC-1 | All proposal-type definitions, RFC workflow states, and maturity levels in CONVENTIONS.md only | **PASS** |
| AC-2 | AGENTS.md thin shim pointing to CONVENTIONS.md + Codex-specific content only | **PASS** (26 lines) |
| AC-3 | CLAUDE.md thin shim pointing to CONVENTIONS.md + Claude-specific content (hotfix, model constraints) | **PASS** (27 lines) |
| AC-4 | agentGuide.md unique content merged into CONVENTIONS.md (overseer, governance, escalation, loop detection) | **PASS** |
| AC-5 | copilot-instructions.md moved to docs/reference/schema-migration-guide.md, redirect at .github/ | **PASS** (7 + 11 lines) |
| AC-6 | CWD-based worktree convention everywhere, no hardcoded paths | **PASS** |
| AC-7+8 | Precedence section in CONVENTIONS.md §0 declaring it canonical | **PASS** |
| AC-9 | agentGuide.md retired with merge pointer table | **PASS** |
| AC-10 | No contradictions across files | **PASS** |

## File Inventory

| File | Lines | Role |
| :--- | :--- | :--- |
| CONVENTIONS.md | 500 | Canonical source — workflow, MCP, DB, Git, governance |
| AGENTS.md | 26 | Thin shim — Codex-specific notes + pointer |
| CLAUDE.md | 27 | Thin shim — Claude-specific notes + pointer |
| agentGuide.md | 18 | Retired — pointer to CONVENTIONS.md |
| .github/copilot-instructions.md | 7 | Redirect to docs/reference/schema-migration-guide.md |
| docs/reference/schema-migration-guide.md | 11 | Migrated schema migration context |

## Verification Method

Independent Python script verified each AC programmatically:
- Checked no duplicated proposal-type tables outside CONVENTIONS.md
- Confirmed thin shims are under 40 lines with pointers
- Verified agentGuide content (overseer, financial, escalation, loop) present in CONVENTIONS.md
- Confirmed copilot redirect and schema-migration-guide exist
- Validated no hardcoded worktree paths, CWD convention used
- Confirmed precedence section exists in CONVENTIONS.md §0

## Result

**SHIP APPROVED** — All 10 ACs pass. No open items. No contradictions. No stale content.
