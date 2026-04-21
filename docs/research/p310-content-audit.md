# P310 Research: Content Audit of 5 Instruction Files

**Proposal:** P310 — Reconcile and deduplicate 5 instruction files
**Phase:** DRAFT / design
**Agent:** hermes-andy (researcher)
**Date:** 2026-04-20

## 1. File Inventory

| File | Lines | Last Changed | Scope |
|------|-------|-------------|-------|
| CONVENTIONS.md | 337 | 8761f3d | Canonical conventions — workflow, MCP, DB, Git, deployment |
| AGENTS.md | 82 | 5aeaaf4 | Codex agent instructions |
| CLAUDE.md | 74 | e5e35f4 | Claude Code agent instructions |
| agentGuide.md | 107 | a126a6f | Agent operational guide (overseer, governance, escalation) |
| .github/copilot-instructions.md | 65 | 5aeaaf4 | Copilot-specific v2 schema migration guide |
| **Total** | **665** | | |

## 2. Content Overlap Matrix

### 2.1 Proposal Types Table
- **AGENTS.md** lines 10-17: Full table (5 types)
- **CLAUDE.md** lines 10-17: Full table (5 types) — identical content
- **CONVENTIONS.md**: NOT present (references proposal workflow but no types table)

Verdict: Pure duplication. AGENTS.md and CLAUDE.md have byte-for-byte identical tables.

### 2.2 Standard RFC Workflow (States + Maturity)
- **AGENTS.md** lines 19-34: States table + Maturity table
- **CLAUDE.md** lines 19-34: States table + Maturity table — identical content
- **CONVENTIONS.md** line 128: One-liner "Draft -> Review -> Develop -> Merge -> Complete"

Verdict: Pure duplication between AGENTS.md and CLAUDE.md. CONVENTIONS.md has a minimal reference only.

### 2.3 Working Rules
- **AGENTS.md** lines 43-53: 7 rules (check proposal, use MCP, claim/lease, surgical changes, etc.)
- **CLAUDE.md** lines 47-51: 4 rules (leasing, RFC standard, issue reporting, cubic context)
- **CONVENTIONS.md** lines 57-67: 10 daily working rules (worktree, surgical, patterns, etc.)

Verdict: Three overlapping but non-identical versions. AGENTS.md and CONVENTIONS.md share some rules verbatim. CLAUDE.md has a unique "RFC Standard" phrasing. None is the superset.

### 2.4 Commit/Git Discipline
- **AGENTS.md** lines 55-60: Commit discipline section
- **CONVENTIONS.md** lines 250-284: Full Git and worktree best practices (much more detailed)

Verdict: AGENTS.md is a subset. CONVENTIONS.md is authoritative.

### 2.5 Technical Environment
- **CLAUDE.md** lines 68-74: Project root (CWD), Hermes worktree (CWD-based), MCP URL, systemd services, SCM policy
- **CONVENTIONS.md** lines 18-29: Operating reality table (DB, MCP, config, code paths)
- **copilot-instructions.md** lines 31-36: Architecture section (config, worktree root, MCP port, WS bridge, env)

Verdict: Three files describe overlapping but different environment details. CLAUDE.md uniquely lists systemd services. CONVENTIONS.md uniquely lists code paths. copilot-instructions.md uniquely mentions WS bridge on port 3001.

### 2.6 Lease & Claim Protocol
- **agentGuide.md** lines 55-63: Detailed lease protocol (claim, TTL, renewal, conflict handling)
- **CONVENTIONS.md** lines 108-112: Lease tools table (lease_acquire, lease_renew)
- **CLAUDE.md** line 48: One-liner "Claim/Lease a proposal before starting work"

Verdict: agentGuide.md has the most detail but references stale tool names (mcp_claim_proposal, mcp_renew_lease). CONVENTIONS.md has current tool names. CLAUDE.md is a pointer only.

### 2.7 Coding Principles
- **AGENTS.md** lines 38-41: Coding principles (think before coding, simplicity, surgical, goal-driven)
- **AGENTS.md** lines 43-53: Coding preferences (smallest change, existing patterns, push back, verify)
- Not in CLAUDE.md or CONVENTIONS.md

Verdict: Unique to AGENTS.md. Should be promoted to CONVENTIONS.md if shared.

## 3. Unique Content (Not Duplicated Anywhere)

### 3.1 agentGuide.md — Unique Sections

| Section | Lines | Content |
|---------|-------|---------|
| Overseer role (Hermes/Andy) | 0-28 | Role definition, responsibilities, what Hermes does NOT do, orchestrator relationship |
| Financial governance | 66-74 | Budget estimation, threshold monitoring, circuit breaker, efficiency |
| Anomaly & loop detection | 77-83 | Inertia loops, DAG loops, reporting |
| Escalation matrix | 86-96 | Table: issue type → primary/secondary escalation, "The Gary Rule" |
| Model-to-workflow mapping | 29-42 | Phase → model → cost tier table |

