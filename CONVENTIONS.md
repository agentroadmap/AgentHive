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
| Runtime database | PostgreSQL. **Two-tier topology** (target): `hiveControl` for control plane, one DB per project tenant (`agenthive`, `monkeyKing-audio`, `georgia-singer`, …). Today still single-DB `agenthive`; see §6.0. |
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
| `docs/architecture/` | canonical architecture documents | durable design docs that survive multiple proposals |
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
| **feature** | Type B (Impl) | Standard RFC | Concrete capability to build |
| **issue** | Type B (Impl) | Standard RFC | Problem in the product requiring code changes |
| **hotfix** | Type C (Ops) | Hotfix | Localized operational fix to running instance |

### Standard RFC Workflow (product, component, feature, issue)

| State | Phase | Description |
| :--- | :--- | :--- |
| **Draft** | Architecture | Initial idea. If too broad or incoherent, **split it** into smaller proposals. |
| **Review** | Gating | Gating review for feasibility, coherence, and architectural fit. |
| **Develop** | Building | Building, coding and testing. |
| **Merge** | Integration | Merging branch to `main`. Focus on compatibility and stability. |
| **Complete** | Stable | Temporary stable state until the next evolution cycle begins. |

### Hotfix Workflow (hotfix)

| State | Phase | Description |
| :--- | :--- | :--- |
| **TRIAGE** | Confirm | Confirm the problem exists and is a localized operational fix |
| **FIX** | Apply | Specialist/ops claims and applies the fix (often higher privilege) |
| **DEPLOYED** | Verified | Fix applied and verified working |

**Terminal states:** DEPLOYED, WONT_FIX, NON_ISSUE
**Escape:** ESCALATE → creates a new issue proposal (Standard RFC)

### Maturity Levels

| Maturity | Description |
| :--- | :--- |
| **New** | Just entered the state. Waiting for an agent to claim or lease it, or for dependencies to clear. Every workflow state entry resets maturity to `new`, including entry into `Complete`. |
| **Active** | Under lease and being worked on with fast iteration. |
| **Mature** | Work in this state is complete enough to request a gate decision to advance. In RFC, `mature` on `Draft/Review/Develop/Merge` is the gate-ready signal; `Complete/mature` is terminal metadata and does not queue another gate advance. |
| **Obsolete** | No longer relevant because the structure or direction has changed. |

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

- The default lifecycle is `Draft -> Review -> Develop -> Merge -> Complete`.
- Proposal type determines workflow selection. Do not invent ad-hoc types. Check existing usage or `roadmap.proposal_type_config` before creating new proposals.

## 6. Database Conventions

### 6.0 Database Topology (target architecture)

AgentHive runs on a **two-tier Postgres topology**:

1. **`hiveControl`** — the **control-plane database**. Single, shared, contains everything that is global to the platform:
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

**The keystone invariant:** `roadmap_proposal.proposal.project_id` (in `hiveControl`) is a **foreign key into `roadmap.project.project_id`**, which **points at a tenant DB connection record** — it is **NOT** a tenancy discriminator on rows that share a database with other tenants. Two projects never share a table inside a single DB.

**Default placement: one Postgres instance, multiple databases on it.** Today all databases (`hiveControl` + project DBs) live on the same `127.0.0.1:5432` Postgres server. The two-tier topology is **logical** (database + role boundary), so isolation does not require physical separation. Moving a tenant to its own host later is a normal operational decision — the architecture supports it but does not require it. **Naming is fixed:** the control database is always `hiveControl`; each project database is named after the project slug.

**Why two databases on one instance (not single-DB-with-project_id):**
- **Blast radius:** a runaway query against tenant data cannot lock control-plane tables (different DB = different lock space, different connection, different role).
- **Backup/RTO:** each database gets its own `pg_dump` schedule and retention; control-plane has its own.
- **Credentials:** each database has its own role with grants only on its own schemas; tenant role cannot reach control-plane data.
- **Tenancy by accident:** prevents the multi-tenant-without-isolation failure mode.
- **Placement flexibility:** because isolation is database-level, moving any single database to its own Postgres host later is a self-contained migration that doesn't re-architect the control plane (P517 covers the operational pattern). Default placement is one instance; multi-instance is available when justified.

