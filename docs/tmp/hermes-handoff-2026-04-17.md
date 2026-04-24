# Handoff to Hermes — 2026-04-17

**From:** claude-opus (on `bot`, Gary's shared CLI/operator host)
**To:** hermes (a peer CLI, same kind of thing as Claude Code — just a different agent identity running a different model)
**Workspace:** `/data/code/AgentHive`, branch `main`, up to date.

Hermes — you're picking up the driver seat on this workspace. This note is what you need to know on day one so you don't repeat work, don't burn credit, and can prioritize cleanly.

---

## 1. You are a CLI. The model matters.

You run as a CLI just like I do. The difference is **which model answers your prompts**. Gary's intent:

- You (**hermes**) answer from `xiaomi/mimo-v2-pro` or `xiaomi/mimo-v2-omni`, which route via `nous` → Gary's Hermes account → **no Anthropic credit burned**.
- I (**claude-opus**) answer from Anthropic → burns Anthropic credit. I can still run on the shared `bot` host, but I must not resolve to Anthropic routes there unless the DB policy explicitly allows it.

Do **not** resolve model hints that route to `anthropic` while you're running on a non-Claude host. The platform will stop you if you try (see §2), but please don't try — escalations are noisy.

## 2. The P245 guardrail (just shipped — know it, don't fight it)

P245 is deployed and committed (`930ef9b` + hardening `c53a6b0`). Before any CLI subprocess spawns, `agent-spawner.ts` calls `roadmap.fn_check_spawn_policy(host, route_provider)`. If it returns FALSE:

- An `escalation_log` row is written with `obstacle_type='SPAWN_POLICY_VIOLATION'`, `severity='high'`, `escalated_to='orchestrator'`.
- `SpawnPolicyViolation` throws. The CLI never launches.

Current policy:

| host | allowed | forbidden | default model |
|---|---|---|---|
| `hermes` | nous, xiaomi | **anthropic** | `xiaomi/mimo-v2-omni` |
| `gary-main` | nous, xiaomi | **anthropic** | `xiaomi/mimo-v2-omni` |
| `bot` | shared operator host | route-specific by DB policy | `gpt-5.4` (default operator fallback) |
| `claude-box` | all | — | `claude-sonnet-4-6` |
| *unknown host* | anything **except anthropic** (safe default) | anthropic | — |

Host identity comes from `AGENTHIVE_HOST` env, falling back to `os.hostname()`. On the shared operator machine, set `AGENTHIVE_HOST=bot` explicitly so the policy lookup lands the shared-host row. The host is not a single-provider host; route selection still comes from the DB.

**Design note worth knowing:** the check is on the **resolved `route_provider`** from `resolveModelRoute()`, not the raw model string. So `claude-sonnet-4-6` (no slash) still gets flagged correctly. Don't "fix" this by going back to `split_part(model,'/',1)` — that was the bug in the original P245 body.

Files: `database/ddl/v4/002_host_spawn_policy.sql`, `database/ddl/v4/004_spawn_policy_default_deny_anthropic.sql`, `src/core/orchestration/agent-spawner.ts` (search `assertSpawnAllowed`), `docs/deployment/agenthive-orchestrator.service`.

## 3. Workspace posture

- **Worktree:** `/data/code/AgentHive` on `main`, clean.
- **MCP:** `http://127.0.0.1:6421/sse` — prefer `mcp__agenthive__*` over raw SQL.
- **DDL user:** `andy` (password in repo `.env.andy` or ask). The `claude` DB user is read/write DML only; it **cannot** run DDL on `roadmap*`. Any migration in `database/ddl/v4/` must be applied as `andy`.
- **Commit discipline:** commit each task as you finish it. Gary's rule is "specific file refs, no mega-commits." Treat "commit" as "push to main" — he's the workspace maintainer; your local main moves forward.

## 4. Priority queue — work top-down

The shortlist below is ordered by what will unblock the most downstream work first. All four drafts below were filed by me (claude-opus) in the last session and are waiting for an owner to claim/enhance/develop.

### P248 — Cubic Board View & State-Machine Visualization (feature, Draft)
**Why now:** Gary can't see cubic occupancy or gate backlogs without ad-hoc SQL. This is his current pain point.
**Scope:** design doc + ACs already in the proposal body. Read-only v1. New view `roadmap.v_cubic_board` + 2 API endpoints in `src/web/lib/board-api.ts` + 2 React components (`CubicBoard.tsx`, `StateMachineGraph.tsx` via React Flow). Migration stub: `database/ddl/v4/003_cubic_board_view.sql`.
**Depends on:** P058 (Cubic Orchestration), P240 (Implicit Maturity Gating) — both complete.
**Estimate:** 1 builder day.
**Design doc:** `docs/architecture/cubic-board-view.md`.

### P244 — Collapse transition_queue (issue, Draft)
**Why now:** P240 made `transition_queue` a second state machine that competes with `proposal.status`/`maturity`. Confusing and drifty. Kill it.
**Scope:** read `docs/architecture/implicit-maturity-gating.md` §"Role of transition_queue" first. Remove writers, keep the table as a diagnostic read-only during migration, replace consumers with a projection over proposal+lease+event.

### P247 — TUI board W/TAB keybind fix (issue, Draft)
**Why now:** board TUI is unusable for workflow/view switching right now. Low effort, high daily-friction win.
**Scope:** duplicate key registration in `src/apps/ui/board.ts` (check `view-switcher.ts` neighbor). Reproduce, dedupe, add a regression test under `src/test/board-keyboard-navigation.test.ts`.

### P246 — Per-million + cache cost columns (feature, Draft)
**Why now:** `model_routes.cost_per_1k_input/output` doesn't capture cache read/write pricing (crucial for prompt-caching math) or per-million-token billing norms. Analytics are therefore wrong for anthropic + xiaomi tiers.
**Scope:** DDL — add `cost_per_1m_input`, `cost_per_1m_output`, `cache_read_per_1m`, `cache_write_per_1m` (nullable), backfill known rows, wire spending calculators. Apply as `andy`.

### Also outstanding (already in-flight, don't re-file):
- **P237** (Proposal OS — orchestrator + gate agents) — Develop/new, large.
- **P228** (Cubic Runtime Abstraction — multi-CLI, host auth, A2A) — Develop/new. You **are** the multi-CLI reality this is designing for. Read it.
- **P227** (Mandatory review/test gates) — Develop/new.
- **P226** (Tiered LLM with frontier oversight) — Develop/new. Relevant to you because it formalizes when frontier (me) vs. mid-tier (you) should answer.
- **P238** (State Machine Dashboard) — Review/new. Overlaps with P248; talk to D2 before picking both up.

## 5. Things to avoid

- Don't apply DDL as `claude` — it will fail. Use `andy`.
- Don't bypass the spawn policy. If you hit `SpawnPolicyViolation`, that's a signal to rethink the model hint, not to patch the check.
- Don't edit `MEMORY.md` directly with memory content — it's an index. Put content in a separate `.md` in the same folder and link from the index.
- Don't mass-refactor. Keep commits surgical, tied to one proposal.
- Don't create doc files unless the task asks for them or the feature's ACs require them.
- Don't narrate internal deliberation in replies to Gary — state results, not process.

## 6. How to get started

1. Read `CLAUDE.md` and `AGENTS.md` at repo root (same content, different tool consumers).
2. Read `docs/architecture/implicit-maturity-gating.md` (P240 is the mental model).
3. `mcp__agenthive__prop_get P248` — confirm scope, then `prop_claim` if you want it.
4. Before coding, run the MCP proposal-execution guide: `get_proposal_execution_guide` — keeps you inside the workflow.
5. When you finish: `prop_set_maturity <id> mature` with a clear reason; leave gating to D1–D4.

Good hunting.

— claude-opus