None of these appear in any other file. If agentGuide.md is retired, this content must be preserved.

### 3.2 CLAUDE.md — Unique Sections

| Section | Lines | Content |
|---------|-------|---------|
| Hotfix workflow | 36-46 | Triage → Fixing → Done, terminal states, escape to issue |
| Completed capabilities table | 53-66 | P050-P148 capability reference (date-stamped 2026-04-11) |

The hotfix workflow is not in any other file. The capabilities table is informational only.

### 3.3 copilot-instructions.md — Unique Content

| Section | Lines | Content |
|---------|-------|---------|
| v1→v2 breaking changes | 14-23 | Column renames, constraint changes, table count delta |
| 4 pillar modules | 24-28 | Product, Workforce, Efficiency, Utility |
| Key files to rewrite | 38-43 | 5 specific files for v2 migration |
| Important column changes | 45-51 | blocked_by_dependencies, IDENTITY, timestamptz, jsonb |
| DDL status | 52-54 | Schema is live, do NOT re-apply |
| Testing | 56-58 | 220 tests, 2 known failures |

This is a point-in-time migration guide. Most of the v2 migration is probably complete. The 2 known failures may be stale.

### 3.4 AGENTS.md — Unique Sections

| Section | Lines | Content |
|---------|-------|---------|
| Instruction files section | 25-28 | Which file is for which tool (AGENTS.md=Codex, CLAUDE.md=Claude, etc.) |
| Coding principles + preferences | 38-53 | Duplicated in spirit but not verbatim elsewhere |
| Commit discipline | 55-60 | Partially overlaps CONVENTIONS.md |
| Repo context | 62-65 | CWD-based worktree, MCP URL |

### 3.5 CONVENTIONS.md — Unique Content (Authoritative)

| Section | Lines | Content |
|---------|-------|---------|
| Start here reading list | 5-15 | Ordered list of files to read |
| Where things live | 40-55 | Full repo layout table |
| MCP tool lists | 84-112 | Core, RFC, lease tools with descriptions |
| Expected MCP flow | 114-125 | 5-step flow with maturity guidance |
| Database conventions | 131-248 | DDL, DML, proposal-gated changes, coordinated rollout, handoff pattern |
| Git and worktree | 250-284 | Branching, commits, shared-history, conflict handling, safety |
| Validation expectations | 286-297 | Code, DB, MCP verification standards |
| Quick checklist | 299-319 | Before-start and before-finish checklists |
| Default escalation rule | 321-337 | When to escalate, how to leave surface for next agent |

## 4. Contradictions and Stale Content

### 4.1 Worktree Path (CRITICAL)
- **agentGuide.md line 49:** `/data/code/worktree-{agent_name}` (hardcoded, wrong format with hyphen)
- **AGENTS.md line 62:** `CWD` (correct — relative)
- **CLAUDE.md line 69-70:** CWD-based (correct)
- **CONVENTIONS.md line 59:** `/data/code/worktree/<agent-name>` (hardcoded, correct format)

Verdict: agentGuide.md has wrong format (hyphen vs slash). AGENTS.md and CLAUDE.md use CWD which is the current convention. CONVENTIONS.md hardcodes the correct format. The CWD convention wins.

### 4.2 Lease Tool Names
- **agentGuide.md lines 58-61:** `mcp_claim_proposal`, `mcp_renew_lease` (stale names)
- **CONVENTIONS.md lines 110-111:** `lease_acquire`, `lease_renew` (current names)

Verdict: agentGuide.md is stale.

### 4.3 MCP Tool Lists
- **CONVENTIONS.md lines 84-104:** Comprehensive tool list with MCP router names
- **agentGuide.md:** References individual tool names that may not match current consolidated routers

Verdict: CONVENTIONS.md is authoritative.

### 4.4 Systemd Service Names
- **CLAUDE.md line 72:** `agenthive-gate-pipeline`, `agenthive-orchestrator`, `agenthive-mcp`, `agenthive-discord-bridge`
- **CONVENTIONS.md line 24:** `agenthive-mcp.service` only
- **agentGuide.md line 21:** `scripts/orchestrator.ts` (references script, not service name)

Verdict: CLAUDE.md has the most complete list. Others are partial or stale.

### 4.5 Maturity Descriptions
- **AGENTS.md lines 29-34:** Concise (New, Active, Mature, Obsolete)
- **CLAUDE.md lines 29-34:** Identical to AGENTS.md
- **agentGuide.md line 101:** "Universal Maturity Model: new (White), active (Yellow), mature (Green)" — adds color coding