**Connection resolution at runtime:**
- All control-plane queries connect to `hiveControl` (DSN in `databases.control` of `roadmap.yaml`, env-overridable per §config-resolver).
- A handler that needs project tenant data resolves the DSN via `config.getProjectDb(slug_or_id)`, which queries `hiveControl.roadmap.project` and returns the tenant DSN.
- Connection pools are keyed per-DB; never reuse a `hiveControl` pool for tenant queries.

**Today's reality (transition state):**
- The live database is still single-DB `agenthive` — control-plane and the agenthive-tenant data share one Postgres instance.
- P429 is the keystone migration that extracts `hiveControl` and recasts `agenthive` as the first project tenant DB.
- P487 defines the per-project DB schema bootstrap and registry connection model.
- Until P429 lands, `project_id = 1` is implicit and refers to the agenthive tenant inside the same DB. Do not seed projects with `project_id > 1` outside test fixtures.

**Schema-qualification rules under the new topology:**
- Inside `hiveControl`: continue to schema-qualify with `roadmap.` and `roadmap_proposal.`
- Inside a tenant DB: project-chosen schemas (e.g., `audio.`, `song.`); never use `roadmap.` in a tenant DB.
- Cross-DB joins are forbidden. If a handler needs both, it issues two queries and joins in code.

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

- `database/ddl/roadmap-ddl-v2.sql`
- `database/ddl/roadmap-ddl-v2-additions.sql`
- numbered rollout files such as `002-...sql`, `003-...sql`, `012-...sql`

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

## 7. Git and Worktree Best Practices

AgentHive is multi-agent. Git discipline is part of system safety.

### Branching and worktrees

- Use one worktree per active agent/task.
- Use a branch name that identifies the agent and topic, for example `xiaomi/schema-rollout` or `codex/workflow-defaults`.
- Do not work inside another agent's worktree unless explicitly coordinating.

### Commits

- Commit coherent units of work early.
- Keep commit messages specific to the changed files or proposal.
- Prefer multiple small commits over one mega-commit when the work naturally separates.
- If you change behavior, update the related docs in the same branch.

### Shared-history rules

- Do not rewrite shared history.
- Do not force-push a branch another agent may be using.
- Do not amend someone else's commit.
- Rebase only your own unpublished work.
- If a branch has already been merged or consumed by another agent, fix forward with new commits.

### Conflict handling

- Read both sides before resolving conflicts.
- Never delete unknown changes just to get a clean merge.
- If the repo root contains local changes and the live service runs from that root, remember that a restart may pick up those changes immediately.

### Safety

- Do not use destructive Git commands to discard work you did not create.
- If you encounter unexpected changes, assume they may be intentional until proven otherwise.

## 8. Validation and Deployment Expectations

- For code changes, run the relevant existing tests, build steps, or targeted checks already provided by the repo.
- For DB changes, prefer validating against a clone of the live schema before touching production.
- For MCP changes, verify through the live service when feasible, not only with unit-level reasoning.
- Report the exact scope of what you verified:
  - code only
  - clone DB validation
  - live DB deployment
  - live MCP smoke test

Precision matters more than confidence theater.

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

## 11. Overseer Role: Hermes (Andy)

Hermes (Andy) is the **overseer** of the AgentHive autonomous system. This role is distinct from squad agents — Hermes does not execute proposals directly.

### Responsibilities
* **Orchestrator Onboarding**: Teach the orchestrator processes, conventions, and workflow rules so it can organize the workforce without human intervention.
* **System Oversight**: Monitor state machine health, gate pipeline integrity, agent dispatch, model routing, spending, and workflow compliance.
* **Convention Enforcement**: Ensure all agents follow CONVENTIONS.md, proposal lifecycle rules, and governance decisions.
* **Human Interface**: Bridge between the project owner (Gary) and the autonomous workforce.
* **Knowledge Transfer**: Ensure spawned agents inherit correct and complete context.

