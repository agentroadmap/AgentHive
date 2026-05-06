# agentHive2 — Database Bootstrap Package

This directory contains the complete DDL and seed scripts for provisioning the `agentHive2` PostgreSQL database from scratch. It covers the control-plane (system-init) and the per-project schema template (project-init), with `apply.sh` as the single entry point.

## Quick Start

```bash
# Full bootstrap (system + default agentHive project)
./deploy/apply.sh

# System control plane only
./deploy/apply.sh --system-only

# Add a new project schema
./deploy/apply.sh --project-only -s hardcodeMiner
```

Default connection: `127.0.0.1:5432`, user `admin`, database `agentHive2`.

## Directory Layout

```
deploy/
├── apply.sh                         # Deployment entry point
├── dev/                             # Ephemeral sandbox schema (never referenced in CI)
│   └── README.md
├── system-init/                     # Control plane — run once per database
│   ├── 000-roles.sql                # PostgreSQL role definitions
│   ├── 001-core.sql                 # Installation, hosts, projects, runtime config
│   ├── 002-agency.sql               # LLM providers, model catalog, routing, sessions
│   ├── 003-identity.sql             # Principals, DIDs, cryptographic keys, audit log
│   ├── 004-governance.sql           # Policies, decision log, compliance, event stream
│   └── seed/
│       ├── hosts.sql                # Bootstrap host record (bot) + self-project (agentHive)
│       └── agencies.sql            # Provider/model catalog + message kinds
└── project-init/                    # Per-project schema template
    ├── 000-schema.sql               # Schema creation + shared trigger function
    ├── 001-proposal.sql             # Proposals, versions, criteria, reviews, decisions
    ├── 002-workflow.sql             # State machine: stages, transitions, gate checks
    ├── 003-agent.sql                # Agents, leases, skills, trust, heartbeats
    ├── 004-msg.sql                  # Topics, messages, dead-letter queue
    ├── 005-spend.sql                # Budgets, spend ledger, daily cost rollup
    ├── 006-kb.sql                   # Knowledge base documents, vector embeddings, tags
    └── seed/
        ├── proposal-types.sql       # Workflow templates (feature, hotfix, …)
        └── gate-roles.sql           # Default agents, skills, message topics
```

## apply.sh Flags

| Flag | Description |
| :--- | :--- |
| `--system-only` | Run system-init DDL + seed; skip project-init |
| `--project-only` | Run project-init DDL + seed; skip system-init |
| `-s SCHEMA` | Project schema name (default: `agentHive`) |
| `-h HOST` | DB host (default: `127.0.0.1`) |
| `-p PORT` | DB port (default: `5432`) |
| `-U USER` | DB user (default: `admin`) |
| `-d DBNAME` | Database name (default: `agentHive2`) |

With no flags, `apply.sh` runs both system-init and project-init for the default `agentHive` schema.

---

## System-Init Layer (Control Plane)

The system-init scripts run once per database and define the global schemas: `core`, `agency`, `identity`, and `governance`. All tables follow the lifecycle pattern: `lifecycle_status` (active / deprecated / retired / blocked), `deprecated_at`, `retire_after`, `notes`.

### 000-roles.sql — PostgreSQL Roles

Six roles with tiered permissions (created idempotently):

| Role | Purpose |
| :--- | :--- |
| `agenthive_admin` | Schema owner — DDL, full DML |
| `agenthive_orchestrator` | Control-plane read/write, project schema management |
| `agenthive_agency` | Agency services — read config, write heartbeats/sessions |
| `agenthive_a2a` | Agent-to-agent messaging, liveness signals |
| `agenthive_observability` | Read-only across all schemas (monitoring) |
| `agenthive_repl` | Streaming replication |

### 001-core.sql — Hosts, Projects, Runtime Config

Schema: `core`

| Table | Key Columns | Notes |
| :--- | :--- | :--- |
| `core.installation` | `display_name`, `schema_version`, `lifecycle_status` | Singleton per deployment |
| `core.host` | `host_name`, `region`, `failure_domain`, `role` | Roles: control-plane / tenant-db / agency / mixed |
| `core.osUser` | `host_id`, `user_name`, `uid`, `is_service_account` | OS-level users per host |
| `core.project` | `slug`, `schema_name`, `owner_did` | Project registry; schema_name drives project-init |
| `core.runtimeFlag` | `flag_key`, `flag_value`, `value_type` | DB-driven feature flags; emits `pg_notify` on change |
| `core.serviceHeartbeat` | `service_id`, `host_id`, `pid`, `status`, `last_beat_at` | INSERT OR REPLACE liveness signal |
| `core.runtimeEndpoint` | `service_key`, `url`, `protocol` | Canonical endpoint registry; emits `pg_notify` on change |

