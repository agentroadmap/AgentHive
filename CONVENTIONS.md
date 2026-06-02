# AgentHive Conventions and Onboarding

This document is the **canonical, single source of truth** for all agent-facing conventions in AgentHive. If any other instruction file (AGENTS.md, CLAUDE.md, agentGuide.md, copilot-instructions.md) conflicts with this document, **this document wins**.

## 0. Precedence and Instruction File Map

| File | Role |
| :--- | :--- |
| **CONVENTIONS.md** (this file) | Canonical source. All shared rules: workflow, MCP, DB, Git, governance. |
| AGENTS.md | Thin shim for Codex/similar tools. Points here for details. |
| CLAUDE.md | Thin shim for Claude Code. Claude-specific memory + pointer here. |
| agentGuide.md | Retired. Content merged into this file. Pointer only. |
| .github/copilot-instructions.md | Redirect to `docs/reference/schema-migration-guide.md`. |

If you are reading AGENTS.md, CLAUDE.md, or agentGuide.md, follow their pointer to this file for the full context.

## 1. Start Here

Read these files first, in order:

1. `README.md` - project vision and the current proposal lifecycle.
2. This file (CONVENTIONS.md) — the canonical source for all conventions.
3. `roadmap.yaml` - active runtime configuration, especially the Postgres provider and `roadmap` schema.
4. `docs/pillars/1-proposal/new-data-model-guide.md` - current v2 data model rules.
5. `database/ddl/` and `database/dml/` - canonical schema and initialization artifacts.
6. `docs/governance/agent-onboarding.md` — who you are, the constitution, proposal workflow, skeptic protocol, rights, and obligations.

Note: `agentGuide.md` has been retired; its content (overseer role, governance, escalation) now lives in sections 10-16.

If your task touches the proposal workflow, also read `docs/pillars/1-proposal/data-model-change.md`.

## 2. File Precedence and Current Operating Reality

### File Precedence

See §0 above for the full instruction file map and precedence rules. **CONVENTIONS.md is always canonical.**

### Current Operating Reality

AgentHive is not a greenfield repo. Work against the system that exists today.

| Surface | Current convention |
| --- | --- |
| Runtime database | PostgreSQL. **Two-tier topology** (target): `hiveCentral` for control plane, one DB per project tenant (`agenthive`, `monkeyKing-audio`, `georgia-singer`, …). Today still single-DB `agenthive`; see §6.0. |
| MCP service | `agenthive-mcp.service` on `127.0.0.1:6421` |
| Runtime config | `roadmap.yaml` |
| Main proposal storage code | `src/infra/postgres/proposal-storage-v2.ts` |
| MCP proposal tools | `src/apps/mcp-server/tools/proposals/` |
| MCP RFC workflow tools | `src/apps/mcp-server/tools/rfc/` |
| Core roadmap query layer | `src/core/roadmap.ts` |

Important live facts:

- The database contains both `public.*` and `roadmap.*` tables for some objects. **Always schema-qualify SQL with `roadmap.`**. Do not rely on `search_path`.
- The live proposal model is in a **phased migration**. `roadmap.proposal` currently keeps both:
  - legacy `maturity` JSONB
  - new `maturity_state` TEXT
- Do not drop compatibility columns or old views unless your task explicitly completes the runtime migration and verifies every dependent code path.
- Live data may still contain legacy-cased stage values such as `REVIEW` and `DEVELOP`. Avoid brittle case-sensitive assumptions in SQL and code.

**Process supervision topology (P1095 → P1132, mid-cutover):** MCP, orchestrator, state-feed, board, and agency liaisons are independent systemd units — peers, not parent/child; stopping the orchestrator does not stop MCP or liaisons. `agenthive-mcp.service` (`Restart=always`, `RestartSec=3`) owns the listener on `127.0.0.1:6421`; liveness check: `curl -fsS http://127.0.0.1:6421/health`.

Agency liaisons have **two coexisting topologies** while the P1132 cutover completes — do not assume one:
- **Canonical (P1132):** one per-host `agenthive-a2a-host.service` discovers all local agencies via `agent_registry.host_affinity` and holds their LISTEN sessions in-process. This is the only model with multi-tenant economics and is the target.
- **Legacy (P1095):** per-agency `agenthive-agency@<id>.service` (`Restart=on-failure`, `RestartSec=15`, `Requires=agenthive-mcp.service`). `doctor.ts` flags running instances as legacy. **Still the live path** as of 2026-05-31 because a2a-host's cutover is incomplete (it excludes registered agencies and fails `bootLiaison: not registered` — see the V3 cutover tracker). Do NOT disable per-agency units until a2a-host is verified to boot a registered agency.

Dispatchability is **heartbeat-derived** (`roadmap.v_agency_status.dispatchable` = active AND `last_heartbeat_at` < 60s; migration 186/P1104). `presence_state` and PG-listener existence are diagnostics only (`has_live_listener`), never sufficient — they go stale because the authoritative presence writer (a2a-host session lifecycle) lands with self-claim in P1438/C6. Full topology and failure-mode table: `docs/architecture/mcp-liaison-topology.md`; runbook `docs/operations/service-topology-runbook.md`; a2a-host troubleshooting `docs/operations/troubleshooting/a2a-host.md`.

**Pool lifecycle invariant (P1123):** long-running services that use the shared Postgres singleton MUST call `setPoolLifecycleMode("long-running")` at startup. In long-running mode, accidental `getPool().end()` calls are ignored with an error-level stack trace; real shutdown must use `closePool()`, which bypasses the sentinel intentionally. If a service reports `pool_poisoned` on `control_feed` / `agent_lifecycle_events` or `Cannot use a pool after calling end`, follow `docs/operations/board-stale.md`.

### Workflow Vocabulary (quick reference)

> Vocabulary canonicalized by P706. The table below is the authoritative quick-reference; §5 has full definitions, maturity semantics, MCP tools, and the Architecture RFC variant.

All work moves through a typed state machine. Proposal type determines the workflow; workflow determines the allowed stages; maturity applies inside every stage.

| Attribute | RFC workflow | Hotfix workflow | Source |
| :--- | :--- | :--- | :--- |
| **Stages** | DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE | TRIAGE → DEPLOY → CLOSED | `roadmap.workflow_stages` |
| **Proposal types** | product, component, architecture, feature, issue | hotfix | `roadmap.proposal_type_config` |
| **Maturity axis** | new → active → mature (→ obsolete) | same | `roadmap_proposal.proposal.maturity_state` |
| **Terminal stage** | COMPLETE | CLOSED (also WONT_FIX, NON_ISSUE) | `roadmap.workflow_stages.is_terminal` |
| **Obsolete reason** | `obsoleted_reason TEXT` — free-text, always populate when setting maturity to `obsolete` | same | `roadmap_proposal.proposal.obsoleted_reason` |

Key rules:
- **No code path may hardcode a list of workflow stages.** Boards, dispatch code, and UI must load stages from `roadmap.workflow_stages` at runtime. See §5 for the full workflow reference.
- **Boards are workflow-aware.** Board columns derive from `roadmap.workflow_stages` for the active workflow. A workflow filter is always required. No static column list may be hardcoded.
- **Code Review Pipeline is outside the stage model.** Git PR review, static analysis, and automated test pipelines are implementation tooling — they are not workflow stages and must not appear in `roadmap.workflow_stages`.

> **Legacy note:** Older data may reference FIX, DEPLOYED, ESCALATE, REJECTED, DISCARDED, REPLACED from pre-P774 hotfix vocabulary. These are migration artifacts; do not introduce them in new code.

See §5 for the full workflow reference, maturity-level semantics, architecture RFC variant, and MCP tool list.

## 3. Where Things Live

### Tracked vs untracked, at a glance

**TRACKED — every commit is reviewed; do not litter:**

| Area | Purpose | What belongs here |
| --- | --- | --- |
| `src/core/` | proposal logic, workflow logic, roadmap query layer | TypeScript modules that are imported by other modules |
| `src/infra/` | Postgres pool, storage adapters, DB-facing helpers | infrastructure adapters; nothing domain-specific |
| `src/apps/mcp-server/` | MCP server, tool registration, handlers | MCP tool wrappers and the SSE/HTTP server |
| `src/apps/cli.ts`, `src/apps/agenthive-cli.ts` | CLI entrypoints | CLI command wiring; thin |
| `src/apps/dashboard-web/`, `src/apps/ui/` | board/web UI | TUI/web view components |
| `src/shared/` | shared types, constants, utilities | code imported from both core and apps |
| `database/ddl/` | schema DDL and numbered rollout SQL | schema-qualified, idempotent, numbered files |
| `database/dml/` | initialization data and seed-like artifacts | reference data, seeds |
| `database/migrations/` | newer numbered migrations | one logical migration per file |
| `docs/architecture/` | canonical architecture documents | durable design docs that survive multiple proposals (e.g., [`mcp-liaison-topology.md`](docs/architecture/mcp-liaison-topology.md) — P1095) |
| `docs/governance/` | constitution, decisions log, agent onboarding | durable governance |
| `docs/pillars/` | pillar/proposal architecture docs | per-pillar canonical docs |
| `docs/reference/` | reference material (schema migration, glossary, etc.) | durable reference |
| `docs/glossary.md` | shared vocabulary | one file; update in place |
| `scripts/` | runtime, board, systemd, helper scripts | committed scripts that other code depends on |
| `tests/` | automated tests | test code only |

**UNTRACKED — write here freely; do not commit:**

| Area | Purpose |
| --- | --- |
| `tmp/<session>/` | per-session scratch (logs, dumps, intermediate notes); auto-reaped |
| `tmp/` (root, no subdir) | one-off scratch; falls under same auto-reap rule |
| `<sibling-worktree>/` | per-agent git worktree resolved from CWD; is your sandbox |

`.gitignore` enforces these. If a tool wants to commit something under `tmp/`, that means the artifact is not actually scratch and should be moved into a tracked location with a real home.

## 4. Daily Working Rules

- Use a dedicated Git worktree for your task, typically under a sibling worktree directory resolved from CWD.
- Keep changes surgical. Do not opportunistically refactor unrelated code while fixing something else.
- Prefer existing patterns and helpers over inventing parallel abstractions.
- Keep TypeScript and SQL changes aligned. If schema changes, check the storage layer, MCP handlers, CLI, and views that consume it.
- If you notice an improvement, consolidation opportunity, concept unification, or a current or potential issue, create or update a proposal instead of leaving it as chat-only context.
- Never commit credentials, copied env files, or secrets from `.env`, `/etc/agenthive/env`, or local shell history.
- Do not claim a deployment, migration, or verification step that you did not actually perform.
- Gate cubic agents MUST call `prop_transition` (records gate_decision_log + flips status) and `set_maturity` after a verdict. The P611 reconciler is the safety net — omitting these is a protocol violation, not an acceptable shortcut.

### Pool lifecycle invariant (P1123)

Every long-running service (orchestrator, board, MCP server, notification-router, per-agency liaison) MUST call `setPoolLifecycleMode("long-running")` from `src/infra/postgres/pool.ts` at startup, **before any database access**. The default mode is `"one-shot"` for CLI subcommands and tests, which preserves the existing fast-exit behavior — `closePool()` and `pool.end()` on signature change both fire normally.

In `"long-running"` mode:
- `closePool()` is a no-op, logs the caller stack at warn.
- `getPool()` with a changed signature keeps the existing pool, logs the caller stack at warn.

Graceful shutdown handlers drop back to `"one-shot"` immediately before the final `closePool()` so the pool actually closes:

```ts
setPoolLifecycleMode("one-shot");
await closePool();
```

Why this rule exists: shared CLI code (e.g., `agents send` subcommand exit, internal getPool signature-change path) can call `pool.end()` mid-process. In CLI mode that's fine — the process exits. In a long-running service it poisons every downstream consumer (broadcastSnapshot, LISTEN reconnect, TimeoutCron, ledger writes) for the remainder of the process. The 2026-05-15 agenthive-board.service outage (30 hours silent failure) is the canonical incident. See `docs/audit/p1123-pool-end-callers.md` for the full caller catalog and verdict matrix. A Phase 3 watchdog (`SELECT 1` probe + `pg_notify control_feed pool_poisoned`) provides defense in depth for any bypass path.

## 4a. Folder Discipline (mandatory for every cubic agent)

AgentHive is shared infrastructure. Multiple agencies, projects, and providers share this repo. Every file you write is a vote on what belongs in the repo forever. Be ruthless about where things go.

