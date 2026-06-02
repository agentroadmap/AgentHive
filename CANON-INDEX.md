# Canon Index: Learn-First Roadmap for Parallel Agents

**Purpose:** Dozens-to-hundreds of agents onboard in <5 minutes via learn-first canon. Single source per fact; pointers replace duplication.

**Token Budget:** ~17-21 KB per new agent start (vs. 104 KB full CONVENTIONS.md per agent = 80% savings at scale for 100+ agents).

---

## Core Docs (Read in This Order)

| Priority | Doc | Responsibility | Size | Read First? |
|---|---|---|---|---|
| **1** | **GIT.md** | Isolated worktrees, atomic commits, safety checks, merge protocol, self-merge anti-pattern, force-push, test hygiene, destructive-op verification, migration numbering, parallel-dispatch audit | 6–8 KB | **YES** before any `git` command |
| **1** | **CLAUDE.md** | Claude Code identity, MCP SSE URL, project root, co-agent acknowledgment | 2–3 KB | **YES** (Claude Code agents only) |
| **1** | **AGENTS.md** | Codex/Gemini/Hermes/George tool-specific quirks, pointer to GIT.md | 2–3 KB | **YES** (all non-Claude agents) |
| **2** | **MCP.md (excerpt)** | Proposal CRUD calls, schema-qualify rules, error patterns, roadmap API quick reference | 4–5 KB | **YES** before first `roadmap` call |
| **2** | **CONVENTIONS.md §1-2 (excerpt)** | Proposal state machine, maturity axis, workflow stages, file precedence | ~5 KB | **YES** after identity docs |
| **2** | **ORCHESTRATION.md (excerpt)** | How proposals move, dispatch mechanics, state transitions, orchestrator timing | 5–7 KB | NO (unless authoring workflow code) |
| **-** | **CONVENTIONS.md §3-9 (deep ref)** | Full DB schema, MCP handler details, triggers, control-plane architecture, escalation matrix | 50–60 KB | **LINK ONLY** (as-needed) |
| **-** | **CONVENTIONS.md §7 (retired)** | Replaced by GIT.md (2-line pointer) | (deleted) | NO (superseded) |

---

## Learn-First Sequence (New Agent, 5 Minutes)

1. **Load identity doc** (CLAUDE.md or AGENTS.md): Who am I? Where do I run? MCP URL? Project root?
2. **Load GIT.md STOP section + quick-reference tables**: 6 critical rules, copy-paste commands
3. **Load MCP.md excerpt**: Proposal CRUD calls, schema-qualify table names, common error patterns
4. **Load CONVENTIONS.md §1-2 excerpt**: Proposal vocabulary (state machine, maturity axis, workflow stages)
5. **Reference deep docs as-needed** (hyperlinks only): CONVENTIONS.md §3-9 for full context

---

## Per-Doc Single Responsibility (No Duplication)

### GIT.md (NEW — 6–8 KB)

**Owns:** Isolated worktrees, atomic commits, branch ownership, merge protocol, self-merge anti-pattern, force-push safety, live-DB test cleanup, destructive-op verification, migration numbering, parallel-dispatch audit, terminal reliability.

**Does NOT own:** Proposal lifecycle details (→ CONVENTIONS.md §1), full MCP API (→ CONVENTIONS.md §5.0), orchestrator mechanics (→ CONVENTIONS.md §6.0).

**When to read:** Before first `git` command.

**Pointers:** "For proposal vocabulary, see CONVENTIONS.md §1. For full MCP API, see CONVENTIONS.md §5.0. For orchestrator details, see CONVENTIONS.md §6.0."

---

### CLAUDE.md (EXISTING — 2–3 KB)

