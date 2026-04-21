# P310 Final Ship Verification

**Date:** 2026-04-21 11:36 EDT
**Agent:** hermes/agency-xiaomi (documenter)
**Phase:** ship
**Status:** COMPLETE
**Maturity:** obsolete

## AC Verification (10/10 PASS)

| AC | Description | Result |
|----|-------------|--------|
| AC-1 | Single canonical copy in CONVENTIONS.md only | PASS |
| AC-2 | AGENTS.md thin shim (26 lines) | PASS |
| AC-3 | CLAUDE.md thin shim (27 lines) | PASS |
| AC-4 | agentGuide.md content merged into CONVENTIONS.md sections 10-16 | PASS |
| AC-5 | copilot-instructions.md → docs/reference/schema-migration-guide.md | PASS |
| AC-6 | CWD-based worktree convention everywhere | PASS |
| AC-7 | No contradictions across files | PASS |
| AC-8 | CONVENTIONS.md section 0 declares precedence | PASS |
| AC-9 | agentGuide.md retired with section mapping table | PASS |
| AC-10 | Consistent paths, maturity, escalation | PASS |

## On-Disk Verification

```
CONVENTIONS.md          500 lines  canonical (sections 0-17)
AGENTS.md                26 lines  thin shim, Codex-specific
CLAUDE.md                27 lines  thin shim, Claude-specific
agentGuide.md            18 lines  retired redirect
.github/copilot-instructions.md   7 lines  redirect
docs/reference/schema-migration-guide.md  11 lines  actual content
```

## Key Fixes Verified

- Hotfix workflow: TRIAGE/FIX/DEPLOYED (corrected from old Triage/Fixing/Done) ✓
- Model table: labeled as "design intent", DB model_routes as source of truth ✓
- Worktree: "CWD-based convention" everywhere, no hardcoded paths ✓
- Precedence: section 0 declares CONVENTIONS.md canonical, lists all 5 files ✓

## Pre-Existing Issue (Not In Scope)

**S4 from skeptic review:** `hotfix` type in `proposal_type_config` maps to an empty Hotfix template (zero stages), while the actual hotfix workflow has TRIAGE/FIX/DEPLOYED. This is a pre-existing DB configuration bug, not caused by P310. Should be fixed in a dedicated DB proposal.

## Verdict

**SHIP CONFIRMED.** Documentation-only change. Zero code/DB/MCP risk. Single source of truth established — CONVENTIONS.md is canonical, all other files are thin shims or redirects.
