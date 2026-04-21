# Handoff to Codex — 2026-04-12

## Session Summary

Hermes (overseer) conducted a full system audit on 2026-04-12. This document covers what was discovered, what was fixed, and what still needs work.

---

## CRITICAL: Agent Dispatch Is Broken

**The orchestrator cannot spawn agents.** This is the single most important finding.

### Root Cause
1. `ANTHROPIC_API_KEY` is missing from `~/.agenthive.env`
2. The orchestrator service (systemd) loads only `~/.agenthive.env`
3. `agent-spawner.ts` reads `process.env.ANTHROPIC_API_KEY` and passes it to child processes
4. Without the key, `claude --print` fails with "Not logged in"

### Fix Required
```bash
echo "ANTHROPIC_API_KEY=<your-key>" >> ~/.agenthive.env
systemctl --user restart hermes-orchestrator
```

### Secondary Issue
The orchestrator's `dispatchAgent()` calls `cubic_create` + `cubic_focus` — but these only write metadata to the DB. They do NOT spawn an actual agent process. The `agent-spawner.ts` module exists with full spawn logic but is never imported or called by the orchestrator or pipeline-cron.

After adding the API key, the orchestrator needs to be modified so that after `cubic_focus`, it calls `spawnAgent()` from `src/core/orchestration/agent-spawner.ts` to actually start Claude Code.

### Evidence
- 1,304 agent_runs in DB — ALL are `failed` status
- ZERO successful agent runs ever recorded
- Last run: 2026-04-11 19:45 (all failed)
- No claude processes running despite orchestrator logging "dispatched"

---

## What Was Fixed This Session

### 1. Issue Type → Standard RFC Workflow
- `issue` type changed from `Quick Fix` to `Standard RFC` workflow in `proposal_type_config`
- Rationale: issues are programmatic product problems that need proper code review lifecycle
- P201, P202 migrated from TRIAGE → Draft (TRIAGE not valid in RFC workflow)
- P167, P168, P169 migrated from FIX → Develop (FIX not valid in RFC workflow)

### 2. Hotfix Type Created
- New `hotfix` type added to `proposal_type_config`
- New `Hotfix` workflow template created with 7 transitions:
  - TRIAGE → FIXING (confirm, specialist claims)
  - TRIAGE → WONT_FIX (skip)
  - TRIAGE → NON_ISSUE (confirmed not a problem)
  - TRIAGE → ESCALATE (upgrade to issue)
  - FIXING → DONE (applied, verified)
  - FIXING → TRIAGE (re-triage)
  - FIXING → ESCALATE (beyond scope)
- Terminal states: DONE, WONT_FIX, NON_ISSUE
- No AC required, no gate evaluation

### 3. CLAUDE.md Updated
- Added proposal type table (5 types with workflows)
- Added Hotfix workflow documentation
- Added "Standard RFC Workflow" section header

### 4. Constants Updated
- `src/shared/constants/index.ts` — added FIXING, DONE, NON_ISSUE statuses
- Updated workflow comments (RFC now covers issue type too)
- Removed duplicate DEPLOYED entry

### 5. P210 Enhanced (Crash Recovery)
- Full design with 3 crash zones (process crash, lock orphans, stuck proposals)
- 13 acceptance criteria
- Motivation document with DB evidence
- Discussion note with analysis

### 6. P211 Filed (Transition Completion Bug)
- Filed as issue type, Draft status, high priority
- `markTransitionDone()` exists in pipeline-cron.ts line 454 but is NEVER CALLED
- 0 out of 1,090 transitions have EVER been marked 'done'
- 14 stuck in 'processing', 1,076 eventually marked 'failed'
- 6 acceptance criteria

### 7. Governance Proposals Tagged
- P170-P185 tagged with theory/pillar/layer associations
- Tag format: `theory:<name>`, `pillar:<name>`, `layer:<name>`
- Enables future theory-subscription protocol for agents

### 8. P211 Cubic Recycled
- Created and focused but agent never spawned (API key missing)
- Cubic recycled on shutdown

---

## System State at Shutdown

### Services
```
hermes-gate-pipeline  — active (running) since 13:00
hermes-orchestrator   — active (running) since 13:17
hermes-gateway        — active (running) since 13:00
```

### Pipeline State
```
transition_queue:
  processing: 14 (stuck since April 11, needs cleanup)
  failed:  1,076 (exhausted 3 attempts)
  done:      0 (NEVER — this is the P211 bug)

mature proposals: 74 (mostly already in terminal states)
agent_runs: 1,304 total, all failed
```

### Cubics
- 15 cubics total
- 8 locked (dispatched but no agents running)
- Most are stale from April 11/12 dispatch attempts

---

## Pending Work (Priority Order)

### P0: Fix Agent Dispatch (BLOCKS EVERYTHING)
- Add ANTHROPIC_API_KEY to ~/.agenthive.env
- Wire agent-spawner.ts into orchestrator's dispatchAgent() function
- Test: orchestrator should actually start claude --print after cubic_focus
- Verify agent_runs shows 'completed' status

### P1: Implement P211 (Transition Completion Bug)
- Clean up 14 stuck 'processing' transitions (SQL)
- Wire markTransitionDone() into processTransition() in pipeline-cron.ts
- Add stale transition auto-cleanup on pipeline startup
- Remove dead proposal_maturity_changed listener

### P2: Implement P210 (Crash Recovery)
- Graceful shutdown: release cubic locks, kill child processes, cleanup agent_runs
- Startup recovery: clear orphaned locks, mark stuck runs as failed
- dispatch_ledger table for crash forensics
- Discord notification on crash detection

### P3: Advance Governance Proposals (P178-P185)
- These are stuck in REVIEW — can't advance without working gate pipeline
- After P0+P1 fixed, gate pipeline can process them

### P4: Gate Pipeline Health (P190, P202)
- Anomaly detection for repeated failures
- Health monitoring for pipeline stall detection

---

## Key File Locations

```
Orchestrator:     scripts/orchestrator.ts
Agent Spawner:    src/core/orchestration/agent-spawner.ts
Pipeline Cron:    src/core/pipeline/pipeline-cron.ts
Cubic Tools:      src/apps/mcp-server/tools/cubic/index.ts
Constants:        src/shared/constants/index.ts
CLAUDE.md:        CLAUDE.md
Env File:         ~/.agenthive.env
```

## Key DB Tables

```
roadmap.proposal              — proposals
roadmap.transition_queue      — gate pipeline queue
roadmap.cubics                — cubic workspaces
roadmap.agent_runs            — agent execution records
roadmap.proposal_type_config  — type → workflow mapping
roadmap.proposal_valid_transitions — allowed state transitions
roadmap.workflow_templates    — workflow definitions
roadmap.gate_task_templates   — gate agent prompts
```

## MCP Server
```
URL: http://127.0.0.1:6421/sse
Key tools: prop_get, prop_list, prop_update, prop_set_maturity, 
           cubic_create, cubic_focus, cubic_list, cubic_recycle,
           list_ac, add_acceptance_criteria, create_note
```

---

## Final Type/Workflow Matrix

| Type | Workflow | Category | Description |
|------|----------|----------|-------------|
| product | Standard RFC | Design | Top-level product vision |
| component | Standard RFC | Design | Architectural pillar |
| feature | Standard RFC | Impl | Concrete capability |
| issue | Standard RFC | Impl | Product problem needing code fix |
| hotfix | Hotfix | Ops | Localized instance fix |

---

*Handoff prepared by Hermes (overseer) — 2026-04-12 20:45 EDT*
*All services running. MCP server at 127.0.0.1:6421.*
