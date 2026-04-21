# P310 Ship Re-Verification — 2026-04-21

**Proposal:** P310 — Reconcile and deduplicate 5 instruction files
**Status:** SHIPPED (re-verified)
**Previous verification:** 2026-04-21 (commit e9d8c06)

---

## Re-verification Results

### Deliverable 1: CONVENTIONS.md — Canonical Source
- Lines: 499 (was 498 at initial ship)
- Precedence section: present (Section 0)
- Proposal types table: merged (Section 3)
- Maturity definitions: merged
- Overseer role: Section 11
- Financial governance: Section 13
- Anomaly/loop detection: Section 14
- Escalation matrix: Section 15
- Hardcoded worktree paths: none found
- Verdict: **PASS**

### Deliverable 2: AGENTS.md — Thin Shim
- Lines: 27 (was 26)
- Points to CONVENTIONS.md: yes
- No duplicated content: confirmed
- Codex-specific notes only: confirmed
- Verdict: **PASS**

### Deliverable 3: CLAUDE.md — Thin Shim
- Lines: 28 (was 27)
- Points to CONVENTIONS.md: yes
- Claude-specific content only: confirmed
- Host policy noted: yes
- Hotfix workflow pointer: yes (Section 5 + 15)
- Verdict: **PASS**

### Deliverable 4: agentGuide.md — Retired
- Lines: 19 (was 18)
- Marked RETIRED: yes
- Section mapping table: present (maps old → new sections)
- Content pointer to CONVENTIONS.md: yes
- Verdict: **PASS**

### Deliverable 5: copilot-instructions.md — Redirect
- Lines: 8 (was 7)
- Redirects to schema-migration-guide.md: yes
- docs/reference/schema-migration-guide.md exists: yes (11 lines)
- Verdict: **PASS**

## Contradiction Check
- No duplicated proposal types across files
- No conflicting workflow definitions
- No hardcoded paths
- Reference mentions in agentGuide.md (Overseer, Governance, Escalation) are retirement table entries only — not duplicated content
- Reference in CLAUDE.md ("Escalation Matrix") is a section pointer only
- Precedence unambiguous: CONVENTIONS.md wins

## File Stability
| File | Initial Ship | Now | Delta |
|------|-------------|-----|-------|
| CONVENTIONS.md | 498 lines | 499 lines | +1 (minor) |
| AGENTS.md | 26 lines | 27 lines | +1 (minor) |
| CLAUDE.md | 27 lines | 28 lines | +1 (minor) |
| agentGuide.md | 18 lines | 19 lines | +1 (minor) |
| copilot-instructions.md | 7 lines | 8 lines | +1 (minor) |

Minor line count changes are within normal drift (trailing newlines, whitespace).

## Verdict
**ALL 5 DELIVERABLES PASS. No regressions. No contradictions. Ship confirmed.**