**Owns:** Claude Code identity, MCP SSE endpoint (http://127.0.0.1:6421/sse), worktree policy, project root (/data/code/AgentHive), co-agent acknowledgment.

**Must add footer:** "See GIT.md before your first `git` command. See MCP.md excerpt for roadmap API quick reference."

---

### AGENTS.md (EXISTING — 2–3 KB)

**Owns:** Codex, Gemini, Hermes, George tool-specific quirks, tool-specific notes, pointer to CONVENTIONS.md.

**Must add footer:** "See GIT.md before your first `git` command. See MCP.md excerpt for roadmap proposal CRUD quick reference."

---

### MCP.md (NEW EXCERPT — 4–5 KB fast reference)

**Owns (excerpt):** 
- Tool discovery (list all tools)
- Proposal CRUD (claim, release, transition, get, detail, list_ac, add_ac, verify_ac)
- Schema-qualify rules (roadmap.proposal, roadmap.proposal_acceptance_criteria, roadmap.proposal_lease, etc.)
- Common error patterns (proposal not found, lease not active, invalid AC status enum values, etc.)

**Points to deep reference:** "For full MCP handler documentation, edge cases, and schema details, see CONVENTIONS.md §5.0 MCP Schema & Tools."

**When to read:** Before first `roadmap` call.

---

### ORCHESTRATION.md (NEW EXCERPT — 5–7 KB fast reference)

**Owns (excerpt):**
- How proposals move through state machine (DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE)
- Dispatch mechanics (isolation:worktree guarantee, parallel spawn constraints, lease enforcement)
- When orchestrator runs (cron schedule, post-upgrade hooks, signal handling)
- Maturity advance rules (New → Active → Mature; gate decides Mature → next state transition)

**Points to deep reference:** "For full orchestrator implementation, DB triggers, failure modes, and signal specs, see CONVENTIONS.md §6.0 Orchestration & Workflow."

**When to read:** Only if building workflow code or debugging dispatch issues.

---

### CONVENTIONS.md §1–2 Excerpt (NEW — ~5 KB)

**Owns (excerpt):**
- Proposal state machine (diagram + semantics)
- Maturity axis (New, Active, Mature, Obsolete)
- Workflow stages (Architecture, Gating, Building, Integration, Stable)
- File precedence (DB is source of truth; markdown supplements only)

**Points to deep reference:** "For full context (DB topology, control-plane architecture, schema details, service restart procedures), see CONVENTIONS.md §3.0 onwards."

**When to read:** After identity docs, before opening first proposal.

---

### CONVENTIONS.md §3–9 (EXISTING DEEP REFERENCE — 50–60 KB)

**Owns:** Full DB schema, MCP handler details, validation rules, control-plane architecture, trigger specs, escalation matrix, service lifecycle, hotfix workflow.

**Excerpt pointers:** GIT.md, MCP.md, ORCHESTRATION.md all link here with section numbers (e.g., "CONVENTIONS.md §5.0").

**When to read:** Link as-needed; do NOT load into agent's session memory on start.

---

## Cross-Doc Reference Convention (Prevent Drift)

**In GIT.md:**
```markdown
For proposal vocabulary and state machine, see CONVENTIONS.md §1 (Proposal Lifecycle).
For full MCP API documentation, see CONVENTIONS.md §5.0 (MCP Schema & Tools).
For orchestrator details, see CONVENTIONS.md §6.0 (Orchestration & Workflow).
```

**In MCP.md excerpt:**
```markdown
For full MCP handler documentation, edge cases, and parameter details, see CONVENTIONS.md §5.0.
```

**In ORCHESTRATION.md excerpt:**
```markdown
For full orchestrator implementation, failure modes, trigger specs, and signal handling, see CONVENTIONS.md §6.0.
```

**In CONVENTIONS.md §1-2 excerpt:**
```markdown
For full context and deep reference (DB topology, control-plane architecture, file precedence, service lifecycle), see CONVENTIONS.md §3.0 onwards.
```

---

## Migration Path (Implement Before Publishing)

### Retire CONVENTIONS.md §7 (Git Section)

**Old (36 lines, generic):** Worktree best-practices, commit discipline, shared-history rules, conflict handling, safety warnings.

**New (2-line pointer, replaces §7):**
```markdown
## 7. Git Discipline for Multi-Agent Work

**See GIT.md for complete parallel-agent git workflow** (isolated worktrees, atomic commits, safety checks, merge protocol, self-merge anti-pattern, live-DB test hygiene, parallel-dispatch audit, migration numbering).

For project context and workflow stages, see CONVENTIONS.md §1–2 (Proposal Lifecycle and File Precedence).

For deep reference (DB schema, control-plane architecture, escalation matrix), see CONVENTIONS.md §3.0 onwards (link as-needed).
```

### Add Footers to Identity Docs

**CLAUDE.md footer (before "References" section):**
```markdown
## Getting Started: Git and MCP

Before your first work session, read in this order:
1. **GIT.md** (isolated worktrees, atomic commits, safety checks, merge protocol)
2. **MCP.md excerpt** (proposal CRUD, schema-qualify rules, error patterns)
3. **CONVENTIONS.md §1-2 excerpt** (proposal vocabulary, maturity axis, workflow stages)

For deep reference (DB schema, control-plane, escalation), see CONVENTIONS.md §3.0 onwards (link as-needed).
```

**AGENTS.md footer (before "References" section):**
```markdown
## Shared Learning Resources

All agents read in this order:
1. Your identity doc (this file) for tool-specific quirks
2. **GIT.md** before any `git` command (worktrees, atomic commits, safety checks)
3. **MCP.md excerpt** before first `roadmap` call (proposal CRUD, schema-qualify, errors)
4. **CONVENTIONS.md §1-2 excerpt** for proposal vocabulary (state machine, maturity, workflows)

For orchestrator/dispatch mechanics, see **ORCHESTRATION.md excerpt**. For deep reference, link to CONVENTIONS.md §3.0 onwards.
```

---

## Token-Efficiency Targets (Per-Agent Onboarding)

### Baseline Load (Every Agent Session Start)
- Identity doc (CLAUDE.md or AGENTS.md): 2–3 KB
- GIT.md STOP section + quick-reference tables: 2–3 KB
- MCP.md excerpt (claim/release/transition calls + errors): 1–2 KB
- CONVENTIONS.md §1-2 excerpt (vocabulary + state machine): ~5 KB
- **Total: 10–13 KB per agent session start**

### On-Demand Deep Reference (Hyperlinks Only)
- CONVENTIONS.md §3–9 (full reference): 50–60 KB (loaded only when agent clicks link or explicitly requests deep context)

### Scale Efficiency (100 Agents)
- Baseline start: 100 agents × 10–13 KB = ~1.3 MB (tractable)
- vs. loading full CONVENTIONS.md for each: 100 agents × 104 KB = 10.4 MB (wasteful)
- **Savings: 80% token reduction on onboarding** (critical at 100+ parallel agents)

---

## Validation Checklist (Before Publishing New Canon)

- [ ] GIT.md critical rules are copy-paste executable commands (never abstract theory)
- [ ] Every rule in GIT.md has incident number reference (why: <#N>)
- [ ] Cross-doc references use section numbers + URLs (e.g., "CONVENTIONS.md §6.0 Orchestration & Workflow")
- [ ] No rule duplicated across GIT.md, MCP.md, ORCHESTRATION.md, CONVENTIONS.md
- [ ] CONVENTIONS.md §7 replaced with 2-line pointer to GIT.md
- [ ] CLAUDE.md footer added (points to GIT.md + MCP.md)
- [ ] AGENTS.md footer added (points to GIT.md + MCP.md + CONVENTIONS)
- [ ] MCP.md excerpt max 4–5 KB (not full tool documentation)
- [ ] ORCHESTRATION.md excerpt max 5–7 KB (not full implementation)
- [ ] All new docs tagged with: version, status, max-size target, read-first priority
- [ ] Test fixture testId pattern (GIT.md §8) is copy-paste ready in TypeScript
- [ ] Parallel-dispatch audit pattern (GIT.md §7) is copy-paste ready in bash
- [ ] All bash commands in GIT.md tested against repo state 2026-06-01
- [ ] All cross-doc links verified (no circular references, all targets exist)
- [ ] No agent-facing doc >10 KB (except CONVENTIONS.md deep ref)

---

## Future Enhancements (Post-Launch, Tracked Separately)

- **MESSAGING.md (excerpt + deep):** Channel naming convergence, A2A bus semantics, valid message_types list, handler patterns, ACL canonical-vs-fully-qualified identity
- **ARCHITECTURE.md (excerpt + deep):** System topology, dependency graph, service roles (orchestrator, liaisons, workers), bootstrap order, proposal-to-worker matching
- **Codex-specific quirks (AGENTS.md):** Shared-root exception policy for distributed merge ops, CRC-fetch workaround, codex-one/codex-two persistent branches vs. feat/* lifecycle
- **Gemini-specific quirks (AGENTS.md):** Gemini-liaison session management, gemini-executor defaults, token budget constraints, model-selection policy
- **Hermes-specific quirks (AGENTS.md):** Hermes-monitor role, watchdog scope, escalation signal patterns, health-check intervals
- **George-specific quirks (AGENTS.md):** George-auditor baseline (static analysis + live probe), verification patterns, human-readable output expectations, report format

---

## Maintainer Notes

- **Update cadence:** Quarterly minimum. After major incidents (critical rules violations), publish GIT.md + docs updates same week.
- **Deprecation:** Retire CONVENTIONS.md §7 on publish date of GIT.md v1.0 (same commit preferred).
- **Audit trail:** Each doc version includes incident numbers resolved + date published.
- **Token budget regression:** If baseline load >13 KB, mark as regression; split further.
- **Link verification:** Tools should validate all cross-doc references (§N.0 pointers) on publish; broken links block release.
- **Agent feedback:** Agents encountering undocumented edge cases should file P<new> with evidence; docs updated next cycle.