### What goes where — a decision tree

When you are about to write a file, ask in this order:

1. **Is it code another module imports?** → `src/...` in the right subtree. Never under `docs/`, never under `scripts/`, never under `tmp/`.
2. **Is it canonical, durable design or governance?** (multi-month relevance, multiple agents will read it) → `docs/architecture/`, `docs/governance/`, `docs/reference/`, or a pillar folder. Pair with a tracked MCP proposal that owns the lifecycle.
3. **Is it about a specific proposal?** → it goes in MCP, not in a markdown file. Use `prop_update`, `add_acceptance_criteria`, `add_discussion`, or `submit_review`. Markdown design notes paired with an MCP proposal live under `docs/architecture/<topic>/<slug>.md` (no `Pxxx-` prefix in the filename) and reference the MCP `display_id` in their frontmatter.
4. **Is it a one-off output you need during this session?** (a SQL dump, a log capture, a parser experiment, a temporary report) → `tmp/<your-session-id>/`. Never `docs/tmp/`. Never repo root. Never `docs/` at all.
5. **Is it a "ship verification" or "gate decision" or "handoff" note?** → these are MCP-tracked artifacts. Use `add_discussion` on the proposal with a `context_prefix` like `ship-verification:` or `gate-decision:` or `handoff:`. Do not create `docs/ship-reports/`, `docs/handoff/`, `docs/tmp/gate-decisions-*.md` files. Those folders are deprecated.
6. **Is it a research note or RFC draft you want to keep?** → it should be either an MCP proposal (`prop_create` with `type=feature` or `component`, status `DRAFT`) or a durable doc under `docs/research/<topic>.md` linked from a proposal. If it would not survive a code review, it does not belong in `docs/`.

### Hard rules

- **Never write to `docs/tmp/`.** That folder is being retired (P452). Use `tmp/<session>/` instead.
- **Never write to `docs/ship/`, `docs/ships/`, `docs/shipping/`, `docs/ship-reports/`.** Ship verifications go into MCP via `add_discussion` with `context_prefix=ship-verification:`.
- **Never write to repo root** outside the existing top-level files. New top-level files require a proposal.
- **Never create `docs/handoff/<date>.md` files.** Handoffs go into MCP discussions on the proposal you are handing off, plus optional team-memory or ZK notes.
- **Never create `docs/<Pxxx>-<anything>.md`.** The MCP record at `roadmap_proposal.proposal` row Pxxx is canonical. Design notes paired with a proposal live under `docs/architecture/<topic>/<slug>.md` with the assigned MCP ID in frontmatter — not in the filename.
- **Never copy `docs/proposals/` from before 2026-04-25.** Those legacy stubs collided with live MCP IDs and have been moved to `docs/architecture/control-plane/` with stripped prefixes. Don't recreate the pattern.
- **Do not commit anything under `tmp/`.** The folder is gitignored and reaped on a schedule. If a file under `tmp/` is worth keeping, find it a real home in a tracked folder under a real proposal.

### When you write a markdown file under `docs/`

It must have:

1. A clear topic-driven filename (no `Pxxx-` prefix, no date stamp, no agent name). Slug-style: `multi-project-rollout-plan.md`.
2. A short frontmatter block at the top:
   ```markdown
   > **Type:** design note | governance | reference  
   > **MCP-tracked:** P### (or N/A if cross-cutting)  
   > **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P### (or "this file" for cross-cutting governance)
   ```
3. A clear first paragraph stating what problem this doc solves and who reads it.
4. No personal session context, no `# 2026-04-25 hermes-andy figured out…`, no narrative about how the doc came to exist. Future readers don't care.

### When in doubt

Ask via MCP `msg_send` to a senior agent or to the orchestrator before creating a new top-level folder, a new `docs/` subdirectory, or a new file under `docs/` whose topic is not already represented. The bar is high because every new tracked file is permanent.

## 5. Proposal and RFC Workflow Through MCP

AgentHive work is proposal-driven. Participate through MCP, not through chat-only side channels.

### Precedence
- Proposal type decides the workflow.
- Workflow decides the allowed states.
- Maturity applies inside every state.

### Proposal Types

| Type | Category | Workflow | Description |
| :--- | :--- | :--- | :--- |
| **product** | Type A (Design) | Standard RFC | Top-level product vision, pillars, constraints |
| **component** | Type A (Design) | Standard RFC | Major subsystem or architectural pillar |
| **architecture** | Type A (Design) | Architecture RFC | Durable design artifact, theory, business architecture, tradeoff analysis — no code deliverable |
| **feature** | Type B (Impl) | Standard RFC | Concrete capability to build |
| **issue** | Type B (Impl) | Standard RFC | Problem in the product requiring code changes |
| **hotfix** | Type C (Ops) | Hotfix | Localized operational fix to running instance |

See `docs/architecture/architecture-proposal-type.md` for full guidance on when to use `architecture` vs. other types, advisory mechanics, migration rules, and child proposal spawning.

### Workflow States (P706 unified vocabulary)

P706 is the vocabulary authority for workflow stages. This section documents the unified 8-stage RFC vocabulary and 3-stage Hotfix vocabulary that boards, MCP surfaces, and agent-facing docs are expected to use. Treat older labels as migration artifacts only. See P706 for the design authority behind this vocabulary split.

### Standard RFC Workflow (product, component, feature, issue)

The RFC workflow is the 8-stage path:

`DRAFT -> REVIEW -> DEVELOP -> CODE_REVIEW -> TEST_WRITING -> TEST_EXECUTION -> MERGE -> COMPLETE`

| State | Phase | Description |
| :--- | :--- | :--- |
| **DRAFT** | Formation | Initial proposal drafting, framing, and splitting if scope is still too broad. |
| **REVIEW** | Gate | Feasibility, coherence, dependency, and architecture review before implementation starts. |
| **DEVELOP** | Build | Main implementation work. |
| **CODE_REVIEW** | Review | Peer review of the implementation delta. |
| **TEST_WRITING** | Verify Prep | Add or update the acceptance tests and verification artifacts required for the change. |
| **TEST_EXECUTION** | Verify | Run the acceptance checks and confirm the proposal is ready to integrate. |
| **MERGE** | Integrate | Merge readiness, compatibility, rollout checks, and main-branch integration. |
| **COMPLETE** | Terminal | Integrated and closed as the current shipped baseline. |

### Hotfix Workflow (hotfix)

The hotfix workflow uses the lightweight 3-stage path, drawn from `roadmap.workflow_stages`:

`DRAFT -> DEVELOP -> COMPLETE`

| State | Phase | Description |
| :--- | :--- | :--- |
| **DRAFT** | Confirm | Confirm the defect, constrain scope, and decide that this remains a localized hotfix. |
| **DEVELOP** | Apply | Implement and verify the operational fix. |
| **COMPLETE** | Terminal | Fix applied, verified, and closed. |

### Unified Vocabulary Table

Both workflows share the same maturity axis and are stored in `roadmap.workflow_stages`. No code path may hardcode a list of workflow stages — always load from the stage registry (`src/core/workflow/stage-registry.ts`).

| Attribute | RFC value | Hotfix value | Source |
| :--- | :--- | :--- | :--- |
| Status values | DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE | DRAFT, DEVELOP, COMPLETE | `roadmap.workflow_stages` |
| Maturity values | new, active, mature, obsolete | same | `roadmap_proposal.proposal.maturity` |
| Terminal closure | COMPLETE with terminal-stage semantics from the active workflow | COMPLETE with terminal-stage semantics from the active workflow | `roadmap.workflow_stages` |
| Obsolete reason | `obsoleted_reason TEXT` free-text | same | `roadmap_proposal.proposal.obsoleted_reason` |

### Boards Are Workflow-Aware

Boards render columns from `roadmap.workflow_stages` for the active workflow and ordered stage definitions in that table. A Workflow filter is required on every board surface and must be resolved before columns are rendered. No code path may hardcode a list of stage columns or infer them from proposal type without first resolving the active workflow.

### Terminal Closure

Closing a proposal as terminal and closing a proposal as obsolete are different actions:

- Terminal closure follows the active workflow and lands on its terminal stage, typically `COMPLETE`.
- Obsolete closure uses `maturity='obsolete'`.
- `obsoleted_reason` is free-text and must explain why the proposal became obsolete; it is not an enum and must not be treated as one in code or UI.

`obsoleted_reason` must be populated whenever `maturity` is set to `obsolete`. Obsolete is not a terminal stage — it can apply in any state — but obsolete proposals are not dispatched and are filtered from active boards.

### Out Of Scope

`Code Review Pipeline` is a separate workflow family and is out of scope for this vocabulary section. Do not use it to infer RFC or Hotfix stage names.

### Architecture RFC Workflow (architecture)

| State | Phase | Description |
| :--- | :--- | :--- |
| **Draft** | Formation | Theory formation, business architecture, product structure, alternative analysis, and synthesis of prior discussions. |
| **Review** | Gating | Coherence, strategic fit, terminology alignment, dependency impact, advisory coverage, and spawn/split evaluation. Includes an advisory function: advisors post critique and recommendations, but the gate decision remains singular and auditable. |
| **Complete** | Baseline | Architecture decision accepted as the current design baseline. |

**No `Develop` or `Merge` states.** Implementation work identified during Review must be broken out into child `feature` or `issue` proposals.
**Advisory:** Advisors inform the gate decision; they do not create a separate workflow state, queue, or lease.
**AC type:** Design-review criteria (clarity, scope, product direction fit, dependency impact, glossary alignment, advisory coverage, downstream spawning) — not code-verifiable implementation tests.

### Maturity Levels

| Maturity | Description |
| :--- | :--- |
| **new** | Just entered the state. Waiting for an agent to claim or lease it, or for dependencies to clear. Every workflow state entry resets maturity to `new`, including entry into `COMPLETE`. |
| **active** | Under lease and being worked on with fast iteration. |
| **mature** | Work in this state is complete enough to request a gate decision to advance. In RFC, `mature` on `DRAFT/REVIEW/DEVELOP/MERGE` is the gate-ready signal; `COMPLETE/mature` is terminal metadata and does not queue another gate advance. |
| **obsolete** | No longer relevant because the structure or direction has changed. Set `obsoleted_reason` to explain why. |

### Proposal-first rule of thumb

AgentHive is self-evolving. When you identify any of the following, the default action is to create a proposal or add the concern to an existing proposal:

- an improvement idea
- consolidation of duplicate logic or structure
- unifying terminology, workflow, schema, or concepts
- a current defect or architectural mismatch
- a likely future issue, migration risk, or scaling concern

Do not wait for a human to ask twice if the need is clear. The proposal system, team workflow, and pipeline exist so the platform can evolve intentionally rather than through scattered ad-hoc edits.

### Core proposal tools

| Tool | Use |
| --- | --- |
| `prop_list` | list proposals by status or type |
| `prop_get` | load the full current proposal |
| `prop_create` | create a new proposal; **type is required** |
| `prop_update` | update proposal content |
| `prop_set_maturity` | set `new`, `active`, `mature`, or `obsolete` |
| `prop_transition` | move between workflow stages |

### RFC workflow tools

| Tool | Use |
| --- | --- |
| `get_valid_transitions` | inspect allowed transitions |
| `transition_proposal` | RFC-state transition surface |
| `add_acceptance_criteria`, `list_ac`, `verify_ac` | manage and verify AC |
| `add_dependency`, `get_dependencies` | manage proposal DAG edges |
| `submit_review`, `list_reviews` | review workflow |
| `add_discussion` | durable threaded discussion on a proposal |

### Lease and collaboration tools

| Tool | Use |
| --- | --- |
| `lease_acquire` | claim work before long-running execution |
| `lease_renew` | renew an active lease |
| `msg_send`, `msg_read`, `chan_list` | inter-agent coordination |

### Expected MCP flow

1. Discover or load the proposal with `prop_list` or `prop_get`.
2. Acquire a lease before doing substantial work.
3. Keep maturity truthful:
   - `new` = waiting or freshly entered state
   - `active` = being worked
   - `mature` = ready for a gate or decision
   - `obsolete` = no longer relevant
4. Use `prop_transition` only when the proposal is actually ready to move stages.
5. Put AC, dependency, review, and discussion updates into MCP so they survive handoff.

Notes:

- The default lifecycle is workflow-defined. Resolve the active workflow and read its ordered stages from `roadmap.workflow_stages` instead of assuming a fixed five-stage path.
- Proposal type determines workflow selection. Do not invent ad-hoc types. Check existing usage or `roadmap.proposal_type_config` before creating new proposals.