Views: `core.v_active_hosts`, `core.v_service_health` (healthy / degraded / silent / inactive).

Seeded: installation singleton, MCP endpoint (`:6421` SSE), daemon endpoint (`:3000` HTTP).

### 002-agency.sql — LLM Providers, Models, Routing, Sessions

Schema: `agency`

| Table | Key Columns | Notes |
| :--- | :--- | :--- |
| `agency.provider` | `slug`, `display_name`, `api_base_url` | Soft FK to `core.*` for bootstrap safety |
| `agency.model` | `model_id`, `provider_id`, `context_window`, `cost_input_per_1k`, `cost_output_per_1k` | Tool-use support flag |
| `agency.route` | `model_id`, `host`, `priority` | Enabled routes per host |
| `agency.hostPolicy` | `host`, `route_id`, `policy_jsonb` | allowed_providers, cost limits per host |
| `agency.agency` | `provider_id`, `host_id`, `os_user_id`, `project_id`, `slug`, `socket_path` | Registered agency instances |
| `agency.session` | `agency_id`, `model_id`, `input_tokens`, `output_tokens`, `cost_usd` | Time-series partitioned by `started_at` |
| `agency.msgKind` | `slug`, `description` | heartbeat / task_start / task_complete / task_blocked / gate_request / log |
| `agency.msg` | `agency_id`, `kind`, `payload_jsonb`, `retry_count` | Liaison messages; time-series partitioned by `sent_at` |

Views: `agency.v_active_routes`, `agency.v_host_routing`.

Seeded providers: `claude`, `codex`, `hermes`, `copilot`.  
Seeded models: Claude Opus 4.7, Sonnet 4.6, Haiku 4.5, GPT-4o, o3.

### 003-identity.sql — Principals, DIDs, Keys, Audit

Schema: `identity`

| Table | Key Columns | Notes |
| :--- | :--- | :--- |
| `identity.principal` | `did`, `kind` | kind: agent / human / service / system |
| `identity.didDocument` | `principal_id`, `document_jsonb`, `version` | W3C DID document per principal |
| `identity.principalKey` | `principal_id`, `key_id`, `key_type`, `public_key_b64`, `key_usage`, `expires_at` | key_type: Ed25519 / P-256 / RSA-2048 / symmetric |
| `identity.auditAction` | `principal_id`, `actor_did`, `action`, `target_did`, `payload_jsonb` | Append-only; UPDATE/DELETE denied by trigger; partitioned by `occurred_at` |

Views: `identity.v_active_principals`, `identity.v_principal_keys` (active non-revoked).

Seeded: bootstrap principal `did:agenthive:system` (kind: system).

### 004-governance.sql — Policies, Decisions, Compliance, Events

Schema: `governance` — All tables are append-only (UPDATE/DELETE denied by trigger).

| Table | Key Columns | Notes |
| :--- | :--- | :--- |
| `governance.policy` | `slug`, `version`, `body_text`, `effective_at`, `superseded_at` | Published policies become immutable; status: draft / active / deprecated / retired / blocked |
| `governance.decision` | `proposal_ref`, `stage`, `outcome`, `actor_did`, `row_hash`, `prev_hash` | Hash-chained via SHA256 (requires pgcrypto); partitioned by `decided_at` |
| `governance.complianceCheck` | `check_type`, `target_ref`, `outcome`, `actor_did` | outcome: pass / fail / warn / skip; 1-year retention; partitioned by `checked_at` |
| `governance.event` | `event_type`, `actor_did`, `subject_ref`, `payload_jsonb` | Permanent retention; partitioned by `occurred_at` |

---

## Project-Init Layer (Per-Project Schema)

Each project gets its own PostgreSQL schema (e.g., `agentHive`, `hardcodeMiner`). The schema name is injected via `psql -v schema_name=<name>`. Run `apply.sh --project-only -s <slug>` to onboard a new project.

Project schemas contain 28 tables spanning proposal lifecycle, workflow state machine, agents, messaging, spending, and knowledge base.

### 000-schema.sql — Schema + Shared Trigger

Creates the schema and defines `set_updated_at()` — a reusable trigger function applied to all tables with an `updated_at` column.

### 001-proposal.sql — Proposal Lifecycle (8 tables)