### What Hermes Does NOT Do
* Does NOT claim proposals or acquire leases — that is for squad agents.
* Does NOT execute code changes directly — delegates to developer agents.
* Does NOT advance proposals through gates — that is the gate pipeline's job.
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
| **Design** (DRAFT, REVIEW, TRIAGE) | Deep reasoning model | Architecture, adversarial review | Premium |
| **Build** (DEVELOP, FIX) | Code generation model | Implementation, balanced cost | Standard |
| **Test** (MERGE) | Balanced model | Integration testing, validation | Standard |
| **Ship** (COMPLETE, DEPLOYED) | Fast economy model | Documentation, finalization, low-cost | Economy |

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
| **Multi-tenancy DB topology** (hiveControl + per-project tenant DBs, two-tier) | **P429** | Foundation: P495, P496, P497, P498, P499, P500, P520. Bootstrap: P501, P502, P503. Cutover: P504, P505, P518, P506. Tenant lifecycle: P507, P508, P509. Cleanup: P511, P512. Real tenants: P513, P514. Long tail: P515, P516, P517. | P430 (column classification → P506), P431 (control DB bootstrap → P501), P432 (project DB isolation → P429), P487 (memory artifact, never created) |
| **Multi-tenancy program plan** (4-phase rollout orchestration) | **P471** | Blocks: P429, P448, P453✓, P463, P472, P473, P474, P475, P476✓, plus the entire P429 wave above | P471 IS the master plan; do not create competing program proposals |
| **MCP tool surface hardening** (input validation, naming, error envelopes) | **P475** | Implements principle from **P456** (REVIEW mature). Companion fixes shipped: P457✓ (context_prefix CHECK widening), P486 (extractArgs+collision detection), P521 (auto-register reviewer FK). | P380 (type errors — fixed by P457 and P475) |
| **State machine + dispatch hardening** (concurrency, idempotency, retry, leases, races) | **P433** | Blocks: P437 (idempotency), P438 (claim fail-closed), P439 (concurrency ceilings), P440 (retry+terminal), P442 (operator stop), P443 (causal IDs), P444 (host/provider/route sep), P445 (race tests), P446 (MCP runtime reliability). P441 (service topology) is adjacent but separate. | — |
| **Gate evaluator automation** (auto-advance mature proposals through gates) | **P206** (DEVELOP active critical) | Companion: P222 (SMDL DSL), P224 (lease-required gates), P227 (workflow quality gates) | — |
| **Liaison + agency protocol** (always-on agency representative, two-way orchestrator) | **P463** | Blocks: P464 (liaison spec + dormancy), P465 (subscription claim policy), P466 (spawn briefing), P467 (stuck detection), P468 (orchestrator↔liaison messaging), P469 (observability surface) | — |
| **Web control plane** (multi-project operations dashboard, workforce control) | **P477** | Sub-areas (originally drafted under P387 umbrella): P388 (data layer), P389 (info-arch), P390 (design system), P391 (project/host mgmt), P392 (agency/workforce), P393 (model routes), P394 (proposal kanban), P395 (observability views), P396 (workforce viz), P397 (budget center), P398 (OAuth), P399 (co-orchestration). Treat these as P477's design backlog until/unless explicitly re-keyed. | P387 (Universal Web Dashboard — superseded by P477's multi-project framing), P301 (filesystem→Postgres unify — partially absorbed by P294) |
| **Auth + identity unification** (keys, sessions, tokens, OAuth across agents/liaisons/operators) | **P472** (REVIEW mature) | Adjacent: P398 (OAuth UI), P159 (agent-identity wiring), P413 (service account consolidation) | — |
| **Configuration resolution order** (env vs roadmap.yaml vs control DB vs feature flags) | **P474** (DEVELOP active) | Extended by P498 (tenant DSN class), companion P416✓/P402✓ obsoleted | — |
| **Compatibility migration plan** (control plane and liaison cutover, dual-write windows) | **P473** (REVIEW mature) | Blocks: P438, P432 (now obsolete), P468, P464, P431 (now obsolete), P453✓ | — |

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