### 5a-release. Lease release — reason taxonomy and lock ordering

**P934: releasing a lease is a lifecycle decision, not cleanup.** Choose the reason that describes the work outcome — the trigger `fn_lease_clear_maturity_on_release` uses it to set proposal `maturity` deterministically. Wrong reasons silently corrupt the pipeline queue; the trigger now raises on unknown values.

| Bucket | Canonical reasons | Resulting maturity |
|---|---|---|
| **work_complete** | `work_delivered`, `gate_review_complete`, `authored_complete` | `mature` |
| **abandoned** | `wont_pursue`, `superseded`, `out_of_scope` | `obsolete` |
| **incomplete** | `gate_hold`, `gate_reject`, `lease_expired`, `manual_release`, `released_unfinished`, `reassigned`, `force_reclaimed`, `operator_cancelled`, `operator_terminated`, `gate_dispatch_blocked`, `gate_spawn_failed`, `work_failed` | `new` |
| **internal** (trigger-only) | `gate_transitioned` | `new` |

Rules:
- **`manual_release`** and **`released_unfinished`** return the proposal to `new` (re-queues it). Use `authored_complete` or `gate_review_complete` to preserve `mature` when the work is genuinely done.
- The `release_reason` column is capped at 128 characters. Never write stderr, stack traces, or prose — use a `proposal_event` row with `event_type='spawn_diagnostic'` for long diagnostics.
- Source of truth for the enum: `src/core/proposal/release-reasons.ts`. All callers must pass a reason from `CALLER_RELEASE_REASONS`.

**Lock acquisition order (P934 AC-15):** The trigger `fn_lease_clear_maturity_on_release` fires on `UPDATE proposal_lease` and immediately does `UPDATE proposal`. Any code that takes both row locks must acquire them in **proposal-first order** (lock the proposal row before touching proposal_lease) to avoid deadlocks with the trigger path. Transition handlers naturally start from the proposal, so this order is usually free. If you write a helper that starts from proposal_lease (e.g., a batch reaper), take a `SELECT … FOR UPDATE` on the proposal row first.

### 5a. Architectural Umbrella Pattern

Use this pattern for proposals that span multiple implementation phases (architecture, migrations, multi-system changes).

**Lifecycle:**

| State | Meaning |
|---|---|
| **DRAFT** | Architecture being designed; ACs not yet settled |
| **REVIEW** | Design locked; gate agents validate coherence + feasibility |
| **DEVELOP** | Active coordination: file child proposals, track their progress |
| **MERGE** | All children COMPLETE; run e2e integration test across all phases |
| **COMPLETE** | Integration verified; architecture fully shipped |

**Rules:**
1. File the architectural proposal with type `feature` (or `component` for subsystem work). Its ACs define the child breakdown and the MERGE test scope.
2. During DEVELOP: file each child as a separate proposal with `parent_id` set to the architectural proposal. Children are normal feature proposals — they move through DRAFT→REVIEW→DEVELOP→MERGE→COMPLETE independently.
3. Wire sequential dependencies via `add_dependency` where a phase requires a prior phase to be COMPLETE.
4. The architectural proposal stays in DEVELOP until all children are COMPLETE.
5. MERGE phase = run the e2e integration test defined in the MERGE ACs. This verifies the assembled system behaves as the architecture intended — not just that all PRs landed.
6. Do not advance to MERGE until every child is COMPLETE.

**Standard AC structure (required for all architectural proposals):**

```
DEVELOP phase:
- [ ] File child proposal: Phase A — <title> (parent_id: this)
- [ ] File child proposal: Phase B — <title> (parent_id: this, depends_on: Phase A)
- [ ] ... (enumerate all phases)
- [ ] All child proposals reach COMPLETE

MERGE phase:
- [ ] E2E integration test: <specific test scope covering all phases>
- [ ] No regressions in <critical paths>
```

**Why this pattern:** keeps the architectural proposal alive as an active coordination anchor through implementation, surfaces design corrections as children reveal edge cases, and ensures MERGE is a meaningful system-level gate rather than a formality.

### 5b. Program Phases and Build-Order Gate (P471)

The multi-tenancy program is sequenced into four phases tracked in `roadmap.program_phases`
(migration 060-program-phases-p471.sql). Phase assignments are stored in `roadmap.proposal.phase_id`.

| Phase | Name | Proposals | Exit Gate |
| :--- | :--- | :--- | :--- |
| **0** | MCP Integrity | P456-P462, P470 | Scanner endpoints+workflow-states findings in `src/` < 5 |
| **1** | Foundation Modules | P416, P448, P449, P453 | Scanner paths/identity/endpoints/workflow-states → 0 findings |
| **2** | Control Plane & Dispatch | P429 family (P495–P520), P430–P452, P471 | Total scanner findings < 50; race tests green; hiveControl online |
| **3** | Agency Liaison | P454, P463–P469, P472–P476 | Multi-agency dispatch race-test green |

#### Querying build order

```sql
-- All incomplete proposals in a phase, dependency-sorted
SELECT p.display_id, p.title, p.status, p.maturity
FROM roadmap.proposal p
WHERE p.phase_id = <N>
  AND p.status <> 'COMPLETE'
ORDER BY p.id;

-- Phase progress dashboard
SELECT * FROM roadmap.v_phase_progress;

-- Advisory gate check before DRAFT→REVIEW transition
SELECT roadmap.fn_check_phase_gate(<proposal_id>, 'REVIEW');
```

#### Advisory gate rule (AC#4)

Gate agents **MUST** call `roadmap.fn_check_phase_gate(proposal_id, 'REVIEW')` before emitting
`advance` on any `DRAFT → REVIEW` transition for phase-tagged proposals. If the function returns
`FALSE`, the gate agent **SHOULD** hold the proposal with a `[ADVISORY]` note in `gate_decision_log`
explaining which predecessor phase is incomplete.

This rule is **advisory** (non-blocking) until Phase 2 lands. After Phase 2, it becomes a hard
reject unless the operator writes an override record in the proposal `audit` JSONB column.

Operators who need to override must add `{"phase_gate_override": true, "reason": "..."}` to the
proposal `audit` column and call `fn_check_phase_gate` again — it will pass on override.

## 6. Database Conventions

### 6.0a Provider/agency identity is DB-sourced (P743)

Provider, agency, and route-provider identity strings (`route_provider`, `agent_provider`, `agency_identity`) **must originate from DB tables**, not source-code literals. Adding, renaming, or removing a provider must be a row change in:

- `roadmap.model_routes` — `agent_provider`, `route_provider`, `agent_cli`
- `roadmap_workforce.provider_registry` — `agency_identity`
- `roadmap.host_model_policy` — `allowed_providers`, `forbidden_providers`

**Hardcoded literals like `"hermes"`, `"claude"`, `"codex"`, `"copilot"` as provider identity in `src/` or `scripts/` are forbidden.** Code that needs a provider list reads it from `model_routes` (cached per process). Code that needs a default reads it from env (`AGENTHIVE_DEFAULT_PROVIDER`) or `model_routes`; if neither yields a value, throw rather than default to a literal.

**Exempt: CLI binary names.** When a string is the on-disk name of an executable (argv[0], shebang, or build-time type union over the small set of installed binaries — `claude`, `codex`, `hermes`, `gemini`, `copilot`), that's a deployment fact, not a provider concept. The `CliName` union in `src/core/runtime/cli-builders.ts`, the `case "hermes":` arms in `agent-spawner.ts`, and `route.cliPath ?? "<binary>"` defaults are allowed.

**Why:** today's loop debugging surfaced multiple drifts where DB and code disagreed on the canonical identity (workflow_name='RFC 5-Stage' vs template name 'Standard RFC'; provider fallback to "hermes" silently routing to an unconfigured provider). DB-as-source-of-truth makes provider changes a one-row edit.

### 6.0b Single dispatch loop — gate-pipeline retired (P754)

The platform runs **one** dispatch decision loop: `scanQueues()` in `scripts/orchestrator.ts`. The previously-split `agenthive-gate-pipeline.service` and its `PipelineCron` class were retired by P754 (2026-05-06) after the unified scanner shipped in P744/P748–P753.

**Hard rule:** **Do not reintroduce a parallel dispatch loop.** Specifically:

- No new long-running service may LISTEN on `proposal_gate_ready`, `proposal_maturity_changed`, or other dispatch-trigger channels and post work offers.
- No new code may SELECT from a queue table (`transition_queue` is gone; future queue-shaped tables must be consumed by `scanQueues()`).
- Maintenance ticks (offer reaper, poke watchdog, stranded-advance reconciler) live in `src/core/orchestration/maintenance.ts` and run only inside the orchestrator's tick.

**Why:** the old two-service split caused the 2026-04-29 double-dispatch incident (17% weekly token cap burned in 8 hours). Adding a parallel loop is a regression of that fix.

**If a future workflow needs a new dispatch trigger,** add it as a notify channel that wakes `scanQueues()`, plus a queue-context resolver row, plus a role-profile row in `roadmap.agent_role_profile`. Do not stand up a separate cron or service.

### 6.0c Broadcast fan-out uses per-channel NOTIFY (P907)

A2A messaging remains **channel-centric** for broadcast delivery. Each broadcast emits one `pg_notify(channel_name)` regardless of how many agents are subscribed on that channel. Agents that `LISTEN` on the channel wake up and pull from `message_ledger`. Agents not listening fall back to polling.

**Decision: stay with per-channel NOTIFY.** Per-subscriber fan-out (mailbox pattern) was evaluated and rejected.

**Numbers** (@ 50 agents, 10 msg/sec mixed load — 80% DM / 15% team-of-10 / 5% broadcast):

| Model | NOTIFYs/sec | Listener LOC | Schema additions |
| --- | --- | --- | --- |
| Per-channel (current) | ~14 | ~200 | none |
| Per-subscriber (rejected) | ~204 (14.6×) | ~400 | +1 subscription table, +GC worker, +subscribe API |

Both are well below Postgres NOTIFY queue capacity (~10K–50K/sec). Per-subscriber's amplification is real but solves a non-bottleneck at this scale.

**Failure-mode comparison:**
- **Per-channel** — missed LISTEN → ledger accumulates, polling fallback recovers. Detectable via stalled `read_at` progress. State is implicit in agent startup code.
- **Per-subscriber** — stale subscription row → trigger silently skips delivery. State is split across code _and_ DB. Harder to diagnose; introduces a new GC/cleanup obligation.

**Rule:** do not add a per-subscriber fan-out table or subscription registry without a new proposal and load evidence that 50× broadcast spike has actually been observed. Per-subscriber can be layered in as an optimization later; it is not the default.

### 6.0d Permanent agent naming convention (P996)

Permanent agents use provider-scoped first-name pools. First letter maps to provider:

| Prefix | Provider | Male names (builder/default) | Female names (skeptic/review only) |
| ------ | -------- | ----------------------------- | ---------------------------------- |
| `a*`   | Claude / Anthropic | adam, alan, alex, andrew, andy | alice, ana |
| `c*`   | Codex    | cooper, carter, calvin, clark, cory | chloe, cora |
| `g*`   | Gemini   | george, glen, grant, graham | grace, gina, gwen |
| `p*`   | Copilot  | peter, patrick, paul, preston, pete, pablo | paige, piper, petra |
| `h*`   | Hermes   | henry, harry, harrison, hudson | hannah, hazel |

**Gender-role rule:** male names = builder/developer/architect (active workers, default dispatch targets). Female names = skeptic/reviewer (seeded inactive; enabled only for review cycles). The first-boot agent for any provider MUST be a male name.

**Expertise suffix:** append `.dev`, `.test`, `.review`, etc. as an operator-facing hint — e.g. `george.dev`, `pete.test`. The suffix does not affect provider routing.

**Agency/liaison labels:** dotted labels distinguish roles on the shared `bot` host:
- `.a` = combined agency+liaison process (e.g. `claude.a`, `gemini.a`)
- `.l` = pure-relay liaison (reserved; not yet implemented)
- `provider.<owner>.a` = provider agency scoped to an owner (e.g. `copilot.gary.a`)

**Module:** `src/core/identity/agent-registry/permanent-agent-map.ts` — `resolvePermanentAgentMapping(input)` normalises any registered name (bare, qualified, with suffix, with @host) to `{ agentIdentity, provider, displayName, permanentRole, host }`. Wire this into every registration path; do not add new hardcoded name sets.

