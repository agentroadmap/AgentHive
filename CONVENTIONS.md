# AgentHive Conventions and Onboarding

This document is the fast, practical onboarding guide for new AI agents working in AgentHive. Read it before making code, database, MCP, or Git changes.

## 1. Start Here

Read these files first, in order:

1. `README.md` - project vision and the current proposal lifecycle.
2. `agentGuide.md` - agent operating rules and behavioral guardrails.
3. `roadmap.yaml` - active runtime configuration, especially the Postgres provider and `roadmap` schema.
4. `docs/pillars/1-proposal/new-data-model-guide.md` - current v2 data model rules.
5. `database/ddl/` and `database/dml/` - canonical schema and initialization artifacts.

If your task touches the proposal workflow, also read `docs/pillars/1-proposal/data-model-change.md`.

## 2. Current Operating Reality

AgentHive is not a greenfield repo. Work against the system that exists today.

| Surface | Current convention |
| --- | --- |
| Runtime database | PostgreSQL, database `agenthive`, schema `roadmap` |
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

Use the real repo layout, not an imagined one:

| Area | Purpose |
| --- | --- |
| `src/core/` | proposal logic, workflow logic, roadmap query layer |
| `src/infra/postgres/` | Postgres pool, storage adapters, DB-facing helpers |
| `src/apps/mcp-server/` | MCP server, tool registration, handlers |
| `src/apps/cli.ts` | CLI entrypoint |
| `database/ddl/` | schema DDL and numbered rollout SQL |
| `database/dml/` | initialization data and seed-like artifacts |
| `docs/pillars/` | architecture and proposal/workflow docs |
| `scripts/` | runtime, board, systemd, and helper scripts |
| `tests/` | existing automated tests |
| `tmp/` | disposable local artifacts only; never commit from here |

## 4. Daily Working Rules

- Use a dedicated Git worktree for your task, typically under `/data/code/worktree/<agent-name>`.
- Keep changes surgical. Do not opportunistically refactor unrelated code while fixing something else.
- Put logs, scratch files, dumps, and temporary outputs in `tmp/` or your session workspace, not in tracked source folders.
- Prefer existing patterns and helpers over inventing parallel abstractions.
- Keep TypeScript and SQL changes aligned. If schema changes, check the storage layer, MCP handlers, CLI, and views that consume it.
- If you notice an improvement, consolidation opportunity, concept unification, or a current or potential issue, create or update a proposal instead of leaving it as chat-only context.
- Never commit credentials, copied env files, or secrets from `.env`, `/etc/agentroadmap/env`, or local shell history.
- Do not claim a deployment, migration, or verification step that you did not actually perform.

## 5. Proposal and RFC Workflow Through MCP

AgentHive work is proposal-driven. Participate through MCP, not through chat-only side channels.

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

Before you finish:

1. Update code, docs, and SQL together if they are coupled.
2. Verify with the appropriate existing checks.
3. If the task touched the database, ensure the rollout proposal chain and handoff state are updated in MCP.
4. If you lack DB access, prepare a deployable handoff instead of pretending to deploy.
5. Leave a clean, specific Git history.
6. Record durable workflow state in MCP, not only in chat.
7. If the work revealed a follow-up improvement or cleanup opportunity, create the next proposal instead of leaving a hidden TODO behind.

## 10. Default Escalation Rule

Escalate instead of improvising when:

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