Verdict: agentGuide.md adds color codes not used elsewhere. Probably stale convention.

### 4.6 Escalation Paths
- **agentGuide.md lines 89-96:** Formal escalation matrix (Technical → Architect Squad → Gary, Budget → Auditor → Gary, etc.)
- **CONVENTIONS.md lines 321-337:** Generic "escalate instead of improvising" with specific conditions

Verdict: Different approaches. agentGuide.md has a structured matrix. CONVENTIONS.md has situational guidance. Both are useful — should merge.

## 5. Content Dependency Graph

```
CONVENTIONS.md (337 lines) — THE canonical source
  |
  ├── absorbs from agentGuide.md:
  │     ├── Overseer role (Hermes/Andy responsibilities)
  │     ├── Financial governance / budget control
  │     ├── Anomaly & loop detection
  │     ├── Escalation matrix
  │     └── Model-to-workflow mapping
  |
  ├── absorbs from AGENTS.md + CLAUDE.md:
  │     ├── Proposal types table (single copy)
  │     ├── RFC workflow states (single copy)
  │     ├── Maturity definitions (single copy)
  │     └── Working rules (consolidated)
  |
  ├── AGENTS.md → thin shim (~30 lines)
  │     ├── Pointer to CONVENTIONS.md
  │     ├── Codex-specific config
  │     └── Coding principles (if not moved to CONVENTIONS)
  |
  ├── CLAUDE.md → thin shim (~40 lines)
  │     ├── Pointer to CONVENTIONS.md
  │     ├── Claude-specific memory (model constraints, host policy)
  │     ├── Hotfix workflow (unique, keep here or move to CONVENTIONS)
  │     └── Capabilities pointer
  |
  ├── agentGuide.md → RETIRED (pointer to CONVENTIONS.md)
  │
  └── copilot-instructions.md → moved to docs/reference/
        └── .github/copilot-instructions.md stays as thin redirect
```

## 6. Quantitative Summary

| Metric | Value |
|--------|-------|
| Total lines across 5 files | 665 |
| Lines that are pure duplication | ~80 (proposal types, RFC workflow, maturity = 15 lines × 2 copies + working rules overlap) |
| Lines that are near-duplicate (same meaning, different words) | ~40 (working rules, commit discipline) |
| Unique content in agentGuide.md (at risk if retired) | ~60 lines |
| Unique content in copilot-instructions.md | ~50 lines |
| Contradictions found | 6 (worktree path, tool names, MCP tools, services, maturity, escalation) |
| Stale references | 4 (worktree format, MCP tool names, color-coded maturity, v2 migration may be done) |

## 7. Recommendations for Implementation Order

1. **Add precedence section** to CONVENTIONS.md declaring it canonical
2. **Merge agentGuide.md unique content** into CONVENTIONS.md:
   - Overseer role → new section after "Start Here"
   - Financial governance → new section or reference to P060/P090 docs
   - Loop detection → merge into "Default Escalation Rule"
   - Escalation matrix → merge into "Default Escalation Rule"
   - Model-to-workflow mapping → new section or reference to routing docs
3. **Merge AGENTS.md/CLAUDE.md shared content** into CONVENTIONS.md:
   - Proposal types table → new section in CONVENTIONS.md
   - RFC workflow → expand existing one-liner to full table
   - Maturity → expand existing references to full definitions
   - Coding principles → new section in CONVENTIONS.md
4. **Fix worktree path convention** — use CWD everywhere, remove hardcoded paths
5. **Rewrite AGENTS.md** as thin shim (~30 lines)
6. **Rewrite CLAUDE.md** as thin shim (~40 lines), keep hotfix workflow
7. **Move copilot-instructions.md** to docs/reference/schema-migration-guide.md
8. **Update cross-references** — remove agentGuide.md from reading lists
9. **Retire agentGuide.md** — replace with pointer
10. **Verify** — grep for contradictions, ensure no stale tool names remain

## 8. Open Questions

1. **copilot-instructions.md staleness:** Is the v2 migration complete? If so, the file can be archived rather than moved. Check `proposal-storage-v2.ts` status.
2. **Hotfix workflow location:** Should it live in CONVENTIONS.md (making it canonical) or stay Claude-specific?
3. **Coding principles scope:** AGENTS.md has coding principles that don't appear elsewhere. Should they be promoted to CONVENTIONS.md (shared) or stay in AGENTS.md (Codex-specific)?
4. **Completed capabilities table in CLAUDE.md:** This is date-stamped. Should it be maintained or dropped (the data lives in MCP/DB)?
5. **Model-to-workflow mapping in agentGuide.md:** References premium models (claude-opus-4-6, o3). Is this mapping still valid given the current xiaomi/nous routing?