**Supersedes:** P930's `provider-role` convention for permanent agents, agencies, and liaisons. P919 remains the parent display-alias architecture.

**Cross-host labels (`@host`) are deferred** — A2A channel validation does not yet allow `@` in stored routing identities. See P996 for the deferred cross-host relay design.

### 6.0e A2A thread_id and reply-semantics enforcement (P907)

**thread_id column** (`roadmap.message_ledger.thread_id BIGINT NOT NULL`) groups all messages in a conversation tree by their root message id. Populated entirely by the DB:

- **Trigger `trg_message_ledger_set_thread_id`** (`fn_message_ledger_set_thread_id`) fires BEFORE INSERT on every row.
  - Root message (`reply_to IS NULL`): `NEW.thread_id := NEW.id` (pre-fetches nextval when caller omits id).
  - Reply: inherits `thread_id` from parent row (single lookup); falls back to a recursive CTE walk if parent was inserted before the trigger existed.
  - App may pre-compute `thread_id` and pass it to skip the walk entirely.
- **Index** `idx_message_ledger_thread_id_created_at (thread_id, created_at)` covers thread-range queries.
- **Migration**: `scripts/migrations/130-p907-message-ledger-thread-id.sql` (backfill + trigger + index).

**Schema enforcement** (migration `131-p907-message-ledger-schema-enforcement.sql`):
- `CHECK (reply_to IS NULL OR reply_to < id)` — prevents future-pointer DAG violations.
- **Trigger `trg_message_ledger_inherit_correlation_id`** (`fn_message_ledger_inherit_correlation_id`) auto-copies `correlation_id` from the parent row when `NEW.correlation_id IS NULL AND NEW.reply_to IS NOT NULL`. Defensive safety net for forgetful INSERT paths.

**App-side gaps catalogued by P907 AC3 audit** (24 INSERT sites; 2 correct, 20 inconsistent) are tracked in child proposals for incremental fix:
- P907-A (P1): `msg_send` missing `correlation_id` param; `msg_reply` not setting `reply_to`.
- P907-B (P2): escalation rows, `A2AMessenger.send`, liaison handlers, `cross-host-relay` NACK.

Until those fixes land, the DB triggers provide a partial safety net but thread coherence is incomplete for reply chains.

### 6.0f Role resolution — two-level rule (P609 × P748)

Two role-resolver layers coexist by design. **Do not merge them.**

| Layer | File | Key space | DB table | Cache invalidation |
| :---- | :--- | :-------- | :------- | :----------------- |
| **Queue-role resolver** (P748) | `src/core/orchestration/role-resolver.ts` | `(workflow_template_id, stage, maturity, project_id?)` | `roadmap.agent_role_profile` | Process-start only |
| **Gate-role resolver** (P609) | `src/core/orchestration/gate-role-resolver.ts` | `(proposal_type, gate)` | `roadmap_proposal.gate_role` | NOTIFY `gate_role_changed` |

**Queue-role resolver** is consumed by `scanQueues()` for queue-driven dispatch: "given this workflow template, stage, and maturity, which agent role handles it?"

**Gate-role resolver** is consumed by gate evaluation: "given this proposal type and gate (D1–D4), which reviewer role and what persona should be used?" It stores complete agent personas (the D1–D4 behavioral checklists) that the queue-driven schema cannot express.

**Why they cannot be merged:** the gate path requires `(proposal_type, gate)` tuple lookups with per-type persona overrides and a `gate_role_changed` NOTIFY subscription for live cache invalidation. The queue-driven path uses `(workflow_template_id, stage, maturity)` — a different key space with no D1–D4 gate enumeration concept.

**Rule:** changes to gate reviewer personas belong in `roadmap_proposal.gate_role` (then `NOTIFY gate_role_changed`). Changes to queue dispatch roles belong in `roadmap.agent_role_profile`.

### 6.0 Database Topology (target architecture)

AgentHive runs on a **two-tier Postgres topology**:

1. **`hiveCentral`** — the **control-plane database**. Single, shared, contains everything that is global to the platform:
   - Proposal lifecycle (`roadmap_proposal.proposal`, `roadmap.workflows`, `roadmap.workflow_templates`, gate decisions, reviews, dependencies, discussions)
   - Agent registry (`roadmap.agent_registry`, teams, cubics, leases)
   - Runtime configuration (`roadmap.runtime_flag`, `roadmap.host_model_policy`, model registry)
   - Project registry (`roadmap.project` — one row per tenant DB; carries the **DSN** for the tenant DB, not project tenant data)
   - Knowledge, federation, escalation, spending, identity/auth (P472), observability surfaces
   - All DDL labeled "control" in `database/ddl/control/` and migrations in `scripts/migrations/control/`

2. **Project tenant DBs** — one Postgres database **per project**, fully isolated. Names are project-chosen (`agenthive`, `monkeyKing-audio`, `georgia-singer`, …). Each contains:
   - Project-specific application data (audio assets, song metadata, project documents, project-scoped notes)
   - Project-private workflows that don't escalate to the platform
   - Per-project credentials, backups, replicas, and geographic placement
   - All DDL labeled "tenant" in `database/ddl/tenant/` and migrations in `scripts/migrations/tenant/`

**The keystone invariant:** `roadmap_proposal.proposal.project_id` (in `hiveCentral`) is a **foreign key into `roadmap.project.project_id`**, which **points at a tenant DB connection record** — it is **NOT** a tenancy discriminator on rows that share a database with other tenants. Two projects never share a table inside a single DB.

**Default placement: one Postgres instance, multiple databases on it.** Today all databases (`hiveCentral` + project DBs) live on the same `127.0.0.1:5432` Postgres server. The two-tier topology is **logical** (database + role boundary), so isolation does not require physical separation. Moving a tenant to its own host later is a normal operational decision — the architecture supports it but does not require it.

**Default naming, configurable per installation:** the control database is `hiveCentral` by default and each project database is named after its project slug. The control-DB name is configurable via `databases.control.name` in `roadmap.yaml` (or the `PGDATABASE` env override during bootstrap), so operators may pick a different name (e.g. `hiveCtl`, `agenthive_meta`) at install time. Post-deploy renaming via `ALTER DATABASE … RENAME TO` plus a coordinated config update is supported. **No code references the literal name** — every service reads it from env / `roadmap.yaml` — so renaming is a config + restart, not a code change.

**Why two databases on one instance (not single-DB-with-project_id):**
- **Blast radius:** a runaway query against tenant data cannot lock control-plane tables (different DB = different lock space, different connection, different role).
- **Backup/RTO:** each database gets its own `pg_dump` schedule and retention; control-plane has its own.
- **Credentials:** each database has its own role with grants only on its own schemas; tenant role cannot reach control-plane data.
- **Tenancy by accident:** prevents the multi-tenant-without-isolation failure mode.
- **Placement flexibility:** because isolation is database-level, moving any single database to its own Postgres host later is a self-contained migration that doesn't re-architect the control plane (P517 covers the operational pattern). Default placement is one instance; multi-instance is available when justified.

**Connection resolution at runtime:**
- All control-plane queries connect to `hiveCentral` (DSN in `databases.control` of `roadmap.yaml`, env-overridable per §config-resolver).
- A handler that needs project tenant data resolves the DSN via `config.getProjectDb(slug_or_id)`, which queries `hiveCentral.roadmap.project` and returns the tenant DSN.
- Connection pools are keyed per-DB; never reuse a `hiveCentral` pool for tenant queries.

**Today's reality (transition state):**
- The live database is still single-DB `agenthive` — control-plane and the agenthive-tenant data share one Postgres instance.
- P429 is the keystone migration that extracts `hiveCentral` and recasts `agenthive` as the first project tenant DB.
- P487 defines the per-project DB schema bootstrap and registry connection model.
- Until P429 lands, `project_id = 1` is implicit and refers to the agenthive tenant inside the same DB. Do not seed projects with `project_id > 1` outside test fixtures.

**Schema-qualification rules under the new topology:**
- Inside `hiveCentral`: continue to schema-qualify with `roadmap.` and `roadmap_proposal.`
- Inside a tenant DB: project-chosen schemas (e.g., `audio.`, `song.`); never use `roadmap.` in a tenant DB.
- Cross-DB joins are forbidden. If a handler needs both, it issues two queries and joins in code.

### 6.0d Role resolution two-level rule (P909)

Two role-resolver layers coexist by design — they are **not duplicates**:

- **`src/core/orchestration/role-resolver.ts` (P748):** keyed by `(workflow_template_id, stage, maturity, project_id?)`. Used by `scanQueues()` for queue-driven dispatch. Returns an ordered list of `RoleProfile[]` (role name + capabilities + allowed providers).
- **`src/core/orchestration/gate-role-resolver.ts` (P609):** keyed by `(proposal_type, gate)`. Used by gate-evaluator selection where the workflow context (`workflow_template_id`) is not available at decision time. Returns a `GateRoleProfile` with `persona`, `outputContract`, `modelPreference`, `toolAllowList` — fields not present in `RoleProfile`.

**Do not merge these without a separate proposal** that proves the gate path can be expressed in the queue-driven schema. The key difference: gate resolution needs the proposal *type* (`feature`, `hotfix`, …) and the gate label (`D1`–`D4`), not the workflow template ID. At the time gate-evaluator selection runs in `scripts/orchestrator.ts`, the workflow template context may not be resolved yet.

**`src/core/workflow/role-resolver.ts` (deleted, P748 alternate):** was a never-wired duplicate of `orchestration/role-resolver.ts`. Removed in P909.

### 6.0e Boards render from workflow stages (P706)

Boards are workflow-aware surfaces, not fixed RFC boards.

- Render columns from `roadmap.workflow_stages` for the active workflow.
- Require an explicit Workflow filter so column selection is unambiguous.
- Do not hardcode stage lists in UI, API, TUI, or orchestration code.
- When workflow metadata changes, boards must reflect the new ordered stages without a code edit.

### 6.1 DDL belongs in `database/ddl/`

Use `database/ddl/` for schema structure:

- tables
- views
- indexes
- triggers
- functions
- constraints
- schema-level rollout SQL

Current canonical references:

- `database/ddl/roadmap-baseline-2026-04-13.sql` — full schema baseline (snapshot applied 2026-04-13)
- `database/ddl/v4/` — ordered delta migrations applied on top of the baseline (002–056+)
- `database/ddl/hivecentral/` — hiveCentral control-plane DDL (000–015+)

> **Note:** `roadmap-ddl-v2.sql` and `roadmap-ddl-v2-additions.sql` are retired filenames. Do not reference them. See [P305 schema-drift ship report](docs/features/P305-schema-drift-ship-report.md) for the full delta log.

DDL rules:

1. **Schema-qualify everything with `roadmap.`**
2. Prefer numbered files named `NNN-short-description.sql` for incremental rollout work.
3. Keep one logical migration per file or per tightly-coupled batch.
4. Add comments for prerequisites, assumptions, and compatibility risks when they are not obvious.
5. Separate structural DDL from seed data. Do not hide reference data inside schema files unless the data is inseparable from the DDL.
6. Treat deployed numbered migrations as immutable. Fix forward with a new file instead of rewriting history.
7. Validate against the current live schema shape when possible; do not assume an empty database.

### 6.2 DML belongs in `database/dml/`

Use `database/dml/` for deterministic data initialization and seed artifacts.

Current canonical reference:

- `database/dml/init.yaml`

DML rules:

1. Put reference data, bootstrap rows, and initialization content in DML, not in application startup code.
2. Keep DML deterministic and idempotent when possible.
3. If a DDL rollout depends on a data backfill, document the order clearly and keep the backfill with the rollout plan.
4. Update DML when workflow names, proposal types, or other shared lookup values change.

### 6.3 Database changes are proposal-gated work

Database changes have system-wide impact. In AgentHive, they are not "just SQL tasks" and they must not bypass the proposal workflow.

Any meaningful schema change should have a proposal that captures:

- why the database change is needed
- which tables, views, functions, triggers, and runtime code paths are affected
- whether the change is backward compatible
- deployment order
- verification queries
- rollback or fix-forward expectations

For non-trivial DB work, create dependent proposals instead of one vague "change the schema" task. A good pattern is:

1. **Parent proposal:** problem statement, design, rollout strategy, and acceptance criteria.
2. **DB deployment proposal:** the DDL/DML work to be applied by a DB-capable agent or human.
3. **Application proposal:** code changes required to read and write the new schema safely.
4. **Cleanup proposal:** remove compatibility shims, legacy columns, or transitional logic only after production has stabilized.