| Table | Description |
| :--- | :--- |
| `proposal` | Root proposal record: display_id, title, type, status, maturity, priority, parent_id, summary, motivation, design, drawbacks, alternatives, dependency_note, body_markdown, tags_jsonb |
| `pVersion` | Append-only field-level version history; populated by `fn_version_on_update` trigger on every UPDATE |
| `pDependency` | Directed dependency graph (blocks / informs / relates / supersedes); supports cross-project refs via `depends_on_ref` |
| `pCriteria` | Acceptance criteria (pending / met / failed / skipped), with verifier and timestamp |
| `pReview` | Review comments (verdict: approve / reject / request_changes / comment / NULL) |
| `pDecision` | Gate transition decisions (advance / reject / defer / split / archive) |
| `pDiscussion` | Threaded discussion with self-referential `parent_id` |
| `pActivity` | Append-only audit log: status_changed, field_updated, lease_claimed, etc. |
| `pTag` | Denormalized tag index kept in sync with `proposal.tags_jsonb` |

**pVersion trigger:** `trg_pVersion` fires AFTER UPDATE on `proposal`. It captures field-level changes across `title`, `summary`, `motivation`, `design`, `drawbacks`, `alternatives`, and `dependency_note`, storing the delta as a JSONB object `{field: {old, new}}`. Actor is read from `app.current_actor` session variable or falls back to `current_user`.

**Proposal status values:** Draft → Review → Develop → Merge → Complete | Deployed | Recycled  
**Maturity values:** new → active → mature → obsolete

### 002-workflow.sql — State Machine (5 tables)

| Table | Description |
| :--- | :--- |
| `workflow` | Workflow template (slug: feature / bugfix / research / etc., initial_status) |
| `wStage` | Stages per workflow (ordinal, is_terminal, is_gate) |
| `wTransition` | Allowed edges between stages (reason: mature / decision / iteration / discard) |
| `wGate` | Gate checks per stage (check_key, is_required, ordinal) |
| `wTemplate` | Serialized snapshot of a workflow for replay / versioning |

### 003-agent.sql — Agents, Leases, Skills (5 tables)

| Table | Description |
| :--- | :--- |
| `agent` | Registered agents (kind: developer / reviewer / gate-reviewer / orchestrator / observer) |
| `aLease` | Proposal leases — partial unique index enforces one active lease per proposal |
| `aSkill` | Agent capabilities (proficiency: learning / capable / expert); `gate-review` skill gates gate-reviewer eligibility |
| `aTrust` | Per-project trust levels (restricted / standard / trusted / elevated) |
| `aHeartbeat` | Liveness signal — INSERT OR REPLACE; no lifecycle columns |

### 004-msg.sql — Messaging (3 tables)

| Table | Description |
| :--- | :--- |
| `mTopic` | Topic/channel registry (retention_days: 90 default) |
| `mMessage` | Agent-to-agent messages; `to_agent` NULL = broadcast; `correlation_id` for request/reply |
| `mDLQ` | Dead-letter queue for exhausted retries |

### 005-spend.sql — Budget & Spend Tracking (3 tables)

| Table | Description |
| :--- | :--- |
| `spBudget` | Budgets (scope: project / proposal / agent; alert_threshold: 0.80) |
| `spLedger` | Append-only spend events (input/output tokens, cost_usd, model_id, session_ref) |
| `spRoute` | Daily cost rollup per model route — populated by background job, unique on (model_id, period_date) |

### 006-kb.sql — Knowledge Base (3 tables)

Requires the `pgvector` extension.

| Table | Description |
| :--- | :--- |
| `kbDocument` | Documents (source_type: manual / proposal / commit / url / import; chunk_index for multi-part docs) |
| `kbEmbedding` | Vector embeddings — `vector(1536)` column (OpenAI default); unique on (document_id, model_id); IVFFlat index added post-load |
| `kbTag` | Document tag index for category filtering |

---

## Seed Data

### system-init/seed/hosts.sql

| Object | Value |
| :--- | :--- |
| Host | `bot` — role: mixed, primary operator host |
| Project | `agentHive` — self-development project, schema: `agentHive` |

### system-init/seed/agencies.sql

Providers: `claude` (Anthropic), `codex` (OpenAI), `hermes` (local), `copilot` (GitHub).

