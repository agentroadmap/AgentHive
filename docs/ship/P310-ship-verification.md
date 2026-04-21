# P310 Ship Verification — Reconcile and Deduplicate 5 Instruction Files

**Date:** 2026-04-21  
**Status:** SHIPPED  
**Verifier:** hermes (documenter)  
**Commit:** 6b7969d — `P310: Reconcile and deduplicate 5 instruction files`

---

## Deliverable Verification

### 1. CONVENTIONS.md — Canonical Source (498 lines, up from 337)
- [x] Precedence section (Section 0) declares it canonical
- [x] Proposal types table merged (Section 3, line 97)
- [x] RFC workflow states consolidated
- [x] Maturity definitions merged (line 128)
- [x] Overseer role: Hermes/Andy responsibilities (Section 11)
- [x] Financial governance & budget control (Section 13)
- [x] Anomaly & loop detection (Section 14)
- [x] Escalation matrix (Section 15)
- [x] No hardcoded paths — CWD-based convention throughout
- [x] Cross-references updated (agentGuide.md retired, not in reading list)

### 2. AGENTS.md — Thin Shim (26 lines, target ~30)
- [x] Points to CONVENTIONS.md as canonical source
- [x] Codex-specific quirks only (sandbox, MCP, surgical changes)
- [x] No duplicated proposal types, workflow, or maturity content

### 3. CLAUDE.md — Thin Shim (27 lines, target ~40)
- [x] Points to CONVENTIONS.md as canonical source
- [x] Claude-specific memory: host policy (nous+xiaomi), MCP, DB
- [x] Hotfix workflow pointer (Section 5 + Section 15)
- [x] No duplicated content

### 4. agentGuide.md — Retired (18 lines)
- [x] Marked RETIRED with section mapping table
- [x] All original content merged into CONVENTIONS.md sections 10-16
- [x] Clear pointer to CONVENTIONS.md

### 5. copilot-instructions.md — Redirect (7 lines)
- [x] Redirects to `docs/reference/schema-migration-guide.md`
- [x] Points to CONVENTIONS.md for all other conventions
- [x] `docs/reference/schema-migration-guide.md` exists (11 lines)

## Contradiction Check
- No duplicated proposal types across files
- No conflicting workflow definitions
- No hardcoded paths (agentGuide.md bug fixed)
- Precedence is unambiguous: CONVENTIONS.md wins

## DB State
- P310: status=COMPLETE, maturity=obsolete
- Stale leases cleaned (1 released)
- Stale dispatches cleaned (2 cancelled)
- No active leases or dispatches remaining

## Verdict
**ALL 5 deliverables PASS. No contradictions. Ship approved.**