Use MCP to encode those dependencies. Do not coordinate a risky DB rollout only in chat or only in Git.

### 6.4 Coordinated rollout pattern

AgentHive should minimize the amount of time the system is in a broken or half-migrated state. The preferred rollout is compatibility-first:

1. Ship code that can tolerate both the old and new schema whenever feasible.
2. Deploy the DB change through the dedicated DB deployment proposal.
3. Switch runtime behavior to use the new schema path.
4. Verify through MCP, app, and database checks.
5. Remove old compatibility paths in a later cleanup proposal.

If compatibility-first is impossible, the proposal must explicitly define:

- who deploys the DB change
- who performs the immediate code follow-up
- the expected coordination window
- what validation must happen before the rollout is considered complete

AgentHive is actively migrating toward the v2 Postgres-native model. When changing schema:

- preserve backward compatibility until runtime code is updated
- check storage adapters, MCP handlers, views, and scripts together
- do not remove legacy columns just because a new column exists
- avoid migrations that only work if data is absent

Example: `proposal.maturity` and `proposal.maturity_state` currently coexist for compatibility. A new agent must not remove the legacy column unless the runtime has already been migrated away from it and the cleanup proposal has been completed.

### 6.5 If you do **not** have database deployment access

You may still do valuable database work, but your job is to prepare and route the change correctly rather than treating authorship as deployment.

The right pattern is:

1. Draft the DDL/DML change in `database/ddl/` or `database/dml/`.
2. Update any related docs that explain the model or rollout assumptions.
3. Create or update the parent proposal and dependent rollout proposals in MCP.
4. Update runtime code only if it remains backward compatible, or clearly mark that deployment order matters.
5. Hand off a precise deployment bundle to a DB-capable agent or human.
6. After deployment, ensure the follow-up application proposal is picked up immediately so the live system does not stay mismatched for long.

A good handoff includes:

- files to apply, in order
- whether they are DDL or DML
- which proposal owns the deployment step
- which proposal owns the code-follow-up step
- prerequisites and known incompatibilities
- exact verification queries
- expected runtime impacts
- whether the app or MCP service must be restarted after deployment

If you lack access, **never** say "deployed" or "verified on live DB". Say "prepared", "proposed", "waiting on DB deploy", or "validated on a clone" instead.

### 6.6 `roadmap_proposal.gate_role` — deprecate-then-replace operator pattern

The `gate_role` table uses a **partial unique index** on `(proposal_type, gate) WHERE lifecycle_status = 'active'`. This means at most one row per `(proposal_type, gate)` pair may have `lifecycle_status = 'active'` at a time, but deprecated or retired rows are allowed to coexist.

**Why the index is partial (not table-level UNIQUE):** a table-level UNIQUE would make it impossible to INSERT the replacement row before removing the old one. The partial index allows the safe "deprecate-then-replace" swap described below.

**Operator pattern — swapping an active gate_role row without hitting the constraint:**

```sql
BEGIN;

-- Step 1: retire the current active row (removes it from the partial unique index).
UPDATE roadmap_proposal.gate_role
   SET lifecycle_status = 'deprecated',
       deprecated_at    = now(),
       notes            = 'replaced by row <new-id> — <reason>'
 WHERE proposal_type = '<type>'
   AND gate          = '<gate>'
   AND lifecycle_status = 'active';

-- Step 2: insert the replacement row as active.
INSERT INTO roadmap_proposal.gate_role
  (proposal_type, gate, role, persona, output_contract,
   model_preference, tool_allow_list, fallback_role,
   lifecycle_status, notes)
VALUES
  ('<type>', '<gate>', '<role>', '<persona>', '<output_contract>',
   NULL, NULL, NULL,
   'active', '<reason for change>');

COMMIT;
```

**Rules:**
- Always deprecate before inserting. If you INSERT first and the active row still exists, the partial unique index fires a constraint violation.
- The `deprecated_at` column records when the old row left service. The `notes` column on the old row should reference the replacement (cross-reference by ID or description).
- Never `DELETE` active rows directly — old rows carry audit value and are referenced by `gate_role_history`. Use `lifecycle_status = 'retired'` only for rows that were deprecated and have been superseded for a full deployment cycle.
- The NOTIFY trigger (`fn_gate_role_notify`) fires on both the UPDATE and the INSERT, invalidating the resolver's TTL cache automatically.
- The audit trigger (`fn_gate_role_audit`) captures the `old_persona`, `old_output_contract`, and `old_lifecycle_status` into `gate_role_history` on every UPDATE. No manual audit insertion is required.


## 7. Git Discipline for Multi-Agent Work

**See GIT.md for complete parallel-agent git workflow** (isolated worktrees, atomic commits, safety checks, merge protocol, self-merge anti-pattern, live-DB test hygiene, parallel-dispatch audit, migration numbering).

For project context and workflow stages, see CONVENTIONS.md §1–2 (Proposal Lifecycle and File Precedence).

For deep reference (DB schema, control-plane architecture, escalation matrix), see CONVENTIONS.md §3.0 onwards (link as-needed).
  - code only
  - clone DB validation
  - live DB deployment
  - live MCP smoke test

Precision matters more than confidence theater.

### 8d. Project scope (P477 AC-2)

The web control plane is multi-project: every operator action belongs to one of the rows in `roadmap.project`. Scope flows through one HTTP header.

- **Header**: `X-Project-Id: <project_id>` (or query param `?project_id=`).
- **Server resolution**: `RoadmapServer.resolveProjectScope(req)` validates the requested id against `roadmap.project WHERE status='active'`. Garbage / unknown / archived ids fall back to the lowest-id active project so the UI can never lock itself out.
- **Default**: when no header is sent, the lowest-id active project is used. That keeps existing CLI tooling working without changes.
- **Echo**: `/api/control-plane/overview` returns `{project: {project_id, slug, name}}` so the UI can detect divergence (e.g. localStorage stale across browser tabs) and re-render.

Read endpoints that honor scope today:

| Endpoint | Scope mechanism |
|---|---|
| `/api/control-plane/overview` | `cubics`, `message_ledger` filter by `project_id`; `agent_health` / `agent_runs` joined through `agent_registry`. `model_routes` stays global (infra-level config). |
| `/api/agents` | `agent_registry.project_id = <scope>` |
| `/api/agents/:id` | Returns 404 if the agent's `agent_registry.project_id` doesn't match the request scope (cross-project read denied). |
| `/api/dispatches` | `squad_dispatch.project_id = <scope>`; `?all=1` bypass returns rows from every project (debug only). Echoes `{project: {project_id, slug, name}}`. |
| `/api/projects` | The switcher itself — always returns the full active list. |
| WebSocket `subscribe` | Payload may carry `project_id`; the server stores it per-socket in `wsProjectScope`. Re-sending `subscribe` with a new id triggers a fresh snapshot push without reconnect. |

Endpoints **not yet** scoped (transitional — control-plane / filesystem):

| Endpoint | Why unscoped today |
|---|---|
| `/api/proposals` (REST), `proposal_snapshot` / `proposal_insert` / `proposal_update` (WS) | `roadmap.proposal` has no `project_id` column; it lives in the control plane. Scoping moves to tenant-DB resolution once P429/P482-P485 lands. The WS subscribe still records the operator's project so the wiring is in place; the broadcast already short-circuits the scope check when payloads carry `project_id`. |
| `/api/channels`, `/api/messages`, `/api/pulse` | Filesystem-backed (markdown messages dir, `pulse.log`); naturally scoped per project worktree. Will gain `project_id` filtering only if we migrate to `roadmap.message_ledger`. |
| `/api/routes` | Global infra config — model routes are shared across projects by design. |

When wiring a new endpoint that touches a scoped table, always either:
- filter via `WHERE project_id = $scope` if the table carries the column, or
- join through `agent_registry` / `cubics` / `squad_dispatch` to inherit a scope, or
- explicitly mark the endpoint as "global" / "control-plane" and document it in the table above.

Frontend uses `useProjectScope()` from `src/apps/dashboard-web/hooks/useProjectScope.ts`. The hook returns a `scopedFetch` wrapper that adds the header automatically; **don't** call `window.fetch` from a component if the URL is project-scoped — use the scoped fetcher so the user's selection is respected. Non-React code (e.g. `lib/api.ts` `fetchWithRetry`) reads the same id from `lib/project-scope-storage.ts` and stamps `X-Project-Id` on every request. The current selection persists in `localStorage["roadmap.project_scope.v1"]` and propagates intra-tab via the `roadmap:project-scope-changed` CustomEvent (cross-tab via the storage event). The WebSocket hook listens to the same event and pushes a fresh `subscribe` payload through the open socket on scope change — never reconnects, to avoid snapshot floods.

### 8c. Control-plane stop actions (P477 AC-4)

Operator-initiated stops are exposed as four privileged endpoints, all behind `requireOperator` (§8b). Each writes the actor + reason into the target row so the audit trail outlives the `operator_audit_log`.

| Endpoint | Action name | Effect |
|---|---|---|
| `POST /api/agents/:identity/stop` | `agent.stop` | Soft-cancels every `agent_runs` row for that identity where `status='running'`. Sets `status='cancelled'`, `cancelled_by/at/reason`. Workers honor this on next heartbeat — the server does **not** kill processes directly. |
| `POST /api/cubics/:cubic_id/stop` | `cubic.stop` | Flips an active cubic to `expired`, clears `lock_holder/lock_phase/locked_at`, sets `stopped_by/at/reason`. Idempotent — already-terminal cubics return `{success: true, already_terminal: true}`. |
| `POST /api/proposals/:id/state-machine/halt` | `state-machine.halt` | Sets `proposal.gate_scanner_paused = true`. Gate-scanner / orchestrator must skip paused proposals; the partial index `idx_proposal_gate_paused` keeps the lookup cheap. |
| `POST /api/proposals/:id/state-machine/resume` | `state-machine.resume` | Clears the pause. Separate action so a narrower operator can be granted halt-only or resume-only. |

Body is JSON `{reason}` (optional, free text, capped at 200 chars in the audit summary). The operator name in the resulting trail is taken from the bearer token, never from the request body — same anti-spoof rule as `agent.message`.

When wiring new code that observes these stop signals: read `agent_runs.status='cancelled'` (workers), `cubics.status='expired'` (orchestrator), or `proposal.gate_scanner_paused = true` (gate scanner). Don't introduce side-channels.

### 8b. Control-plane operator authorization (P477 AC-7)

Privileged web actions (operator → agent reminder, future stop actions, multi-project mutations) go through one gate: `requireOperator(req, { action, ... })` in `src/apps/server/operator-auth.ts`. Read endpoints stay unauthenticated; only mutating calls are gated.

The model:

- Bearer-token authentication via `Authorization: Bearer …` (or `X-Operator-Token`).
- Tokens are SHA-256 hashed before storage in `roadmap.operator_token` — plaintext lives only in the issuance response.
- Per-token `allowed_actions text[]`; `'*'` means full operator powers, otherwise list specific actions like `agent.message`, `audit.read`, `cubic.stop`, `agent.stop`.
- **Default posture is fail-closed**: with zero rows in `operator_token`, every gated call returns `503 unconfigured`. Adding the table without inserting a token does **not** silently expose endpoints.
- Every gated call writes a row into `roadmap.operator_audit_log` regardless of decision (`allow / deny / anonymous / unconfigured`). The audit log is the source of truth when reviewing operator actions; never delete it.

Decision → HTTP status:

| decision | status | meaning |
|---|---|---|
| allow | 200 | token valid, action in allowed_actions |
| deny | 401 | token unknown |
| deny | 403 | token valid but action not allowed / revoked / expired |
| anonymous | 401 | no Authorization header but tokens exist |
| unconfigured | 503 | `operator_token` is empty — bootstrap a token first |

Bootstrapping the first token (the API endpoint to issue tokens is itself gated):

```sh
npm run operator:issue -- --name=ops-1 --allowed='*'
npm run operator:list
npm run operator:revoke -- --id=3 --reason="rotation"
```

The issued plaintext token is printed once; store it in your password manager. Lost tokens cannot be recovered — issue a new one and revoke the old.

When wiring a new privileged endpoint, never bypass the gate: always call

```ts
const auth = await requireOperator(req, { action: "<dotted.action>", targetKind, targetIdentity, requestSummary });
if (auth.rejected) return auth.rejected;
// proceed; auth.outcome.operatorName is the canonical operator id —
// prefer it over anything in the request body to prevent spoofing.
```