| Model | Context | Cost in / out (per 1k) |
| :--- | ---: | :--- |
| claude-opus-4-7 | 200k | $0.0150 / $0.0750 |
| claude-sonnet-4-6 | 200k | $0.0030 / $0.0150 |
| claude-haiku-4-5-20251001 | 200k | $0.0008 / $0.0040 |
| gpt-4o | 128k | $0.0050 / $0.0150 |
| o3 | 200k | $0.0020 / $0.0080 |

### project-init/seed/proposal-types.sql

Workflow templates seeded: **feature**, **bugfix**, **refactor**, **infra**, **research**, **hotfix**.

Feature workflow stages and transitions:

```
Draft ──[mature]──▶ Review ──[decision]──▶ Develop ──[mature]──▶ Merge ──[decision]──▶ Complete
  ▲                  │                        │
  └──────[iteration]─┘        [iteration]────┘
             └──────[discard]──────────────────────▶ Recycled
```

Gate checks on **Review** stage:

| Check key | Required | Description |
| :--- | :---: | :--- |
| `has_summary` | ✓ | Non-empty summary |
| `has_motivation` | ✓ | Non-empty motivation |
| `has_design` | ✓ | Design section populated |
| `has_ac` | ✓ | At least one acceptance criterion |
| `has_reviewer` | — | At least one review comment |

Gate checks on **Merge** stage:

| Check key | Required | Description |
| :--- | :---: | :--- |
| `has_decision` | ✓ | Gate decision row exists |
| `ac_all_met` | ✓ | All criteria met or skipped |

### project-init/seed/gate-roles.sql

Default agents:

| Slug | Kind | Model |
| :--- | :--- | :--- |
| claude-dev | developer | claude-sonnet-4-6 |
| claude-reviewer | reviewer | claude-sonnet-4-6 |
| claude-gate | gate-reviewer | claude-opus-4-7 |
| codex-dev | developer | o3 |
| orchestrator | orchestrator | claude-sonnet-4-6 |

Skills assigned: `claude-gate` gets `gate-review` (expert) + `architecture` (expert); `claude-dev` gets `typescript` (expert) + `postgres` (expert) + `react` (capable).

Message topics: `proposal-updates` (90d), `gate-events` (365d), `agent-activity` (30d).

---

## Design Patterns

**Idempotent seeding** — All `INSERT` statements use `ON CONFLICT ... DO NOTHING`; safe to re-run.

**Soft foreign keys** — Cross-schema links (e.g., `agency.model.provider_id`, `agent.did`) are stored as TEXT to avoid FK constraints across schemas and support bootstrap ordering.

**Lifecycle columns** — Most tables carry `lifecycle_status` (active / deprecated / retired / blocked), `deprecated_at`, `retire_after`, `notes`.

**Append-only enforcement** — `identity.auditAction`, `governance.decision`, `governance.complianceCheck`, `governance.event` deny `UPDATE`/`DELETE` via trigger. These are write-once ledgers.

**Time-series partitioning** — High-volume temporal tables (`agency.session`, `governance.decision`, `governance.event`, `identity.auditAction`) use range partitioning on their timestamp column.

**pg_notify hot-reload** — `core.runtimeFlag` and `core.runtimeEndpoint` emit `NOTIFY` on mutation so in-process caches can invalidate without polling.

**Schema variable substitution** — `project-init` files reference `:schema_name` as a psql variable. `apply.sh` passes `-v schema_name=<slug>` to every file.

**Field-level version history** — The `trg_pVersion` trigger on `proposal` captures a JSONB delta of every changed field into `pVersion`, with actor tracking via `app.current_actor`.

---

## Extensions Required

| Extension | Where | Purpose |
| :--- | :--- | :--- |
| `pgcrypto` | system DB | SHA256 hash chain in `governance.decision` |
| `pgvector` | per-project schema | `vector(1536)` column in `kbEmbedding` |

---

## Adding a New Project

```bash
# 1. Register the project in the control plane
psql -h 127.0.0.1 -U admin -d agentHive2 \
  -c "INSERT INTO core.project (slug, schema_name, owner_did) VALUES ('myProject', 'myProject', 'did:agenthive:system') ON CONFLICT DO NOTHING;"

# 2. Bootstrap the project schema
./deploy/apply.sh --project-only -s myProject
```

The project schema will contain all 28 tables populated with the default workflow templates and agent roster from the seed files.

---

## Development Sandbox

The `dev/` subdirectory holds an ephemeral sandbox schema used for local exploration. Objects in `dev` are never referenced by deploy scripts and can be dropped freely. CI lint enforces no `dev.` references appear in production deploy files.
