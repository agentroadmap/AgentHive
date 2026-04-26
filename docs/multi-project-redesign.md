# AgentHive Multi-Project Redesign — `hiveCentral` + `agenthive` (self-evo) + Project Tenant DBs

**Status:** Design v3 — incorporates Gemini + GPT v2 review feedback. Both reviewers approved with conditions; v3 resolves those conditions (2026-04-26).
**Audience:** Architects + senior engineers who will implement P501→P518.
**Date:** 2026-04-26.
**Supersedes (in part):** the "everything in one DB" assumption baked into today's `roadmap.*` schemas.
**Companion docs:** `docs/multi-project-redesign-gemini-review.md`, `docs/multi-project-redesign-chatgpt-review-after-gemini.md`, `docs/multi-project-redesign-gemini-review-v2.md`, `docs/multi-project-redesign-chatgpt-review-after-gemini-v2.md`.

---

## R2. Revision notes (v2 → v3)

Gemini's v2 review and GPT's v2 review both approved v2 ("lock v2 and proceed to P530") with five tracked items. v3 promotes all five into the architecture document so they don't drift into implementation backlog.

| # | v2 reviewer concern (must-have / recommended)              | v3 response                                                                                                                                                                                                                                                                                            |
|---|------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | (must) Budget-dependency deadlock policy is *inevitable*, not edge-case | **§6.1** now defines a **dependency unblock reserve** (default 80% ordinary / 20% reserved) directly in `project_budget_policy`. Cross-tenant dependency-blocker dispatches draw from the reserve; ordinary dispatches cannot. GPT's preferred Option 1, formalized in schema. Deadlock prevention becomes a structural property, not a runtime heuristic. |
| 2 | (must) P530.10 must be **Tenant Lifecycle Control**, not just schema | **§5.8 new** — full tenant lifecycle bounded context covering provisioning (DB creation, schema bootstrap, template seed, grants, secrets, observability registration), lifecycle (upgrades, cloning, backup, archival, restore, retirement), and operations (naming, encryption, replication, quotas, noisy-neighbor). P530.10 in §17 renamed accordingly.        |
| 3 | (must) Control-plane disaster recovery model               | **§11.3 new** — explicit RPO/RTO targets, failover model, region strategy, active-lease handling during failover, orphan-lease reconciliation. Control-plane DR is treated separately from tenant DR.                                                                                                  |
| 4 | (rec) Policy engine extensibility seam                      | **§9.5 new** — a `PolicyEvaluator` port abstraction with a v1 hard-coded implementation and a documented graduation path to OPA / declarative constraints + policy evaluation trace. Grants / budgets / gating / workload-id / dependency rules all flow through this single seam.                  |
| 5 | (rec) Proposal tiering to prevent proposal inflation        | **§4.5 new** — three tiers (A: architectural/governed, B: normal project, C: lightweight operational). Each tier has different gating rigor, two-person-review requirements, and minimum AC. Prevents agents from drowning in paperwork on small changes.                                       |
| 6 | (caveat) "Single process first" — guard against singleton semantics | **§11.0** updated with a CI lint rule: any code that assumes singleton semantics (in-memory locks, process-scoped counters, "the orchestrator" singletons) must be marked `@singleton-fragile` and surveyed quarterly. The clustering migration is now a tracked work item, not aspirational.    |
| 7 | (Gemini) Continuous "shadow-link" auditor for cross-project deps | **§6.4** updated — the consistency check graduates from nightly to continuous (NOTIFY-driven on tenant proposal mutations) once cross-project edges exceed 50.                                                                                                                                       |
| 8 | (Gemini) Audit-chain re-hash speed                           | **§9.6** updated — verification job uses incremental hash-chain windows (last 24 h on every cycle, 7-day full re-verify weekly) so detection latency stays bounded as the chain grows. Hash chain is partition-pruning compatible.                                                                  |