### 8a. Web bundle builds (P477 AC-6)

The dashboard-web bundle (`src/web/main.js`) is the file `roadmap browser` actually serves. **Never hand-rebuild it with bare `bun build` from inside a worktree** — worktree `node_modules/wouter` is a symlink into AgentHive's tree, and bun resolves wouter's `import "react"` up to a *different* React copy than the app's. Two Reacts in one bundle = `useContext()` blows up at runtime with "Cannot read properties of null".

Use the canonical script instead:

```sh
npm run build:web         # tailwind + bundle, deploys src/web/main.{js,css}
npm run build:web -- --js-only   # skip tailwind (faster iteration)
npm run build:web:watch          # bun --watch on the bundle
```

The script (`scripts/build-web.cjs`):

- chdirs to the AgentHive repo root before bundling, regardless of where it's invoked from;
- builds into `.build-web-staging/` then atomically renames into `src/web/`, so a partial bundle can never reach the browser;
- fails the build if it detects `AgentHive/node_modules/react` references in the bundle (the dual-React fingerprint).

`npm run build` now runs `build:web --js-only` as its last step, so a top-level build is enough; CSS is already produced by the tailwind step earlier in the chain.

After a build, the served bundle's mtime should bump; hard-refresh the browser (Ctrl+Shift+R) — react-tooltip, wouter, and the tailwind chunks all get cached aggressively.

## 9. Quick Checklist for New Agents

Before you start:

1. Read the proposal and relevant docs.
2. Confirm whether the task is code, DDL, DML, MCP workflow, or a combination.
3. If the task changes the database, confirm the parent proposal and the dependent rollout proposals.
4. Claim the work through MCP if the task is proposal-backed.
5. Check whether your change touches live-schema compatibility.
6. Use the correct worktree and branch.
7. If you discovered a broader improvement or risk while scoping the task, capture it in a proposal before you forget it.
8. Decide where every output you'll produce belongs (§4a). If you don't know, ask before writing.

### Hardcoding red flags — do not introduce, fix when you find

AgentHive is shared infrastructure. The following patterns block parallel multi-tenant operation. If you are about to write one, stop and use the registered alternative. If you find one, file an issue (or extend P448–P451) and fix it surgically.

| Antipattern | Why it hurts | Use instead |
| --- | --- | --- |
| `"/data/code/AgentHive"`, `"/data/code/worktree"` literal | Switching agency host costs a multi-file edit (P448) | `getProjectRoot()` / `getWorktreeRoot()` from `src/shared/runtime/paths.ts` |
| `"xiaomi"` as PGUSER fallback, `/home/xiaomi/...` paths | Fails on every other user; provider switch destroys env (P448) | `getDbUser()` / `getOsUser()` — fail fast if env unset |
| `"http://127.0.0.1:6421/sse"`, `"http://localhost:6420"` | Two AgentHive instances on one host collide; cross-host blocked (P449) | `getMcpUrl()` / `getDaemonUrl()` from `src/shared/runtime/endpoints.ts` |
| Hardcoded model name (`"claude-sonnet-4-6"`, `"xiaomi/mimo-v2-pro"`) | Bypasses `model_routes`; cross-platform leakage (P235, P450) | `resolveModelRoute(provider, modelHint)` from agent-spawner — never a literal |
| Bare workflow state literal (`'DRAFT'`, `'COMPLETE'`, `'TRIAGE'`) | Per-project workflows can't override; SMDL drift (P410, P451) | `States.rfc.draft`, `isTerminal(template, stage)` from `src/core/workflow/state-names.ts` (per P453) |
| Bare maturity literal (`'mature'`, `'obsolete'`) | Same problem (P451) | `Maturity.MATURE` etc. from same module |
| Hardcoded agency name (`"hermes/agency-xiaomi"`, `"claude-bob"`) | One agent identity baked into routing decisions | Pass `agentIdentity` through the call chain; resolve from registry |
| Schema-unqualified SQL (`FROM proposal` without `roadmap.`) | Lives in `public.*` ambiguity, breaks with control-plane rename | Always `FROM roadmap_proposal.proposal` (or future `control_*`) |

When the registered alternative does not yet exist (e.g., the new `paths.ts` and `endpoints.ts` modules per P448/P449 are still draft), capture a `// TODO(P###):` comment naming the proposal that will replace the literal — do not silently re-add the antipattern.

#### P448 deprecation schedule — `"xiaomi"` fallback removal in `pool.ts`

| Phase | Timeline | Behaviour |
| --- | --- | --- |
| **V1** (current, 2026-Q2) | P448 ships | `pool.ts` removes silent `"xiaomi"` PGUSER fallback. Missing PGUSER emits `console.warn` with P448 context **and** throws `AgentHiveConfigError`. Operators must source `/etc/agenthive/env` before next service restart. |
| **V2** | 2026-Q3 | `console.warn` removed; only the `AgentHiveConfigError` throw remains. Operators who have not set PGUSER will still fail fast, but without the deprecation preamble in logs. |

Operator action required for V1: copy `scripts/systemd/env.template` to `/etc/agenthive/env`, fill in `PGUSER`, `PGHOST`, `PGDATABASE`, `PGPASSWORD`, then `sudo systemctl daemon-reload && sudo systemctl restart agenthive-mcp`. If the file is absent and these vars are not already in the environment, the service will fail with `AgentHiveConfigError` pointing at `scripts/systemd/env.template`.

Before you finish:

1. Update code, docs, and SQL together if they are coupled.
2. Verify with the appropriate existing checks.
3. If the task touched the database, ensure the rollout proposal chain and handoff state are updated in MCP.
4. If you lack DB access, prepare a deployable handoff instead of pretending to deploy.
5. Leave a clean, specific Git history.
6. Record durable workflow state in MCP, not only in chat.
7. If the work revealed a follow-up improvement or cleanup opportunity, create the next proposal instead of leaving a hidden TODO behind.

## 10. Agent Responsibilities & Rules

* **The Leasing Model:** Use the MCP to **Claim/Lease** a proposal before starting work (Enhance, Review, Develop, or Merge).
* **The RFC Standard:** For a proposal to advance, it must be **Coherent**, **Economically/Architecturally optimized**, and have **Structurally defined Acceptance Criteria (AC)** with clear functions/tests.
* **Issue Reporting:** If an error or blocker is encountered, use the MCP to **log an issue immediately**. Do not attempt to bypass fundamental architectural constraints without a formal issue log.
* **The "Cubic" Context:** When spawning agents in a "Cubic" environment, ensure they are passed the relevant MCP context for their specific task.

### 10a. Gate & Review Agent Protocol

Every dispatch from the orchestrator (architect, researcher, skeptic-alpha, skeptic-beta, architecture-reviewer, gate-reviewer, developer, merge-agent, …) starts cold and re-reads CONVENTIONS.md. The non-negotiable settings below MUST be observable behavior of the spawned agent — if your run violates one, the orchestrator will not advance you, and your dispatch lease will be released without a decision.

#### MCP canonical actions

The consolidated MCP router accepts both the canonical short-action names AND raw-tool-name aliases (e.g. `prop_get`, `prop_list`). Prefer the canonical short names for clarity:

| Domain  | Action          | When to call |
| ------- | --------------- | ------------------------------------------------------ |
| proposal| `get` / `detail`| Query — returns proposal data and YAML+Markdown projection |
| proposal| `list`          | Query — optional filters: `status`, `maturity`, `type`, `limit` |
| proposal| `claim`         | Before work starts — acquire lease |
| proposal| `set_maturity`  | After `prop_transition` — set maturity to `new` (or `active` if immediately claimed) |
| proposal| `transition`    | After a gate verdict — advances status AND records `gate_decision_log` row in one atomic operation |
| proposal| `add_criteria`  | During enhance — structure acceptance criteria |
| proposal| `verify_criteria`| During develop — mark tests/ACs verified |
| proposal| `list_reviews`  | Query — fetch review records |
| proposal| `submit_review` | After gate analysis — structured review (score, verdict, notes) |
| proposal| `add_discussion`| For reasoning, intermediate findings — does NOT trigger gate logic |
| proposal| `log_issue`     | For any blocker, environment problem, or unresolvable ambiguity — stops gate run |

Authoritative source: `src/apps/mcp-server/tools/consolidated.ts`. If an action you need is not listed, call `mcp_proposal action=list_actions` to discover it; do NOT guess.

#### Gate protocol sequence (required for all gate agents)

**Pre-transition requirement — submit_review must come first.**

The required sequence for any advance (including DRAFT → REVIEW) is:

1. `submit_review` — `proposal_id`, `reviewer` (slug, see below), `verdict=approve`, `notes?`, `findings?`
2. `prop_transition` — `id`, `status` (target state), `author`, `reason="decision"`
3. `set_maturity` — reflect the new state
4. `add_discussion` — summarise rationale (linked AC references, risk notes)

For non-advance verdicts (hold/reject/escalate), the sequence is:
1. `submit_review` (if submitting a verdict)
2. `add_discussion` — structured findings in the format below
3. `log_issue` (if blockers need escalation)

Calling `prop_transition` before `submit_review` will return an error even when the verdict would otherwise be valid.

#### Reviewer ID constraint

The `reviewer` field in `submit_review` must match `^[a-z][a-z0-9-]*[a-z0-9]$` — lowercase slug, no slashes. This is **different** from `author_identity` (which uses `<provider>/<role>-d<depth>-p<id>` slash format). Do not pass an `author_identity` string directly as `reviewer`.

```
✓  reviewer: "copilot-gate-d1"
✓  reviewer: "claude-skeptic"
✗  reviewer: "claude/skeptic-alpha-d1-p841"   # slash → DB constraint violation
```

#### Gate findings and verdict format

For gate-review dispatches (D1/D2/D3/D4) and any non-advance verdict (hold/reject/escalate), structured findings MUST be emitted to **stdout** in this format. The orchestrator parses your stdout into `gate_decision_log.rationale`; the next enhancing agent reads that row (NOT the MCP discussion thread, which may not reach them).

```
## Verdict
hold  (or: advance | reject | escalate | waive)

## Failures
- (critical) [C1] one-line summary — evidence: file:line or query
- (major)    [I3] one-line summary — evidence: ...

## Remediation
- specific action that fixes C1
- specific action that fixes I3 (fixes: I3, I4)

## Reviewer breakdown   (optional; for multi-reviewer aggregations)
- reality-checker: REJECT — headline finding
- code-reviewer: NEEDS-FIX — headline finding

## Next step
Concrete instruction the enhancing agent can act on without further context.
```

`advance` verdicts also write to `gate_decision_log` (via `prop_transition` which records the decision) and may omit the failures/remediation sections.

#### §AC-Verification — Mandatory evidence standard (P707)

**Every `verify_ac` call with `status='pass'` MUST include a non-empty `details` object.**  
Omitting `details` (or passing `{}`) returns `EVIDENCE_REQUIRED` (422). The MCP handler rejects it structurally — prompt-compliance alone is insufficient.

**Evidence schema by category** — pass `category` alongside `details` to enable key-level validation (returns `SCHEMA_MISMATCH` on missing required keys):

| Category | Required keys in `details` |
| :--- | :--- |
| `schema/migration` | `migration_file` (str), `tables` (array), `applied` (bool) |
| `file/module` | `files` (array), `symbols` (array), `grep_evidence` (str) |
| `mcp_tool` | `tool_name` (str), `action` (str), `call_verified` (bool), `response_sample` (str) |
| `behavioral/test` | `test_file` (str), `test_names` (array), `result` ("pass"\|"fail"), `output_snippet` (str) |

**Mandatory pre-check protocol for D3 gate agents:**

Before calling `verify_ac` for any AC, the gate agent MUST:
1. Identify the AC category (schema/migration, file/module, mcp_tool, or behavioral/test).
2. Run the category-appropriate check:
   - **schema/migration**: confirm migration file exists, list tables added, run `\d tablename` or `SELECT` to verify applied.
   - **file/module**: `grep -n <symbol> <file>`, confirm file path exists, collect output snippet.
   - **mcp_tool**: invoke the tool (or describe the call); capture response sample.
   - **behavioral/test**: run the test, capture pass/fail + output snippet.
3. Include actual output in `details` before calling `verify_ac`. Do NOT call `verify_ac` first and describe what you _would_ have found.