The remaining v2 reviewer items (deadlock #1, P530.10 #2, DR #3) are **architectural commitments**, not "follow-up enhancements." They land in v3 schema and process docs, and ship in P530's first milestone.

---

## R. Revision notes (v1 → v2)

The reviewers raised valid concerns. v1 restrictions were never meant as permanent invariants — they were scope-control choices for the current small-project phase. v2 keeps those restrictions for v1 implementation but **explicitly leaves room for the expansion paths** the reviewers asked for, without over-complicating the v1 build:

| # | Reviewer concern                                          | v2 response                                                                                                                                                                                                                                                       |
|---|-----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1 | "1 central orchestrator process" is a SPOF                 | **Keep single-process v1; design for clustered logical orchestrator.** Section 11 now explicitly marks the single process as "implementation v0," states the lease/work-offer primitives already support multi-instance, and notes the cluster-ready boundaries. |
| 2 | Self-evolution needs harder isolation                      | **`hiveCentral` (control plane) and `agenthive` (self-evo project) are now separate databases.** Self-evo proposals live in the `agenthive` tenant DB just like any other project's proposals. The `is_self_evo` flag stays as a project-registry attribute used for routing and elevated gating, but no schema in `hiveCentral` holds proposals. The `orchestration_self` schema is deleted. See Section 4 below. |
| 3 | Postgres as message bus is seductive but limited          | **Stay Postgres for v1; abstract A2A transport behind a port interface.** Section 7 adds a `MessageTransport` adapter abstraction so future swap to NATS / Kafka / Redpanda is a config change, not a rewrite.                                                    |
| 4 | Observability deserves first-class bounded-context status  | **`observability` is now its own schema** (was buried in `efficiency`). Section 5 lists it as a top-level central concern alongside `governance` and `messaging`. See Section 5.7.                                                                                |
| 5 | Add an event-sourcing spine for replay/audit              | **Adopted (lean v1).** Each lifecycle table gets a paired `*_event` append-only log written in the same txn. Not a full event-sourcing rewrite — just the spine. Section 5.7 (observability) and Section 11 cover this.                                            |
| 6 | Cross-project dependencies → central graph                 | **Adopted.** New `hiveCentral.dependency.cross_project_dependency` schema (graph edges). Section 6.4.                                                                                                                                                              |
| 7 | Workload identity per spawn (not just per agency)         | **Adopted.** Every spawn gets a short-lived signed workload identity scoped to one task. Section 9 layer 3.                                                                                                                                                        |
| 8 | Tamper-evident audit chain                                 | **Adopted (cheap, high value).** `governance.decision_log` rows carry `prev_hash` linking each entry to the previous; verification job runs nightly. Section 9 layer 6.                                                                                            |
| 9 | Metadata caching strategy is first-order architecture     | **Adopted.** Section 7.5 defines a central-metadata cache layer with explicit TTLs, invalidation via NOTIFY, and stale-grant fallback behavior.                                                                                                                    |
| 10 | Templates as immutable versioned APIs                     | **Adopted.** `template.workflow_template` rows are immutable; new versions get a new `template_id`. Projects pin to a specific `template_id`; upgrades require a self-evo proposal. Section 5.5.                                                                  |
| 11 | A2A retention may be too short for long-running deliberations | **Two-tier retention.** Hot tier 14d in `messaging.a2a_message`; cold tier indefinite when a message is referenced by a `proposal_review` or `proposal_decision`. Promotion via FK. Section 7.                                                                  |
| 12 | Sandbox per-task vs per-lease overhead                    | **Per-lease sandbox by default; per-task only when policy demands it.** A lease holds the sandbox; tool calls reuse it. New flag `sandbox_definition.scope = lease|task`. Section 10.                                                                              |
| 13 | Central catalogs risk becoming master-data swamp          | **Every central schema has an owner and a deprecation mechanism.** Catalog rows carry `owner_did`, `lifecycle_status` (`active|deprecated|retired`), and `retire_after`. Section 5 prelude.                                                                        |
| 14 | Project budget is mixing 3 jobs                            | **Split into three concerns:** budget *policy* (central), spend *enforcement* (tenant dispatch hook), portfolio *finance rollup* (central analytics). Section 6.1.                                                                                                  |

The remaining restrictions (no project workflow customization, no cross-DB joins, single-host default placement) **stay for v1** but are explicitly marked as scope-control, not architectural invariants — Section 14 lists what relaxes when.

---

## 0. Identity of the platform

> **AgentHive is an agent-native platform for product development. Work is driven by proposals. Autonomous AI agencies iterate the workflow until proposals reach acceptance. The proposal hierarchy and the repo artifacts that proposals produce are the durable product. The workflow that gets us there is scaffolding — it fades.**

Two consequences shape the entire data model:

1. **Proposals are project-scoped by default**, because proposals describe product work. The exception is **AgentHive self-evolution proposals**, which live in the AgentHive project itself.
2. **The agency layer (CLI auth, models, routes, credentials, workforce, efficiency, tools, templates) is centrally managed**, because it is shared infrastructure across all projects.

Everything below is downstream of those two sentences.

---

## 1. Topology

```
                            ┌─────────────────────────────────────────┐
                            │  MAIN HOST (control-plane node)         │
                            │  ┌────────────────────────────────────┐ │
                            │  │  PostgreSQL Instance               │ │
                            │  │  ┌──────────────────────────────┐  │ │
                            │  │  │  hiveCentral  (control DB)   │  │ │
                            │  │  │   identity / agency / agent  │  │ │
                            │  │  │   models / routes / creds    │  │ │
                            │  │  │   workflow templates         │  │ │
                            │  │  │   project registry (DSNs)    │  │ │
                            │  │  │   observability / governance │  │ │
                            │  │  │   NO proposals — registry only │ │
                            │  │  └──────────────────────────────┘  │ │
                            │  │  ┌──────────────────────────────┐  │ │
                            │  │  │  agenthive  (self-evo tenant)│  │ │
                            │  │  │   AgentHive's OWN proposals  │  │ │
                            │  │  │   treated like any project   │  │ │
                            │  │  │   marked is_self_evo=true    │  │ │
                            │  │  ├──────────────────────────────┤  │ │
                            │  │  │  monkeyKing-audio (tenant)   │  │ │
                            │  │  │  georgia-singer  (tenant)    │  │ │
                            │  │  │  …                            │  │ │
                            │  │  └──────────────────────────────┘  │ │
                            │  └────────────────────────────────────┘ │
                            │  Central Orchestrator (1 process)       │
                            └──────────────────────────────────────────┘
                                          ▲   ▲   ▲
                       ┌──────────────────┘   │   └──────────────────┐
                       │                      │                      │
              ┌────────┴────────┐    ┌────────┴────────┐    ┌────────┴────────┐
              │ Claude Agency   │    │  Codex Agency   │    │ Copilot Agency  │ …
              │ (claude-code)   │    │   (codex CLI)   │    │ (copilot CLI)   │
              │  models[]       │    │   models[]      │    │   models[]      │
              │  routes[]       │    │   routes[]      │    │   routes[]      │
              │  credentials    │    │   credentials   │    │   credentials   │
              │  workforce[]    │    │   workforce[]   │    │   workforce[]   │
              └─────────────────┘    └─────────────────┘    └─────────────────┘
                                          │
                              spawned into project context
                                          ▼
                       ┌──────────────────────────────────────┐
                       │  PROJECT (1)                          │
                       │  ┌────────────────────────────────┐  │
                       │  │  Tenant DB (1)  — agenthive    │  │
                       │  │  - project proposals (truth)   │  │
                       │  │  - project budget / spend       │  │
                       │  │  - project skill grants        │  │
                       │  │  - project efficiency rollups  │  │
                       │  │  - project domain data          │  │
                       │  └────────────────────────────────┘  │
                       │  Hosts (1+)                          │
                       │   ├─ Source Repo (1)                 │
                       │   │   └─ Remote(s): GitLab, GitHub   │
                       │   │   └─ Worktrees (n)               │
                       │   └─ Agent OS users (1+)             │
                       └──────────────────────────────────────┘
```

**Counting from the spec:**

| Cardinality | Entity                                                                |
|-------------|-----------------------------------------------------------------------|
| 1           | Main host (control plane)                                             |
| 1           | PostgreSQL instance on that host                                      |
| 1           | Control-plane database — default name `hiveCentral`, configurable     |
| 1+          | Orchestrator process(es) — single-process v0; clustered logical orchestrator path designed-in (§11) |
| n           | Agencies (one per provider CLI: claude-code, codex, copilot, hermes…) |
| ↳ n         | Models per agency                                                     |
| ↳ n         | Agents (workforce members) per agency, with cross-cutting expertise   |
| n           | Projects, each with a dedicated tenant DB                             |
| ↳ 1        | The `agenthive` project is a tenant just like the others, marked `is_self_evo=true`; holds AgentHive's own proposals |
| ↳ 1+        | Hosts per project                                                     |
| ↳↳ 1        | Source repository per host                                            |
| ↳↳↳ 1+      | Remote repository (GitLab, GitHub) per source repo                    |
| ↳↳↳ n       | Worktrees per source repo                                             |
| ↳↳ 1+       | Agent OS user(s) per host                                             |

---

## 2. Naming — `hiveCentral`, configurable per installation

The default control-DB name is **`hiveCentral`**. It is configurable at install time via `databases.control.name` in `roadmap.yaml` or the `PGDATABASE` env override, and renameable post-deploy via `ALTER DATABASE … RENAME TO` plus a coordinated config update. **No code references the literal name** — every service reads it from env / `roadmap.yaml` at startup. CONVENTIONS.md §6.0 is the canonical statement of this rule.

---

## 3. The boundary — what lives where

This is the one rule everything else hangs on.

### Lives in `hiveCentral` (the control plane)

Anything that is **shared across projects** or that **manages the platform itself**.

| Schema           | Owns                                                                                                                                                                                                                                                              | Why central                                                                                                                                       |
|------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| `core`           | `installation`, `host`, `os_user`, `runtime_flag`                                                                                                                                                                                                                 | Singletons + per-host state                                                                                                                       |
| `identity`       | `principal`, `principal_key`, `did_document`, `trust_grant`, `audit_action`                                                                                                                                                                                       | Who is who, signed by what, allowed to do what                                                                                                    |
| `agency`         | `agency_provider`, `agency`, `agency_session`, `liaison_message`, `liaison_message_kind_catalog`                                                                                                                                                                  | Provider directory + session lifecycle + A2A protocol catalog                                                                                     |
| `model`          | `model`, `model_route`, `host_model_policy`, `model_capability`                                                                                                                                                                                                   | One global routing table; agencies bind to models, projects don't pick models directly                                                            |
| `credential`     | `credential`, `credential_grant`, `credential_rotation_log`, `vault_provider`                                                                                                                                                                                     | All API tokens, OAuth grants, signing keys; pointers only — plaintext lives in vault                                                              |
| `workforce`      | `agent`, `agent_role`, `agent_skill`, `agent_capability`, `agent_persona`                                                                                                                                                                                         | Cross-project agent profiles ("Senior Backend", "Skeptic Alpha"); projects grant them, never define them                                          |
| `template`       | `workflow_template`, `state_name`, `gate_definition`, `proposal_template`                                                                                                                                                                                         | Central catalog. Projects copy from here, **cannot customize** in v1.                                                                             |
| `tooling`        | `tool`, `mcp_tool`, `cli_tool`, `tool_grant`                                                                                                                                                                                                                      | Shared utilities (psql, gh, git, MCP tools); grants per project                                                                                   |
| `sandbox`        | `sandbox_definition`, `boundary_policy`, `egress_rule`, `mount_grant`                                                                                                                                                                                             | Reusable sandbox profiles; central security policy                                                                                                |
| `project`        | `project`, `project_db`, `project_host`, `project_repo`, `project_remote`, `project_worktree`, `project_member`, `project_budget_policy`, `project_skill_grant`, `project_route_grant`, `project_sandbox_grant`                                                  | Registry — DSN pointers, repo URLs, worktree paths, who can access, budget *policy*, which workforce skills/routes/sandboxes the project may use   |
| `dependency`     | `cross_project_dependency` (graph edges; `from_proposal` → `to_proposal` across tenants), `dependency_kind_catalog` (`blocks`, `informed_by`, `supersedes`)                                                                                                       | The only place a cross-project edge can live (no cross-DB FK)                                                                                     |
| `efficiency`     | `efficiency_metric` (rollup), `cost_ledger_summary`, `dispatch_metric_summary`                                                                                                                                                                                    | Cross-project efficiency rollups; raw per-project metrics are stored in tenant DBs and rolled up here                                             |
| `observability`  | `trace_span`, `agent_execution_span`, `proposal_lifecycle_event`, `model_routing_outcome`, `decision_explainability`                                                                                                                                              | First-class bounded context; debugging agent systems is mostly observability (was buried in efficiency in v1)                                     |
| `messaging`      | `a2a_topic`, `a2a_message`, `a2a_subscription`, `a2a_dlq`, `a2a_message_archive` (cold tier for messages referenced by proposals)                                                                                                                                 | One A2A bus across all projects and agencies; transport abstracted via `MessageTransport` adapter                                                 |
| `governance`     | `decision_log` (hash-chained), `policy_version`, `compliance_check`, `event_log` (event-sourcing spine)                                                                                                                                                           | Tamper-evident audit chain that survives tenant DB deletion                                                                                       |

### Lives in each project's tenant DB

Anything that is **scoped to one product**. **The `agenthive` tenant DB is one of these** — AgentHive's own proposals live in `agenthive.proposal.proposal` exactly like any other project's. The only difference is `project.is_self_evo = true` in the central registry, which the orchestrator uses to apply elevated gating (mandatory shadow-test phase before MERGE) and stricter sandbox profiles.

| Schema (per tenant)  | Owns                                                                                                                                                                                                                                                | Why tenant                                                                                                                              |
|----------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `proposal`           | `proposal`, `proposal_section`, `proposal_dependency`, `proposal_decision`, `proposal_review`, `proposal_artifact`, `proposal_lease`, `gate_decision`                                                                                               | **Proposals are the durable product of the project.** They live with the project they describe, not with the platform that built them. |
| `cubic`              | `cubic`, `cubic_state`, `cubic_artifact`                                                                                                                                                                                                            | Project-scoped execution context for proposals                                                                                          |
| `dispatch`           | `dispatch`, `work_offer`, `work_claim`, `briefing`, `assistance_request`                                                                                                                                                                            | Project-local dispatch state; orchestrator writes here when dispatching for this project                                                |
| `efficiency`         | `efficiency_event` (raw), `cost_ledger` (raw), `dispatch_metric` (raw)                                                                                                                                                                              | Raw per-project metrics. Periodically rolled up into `hiveCentral.efficiency.*`.                                                        |
| `workflow_active`    | `workflow_template_copy`, `workflow_state_assignment`                                                                                                                                                                                               | A copy of the template chosen at project bootstrap. **Read-only in v1** — projects cannot customize.                                    |
| `<domain_schemas>`   | Project-chosen (e.g. `audio.*`, `song.*`, `app.*`)                                                                                                                                                                                                  | The actual product data                                                                                                                  |

**The rule, in one sentence:** *if a row identifies a project, it goes in that project's tenant DB; if a row identifies the platform itself, it goes in `hiveCentral`.*

### The keystone foreign-key invariant

```sql
-- hiveCentral.project.project — the only place project metadata lives
project (
  project_id      BIGSERIAL PRIMARY KEY,
  slug            CITEXT UNIQUE NOT NULL,
  display_name    TEXT NOT NULL,
  is_self_evo     BOOLEAN NOT NULL DEFAULT false,  -- true only for the AgentHive project itself
  status          TEXT NOT NULL,                    -- active|archived|suspended
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'
);

-- hiveCentral.project.project_db — DSN pointers (one row per DB the project owns)
project_db (
  project_db_id    BIGSERIAL PRIMARY KEY,
  project_id       BIGINT NOT NULL REFERENCES project (project_id),
  role             TEXT NOT NULL,           -- primary|read_replica|analytics
  host_id          BIGINT NOT NULL REFERENCES core.host,
  db_name          TEXT NOT NULL,
  schema_prefix    TEXT,
  credential_id    BIGINT NOT NULL REFERENCES credential.credential,
  UNIQUE (project_id, role)
);
```

**`project_id` is a pointer to a tenant DB — never a row discriminator inside `hiveCentral`.** No `WHERE project_id = $1` filter ever appears on a `hiveCentral` table other than `project.*`, `dependency.*`, and rollup tables (`efficiency.*`, `observability.*`) where project_id is intentionally a grouping key for cross-project analytics.

**Self-evolution does not break this rule.** AgentHive's own proposals live in `agenthive.proposal.proposal` (a tenant DB), not in `hiveCentral`. The `is_self_evo = true` flag in `project.project` only changes orchestrator routing behavior, never row placement.

**Cross-DB joins are forbidden.** A handler that needs both control-plane and tenant data issues two queries and joins in code. This is the single rule that makes per-tenant placement flexibility (move a project to its own host later) a config change rather than a re-architecture.

---

## 4. Proposals — the durable product

### Lifecycle

```
DRAFT  ──▶  REVIEW  ──▶  DEVELOP  ──▶  MERGE  ──▶  COMPLETE
  │            │             │            │
  └────────── DISCARDED ◀────┴────────────┘   (abandoned at any stage)
```

Each state carries a **maturity**: `new`, `active`, `mature`, `obsolete`.
Each state has **gate criteria** defined by the workflow template.

### Where proposals live

```
Tenant DB <project>.proposal.proposal               -- ALL proposals, including self-evo
  ├─ proposal_section     (free-form structured doc; markdown + YAML frontmatter)
  ├─ proposal_dependency  (DAG edges within the same project)
  ├─ proposal_decision    (gate decisions; immutable once written)
  ├─ proposal_review      (review notes; stage-gated)
  ├─ proposal_artifact    (links to repo paths, files, PRs, external docs)
  └─ proposal_lease       (current claim — who is working on it, when expires)

agenthive.proposal.proposal                          -- AgentHive's own proposals
  └─ same shape; the agenthive project is just another tenant
     marked is_self_evo=true in hiveCentral.project.project

hiveCentral.dependency.cross_project_dependency      -- only cross-tenant edges
  └─ from_project_id, from_proposal_id, to_project_id, to_proposal_id, kind
     (no cross-DB FK; integrity enforced by app + nightly consistency check)
```

### Proposals as documentation

> "project proposals will become single truth for documentation, the workflow facilitated the development will fade. In the end, it's the hierarchical proposals and its details, artifact in repo persist as the product we build"

Concrete implications:

1. **Proposals are markdown-first.** `proposal_section` stores structured markdown blocks (intent, design, acceptance criteria, drawbacks, alternatives, decision log). The DB is the canonical store; rendered docs (HTML, PDF) are ephemeral derivatives.
2. **Proposals are hierarchical.** `proposal.parent_id` lets a project hold one root product proposal, child epic proposals, and grandchild story/task proposals. Browsing the tree is the primary navigation.
3. **Acceptance criteria become tests.** Every proposal that ships code must reference at least one test in `proposal_artifact` (kind=`test`). When the test passes in CI, the artifact link is the receipt.
4. **Workflow tables fade.** `cubic`, `dispatch`, `work_offer`, `briefing`, `assistance_request` are operational. After a proposal completes and shipped, those rows can be archived to cold storage. The proposal + the repo commits + the artifact links are what remain.
5. **Repo is the other half of truth.** Every proposal references commits, files, PRs in the project's repo. The repo is the executable form of the proposal; the proposal is the rationale for the repo.

### 4.5 Proposal tiers (anti-inflation, per GPT v2 caution)

Not every change deserves the cathedral process. Proposals carry a `tier` column with three values:

| Tier | Name                                | What it covers                                                                                                                  | Gating rigor                                                  |
|------|-------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------|
| **A** | Architectural / governed           | Schema changes, security policy, cross-project dependency, budget policy, workforce additions, template publishes, self-evo merges | Two-person review required. Full RFC sections. Mandatory shadow-test for self-evo.   |
| **B** | Normal project (default)           | Feature work, refactors, non-trivial bug fixes, new agents added to a project                                                    | One-person gate review. Standard sections. Tests required.    |
| **C** | Lightweight operational            | Typo fixes, log-level adjustments, doc edits, dependency bumps within semver minor, hotfix-tier ops                              | Auto-advance through gates if tests pass + at least one peer ack. No multi-section RFC required. |

```sql
proposal.proposal (
  ...
  tier              TEXT NOT NULL DEFAULT 'B' CHECK (tier IN ('A','B','C')),
  tier_set_by_did   TEXT NOT NULL,
  tier_set_reason   TEXT,
  ...
);
```

**Tier promotion is one-way:** a Class C proposal that turns out to be architectural is **demoted to draft and reborn as Class A**, not silently upgraded. This forces the architectural conversation that the original Class C label was avoiding.

**Tier auditor:** quarterly job samples completed Class C proposals and re-evaluates whether they should have been B or A; mis-classification rates are reported in `governance.compliance_check`.

### Self-evolution proposals (now a tenant, not a special case)

**v2 change (per GPT review).** AgentHive's own proposals live in the `agenthive` tenant DB exactly like any other project. The control plane (`hiveCentral`) holds **zero** proposals — it is purely registry, catalog, routing, observability, governance.

The `agenthive` tenant is marked `project.is_self_evo = true`. That flag changes orchestrator behavior in three ways:

1. **Elevated gating:** self-evo proposals require a mandatory shadow-test phase between DEVELOP and MERGE — the change is applied to a temporary copy of `hiveCentral` and a smoke-test suite runs against it.
2. **Stricter sandbox profile:** spawns for self-evo dispatches use `sandbox/self-evo-restricted`, which has read-only access to all tenant DBs, write access only to a feature branch in the agenthive worktree, and tighter egress.
3. **Two-person review:** the gate review for any self-evo MERGE requires a decision from at least two distinct principals. Single-agent auto-merge is forbidden.

**Why this is safer than v1's `orchestration_self`:** the platform managing itself is operationally identical to the platform managing any other project. There is no "god mode" code path. A bug in self-evo dispatch can be fixed using the same orchestrator that handles project dispatches. The blast radius of a failed self-evo proposal is bounded by the shadow-test phase, not by a separate dual-path implementation.

This is the ONLY thing that distinguishes AgentHive from any other tenant. There is no `orchestration_self` schema. There are no self-only tables. There is one orchestrator code path.

---

## 5. Centrally-managed concerns (one canonical home each)

### 5.0 Universal catalog hygiene (anti-swamp guardrails)

Every central catalog table — `model.model`, `agency.agency_provider`, `workforce.agent`, `template.workflow_template`, `tooling.tool`, `sandbox.sandbox_definition`, `credential.credential` — carries the same five fields:

```sql
owner_did         TEXT NOT NULL,                  -- who is responsible
lifecycle_status  TEXT NOT NULL DEFAULT 'active', -- active|deprecated|retired
deprecated_at     TIMESTAMPTZ,
retire_after      TIMESTAMPTZ,                    -- hard cutoff; rows past this fail dispatch
notes             TEXT
```

Catalog rows are **never deleted**, only retired. A row in `lifecycle_status='retired'` is invisible to dispatch but still resolvable for historical audit. Quarterly catalog-hygiene job posts a report listing rows past `retire_after` so owners can clean up. This is the safety valve against central plane ossification.

### 5.1 Agency authentication (CLI auth)

```sql
agency.agency_provider (
  provider_id      TEXT PRIMARY KEY,        -- 'claude-code', 'codex', 'copilot', 'hermes'
  display_name     TEXT NOT NULL,
  cli_command      TEXT NOT NULL,           -- 'claude', 'codex', 'copilot', etc.
  auth_kind        TEXT NOT NULL,           -- 'api_key', 'oauth', 'github_app', 'session'
  auth_credential_id BIGINT REFERENCES credential.credential,
  default_sandbox_id BIGINT REFERENCES sandbox.sandbox_definition,
  is_enabled       BOOLEAN NOT NULL DEFAULT true,
  metadata         JSONB NOT NULL DEFAULT '{}'
);

agency.agency (
  agency_id        TEXT PRIMARY KEY,        -- e.g. 'claude/agency-bot'
  provider_id      TEXT NOT NULL REFERENCES agency.agency_provider,
  host_id          BIGINT NOT NULL REFERENCES core.host,
  os_user_id       BIGINT NOT NULL REFERENCES core.os_user,
  signing_key_id   BIGINT NOT NULL REFERENCES identity.principal_key,
  display_name     TEXT NOT NULL,
  status           TEXT NOT NULL,           -- 'active', 'paused', 'dormant', 'retired'
  capabilities     TEXT[] NOT NULL,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

CLI auth is provider-level: one credential per provider on this host. Per-agent variation is achieved via models, not auth.

### 5.2 Models, routes, credentials

```sql
model.model (
  model_id         TEXT PRIMARY KEY,        -- 'claude-opus-4-7', 'gpt-4o', 'codex-large'
  provider_id      TEXT NOT NULL REFERENCES agency.agency_provider,
  context_window   INT NOT NULL,
  cost_in_per_1k   NUMERIC,
  cost_out_per_1k  NUMERIC,
  capabilities     TEXT[] NOT NULL,         -- 'code', 'review', 'long-context', 'tool-use'
  is_enabled       BOOLEAN NOT NULL DEFAULT true
);

model.model_route (
  route_id         TEXT PRIMARY KEY,        -- 'claude-default', 'fast-claude', 'cheap-codex'
  model_id         TEXT NOT NULL REFERENCES model.model,
  cli_path         TEXT,                    -- absolute path to CLI binary if non-default
  rate_limit_rpm   INT,
  rate_limit_tpm   INT,
  priority         INT NOT NULL DEFAULT 100,
  is_enabled       BOOLEAN NOT NULL DEFAULT true
);

model.host_model_policy (
  host_id          BIGINT NOT NULL REFERENCES core.host,
  route_id         TEXT NOT NULL REFERENCES model.model_route,
  is_allowed       BOOLEAN NOT NULL,
  PRIMARY KEY (host_id, route_id)
);
```

Per-host model policy enforces "this host may only use these routes" — useful when a host has data-residency constraints or budget limits.

### 5.3 Credentials & secret management

**Principle: the database never stores plaintext secrets.**

```sql
credential.vault_provider (
  vault_provider_id TEXT PRIMARY KEY,       -- 'systemd_credential', 'file_vault', 'aws_sm', 'vault'
  config            JSONB NOT NULL          -- adapter-specific
);

credential.credential (
  credential_id     BIGSERIAL PRIMARY KEY,
  kind              TEXT NOT NULL,          -- 'pg_password', 'api_key', 'oauth_token', 'signing_key'
  vault_provider_id TEXT NOT NULL REFERENCES credential.vault_provider,
  vault_path        TEXT NOT NULL,          -- pointer the provider understands; never the value
  rotation_policy   TEXT NOT NULL,          -- 'never', 'on_demand', 'daily', 'weekly', 'monthly'
  last_rotated_at   TIMESTAMPTZ,
  next_rotation_at  TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'
);

credential.credential_grant (
  credential_id     BIGINT REFERENCES credential.credential,
  principal_did     TEXT NOT NULL,          -- 'did:agency:claude-code/agency-bot'
  permitted_ops     TEXT[] NOT NULL,        -- 'read', 'rotate'
  granted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by_did    TEXT NOT NULL,
  expires_at        TIMESTAMPTZ
);

credential.credential_rotation_log (
  log_id            BIGSERIAL PRIMARY KEY,
  credential_id     BIGINT NOT NULL REFERENCES credential.credential,
  rotated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_by_did    TEXT NOT NULL,
  outcome           TEXT NOT NULL,          -- 'success', 'failure'
  reason            TEXT
);
```

**Token security for agency credentials:** Per-agency provider creds live in vault under `agency/<agency_id>/<credential_kind>`. The pointer is `agency.agency.signing_key_id` and `agency.agency_provider.auth_credential_id`. Agencies authenticate to the orchestrator via **Ed25519 keypair** (public key in `identity.principal_key`, private key in vault), not a bearer token. Third-party API tokens are pulled fresh per spawn — no persistent token in the agency process memory longer than necessary.

**Today's transition:** existing `/etc/agenthive/env` plaintext creds remain during bootstrap; new code paths must go through `getCredential(credential_id)`. Migration to fully vaulted creds is a follow-up wave.

### 5.4 Workforce — the agent catalog

```sql
workforce.agent (
  agent_id         BIGSERIAL PRIMARY KEY,
  agent_name       TEXT UNIQUE NOT NULL,    -- 'senior-backend', 'skeptic-alpha', 'product-manager'
  display_name     TEXT NOT NULL,
  description      TEXT,
  default_persona  TEXT,                    -- system prompt / role primer
  default_route_id TEXT REFERENCES model.model_route,
  is_enabled       BOOLEAN NOT NULL DEFAULT true,
  metadata         JSONB NOT NULL DEFAULT '{}'
);

workforce.agent_skill (
  skill_id         BIGSERIAL PRIMARY KEY,
  skill_name       TEXT UNIQUE NOT NULL,    -- 'sql', 'react', 'k8s', 'compliance-review'
  description      TEXT,
  category         TEXT                     -- 'code', 'review', 'design', 'ops', 'research'
);

workforce.agent_capability (   -- which agents have which skills (proficiency level)
  agent_id         BIGINT NOT NULL REFERENCES workforce.agent,
  skill_id         BIGINT NOT NULL REFERENCES workforce.agent_skill,
  proficiency      INT NOT NULL,            -- 1-10
  PRIMARY KEY (agent_id, skill_id)
);
```

**Agents are central. Projects do not define agents.** Projects use what's in the catalog.

### 5.5 Workflow templates — central, immutable, versioned, projects pin

Templates are treated as APIs (per GPT feedback #10). Each version is an immutable row; new versions get a new `template_id`.

```sql
template.workflow_template (
  template_id      TEXT PRIMARY KEY,        -- 'rfc-5-stage@v3', 'lightweight-3-stage@v1', 'compliance-7-stage@v2'
  family           TEXT NOT NULL,           -- 'rfc-5-stage' (the family, version-stripped)
  version          INT NOT NULL,            -- monotonic per family
  display_name     TEXT NOT NULL,
  description      TEXT,
  states           JSONB NOT NULL,          -- ordered state machine; immutable after publish
  gates            JSONB NOT NULL,          -- gate criteria per transition; immutable after publish
  published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- catalog hygiene fields (see §5.0):
  owner_did        TEXT NOT NULL,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  UNIQUE (family, version)
);

-- Project pin: hiveCentral.project.project.template_id (FK)
-- Tenant copy: <tenant>.workflow_active.workflow_template_copy is a snapshot for offline reading
```

**v1 rules:**
- A template row, once published, is immutable. Edits create a new version.
- Projects pin to a specific `template_id` at bootstrap (e.g. `rfc-5-stage@v3`).
- Projects cannot modify the template they pinned to.
- Upgrading a project from `@v3` to `@v4` requires a self-evo proposal in the agenthive tenant that documents what changed and migrates any in-flight proposals.

This prevents template drift, keeps the orchestrator simple, and means the same proposal that ran on `@v3` is reproducible against `@v3` forever. **v2 expansion path (when needed):** "composable workflow steps" remains the architectural north star but is explicitly out of scope until v1 is proven across at least 5 active projects.

### 5.6 Tooling — shared utilities

```sql
tooling.tool (
  tool_id          BIGSERIAL PRIMARY KEY,
  tool_name        TEXT UNIQUE NOT NULL,    -- 'psql', 'gh', 'git', 'mcp_proposal', 'mcp_agent'
  kind             TEXT NOT NULL,           -- 'cli', 'mcp', 'http_api'
  config           JSONB NOT NULL,
  is_enabled       BOOLEAN NOT NULL DEFAULT true
);

tooling.tool_grant (
  tool_id          BIGINT NOT NULL REFERENCES tooling.tool,
  project_id       BIGINT REFERENCES project.project,   -- NULL = global grant
  agency_id        TEXT REFERENCES agency.agency,        -- NULL = any agency
  permitted_ops    TEXT[] NOT NULL,
  PRIMARY KEY (tool_id, COALESCE(project_id, 0), COALESCE(agency_id, ''))
);
```

A tool is granted to (project, agency) combinations. Default grants are seeded; project-specific grants are added when a project needs a tool that isn't globally available (e.g., a project-specific MCP server).

### 5.7 Observability (first-class bounded context)

Per GPT feedback #11. Observability is its own schema, not a sub-concern of efficiency.

```sql
observability.trace_span (
  span_id            UUID PRIMARY KEY,
  trace_id           UUID NOT NULL,
  parent_span_id     UUID,
  operation          TEXT NOT NULL,           -- 'orch.dispatch', 'agency.claim', 'agent.tool_call'
  service_did        TEXT NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ,
  attributes         JSONB NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL,           -- 'ok' | 'error' | 'cancelled'
  error_message      TEXT
);

observability.agent_execution_span (
  span_id            UUID PRIMARY KEY REFERENCES observability.trace_span,
  agency_id          TEXT NOT NULL,
  agent_id           BIGINT NOT NULL,
  proposal_id        BIGINT,                  -- reference; may be in tenant DB
  project_id         BIGINT REFERENCES project.project,
  model_id           TEXT REFERENCES model.model,
  input_tokens       INT,
  output_tokens      INT,
  cost_usd           NUMERIC,
  briefing_id        UUID                     -- the contract handed to this spawn
);

observability.proposal_lifecycle_event (
  event_id           BIGSERIAL PRIMARY KEY,
  project_id         BIGINT REFERENCES project.project,
  proposal_display_id TEXT NOT NULL,           -- e.g. 'P527'
  from_state         TEXT,
  to_state           TEXT NOT NULL,
  from_maturity      TEXT,
  to_maturity        TEXT NOT NULL,
  triggered_by_did   TEXT NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  context            JSONB NOT NULL DEFAULT '{}'
);

observability.model_routing_outcome (
  outcome_id         BIGSERIAL PRIMARY KEY,
  trace_id           UUID NOT NULL,
  selected_route_id  TEXT NOT NULL REFERENCES model.model_route,
  candidate_routes   JSONB NOT NULL,           -- routes considered, scores
  selection_reason   TEXT NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

observability.decision_explainability (
  decision_id        BIGSERIAL PRIMARY KEY,
  trace_id           UUID NOT NULL,
  decision_kind      TEXT NOT NULL,            -- 'gate_advance', 'agent_assignment', 'budget_block'
  inputs             JSONB NOT NULL,
  rules_evaluated    JSONB NOT NULL,
  outcome            JSONB NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

This is the substrate for replaying autonomous behavior, generating training data, building dashboards, and explaining "why did the orchestrator pick agent X for proposal Y?" after the fact. Spans use OpenTelemetry semantics; future export to Jaeger / Tempo / Honeycomb is a config change.

**Retention:** trace data 30 days hot, archived to object storage thereafter. Lifecycle events kept indefinitely (cheap, valuable).

### 5.8 Tenant Lifecycle Control (per GPT v2 must-have #2)

Provisioning a tenant DB is the smallest part of tenant lifecycle. v3 makes this a first-class bounded context with a complete state machine.

```
┌────────────┐    ┌──────────────┐   ┌──────────┐   ┌─────────┐   ┌──────────┐   ┌────────┐
│ requested  │ ─▶ │ provisioning │ ─▶│  active  │ ─▶│ archived│ ─▶│ retiring │ ─▶│ retired│
└────────────┘    └──────────────┘   └──────────┘   └─────────┘   └──────────┘   └────────┘
                         │                │  ▲
                         ▼                ▼  │
                    [bootstrap fail]  [upgrading / migrating / cloning / restoring]
                         │                │
                         └─▶ [failed] ────┘
```

**Schema (central):**

```sql
project.tenant_lifecycle (
  project_id           BIGINT PRIMARY KEY REFERENCES project.project,
  state                TEXT NOT NULL,                    -- requested|provisioning|active|upgrading|archived|retiring|retired|failed
  state_reason         TEXT,
  template_id          TEXT NOT NULL REFERENCES template.workflow_template,
  template_pin_version INT NOT NULL,
  ddl_version          INT NOT NULL DEFAULT 0,           -- which schema-bootstrap script ran
  backup_policy        JSONB NOT NULL,                   -- { schedule, retention_days, target }
  encryption_strategy  TEXT NOT NULL DEFAULT 'at-rest-pg', -- at-rest-pg | tde | column-level
  resource_quota       JSONB NOT NULL,                   -- { max_connections, max_db_size_gb, statement_timeout }
  owner_did            TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  state_changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

project.tenant_lifecycle_event (
  event_id             BIGSERIAL PRIMARY KEY,
  project_id           BIGINT NOT NULL,
  from_state           TEXT,
  to_state             TEXT NOT NULL,
  triggered_by_did     TEXT NOT NULL,
  context              JSONB NOT NULL DEFAULT '{}',
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

project.tenant_backup (
  backup_id            UUID PRIMARY KEY,
  project_id           BIGINT NOT NULL REFERENCES project.project,
  taken_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup_kind          TEXT NOT NULL,                    -- 'logical' | 'physical' | 'snapshot'
  storage_uri          TEXT NOT NULL,
  size_bytes           BIGINT NOT NULL,
  retention_until      TIMESTAMPTZ NOT NULL,
  verified_at          TIMESTAMPTZ                       -- restore-test confirmation
);
```

**Provisioning flow (`requested → provisioning → active`):**

1. Create database `<slug>` owned by `agenthive_admin`
2. Create role `agenthive_tenant_<slug>` and grant CONNECT, schema-create on the new DB only
3. Apply tenant DDL bootstrap (schemas: `proposal`, `cubic`, `dispatch`, `efficiency`, `workflow_active`, plus project-chosen domain schemas)
4. Copy pinned `template.workflow_template@<version>` rows into `<tenant>.workflow_active.workflow_template_copy`
5. Seed default `<tenant>.efficiency.budget_enforcement_state`
6. Bootstrap secrets in vault: `tenant/<slug>/db_password`, `tenant/<slug>/encryption_key`
7. Register tenant in `project.project_db` with the DSN pointer + credential ref
8. Create observability stream registrations (trace destinations, lifecycle event topic subscription)
9. Register first `project_member` (the requesting principal) as owner
10. Verify by issuing read+write smoke-tests against the new DB; if any step fails, transition `provisioning → failed` with diagnostics in `state_reason`. Failed tenants leave no orphan resources — every step is idempotent and a cleanup job rolls back partials.

**Lifecycle operations:**

| Operation              | State path                                  | Notes                                                                                                   |
|------------------------|---------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Schema upgrade         | `active → upgrading → active`               | Runs the migration shipped with a new `template.workflow_template` version; bumps `ddl_version`         |
| Tenant cloning         | `active → … → active` (new project)         | Logical replication + structural copy; useful for forking projects                                       |
| Backup                 | (no state change)                            | Cron writes `tenant_backup` rows; restore-test job verifies a sample backup weekly                       |
| Restore                | `active → upgrading → active`               | From a `tenant_backup` row; pauses dispatch during restore                                              |
| Archival               | `active → archived`                          | DB stays online, read-only, dispatch disabled. Reversible via `archived → active`.                      |
| Retirement             | `archived → retiring → retired`              | Final logical backup taken, then `DROP DATABASE`. Catalog row stays for historical reference.           |

**Operations policy:**

- **Naming:** tenant DB name = `project.slug` exactly (e.g. `agenthive`, `monkeyKing-audio`). No suffixes, no version numbers.
- **Per-tenant encryption:** v1 = Postgres at-rest encryption (filesystem-level), v2 = column-level for sensitive fields, v3 = TDE when an enterprise tenant requires it. Strategy stored per tenant.
- **Logical replication approach:** physical streaming for HA (single hot standby per PG instance); logical replication only for cross-host tenant moves (Wave 5 path).
- **Resource quotas:** enforced via Postgres role parameters (`max_connections`, `statement_timeout`, `temp_file_limit`) + cgroup limits at the DB process level for noisy-neighbor protection.
- **Noisy-neighbor protection:** `pg_stat_statements` monitored per-tenant; tenants exceeding 80% of their CPU quota for > 5 min get a warning event in lifecycle log; exceeding 95% triggers throttle (statement_timeout halved temporarily).

**P530.10 = Tenant Lifecycle Control.** Implementation includes the state machine, all provisioning steps as reversible scripts, the backup/restore harness, and the noisy-neighbor monitoring. This ships in the first P530 milestone, before any non-agenthive project onboards.

---

## 6. Project-scoped concerns (lives in tenant DB, may be rolled up centrally)

### 6.1 Project budget — three concerns, three homes

Per GPT feedback #14, "project budget" was doing three jobs in v1. v2 splits them:

**Concern 1 — Budget *policy* (central, governance):**
```sql
hiveCentral.project.project_budget_policy (
  project_id              BIGINT PRIMARY KEY REFERENCES project.project,
  budget_period           TEXT NOT NULL,                  -- 'monthly' | 'quarterly' | 'annual'
  amount_usd              NUMERIC NOT NULL,
  ordinary_share          NUMERIC NOT NULL DEFAULT 0.80,   -- fraction available to ordinary dispatches
  unblock_reserve_share   NUMERIC NOT NULL DEFAULT 0.20,   -- fraction reserved for cross-tenant dependency unblockers
  alert_threshold         NUMERIC NOT NULL DEFAULT 0.8,    -- alert at 80% of ordinary share
  hard_cap                NUMERIC NOT NULL,                -- enforce_at_dispatch on ordinary share
  emergency_bypass_allowed BOOLEAN NOT NULL DEFAULT false,
  effective_from          TIMESTAMPTZ NOT NULL,
  effective_to            TIMESTAMPTZ,
  set_by_did              TEXT NOT NULL,
  approved_by_did         TEXT,
  CHECK (ordinary_share + unblock_reserve_share <= 1.0)
);
```
Set by humans / governance. Immutable once a period starts; changes go through self-evo proposal.

**Dependency unblock reserve (per GPT v2 must-have #1).** The reserve is the platform's structural answer to the deadlock pattern (A waits on B, B blocked by budget, deadlock forever). Default split 80/20:

- **Ordinary share (80%)** — funds normal dispatches. Hits hard-cap → proposal stalls in `budget_blocked`.
- **Unblock reserve (20%)** — funds *only* dispatches that satisfy ALL three conditions:
  1. The dispatching proposal is named in `hiveCentral.dependency.cross_project_dependency.to_proposal_id` with `kind='blocks'`
  2. The blocking edge has at least one `from_proposal` in `active` state (i.e. another project is genuinely waiting)
  3. The dispatch is not for a Class C proposal (Class C cannot consume reserve)

Reserve consumption is logged in `governance.decision_log` (kind=`unblock_reserve_draw`) so portfolio operators can see when the platform is structurally compensating for cross-project blockage. Reserve depletion (run-out before period end) is a strong signal that ordinary-share allocation is too lean and triggers an automatic budget review proposal.

**Concern 2 — Spend *enforcement* (tenant, dispatch hook):**
```sql
<tenant>.dispatch.budget_enforcement_state (
  -- materialized view-ish: current period spend, refreshed before each dispatch
  current_period_start  TIMESTAMPTZ NOT NULL,
  current_period_end    TIMESTAMPTZ NOT NULL,
  current_spend_usd     NUMERIC NOT NULL,
  budget_status         TEXT NOT NULL,        -- 'healthy' | 'warning' | 'blocked'
  last_refreshed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

<tenant>.efficiency.cost_ledger (
  ledger_id         BIGSERIAL PRIMARY KEY,
  proposal_id       BIGINT REFERENCES proposal.proposal,
  agency_id         TEXT NOT NULL,
  agent_id          BIGINT NOT NULL,
  route_id          TEXT NOT NULL,
  input_tokens      INT NOT NULL,
  output_tokens     INT NOT NULL,
  cost_usd          NUMERIC NOT NULL,
  spent_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
Orchestrator dispatch hook checks `budget_enforcement_state.budget_status` against the central `project_budget_policy.hard_cap`. If blocked, the proposal goes into `budget_blocked` state. Mid-flight leases are allowed to finish their current state transition (per Section 15 open question), then stall.

**Emergency bypass:** if `project_budget_policy.emergency_bypass_allowed = true`, dispatches with a proposal flagged `is_emergency_hotfix = true` (and host_id health degraded) skip the cap check. Audited in `governance.decision_log`. Per Gemini's feedback.

**Concern 3 — Portfolio finance *rollup* (central, analytics):**
```sql
hiveCentral.efficiency.cost_ledger_summary (
  project_id        BIGINT NOT NULL REFERENCES project.project,
  agency_id         TEXT NOT NULL,
  day               DATE NOT NULL,
  cost_usd          NUMERIC NOT NULL,
  PRIMARY KEY (project_id, agency_id, day)
);
```
Hourly rollup job aggregates tenant `cost_ledger` rows into the central summary. Powers dashboards and finance reports without cross-DB joins.

### 6.2 Project resources

Resources are agencies, agents, models, sandboxes, and tools that the project may use. Granted from the central catalog:

```sql
-- hiveCentral.project.project_skill_grant
project_skill_grant (
  project_id       BIGINT NOT NULL REFERENCES project.project,
  skill_id         BIGINT NOT NULL REFERENCES workforce.agent_skill,
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by_did   TEXT NOT NULL,
  PRIMARY KEY (project_id, skill_id)
);

-- hiveCentral.project.project_route_grant   (which model routes the project may invoke)
-- hiveCentral.project.project_sandbox_grant (which sandboxes the project may spawn into)
-- hiveCentral.project.project_tool_grant   (covered by tooling.tool_grant)
```

Granting a skill to a project means: any agent in the workforce catalog with that skill is dispatchable for proposals in that project. Removing a skill doesn't kill in-flight work, but blocks new dispatches.

### 6.3 Efficiency

Two layers:

| Layer        | Where it lives                                  | Granularity                    |
|--------------|-------------------------------------------------|--------------------------------|
| Raw events   | `<tenant>.efficiency.efficiency_event`          | Per dispatch, per tool call    |
| Project rollup | `<tenant>.efficiency.cost_ledger_summary`     | Per agent, per day, per project |
| Central rollup | `hiveCentral.efficiency.efficiency_metric`    | Per project, per agency, per day |

The central rollup answers questions like "which agency is most cost-efficient for code-review work?" without joining across tenant DBs at query time. A scheduled job aggregates raw → tenant rollup → central rollup hourly.

### 6.4 Cross-project dependencies (central graph)

Per GPT feedback #6 + Gemini's concurring note. A proposal in tenant A may block / inform / supersede a proposal in tenant B. Cross-DB FK is impossible. The dependency lives centrally as a graph edge:

```sql
hiveCentral.dependency.dependency_kind_catalog (
  kind                TEXT PRIMARY KEY,    -- 'blocks' | 'informed_by' | 'supersedes' | 'requires_artifact'
  description         TEXT NOT NULL,
  is_directional      BOOLEAN NOT NULL DEFAULT true,
  cycle_check         BOOLEAN NOT NULL DEFAULT true   -- nightly job rejects cycles for this kind
);

hiveCentral.dependency.cross_project_dependency (
  edge_id             BIGSERIAL PRIMARY KEY,
  from_project_id     BIGINT NOT NULL REFERENCES project.project,
  from_proposal_id    BIGINT NOT NULL,           -- references <from_tenant>.proposal.proposal — soft FK
  from_proposal_display_id TEXT NOT NULL,         -- e.g. 'P527' for human reading
  to_project_id       BIGINT NOT NULL REFERENCES project.project,
  to_proposal_id      BIGINT NOT NULL,           -- references <to_tenant>.proposal.proposal — soft FK
  to_proposal_display_id TEXT NOT NULL,
  kind                TEXT NOT NULL REFERENCES dependency.dependency_kind_catalog,
  declared_by_did     TEXT NOT NULL,
  declared_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata            JSONB NOT NULL DEFAULT '{}',
  UNIQUE (from_project_id, from_proposal_id, to_project_id, to_proposal_id, kind)
);
```

**Integrity:** the FKs to tenant proposals are soft (no constraint) because Postgres can't enforce cross-DB FK. v1 ships a **nightly consistency check job** that verifies every referenced proposal still exists in the target tenant DB; orphan edges are flagged in `governance.decision_log` for review (not auto-deleted, because deletion may be a real signal).

**v2 graduation — continuous shadow-link auditor (per Gemini v2 feedback).** When `cross_project_dependency` row count > 50, the consistency check graduates from nightly to continuous: each tenant emits `proposal_lifecycle_event` rows on proposal mutation, and a subscriber on the central side re-validates affected edges within seconds. The nightly job is kept as a backstop sweep but the continuous auditor catches stale edges before they block dispatches.

**Within-project dependencies** stay in `<tenant>.proposal.proposal_dependency`. The central table is *only* for cross-tenant edges.

---

## 7. A2A communication — one fabric

### Persistent layer (`hiveCentral.messaging`)

```sql
messaging.a2a_topic (
  topic_id        BIGSERIAL PRIMARY KEY,
  name            CITEXT UNIQUE NOT NULL,   -- e.g. 'orch.dispatch', 'agency.<id>.heartbeat'
  retention_days  INT NOT NULL DEFAULT 14,
  max_size_bytes  BIGINT NOT NULL DEFAULT 10485760,
  metadata        JSONB NOT NULL DEFAULT '{}'
);

messaging.a2a_message (
  message_id      UUID PRIMARY KEY,
  topic_id        BIGINT NOT NULL REFERENCES messaging.a2a_topic,
  sequence        BIGINT NOT NULL,          -- per-topic monotonic
  sender_did      TEXT NOT NULL,
  recipient_kind  TEXT NOT NULL,            -- 'topic' | 'direct'
  recipient_id    TEXT NOT NULL,            -- topic_id::text or DID
  kind            TEXT NOT NULL,            -- references liaison_message_kind_catalog
  payload         JSONB NOT NULL,
  signature       TEXT NOT NULL,            -- Ed25519 over canonical_json(envelope)
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ,
  acked_at        TIMESTAMPTZ,
  UNIQUE (topic_id, sequence)
);

messaging.a2a_subscription (
  subscription_id    BIGSERIAL PRIMARY KEY,
  topic_id           BIGINT NOT NULL REFERENCES messaging.a2a_topic,
  subscriber_did     TEXT NOT NULL,
  last_acked_seq     BIGINT NOT NULL DEFAULT 0,
  subscribed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

messaging.a2a_dlq (
  message_id         UUID PRIMARY KEY,
  reason             TEXT NOT NULL,         -- 'bad_signature', 'expired', 'schema_invalid', 'recipient_unknown'
  dead_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  retry_count        INT NOT NULL DEFAULT 0,
  raw_envelope       JSONB NOT NULL
);
```

- **Append-only** message log; consumers track `last_acked_sequence` per topic
- **Per-topic monotonic sequence** for total ordering within a topic
- **Postgres LISTEN/NOTIFY** for instant wake-up; sequence-based polling for catch-up after disconnect
- **DLQ** for messages that fail signature/schema/expiry — never silently drop

### Transport is abstracted (per GPT feedback #3)

All A2A I/O goes through a `MessageTransport` adapter:

```ts
interface MessageTransport {
  publish(topic: string, envelope: SignedEnvelope): Promise<{message_id, sequence}>;
  subscribe(topic: string, since_seq: bigint, handler: (env) => Promise<void>): Subscription;
  ack(subscription_id, sequence: bigint): Promise<void>;
  health(): Promise<{healthy: boolean, lag_seconds: number}>;
}
```

v1 implementation: `PostgresMessageTransport` (LISTEN/NOTIFY + table polling). Future drop-in replacements: `NatsTransport`, `KafkaTransport`, `RedpandaTransport`. The graduation criteria is documented:

```
Graduate to durable broker when ANY of:
  - sustained > 1k msgs/sec across the bus
  - p99 NOTIFY-to-receive lag > 500ms for 5 minutes
  - cross-host agency count > 3 (LISTEN/NOTIFY doesn't scale across PG instances)
```

### Two-tier retention (per Gemini feedback #4.2)

Hot tier: `messaging.a2a_message`, 14-day TTL (default).
Cold tier: `messaging.a2a_message_archive`, **indefinite** retention for messages referenced by a `proposal_review` or `proposal_decision`.

Promotion: when a proposal review/decision quotes a message_id, a trigger copies the message to `a2a_message_archive` and links it. This guarantees "team memory" for long deliberations without growing the hot table unboundedly.

### Topic taxonomy

```
orch.dispatch                       orchestrator → all agencies (work offers)
orch.lease                          orchestrator ↔ agencies (lease state)
agency.<agency>.heartbeat           agency → orchestrator (capacity envelope)
agency.<agency>.assistance          agent → orchestrator (stuck, need help)
proj.<slug>.gate                    project-scoped gate decisions
proj.<slug>.efficiency              project-scoped cost / metric events
hive.governance                     policy changes, security events, incidents
hive.identity                       key rotations, principal additions/revocations
```

Topic names are CITEXT and validated at creation against a taxonomy table; ad-hoc topics are forbidden in production.

### Signed envelope (every cross-trust-boundary message)

```
{
  envelope_id:  uuid,
  issuer_did:   'did:agency:claude-code/agency-bot',
  audience_did: 'did:hive:orchestrator',  // or topic DID
  issued_at:    ISO-8601,
  expires_at:   ISO-8601 (max +5 min),
  nonce:        random_128b,
  payload:      <action-specific>,
  signature:    Ed25519(issuer_priv, canonical_json(everything_above))
}
```

Receiver verifies: signature, expiry, nonce-not-seen-before (replay protection), issuer is registered in `identity.principal_key` with `revoked_at IS NULL`. Every accept and every reject writes an `identity.audit_action` row.

### 7.5 Central-metadata cache layer (first-order architecture, per GPT feedback #9)

Because cross-DB joins are forbidden (§3) and tenant handlers constantly need control-plane lookups (which agent has which skill, which route is allowed for this host, which credential to pull), caching becomes architecture, not optimization.

```
┌────────────────────────────┐
│ hiveCentral (source)       │
│   workforce.agent          │
│   model.model_route        │
│   tooling.tool_grant       │
│   project.project_*_grant  │
└────────────┬───────────────┘
             │ on write: NOTIFY metadata_invalidated, '<table>:<key>'
             │ periodic: short-TTL refresh
             ▼
┌────────────────────────────┐
│ Per-process LRU cache      │ TTLs: agent/skill 5 min, route 1 min, grants 30s
│ (orchestrator, agencies)   │ stale-while-revalidate; hard expiry on revoke
└────────────────────────────┘
```

**Rules:**
- Every cached fetch is keyed by `(table, key)` and carries the value, fetched_at, source_version.
- On `NOTIFY metadata_invalidated`, the cache evicts the affected key immediately.
- On cache miss or hard expiry, the fetch goes to the source.
- **Stale-grant fallback:** if a grant cache entry was used for a dispatch that's now mid-flight, the dispatch completes — but the next dispatch sees the revoked grant.
- **Hard revoke:** for security-critical revocations (compromised credential, banned principal), `NOTIFY metadata_revoked` triggers immediate process-wide cache flush + reject of in-flight dispatches that depend on the revoked entity.

This is implemented once in `src/infra/cache/control-plane-cache.ts`; every service uses it.

---

## 8. Universal configuration

One resolver, one precedence chain. Every service uses the same one.

```
1. CLI flag                                  (highest)
2. Environment variable
3. /etc/agenthive/env  (systemd EnvironmentFile)
4. roadmap.yaml at project root
5. hiveCentral.core.runtime_flag             (DB-driven, NOTIFY-reload)
6. hard-coded default                        (lowest)
```

```sql
core.runtime_flag (
  flag_name        TEXT PRIMARY KEY,
  value_jsonb      JSONB NOT NULL,
  scope            TEXT NOT NULL,           -- 'global' | 'host:<id>' | 'agency:<id>' | 'project:<slug>'
  description      TEXT,
  modified_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_by_did  TEXT NOT NULL
);
```

- **`config-keys.ts` is the single registry** of every flag — name, type, default, scope, description. Adding a flag without registering it fails CI lint.
- **Hot-reload:** `NOTIFY runtime_flag_changed, '<flag_name>:<scope>'` → services that care subscribe and update their in-memory cache. No restart needed for non-structural changes.
- **Project-scoped flags** override global ones for that project only (e.g. `dispatch.timeout_ms` could be raised for a slow-domain project without affecting others).

---

## 9. Application security — defense in depth

### Layer 1: PostgreSQL roles (least privilege per service)

```
agenthive_admin              SUPERUSER, only for migrations and DBA work — never used by services
agenthive_orchestrator       CONNECT hiveCentral; SELECT/INSERT/UPDATE on orchestration_self.*, agency.*, model.*, workforce.*, project.*; SELECT on identity.*; CONNECT each tenant DB; SELECT/INSERT/UPDATE on its proposal.*, dispatch.*, cubic.*; NO DELETE
agenthive_agency             CONNECT hiveCentral; SELECT/UPDATE on agency.agency_session (own row), liaison_message (own agency); SELECT on orchestration_self.work_offer_self
agenthive_a2a                CONNECT hiveCentral; INSERT/SELECT/UPDATE on messaging.*; nothing else
agenthive_observability      CONNECT hiveCentral READONLY for everything except observability rollups (writeable)
agenthive_tenant_<slug>      CONNECT <tenant_db> only; full DDL/DML inside its own DB; NO connect to hiveCentral and NO connect to other tenant DBs
agenthive_repl               REPLICATION; logical-replication only
```

### Layer 2: row-level security on every multi-tenant-touching table

```sql
ALTER TABLE agency.agency_session ENABLE ROW LEVEL SECURITY;
CREATE POLICY agency_session_self ON agency.agency_session
  FOR ALL TO agenthive_agency
  USING (agency_id = current_setting('app.current_agency_id', true));
```

Application sets `SET LOCAL app.current_agency_id = '<id>'` at the start of every connection bound to a specific agency. Without it, RLS returns zero rows.

### Layer 3: signed envelopes (see §7)

Every state mutation that crosses a trust boundary carries a signed envelope. Audit row written either way.

### Layer 3a: per-spawn workload identity (per GPT feedback #7)

Agency identity (long-lived) is not enough. Every spawned task gets a **short-lived signed workload identity** bound to one task / one briefing:

```
workload_did = 'did:hive:spawn:<dispatch_id>:<spawn_serial>'
issued_at    = now()
expires_at   = now() + min(task_timeout, 1 hour)
issuer_did   = parent agency DID
audience     = ['mcp', 'pgbouncer', 'allowed_tools']
scope        = { proposal_id, project_id, allowed_tool_ids[], sandbox_id }
```

The orchestrator mints this token at dispatch time (signed by the orchestrator key). MCP server / Postgres role layer / tools all verify the workload token, not just the agency token. Lets us enforce "this spawn may call tools X and Y for proposal P527 only, expires in 30 minutes" — least privilege per task, not per agency.

### Layer 4: input boundaries

- All identifiers run through `normalizeAgentId` (NFC + path-safe + collision-detected)
- All worktree paths run through `safeWorktreePath(WORKTREE_ROOT, name)`
- All SQL is parameterized; `format()`/string concat is forbidden in app code (lint rule)
- All MCP tool inputs validate against JSONSchema before reaching SQL
- All CITEXT/TEXT fields with semantic meaning have CHECK constraints matching the application's enum

### Layer 5: sandbox + secure boundary (see §10)

### Layer 6: tamper-evident audit chain (per GPT feedback #8)

`governance.decision_log` rows form a hash chain:

```sql
governance.decision_log (
  entry_id          BIGSERIAL PRIMARY KEY,
  entry_kind        TEXT NOT NULL,            -- 'gate_decision' | 'budget_override' | 'credential_rotation' | 'self_evo_merge' | 'unblock_reserve_draw'
  actor_did         TEXT NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload           JSONB NOT NULL,
  prev_hash         TEXT NOT NULL,            -- sha256 of previous entry's hash || canonical_json(this row minus this_hash)
  this_hash         TEXT NOT NULL,            -- sha256 over (prev_hash || canonical_json(payload + actor + occurred_at + kind))
  CHECK (this_hash != prev_hash)
);
```

Genesis row has `prev_hash = '0' * 64`. **Verification cadence (v3, per Gemini v2 feedback):** the verifier runs **incrementally** — last 24 h on every cycle (every 5 min), and a **full chain re-verify weekly**. Detection latency is bounded at < 5 min for fresh tampering, < 7 days for historical tampering even as the chain grows. The full re-verify uses partition pruning by `occurred_at` so cost stays roughly linear in chain age, not quadratic.

### Layer 7 — policy engine seam (per GPT v2 recommended #4)

Grants, budgets, dependency rules, workload-identity scope, and gate criteria are all *policy*. v1 hard-codes them in TypeScript. v3 adds an explicit seam so v2-of-AgentHive can swap in OPA / Cedar / a declarative DSL without rewriting orchestration:

```ts
interface PolicyEvaluator {
  // Returns allow/deny + a trace of which rules fired and why
  evaluate(input: PolicyInput): Promise<PolicyDecision>;
  // Returns the rule set in a portable representation (for trace/replay)
  describeRuleset(): Promise<RulesetDescriptor>;
}

interface PolicyDecision {
  outcome:    'allow' | 'deny' | 'soft-fail';
  reasons:    PolicyTraceEntry[];   // structured: which rule, what input, what outcome
  ruleset_id: string;               // hash of rules at decision time, for replay
}
```

v1 implementation: `HardcodedPolicyEvaluator` (current TS code, wrapped in the interface). Future drop-ins: `OpaPolicyEvaluator`, `CedarPolicyEvaluator`, `DeclarativePolicyEvaluator`. The **PolicyDecision trace** is written to `observability.decision_explainability` for every consequential check (dispatch, advance, grant, budget draw). The trace is what makes "why did the agent reject my proposal?" answerable.

**Graduation criteria for moving off hardcoded policy:** any of (a) > 50 distinct policy rules in the codebase, (b) more than one team needs to author rules, (c) a regulator/customer requires policy export.

---

## 10. Sandbox connectivity & secure boundary

### Three concentric boundaries

```
┌─────────────────────────────────────────────────────────┐
│ Outer: HOST (Linux, full network, full FS)              │
│   └─ Inner-1: AGENCY PROCESS                            │
│        - dedicated systemd unit                          │
│        - non-root user (agenthive_<provider>)            │
│        - PrivateTmp, ProtectSystem=strict                │
│        - egress restricted to: model API + hiveCentral  │
│        └─ Inner-2: AGENT SPAWN (per task)               │
│             - cgroup: cpu/mem/io limits                  │
│             - filesystem: only its own worktree          │
│             - network: namespaced; egress per policy     │
│             - lifetime: ≤ task timeout                   │
└─────────────────────────────────────────────────────────┘
```

### Schema

```sql
sandbox.sandbox_definition (
  sandbox_id           BIGSERIAL PRIMARY KEY,
  name                 TEXT UNIQUE NOT NULL,    -- 'codex-default', 'claude-restricted', 'self-evo-restricted'
  provider_id          TEXT NOT NULL REFERENCES agency.agency_provider,
  scope                TEXT NOT NULL DEFAULT 'lease',  -- 'lease' | 'task'
  cpu_quota            TEXT,                    -- e.g. '200%'
  memory_max           TEXT,                    -- e.g. '4G'
  task_timeout_seconds INT NOT NULL DEFAULT 1800,
  fs_policy            JSONB NOT NULL,          -- { ro: [...], rw: [...], blocked: [...] }
  egress_policy_id     BIGINT REFERENCES sandbox.boundary_policy,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Scope semantics (per Gemini feedback #4.3):**
- `scope = 'lease'` (default): one sandbox is spawned per lease. All tool calls during that lease reuse it. Avoids per-tool-call container startup cost.
- `scope = 'task'`: a fresh sandbox per task. Required for high-isolation flows (self-evo merges, security-sensitive proposals). Higher latency, stronger isolation.

```sql

sandbox.boundary_policy (
  policy_id      BIGSERIAL PRIMARY KEY,
  name           TEXT UNIQUE NOT NULL,
  default_action TEXT NOT NULL,                 -- 'allow' | 'deny'
  rules          JSONB NOT NULL                 -- [{action, dest_cidr|host, port, protocol}]
);

sandbox.mount_grant (
  agency_id    TEXT REFERENCES agency.agency,
  project_id   BIGINT REFERENCES project.project,
  path_pattern TEXT NOT NULL,                   -- e.g. '/data/code/worktree/<project_slug>/*'
  mode         TEXT NOT NULL                    -- 'ro' | 'rw'
);
```

At spawn time: orchestrator selects a sandbox profile, materializes a transient cgroup + bwrap/firejail invocation from the JSON policy, and writes a `dispatch.dispatch_route_audit` row binding the sandbox to the dispatch.

### Egress rules (the most security-critical surface)

Default-deny. Per provider:

```
claude-code     →  api.anthropic.com:443
codex           →  chatgpt.com:443, api.openai.com:443
copilot         →  api.githubcopilot.com:443
all             →  hivecentral-pgbouncer:6432
all             →  127.0.0.1:6421 (MCP server)
all             →  gitlab.local:22, github.com:22 (git ops)
```

Anything else: `iptables -j REJECT` inside the spawn's network namespace. A "broke out" agent reaches nothing.

---

## 11. Reliability & resilience

### 11.0 Orchestrator: single process v0, clustered logical orchestrator path designed-in (per GPT feedback #1)

v1 ships **a single orchestrator process**, but the design treats this as **implementation v0, not architectural invariant**. Every primitive is already cluster-compatible:

- **Lease arbitration** runs in Postgres (`SELECT … FOR UPDATE SKIP LOCKED`) — multiple orchestrators can share the work queue safely
- **Dispatch is idempotent** — keyed by `(proposal_id, phase, role)`, duplicate dispatches collide on a unique index
- **Work offers** are claimed via Postgres-level uniqueness — only one claim wins
- **Reaper / lease recovery** uses LISTEN/NOTIFY + advisory locks — leader election is a config flip away

When v1 hits a bottleneck, the path to clustering is:

```
Orchestrator API layer        → N stateless instances (round-robin)
Dispatch scheduler workers    → N instances, partitioned by project_id hash
Reaper / lease recovery       → leader-elected via pg_advisory_lock, single-active
A2A bus                       → already abstracted (§7); swap transport if PG saturates
```

**Threshold for graduating to clustered orchestrator:**
- sustained dispatch latency p99 > 5s for 1 hour, OR
- agency count > 10 active concurrent, OR
- proposal queue > 500 active across all tenants

Until then, single process keeps operations simple. The `orchestration` service unit can be replaced with a `orchestration-api` + `orchestration-scheduler` + `orchestration-reaper` triplet without changing the schema.

**Singleton-fragility lint (per GPT v2 caveat).** Any code that assumes singleton semantics — in-memory locks, process-scoped counters, "the orchestrator" globals, in-memory caches that aren't NOTIFY-invalidated, sequence generators that aren't DB-backed — must carry the comment marker `@singleton-fragile <reason>`. CI lint enforces this. A quarterly survey reviews every `@singleton-fragile` to either remove the assumption or upgrade it to a `@cluster-incompatible` blocker that must be fixed before clustering. This stops singleton assumptions from quietly accumulating into a clustering blocker.

### 11.1 Failure mode catalog

| Failure mode             | Technique                                                                                                                                                       |
|--------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Agency crashes mid-claim | **Lease + heartbeat**. 60s TTL, 15s renewal. Reaper transitions stale leases to `released` and re-offers the work.                                              |
| Orchestrator crashes     | **Stateless restart**. All state lives in `hiveCentral` + tenant DBs. systemd restarts; agencies reconnect; in-flight claims survive (lease still valid).       |
| Postgres unavailable     | **Bounded retry with circuit breaker** in pool layer; agencies pause claiming new work but finish in-flight from local memory. No data loss because all writes are committed before ack. |
| Tenant DB corrupt        | **Tenant isolation** — only handlers using that project break; other projects unaffected. Logical replication snapshot lets us restore one tenant in isolation. |
| Bad migration            | **Migration safety harness** — every migration is shadow-tested in a copy of the target DB; only after pass does it run in prod. P501 runbook is the template. |
| Self-evo proposal breaks platform | **Self-evo proposals run through the normal gate pipeline plus a mandatory shadow-test phase** before MERGE; rollback path is `git revert` + service restart. The shadow-test applies the change to a temporary `hiveCentral_shadow` DB and runs a smoke-test suite before promotion. |

### 11.2 Event-sourcing spine (per GPT feedback #5, lean v1)

Not a full rewrite — just append-only paired event tables for the lifecycles that need replay/audit:

| Lifecycle table               | Paired event log                                  |
|-------------------------------|---------------------------------------------------|
| `proposal.proposal`           | `observability.proposal_lifecycle_event`          |
| `dispatch.dispatch`           | `<tenant>.dispatch.dispatch_event`                |
| `proposal.proposal_lease`     | `<tenant>.dispatch.lease_event`                   |
| `project.project_budget_policy` | `governance.decision_log` (kind='budget_change') |
| `template.workflow_template`  | `governance.decision_log` (kind='template_publish') |
| `credential.credential`       | `credential.credential_rotation_log`              |

Every state mutation writes both the new state row AND an event row in the same txn. Events are **never updated or deleted**. Cost: roughly 2× write volume for these tables. Benefit: time-travel debugging, simulation replay, training-data export, and tamper detection for free.

### SLO targets

```
Orchestrator dispatch latency p99 < 5s
Agency claim acceptance      p99 < 2s
A2A message delivery         p99 < 1s
Tenant DB query              p99 < 100ms
Sandbox spawn                p99 < 30s
```

Burning > 50% of any error budget in 7 days auto-pages.

### 11.3 Control-plane disaster recovery (per GPT v2 must-have #3)

Tenant DR is per-DB and well understood (logical backup + restore). Control-plane DR is different — `hiveCentral` going dark stops every project's dispatch, every workload-identity verification, every cross-project lookup. It deserves architecture-level treatment.

**Targets (v1 single-region, single-instance):**

| Target | Value                                                                                              |
|--------|----------------------------------------------------------------------------------------------------|
| RPO    | ≤ 60 seconds (continuous WAL streaming to a hot standby on a separate host)                          |
| RTO    | ≤ 5 minutes (manual failover; promote standby + flip pgbouncer pool target + restart 4 services)    |

**Failover model (v1):**

```
hiveCentral (primary)  ──► hiveCentral (hot standby)
                              │
                              ▼ (on failover)
hiveCentral (new primary, was standby)
```

- **Streaming replication** to a designated hot standby (separate host, same datacenter)
- **PgBouncer** in front of both, with primary as default; failover script flips pool target
- **Orchestrator + agencies + a2a + MCP** reconnect via PgBouncer; existing connections drop, new connections land on the new primary
- **Failover runbook** at `docs/dr/hivecentral-failover.md` (to be written in P530.0); operator-driven, not automatic — control-plane false-positive failover is worse than 5 min of downtime

**Active-lease handling during failover:**

1. Failover detected → orchestrator pauses dispatch (refuses to mint new work offers and new workload tokens)
2. Standby promoted → orchestrator reconnects via PgBouncer
3. **Lease reconciliation pass** runs first thing on the new primary:
   - Every lease with `last_renewed_at < (failover_time - 60s)` is treated as orphan (the holder didn't see the failover; their next renew will fail)
   - Orphaned leases are released (status → `released`); their work re-offered
   - Leases with `last_renewed_at >= failover_time` are kept (the holder reconnected fast enough)
4. Workload tokens issued before failover with `expires_at > now()` are still honored (they were signed by the orchestrator key, which is in vault not in the DB)
5. A2A messages with `sequence > last_acked_seq` on the standby are replayed from the DLQ-style replay log; subscribers idempotently handle duplicates

**Region strategy (v2+):**

- v1 = single region. v2 graduation: when a tenant has multi-region data residency, deploy a regional `hiveCentral` with peer federation (Section 14, "What relaxes when").
- A multi-region `hiveCentral` is **NOT** active-active in v2 — it's active-passive with regional read locality and explicit cross-region asynchronous replication.

**DR drills:**

- Monthly: failover drill in staging (real promotion of standby, real reconnect of services), measure RTO, log to `governance.decision_log` with kind=`dr_drill`
- Quarterly: backup-restore drill — restore a `tenant_backup` to a scratch DB, run smoke tests, verify

**Backup of the control plane itself:**

- Continuous WAL → S3-compatible object storage (off-host)
- Daily logical dump as belt-and-suspenders
- Retention: 30 days WAL + 90 days logical
- Restore time from off-host backup (worst case): ≤ 30 min (this is the "hot standby is also gone" scenario)

---

## 12. Schema dependency graph

```
core         → identity      → agency        → model
                                  ↓             ↓
                              workforce       sandbox
                                  ↓             ↓
                              tooling      credential
                                  ↓             ↓
project      → orchestration_self → efficiency (rollup)
   ↓
template (read by tenants at bootstrap)
   ↓
messaging (depends on identity for envelope verification)
   ↓
governance (depends on everything; audit substrate)
```

Each schema is a **bounded context** with a public API (views + functions) and a private implementation (tables + indexes). Other schemas may only call the public API.

---

## 13. Migration approach — five waves, each independently reversible

**Do not big-bang.**

```
Wave 1 (P501):
  - Create hiveCentral with the schema layout above
  - Empty — no data yet, just structure
  - Existing agenthive DB unchanged; services still point at it
  - Rollback: DROP DATABASE hiveCentral

Wave 2 (P502 + P503):
  - Logical replication: agenthive.roadmap_*  →  hiveCentral.<new schemas>
  - Read-shadow: services dual-read; assert results match for 7 days
  - No production impact; pure validation
  - Rollback: stop replication, drop subscription

Wave 3 (P504 + P505 + P518):
  - Cutover orchestrator + MCP server: read+write hiveCentral; old DB read-only mirror
  - Cutover agencies one at a time (claude first, then copilot, then codex)
  - Rollback: flip DSN back to agenthive

Wave 4 (P506 + P507 + P508):
  - agenthive becomes a tenant DB. Drop roadmap_* schemas from it.
  - Move existing agenthive proposals from hiveCentral.orchestration_self
    → agenthive.proposal.proposal (only self-evo proposals stay central)
  - First non-agenthive tenant onboards (monkeyKing-audio or georgia-singer)
  - Rollback: 7-day fallback window where agenthive's old schemas remain dormant

Wave 5 (P513–P517):
  - Sandbox + credential-vault hardening lands
  - Single-host assumption replaced with project_host registry
  - Federated agency support (off-host agencies via mTLS)
  - Rollback: per-feature feature flag
```

Each wave is a separate proposal. Each wave's gate criteria includes a successful read-shadow / dry-run / replay test before promotion.

---

## 14. What this enables (and what relaxes when)

### Enabled by v1

- **Multi-host agencies:** an agency runs on a different machine; mTLS-authenticates against `hiveCentral`; nothing in this model assumes single-host.
- **Federation:** another `hiveCentral` instance can be a peer via signed envelopes — same primitives.
- **New providers:** add a row to `agency.agency_provider`; spawn rules live in `sandbox.sandbox_definition`. No code changes for the dispatch path.
- **Audit / compliance:** every action is an envelope; `governance.decision_log` is hash-chained and tamper-evident.
- **Per-project isolation guarantees:** a runaway agent in project A cannot read project B's DB (different role, different DB, different sandbox). Provable, not aspirational.
- **Workflow simplicity:** templates are central + immutable + versioned; projects pin to a version. No template fork explosion.
- **Proposal as product:** proposals + repo artifacts are the durable artefact. Workflow tables can be archived without losing the product story.
- **Cross-project planning:** `hiveCentral.dependency.cross_project_dependency` lets a portfolio view reason about blocked work across tenants.

### v1 restrictions that are deliberately scope-control, with relaxation triggers

| v1 restriction                                  | Relaxes when                                                                                          |
|-------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| Single orchestrator process                     | Dispatch p99 > 5s for 1 hour OR agency count > 10 OR queue > 500 → graduate to clustered orchestrator |
| Postgres LISTEN/NOTIFY for A2A                  | > 1k msgs/sec sustained OR p99 lag > 500ms OR cross-host agencies > 3 → graduate to NATS/Kafka         |
| Projects can't customize workflow               | After 5+ projects in production with stable workflow needs → templates as composable steps (v2 north star) |
| No cross-DB joins                               | **Permanent.** Cross-DB joins break tenant portability. Not relaxing.                                   |
| Single host, single PG instance                 | When tenant data residency or compliance requires it → tenant DB on a different host (config change)   |
| No federation between hiveCentral instances     | When multi-region or organizational-boundary deployment is needed → mTLS peering via signed envelopes  |
| Per-spawn workload identity (always-on)         | **Permanent.** Always least privilege.                                                                  |
| Hash-chained audit log                          | **Permanent.** Cheap, high-value.                                                                       |
| Per-project tenant DB                           | **Permanent.** This is the core architectural commitment.                                               |

---

## 15. Open questions — status after v2

1. **Workflow customization in v2?** **Resolved (v2).** Add new templates centrally with immutable versioning (option a). Composable-steps option (c) remains the architectural north star but is out of scope until ≥ 5 active projects with stable needs.
2. **Cross-project proposal dependencies.** **Resolved (v2).** Central graph in `hiveCentral.dependency.cross_project_dependency` (§6.4). Soft FK + nightly consistency check.
3. **Self-evo vs project-evo confusion.** **Resolved (v2).** Self-evo is just a tenant flag (`is_self_evo=true`) on the agenthive project. Proposals always live in their project's tenant DB. The flag changes orchestrator behavior (elevated gating, stricter sandbox, two-person review) but never row placement (§4).
4. **Budget cap behavior.** **Resolved (v2).** Hard-cap = refuse new dispatch; in-flight lease completes its current state transition then stalls in `budget_blocked`. Emergency bypass available when policy permits and host health degraded (§6.1).
5. **Read replicas.** **Deferred.** Not in v1. `project_db.role = read_replica` is in the schema; activation deferred until a project has measurable read pressure.

### Still open after v2

6. **Federation key rotation across hiveCentral peers.** When two hiveCentral instances peer (future), how do they exchange and rotate trust roots? Likely a `governance.federation_peer` table + manual key approval workflow.
7. **Cold-tier message archive sizing.** Two-tier retention (§7) promotes referenced messages to `a2a_message_archive` indefinitely. At what point does archive growth become unbounded enough to need partitioning? Probably > 100M rows.
8. **Tenant DB schema migrations governance.** When `hiveCentral.template.workflow_template` changes how tenants store state, who is responsible for migrating active tenant DBs? Suggest: each template version ships its own migration script in the central catalog; orchestrator runs it during template upgrade.
9. **Workload identity bootstrap problem.** The orchestrator mints workload tokens (§9 layer 3a) signed by its own key. If an attacker compromises the orchestrator key, all workload tokens become attacker-controlled. Suggest: orchestrator key is rotated weekly, stored in vault, and the rotation event is hash-chained.
10. **Multi-region tenant placement.** When a tenant DB has data-residency constraints (EU only), where does the central control plane live? Likely a regional `hiveCentral` per region with peer federation (see #6).

---

## 16. Glossary

- **Proposal:** a unit of product intent. Lives in tenant DB (or `hiveCentral.orchestration_self` if self-evo).
- **Cubic:** an execution context for one proposal at one phase. Tenant-scoped.
- **Dispatch:** an orchestrator decision to assign one agent to one proposal-phase. Tenant-scoped.
- **Work offer / work claim:** the durable representation of "agency X promises to handle dispatch Y."
- **Briefing:** the contract handed to a spawned agent — task, AC, sandbox, budget.
- **Lease:** time-bounded exclusive ownership of a proposal-phase by an agent.
- **Agency:** a registered worker (e.g. `claude/agency-bot`) tied to a provider.
- **Provider:** the CLI / authentication mechanism (claude-code, codex, copilot, hermes).
- **Agent:** a workforce role (e.g. `senior-backend`). Central catalog; agencies execute as agents.
- **Workflow template:** a state machine + gate criteria, central catalog, copied into tenants at bootstrap.
- **Self-evo proposal:** a proposal that changes AgentHive itself; lives in `hiveCentral.orchestration_self`.
- **Tenant DB:** one PostgreSQL database per project; holds the project's proposals, dispatch, cubic, raw efficiency events, and domain data.
- **Control DB:** the singular `hiveCentral` database; holds everything platform-wide.

---

## 17. What I'd build next

1. **Design v2 is locked-pending-final-review.** Gemini + GPT feedback folded in (§R). Optional next pass: PostgreSQL-architecture-specific review per GPT's offer.
2. Draft **P530** (parent: hiveCentral data-model overhaul) + **17 child proposals**:
   - **P530.0 Control-plane DR design** (RPO/RTO targets, failover runbook, drill cadence) — must land before any non-agenthive tenant onboards
   - P530.1 `core` schema (host, os_user, runtime_flag)
   - P530.2 `identity` schema (principal, did, audit_action)
   - P530.3 `agency` schema (provider, agency, session, liaison_message)
   - P530.4 `model` schema (model, route, host_policy)
   - P530.5 `credential` schema (vault adapter + grants + rotation log)
   - P530.6 `workforce` schema (agent, skill, capability)
   - P530.7 `template` schema (immutable versioned workflow templates)
   - P530.8 `tooling` schema (tool catalog + grants)
   - P530.9 `sandbox` schema (definition, policy, mount_grant)
   - **P530.10 Tenant Lifecycle Control** (state machine, provisioning, upgrade, clone, backup, restore, archival, retirement, quotas, noisy-neighbor) — promoted from "project schema" per GPT v2 must-have
   - P530.11 `dependency` schema (cross-project graph + continuous shadow-link auditor)
   - P530.12 `messaging` schema (a2a + transport adapter + cold-tier archive)
   - P530.13 `observability` schema (spans, lifecycle events, routing outcomes, explainability)
   - P530.14 `governance` schema (hash-chained decision log with incremental verifier + event spine)
   - P530.15 `efficiency` schema (rollups only; raw events live in tenants)
   - P530.16 **Policy engine seam** (`PolicyEvaluator` interface + hardcoded v1 + decision-trace wiring) per GPT v2 recommended #4
   - P530.17 **Proposal tiering** (Class A/B/C, gating differences, tier-promotion enforcement, mis-classification auditor) per GPT v2 recommended #5
3. Re-run the migration expert against the new target schemas (re-do P501 simulation against this layout — the previous simulation targeted a today-mirror layout).
4. Execute **Wave 1** under operator supervision — empty `hiveCentral` with the v2 schemas, structure only, no data.
5. **Wave 2** read-shadow window. Treat the agenthive single-DB → hiveCentral + agenthive-as-tenant migration as the primary thing being shadow-tested, since it changes proposal storage location.
6. **Wave 3** cutover, then Wave 4 (agenthive becomes pure tenant), then Wave 5 (hardening).

**Lock the schema before P501 actually runs**, so the DB we create is the *v2 target* layout — not a mirror of today's `roadmap.*` that we'd then have to migrate again.