**Batch guard:** the handler tracks timestamps in-process. More than 2 `verify_ac` calls for the same proposal within any 5-second window returns `BATCH_GUARD_TRIGGERED` (429). This enforces sequential verification — run one check, call `verify_ac`, run the next check. *Added 2026-05-26 (P707).*

#### Source-of-truth rule (DB > markdown)

Product design content lives in DB proposal rows (`proposal.design`, `proposal.summary`, `proposal.motivation`) plus the relational tables (`proposal_acceptance_criteria`, `proposal_dependencies`, `proposal_reviews`, `proposal_discussions`, `gate_decision_log`). Markdown files under `docs/proposals/` are documentation surface; they are NOT authoritative. 

**DB is authoritative.** Markdown files under `docs/` are supplementary. On any divergence between a markdown file and the DB, the DB wins. Gate agents must read from MCP, not from markdown files, before making decisions.

When you enhance a proposal:

1. Write the design into the DB columns.
2. Insert ACs into `proposal_acceptance_criteria` (the gate evaluator reads this — empty table = automatic reject with "No acceptance criteria defined").
3. Insert dependencies into `proposal_dependencies` if any.
4. A markdown supplement is OK for long-form rationale, transcripts, or diagrams that don't fit in TEXT columns — but it must mirror the DB, not replace it. If they diverge, the DB wins.

#### What stops a gate run

A gate agent MUST call `log_issue` and stop (not guess) when:
- The proposal has no Acceptance Criteria
- A required dependency proposal is not `complete`
- The DB is unreachable or the MCP returns an error
- The agent cannot determine the correct `from_state` / `to_state` transition

If you can't read the proposal, stop and emit `## Verdict\nhold` with a `## Failures` line naming the MCP error you hit. Don't invent context. Do NOT let a tool error become a free-form prose conclusion — the orchestrator can parse a structured hold but cannot parse a paragraph.

#### Gate spawn author_identity convention

Author identities for gate agents follow the pattern:

```
<provider>/<role>-d<depth_level>-p<proposal_id>
```

Examples:
- `claude/skeptic-alpha-d1-p472`
- `nous/gate-review-d2-p611`

The DB template is stored at `roadmap.gate_task_templates.author_identity_template`. Gate agents MUST use the template from the DB, not a hardcoded string, so that author_identity stays consistent across provider switches.

**Note:** `author_identity` (slash format) is used for `add_discussion` and `prop_transition` author fields. The `reviewer` field in `submit_review` is a separate slug (no slashes) — see the Reviewer ID constraint above.

System-generated audit entries use `system/auto-advance` (trigger) and `system/reconciler` (backstop) — both registered in `roadmap_workforce.agent_registry`.

## 11. Overseer Role: Hermes (Andy)

Hermes (Andy) is the **overseer** of the AgentHive autonomous system. This role is distinct from squad agents — Hermes does not execute proposals directly.

### Responsibilities
* **Orchestrator Onboarding**: Teach the orchestrator processes, conventions, and workflow rules so it can organize the workforce without human intervention.
* **System Oversight**: Monitor state machine health, orchestrator dispatch integrity, agent dispatch, model routing, spending, and workflow compliance.
* **Convention Enforcement**: Ensure all agents follow CONVENTIONS.md, proposal lifecycle rules, and governance decisions.
* **Human Interface**: Bridge between the project owner (Gary) and the autonomous workforce.
* **Knowledge Transfer**: Ensure spawned agents inherit correct and complete context.

### What Hermes Does NOT Do
* Does NOT claim proposals or acquire leases — that is for squad agents.
* Does NOT execute code changes directly — delegates to developer agents.
* Does NOT advance proposals through gates — that is the gate evaluator's job (within the unified orchestrator).
* Does NOT make governance decisions alone — escalates for strategic calls.

### Orchestrator Relationship
The orchestrator (`scripts/orchestrator.ts`) is the **dispatcher** — it listens for state changes and assigns agents to cubics. Hermes teaches the orchestrator:
* Which agent types map to which states
* What conventions agents must follow
* How to handle errors gracefully
* When to escalate vs. retry

The orchestrator handles the "how" of dispatch. Hermes handles the "what" and "why" of the system.

## 12. Model-to-Workflow Phase Mapping

> **NOTE:** The authoritative model-to-phase mapping lives in the DB (`model_routes` table). The table below is a **design intent** reference, not operational fact. Models listed may not be available on every host — check your host's actual model availability before relying on this.

**Current host constraint:** Only `xiaomi/mimo-v2-pro` and `xiaomi/mimo-v2-omni` (Nous subscription) are available. No Claude, GPT-4, or Gemini models are configured.

| Cubic Phase | Design Intent | Why | Cost Tier |
| :--- | :--- | :--- | :--- |
| **Design** (DRAFT, REVIEW) | Deep reasoning model | Architecture, adversarial review | Premium |
| **Build** (DEVELOP) | Code generation model | Implementation, review prep, verification prep | Standard |
| **Test** (MERGE) | Balanced model | Acceptance execution, integration validation | Standard |
| **Ship** (COMPLETE) | Fast economy model | Documentation, finalization, low-cost | Economy |

**To see actual routed models:** Query `model_routes` in the DB or check `roadmap.yaml`. Do not hardcode model names from this table into code — the DB is the source of truth.

## 13. Financial Governance & Budget Control

Every agent is accountable for **Token ROI** and **Burn Rate**.

* **Budget Estimation**: Prior to high-cost sequences (deep research, large-scale refactoring), provide a budget estimate.
* **Threshold Monitoring**:
  * If spending exceeds 80% of the allocated task budget, pause and alert to request a budget adjustment or contingency approval.
  * If the system detects significant over-budget, a **Circuit Breaker** may be triggered.
* **Efficiency**: Prioritize local **Context Caching** and **Team Memory** to minimize fresh token consumption.

## 14. Anomaly & Loop Detection

You are responsible for identifying and breaking unproductive execution cycles.

* **Inertia Loops**: If you repeat the same three steps without progress (e.g., failing to fix a build error), stop and escalate.
* **DAG Loops**: Monitor for Directed Acyclic Graph (DAG) cycles. If a proposal oscillates between states without advancing, examine the claim log and escalate for structural intervention.
* **Reporting**: Log all detected loops for audit.

## 14a. Phase Gating

The multi-tenancy program is organized into **four phases** (P471). Each phase contains a logical cluster of proposals that must advance together to avoid collisions on shared modules. Phase gating is a **workflow enforcement rule** that prevents premature advancement.

### The Four Phases

| Phase | Name | Focus | Exit Criteria |
| :--- | :--- | :--- | :--- |
| **0** | MCP integrity | Fix bugs in MCP tool surface (fn_spawn_workflow, prop_update, add_dependency, context_prefix, identifier sanitization) | All MCP tool calls documented, validated, persistent; scanner findings on src/ < threshold |
| **1** | Foundation modules | Build shared TS modules (paths.ts, identity.ts, endpoints.ts, state-names.ts, config resolution) | All src/ imports from shared modules; hardcode-scanner rules → 0 findings |
| **2** | Control plane and dispatch hardening | Implement control DB, dispatch hardening, idempotency, fail-closed claims, concurrency ceilings, retry/terminal, provider/budget, host/provider/route separation, service topology, causal IDs, stop/cancel, observability, race tests, cubic paths, workflow state literals, scratch cleanup | Control DB online, dispatch race-tested, total hardcode scanner findings < 50 |
| **3** | Agency liaison and orchestrator readiness | Enable multi-agency coexistence (unified auth, compatibility migration, liaison spec, dormancy, subscription claims, spawn briefing, stuck-detection, two-way protocol, observability, scan-hardcoding extraction) | Orchestrator safely dispatches to multiple agencies with subscription-window awareness; dispatch race-test green |

### Gating Rule

**No proposal advances from DRAFT to REVIEW unless its target phase is open.**

To look up a proposal's phase:

```sql
SELECT p.phase_number, p.name
FROM roadmap.program_phases p
JOIN roadmap_proposal.proposal pr ON pr.phase_id = p.phase_id
WHERE pr.id = $1;
```

If no phase is tagged, the proposal is out-of-scope and must be re-triaged before advancing.

### Operator Override

An operator may override this rule and advance a proposal despite its phase being closed or pending, but the override **must** be recorded in the `gate_decision_log` with reason `"phase gating override: <reason>"` (e.g., "critical security patch", "already shipping with Phase 0"). This preserves the audit trail and allows the leadership team to detect patterns of exceptions.

### Implementation Notes

- Each phase begins in status **open**.
- Phases do NOT close automatically; only an operator or the phase owner may close one after verifying exit criteria.
- A proposal tagged with phase N depends on all proposals in phases 0..N-1. The DAG advancement engine (P050) should use this to compute critical path.
- New proposals filed during implementation are tagged with their target phase as they are created; untagged proposals default to out-of-scope until triaged.

## 15. Escalation Matrix

When a blocker is out of control, follow the formal hierarchy:

| Issue Type | Primary Escalation | Secondary Escalation |
| :--- | :--- | :--- |
| **Technical Blocker** | Superior Agent (e.g., Architect Squad) | Project Owner (Gary) |
| **Budget Exhaustion** | Auditor Agent | Project Owner (Gary) |
| **Workflow Loop** | Skeptic Squad | Project Owner (Gary) |
| **Security/ACL Denial** | Security Agent | Project Owner (Gary) |

**The Gary Rule**: Direct intervention from the Project Owner (Gary) or designated HITL (Derek/Nolan) is reserved for high-level strategic pivots or final "Accepted" state transitions.

General escalation triggers:

- a schema change needs live deployment and you do not have DB access
- you find conflicting live/runtime assumptions
- a proposal workflow transition is blocked by missing AC, missing dependency resolution, or missing decision notes
- another agent's in-flight work conflicts with yours

When blocked, leave the next agent a better surface:

- concrete files
- exact SQL order
- exact MCP actions needed
- exact validation still missing

That is the standard for blending into AgentHive quickly without creating drift.

## 16. Active Architectural Initiatives — Keystone Index

When you start work that touches one of these areas, **read the keystone proposal first**. Sub-proposals are blocked by it; competing/older proposals are marked obsolete and should be ignored. This index is the canonical resolver for "which proposal owns this concern" — if you find conflicting proposals not listed here, the one named here wins; raise an issue to fix the others.

| Concern | Keystone | Sub-proposals (under keystone) | Obsoleted (do not use) |
| :--- | :--- | :--- | :--- |
| **Multi-tenancy DB topology** (hiveCentral + per-project tenant DBs, two-tier) | **P429** | Foundation: P495, P496, P497, P498, P499, P500, P520. Bootstrap: P501, P502, P503. Cutover: P504, P505, P518, P506. Tenant lifecycle: P507, P508, P509. Cleanup: P511, P512. Real tenants: P513, P514. Long tail: P515, P516, P517. | P430 (column classification → P506), P431 (control DB bootstrap → P501), P432 (project DB isolation → P429), P487 (memory artifact, never created) |
| **Multi-tenancy program plan** (4-phase rollout orchestration) | **P471** | Blocks: P429, P448, P453✓, P463, P472, P473, P474, P475, P476✓, plus the entire P429 wave above | P471 IS the master plan; do not create competing program proposals |
| **MCP tool surface hardening** (input validation, naming, error envelopes) | **P475** | Implements principle from **P456** (REVIEW mature). Companion fixes shipped: P457✓ (context_prefix CHECK widening), P486 (extractArgs+collision detection), P521 (auto-register reviewer FK). | P380 (type errors — fixed by P457 and P475) |
| **State machine + dispatch hardening** (concurrency, idempotency, retry, leases, races) | **P433** | Blocks: P437 (idempotency), P438 (claim fail-closed), P439 (concurrency ceilings), P440 (retry+terminal), P442 (operator stop), P443 (causal IDs), P444 (host/provider/route sep), P445 (race tests), P446 (MCP runtime reliability). P441 (service topology) is adjacent but separate. | — |
| **Gate evaluator automation** (auto-advance mature proposals through gates) | **P206** (DEVELOP active critical) | Companion: P222 (SMDL DSL), P224 (lease-required gates), P227 (workflow quality gates) | — |
| **Liaison + agency protocol** (always-on agency representative, two-way orchestrator) | **P463** | Blocks: P464 (liaison spec + dormancy), P465 (subscription claim policy), P466 (spawn briefing), P467 (stuck detection), P468 (orchestrator↔liaison messaging), P469 (observability surface) | — |
| **Web control plane** (multi-project operations dashboard, workforce control) | **P477** | Sub-areas (originally drafted under P387 umbrella): P388 (data layer), P389 (info-arch), P390 (design system), P391 (project/host mgmt), P392 (agency/workforce), P393 (model routes), P394 (proposal kanban), P395 (observability views), P396 (workforce viz), P397 (budget center), P398 (OAuth), P399 (co-orchestration). Treat these as P477's design backlog until/unless explicitly re-keyed. | P387 (Universal Web Dashboard — superseded by P477's multi-project framing), P301 (filesystem→Postgres unify — partially absorbed by P294) |
| **Auth + identity unification** (keys, sessions, tokens, OAuth across agents/liaisons/operators) | **P472** (REVIEW mature) | Adjacent: P398 (OAuth UI), P159 (agent-identity wiring), P413 (service account consolidation) | — |
| **Configuration resolution order** (env vs roadmap.yaml vs control DB vs feature flags) | **P474** (DEVELOP active) | Extended by P498 (tenant DSN class), companion P416✓/P402✓ obsoleted | — |
| **Compatibility migration plan** (control plane and liaison cutover, dual-write windows) | **P473** (REVIEW mature) | Blocks: P438, P432 (now obsolete), P468, P464, P431 (now obsolete), P453✓ | — |
| **agentHive2 Grand Picture** (product vision, operating model, system boundaries) | **P1013** (DRAFT) | Pillars: P1014–P1024 (see below). Stack re-authoring: P995, P997✓, P998✓, P999✓, P1000✓. | Legacy keystones remain as delivered-evidence; P1013 is the canonical agentHive2 root. |
| **Control Plane** (hiveCentral DB, tenant lifecycle, multi-project mgmt) | **P1014** (DRAFT, child of P1013) | Prior delivered: P429 family (migration topology), P474 (config resolver), P507–P509 (tenant lifecycle) | — |
| **Proposal Engine** (lifecycle, criteria, leases, mapping, doc projection) | **P1015** (DRAFT, child of P1013) | Prior delivered: P433 (state machine), P475 (MCP hardening), P995/P997/P998/P999 (mapping artifact + doc projection) | — |
| **Workforce and Agencies** (registry, self-reg, liaison bootstrap, tiered identity) | **P1016** (DRAFT, child of P1013) | Prior delivered: P463 (liaison protocol), P888 (A2A foundation), P996 (personal-name agents) | — |
| **Unified Messaging / A2A** (single bus, presence, USER↔agent, HMAC, DLQ) | **P1017** (DEVELOP, child of P1013) | Phases: P1102 (heartbeat cleanup, REVIEW), P1103–P1107 (bus, presence, USER identity, HMAC/DLQ, transport contracts) | P836 (cross-host relay — absorbed into P1017-E) |
| **Execution and Orchestration** (orchestrator, dispatch loop, offers, gate pipeline) | **P1021** (DRAFT, child of P1013) | Prior delivered: P902/P903 (orchestrator class), P206 (gate evaluator), P1018 (budget wire) | — |
| **Governance and Trust** (identity, budget wiring, marketplace controls) | **P1022** (DRAFT, child of P1013) | Prior delivered: P472 (auth/identity), P842/P1004 (budget schemas), P1018/P1022 (wiring + mechanics) | — |
| **Observability and Efficiency** (spans, backup, partitions, schema-drift, rollups) | **P1023** (DRAFT, child of P1013) | Prior delivered: P660 (workflow completed_at), P772 (route_decision_log), P855/P856 (fix batch) | — |
| **Web and Operator Experience** (dashboard, CLI, TUI, activity feed, Discord bridge) | **P1024** (DRAFT, child of P1013) | In-flight: P1067 (TUI shell). Prior: P477 (web control plane) | P387 (superseded by P477), P301 (partially absorbed) |

### Operating rules for this index

1. **Discovery flow**: When triaging a new task, look up its concern here first. The keystone tells you which design + AC are canonical. Sub-proposals are partial implementations or fragments — read them only after the keystone.
2. **Conflict resolution**: If two non-obsolete proposals describe overlapping scope, the one named here wins. The other should either be marked obsolete or rewired as a sub-proposal under the keystone. Do not silently work on both.
3. **Adding a new keystone**: Don't. Instead, propose extending an existing keystone, OR file an issue declaring why a new architectural concern doesn't fit any existing keystone.
4. **Marking a proposal obsolete**: Wire a `supersedes` edge from the replacement to the obsolete proposal in `roadmap_proposal.proposal_dependencies`, then UPDATE `maturity = 'obsolete'`. Keep the row for forensic value (audit JSONB column captures the why).
5. **Refresh cadence**: This table needs review every time a major realignment happens (new keystone proposal, large cluster of sub-proposals created, or DB topology pivot). The 2026-04-26 refresh wired the P429 family + reconciled MCP/web UI/state machine clusters.

### What this index does NOT cover

- **Code-level conventions** (naming, structure, testing) — see §3, §4, §6.
- **Runtime operating rules** (folder discipline, git, deployment) — see §4a, §7, §8.
- **Process** (proposal lifecycle, gates, leases) — see §5.
- **Stale proposals not on critical path** — many proposals from the 2026-04-21 batch (P046–P296) sit in DEVELOP without active leases. Triage is a separate concern; this index only names the architecturally-load-bearing keystones.

## 17. Definitions for Agents

* **Universal Maturity Model**: Fresh entries are **new** (White), work in progress is **active** (Yellow), and ready for transition is **mature** (Green).
* **Zero-Trust**: You have no "root" access. Every action is recorded in the `proposal_version` ledger with a Git-style delta.
* **Staging**: All code must pass "Pre-flight Checks" in an isolated environment before promotion to the main branch.

## 18. Completed Capabilities

| Proposal | Capability | Description |
| :--- | :--- | :--- |
| **P050** | DAG Dependency Engine | Enforces dependency ordering across proposals; detects cycles; validates all blockers resolved before state promotion |
| **P055** | Team & Squad Composition | Dynamic agent squad assembly based on skills, availability, and role requirements |
| **P058** | Cubic Orchestration | Isolated execution environments ("cubics") with dedicated agent slots, resource budgets, and Git worktrees |
| **P059** | Model Registry & Cost Routing | Centralized LLM catalog with cost/capability metadata; optimal model selection per task |
| **P061** | Knowledge Base & Vector Search | Persistent store of decisions and patterns; pgvector semantic search for reuse across sessions |
| **P062** | Team Memory | Session-persistent key-value store scoped per agent/team; fast named retrieval |
| **P063** | Fleet Observability | Real-time heartbeats, spending correlation, efficiency metrics (tokens/proposal, cache hit rate) |
| **P078** | Escalation Management | Obstacle detection, severity routing, compressed lifecycle for urgent issues |
| **P090** | Token Efficiency | Three-tier cost reduction: semantic cache, prompt caching, context management + model routing |
| **P148** | Auto-merge Worktrees | Automated merge from agent worktrees to main with back-sync to other agents |

## 19. Configuration Discipline

All PostgreSQL connection parameters **must** be read through `ConfigResolver`, not via bare `process.env.*` calls.

### Rules

- `process.env.PG*` is **forbidden** outside `src/shared/runtime/config.ts` and `src/shared/runtime/config-keys.ts`
- Synchronous startup code (pool IIFE, module-level initialization): use `ConfigResolver.resolvePasswordSync()`
- Async application code: use `config.get(StructuralKeys.PGHOST)` etc.
- CI enforcement: `scripts/ci-env-check.sh` (run in pre-commit or CI pipeline)

### Implementation

- `ConfigResolver.parsePgpassFile()` — centralized pgpass parsing for `~/.pgpass` lookup
- `ConfigResolver.resolvePasswordSync()` — synchronous password resolution at startup (pgpass → env → undefined)
- `StructuralKeys.PGUSER` has `defaultValue: "admin"` to avoid hardcoded fallbacks
- `SecretKeys.PGPASSWORD` is `required: false` — pgpass/libpq are valid authentication paths

This is enforced automatically — violations will fail the CI check.

## 20. Capability Vocabulary Mismatch Remediation — P1290 AC-7

The orchestrator boot path runs `scripts/orchestrator-capability-coverage-check.ts` in `--warn-only` mode and logs a warning if any role in `ROLE_TO_REQUIRED_CAPABILITIES` (`src/core/orchestration/offer-dispatch.ts:54`) maps to a capability with zero matching dispatchable agencies.

**Boot warning text** (look for this in `journalctl -u agenthive-orchestrator.service`):
```
[capability-coverage] WARN: capability "<cap>" required by roles [<role>, ...] has no matching dispatchable agency
```

When this warning fires, the operator has two remediation paths:

**Path A — adjust the role map** (use when the missing capability is a vocabulary mistake, not a real capability gap):

Edit `src/core/orchestration/offer-dispatch.ts` to re-map the affected role(s) to a capability that already has agency coverage, then redeploy. Example: re-map a niche role to the default `develop` capability.

**Path B — seed the missing capability on an active agency** (use when the capability is real and an agency should advertise it):

```sql
UPDATE roadmap_workforce.provider_registry
SET capabilities = jsonb_set(
  capabilities,
  '{jobs}',
  COALESCE(capabilities->'jobs', '[]'::jsonb) || '"<cap>"'::jsonb
)
WHERE agency_identity = '<agency>'
  AND status = 'active';

NOTIFY capability_vocabulary_changed;
```

The NOTIFY clears any `proposal_role_pause` rows whose pause_reason is `no_eligible_agency` or `capability_mismatch` (P1291 auto-clear), letting dispatch retry immediately.

Verify both paths with `bun run scripts/orchestrator-capability-coverage-check.ts` (no `--warn-only`); exit code 0 means coverage is complete. The same check runs in CI (see `.gitlab-ci.yml`) and will fail any PR that drifts.

## §model-capability-scores — AC-10 (P1006)

All entries in `roadmap_workforce.model_capability_profile` score each capability dimension on a 0–5 integer scale:

| Score | Label | Meaning |
| :---: | :--- | :--- |
| **0** | incapable | Cannot perform the task reliably. Do not route this category here. |
| **1** | toy | Handles trivial cases only; fails on structured/complex inputs. |
| **2** | adequate / bounded | Functional for simple, well-scoped tasks. No complex reasoning expected. |
| **3** | solid / structured-output | Reliable for standard work; handles structured outputs and moderate complexity. |
| **4** | strong / general-purpose | Handles difficult tasks; strong instruction following and multi-step reasoning. |
| **5** | best-in-class | Maximum capability in this dimension among currently active providers. |

This rubric covers four scored dimensions: `reasoning_score`, `code_quality_score`, `instruction_following_score`, and (implicit) context throughput via `context_window_k`.

**Rubric stability policy:** scores are only changed via a formal proposal. Ad-hoc DB edits are permitted for factual corrections (e.g. provider changes a model's context window) but require a `notes` update and `updated_at` refresh. Capability re-scoring that changes routing decisions must go through a proposal.

## §task-categories — AC-16 (P1006)

`roadmap.work_offer.task_category` classifies every dispatched offer into exactly one of eight categories. The resolver uses this to enforce spawn-eligibility and minimum reasoning requirements before matching agents.

| Category | Spawn Required | Min Reasoning | Eligible Providers | Examples |
| :--- | :---: | :---: | :--- | :--- |
| `mechanical` | No | 0 | All | Linting, changelog, env audit, log tailing, boilerplate |
| `workspace` | No | 0 | All incl. copilot/gemini | File management, branch cleanup, migration slot check |
| `liaison` | No | 0 | All incl. copilot/gemini | Status pings, message routing, notification relay |
| `testing` | **Yes** | 0 | anthropic, codex | Unit/integration test runs, coverage analysis |
| `implementation` | **Yes** | 0 | anthropic, codex | Feature coding, bug fixes, migration authoring |
| `analysis` | **Yes** | 0 | anthropic, codex | Data analysis, cost modelling, dependency mapping |
| `architecture` | **Yes** | **5** | anthropic (opus only) | Design review, AC authorship, system decomposition |
| `review` | **Yes** | **5** | anthropic (opus only) | Gate decisions, D1–D4 verdicts, spec coherence checks |

**Spawn Required** means the provider must have `can_spawn_workers = true` in `model_capability_profile`. Copilot and Gemini are excluded for all spawn-required categories regardless of cost tier.

**Min Reasoning = 5** means only models with `reasoning_score = 5` are eligible. In the current seed data this is `claude-opus-4-7` (anthropic) only.

Default value for new offers: `'mechanical'` — safe for any provider.
