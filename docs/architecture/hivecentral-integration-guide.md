> **Type:** architecture
> **Source proposals:** P590–P608 (hiveCentral V2 data-model group)
> **DDL location:** `database/ddl/hivecentral/`

# hiveCentral Integration Guide

hiveCentral is the AgentHive **control-plane database**. It is a dedicated PostgreSQL instance that holds cross-project state: agencies, models, routes, credentials, workforce, governance, and observability. Project-scoped data (proposals, dispatches, agent runs) lives in per-project **tenant databases**.

This guide is for engineers integrating new code with hiveCentral, running the DDL for the first time, or onboarding to the V2 database architecture.

---

## 1. Connection Topology

```
┌─────────────────────────────────────────────────────────┐
│                       Clients                           │
│   Orchestrator  │  MCP Server  │  Web Dashboard  │  CLI │
└───────┬─────────┴──────┬───────┴────────┬────────┴───┬──┘
        │                │                │            │
        ▼                ▼                ▼            ▼
┌────────────────────────────────────────────────────────┐
│                     PgBouncer :6432                    │
│         (transaction-mode pooler; P499)                │
└────────┬──────────────────────────────┬───────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐           ┌──────────────────────────┐
│   hiveCentral   │           │   Tenant DBs (per project)│
│  (control plane)│           │  agenthive, monkeyKing-  │
│  PostgreSQL 16  │           │  audio, georgia-singer … │
└─────────────────┘           └──────────────────────────┘
```

**Key points:**
- All application code connects through PgBouncer on port **6432**, not directly to Postgres on 5432.
- hiveCentral and tenant DBs are separate databases on the same Postgres host (currently) but can be split to dedicated hosts (P517 pattern).
- The orchestrator, MCP server, and web dashboard each hold a connection pool; they do NOT share a pool (P523).

### Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `AGENTHIVE_V2_DB_URL` | hiveCentral DSN (primary access) | `postgresql://agenthive_orchestrator:***@localhost:6432/hiveCentral` |
| `DATABASE_URL` | Legacy agenthive tenant DB (for backward compat) | `postgresql://agenthive_app:***@localhost:6432/agenthive` |
| `PGPORT` | pgbouncer port (queries) | `6432` |
| `PGDATABASE` | Default DB for psql sessions | `agenthive` |

To connect to hiveCentral from psql:
```bash
psql -h localhost -p 6432 -U agenthive_admin -d hiveCentral
```

### Code: Acquiring a Connection Pool

Use `config.getProjectDb(slug)` for tenant-scoped queries. For hiveCentral control-plane queries:

```typescript
import { getPool } from '../shared/db/pool.ts';

// Control-plane pool (hiveCentral)
const pool = await getPool({ database: 'hiveCentral' });
const result = await pool.query('SELECT * FROM core.host WHERE lifecycle_status = $1', ['active']);
```

**Do NOT** add `WHERE project_id = $1` filters to control-plane tables — `project_id` is a tenant-DB pointer, not a row discriminator. See CLAUDE.md §DB topology.

---

## 2. Schema Overview

hiveCentral contains **15 schemas**. Each maps to one or more DDL files under `database/ddl/hivecentral/`.

| File | Schema | Proposal | Purpose |
|------|--------|----------|---------|
| `000-roles.sql` | *(roles only)* | — | PostgreSQL service roles + password setup. Run against the `postgres` DB, not hiveCentral. |
| `001-core.sql` | `core` | P592 | Installation record, hosts, OS users, `runtime_flag`, `service_heartbeat`. Platform-wide globals. |
| `002-identity.sql` | `control_identity` | P593 | Principal (DID), DID document, principal keys, audit actions. Identity root of trust. |
| `003-agency.sql` | `agency` | P594 | Agencies, agency sessions, liaison messages, `agency_route_policy`. Applied after `control_model`. |
| `004-model.sql` | `control_model` | P595 | Model catalog, model routes, `host_model_policy`. Routing source of truth. |
| `004-template.sql` | *(extends template)* | — | Additional template seeds (applied after `007-template.sql`). |
| `005-credential.sql` | `control_credential` | P596 | Vault providers, credentials, credential grants, rotation log. Secret references (not plaintext). |
| `006-workforce.sql` | `workforce` | P597 | Agent registry, agent skills, agent capabilities. Workforce identity layer. |
| `007-template.sql` | `template` | P598 | Workflow templates (immutable), state names, gate definitions, `agent_role_profile`, proposal templates. |
| `008-tooling.sql` | `tooling` | P599 | Tool catalog (MCP tools, CLI tools), tool grants. |
| `009-sandbox.sql` | `sandbox` | P600 | Sandbox definitions, boundary policies, egress rules, mount grants. |
| `010-project.sql` | `control_project` | P601 | Project registry, project DB pointers, project hosts, repos, permission grants. |
| `010b-project-ext.sql` | *(extends control_project)* | P744/P747 | Project worktrees, members, budget policies, capacity config, route policies, sandbox grants. Requires `009-sandbox.sql`. |
| `011-dependency.sql` | `dependency` | P602 | Cross-project dependency graph, dependency kind catalog. |
| `012-messaging.sql` | `messaging` | P603 | A2A topics, messages, subscriptions, dead-letter queue, message archive. |
| `013-observability.sql` | `observability` | P604 | Trace spans, agent execution spans, proposal lifecycle events, model routing outcomes, decision explainability. |
| `013-observability-stub.sql` | *(stub)* | — | Lightweight observability stub for environments without full observability schema. |
| `014-governance.sql` | `governance` | P605 | Policy versions (immutable), hash-chained decision log, compliance checks, event spine. |
| `015-efficiency.sql` | `efficiency` | P606 | Efficiency metrics, cost ledger summary, dispatch metric summary, route token budgets. |
| `070-p1350-agent-personality-memory.sql` | *(extends workforce)* | P1350 | Agent personality JSONB + long-term memory (display metadata on `agent_registry`). |

### Catalog Hygiene Fields

Every central catalog table carries **seven hygiene fields**:

```sql
owner_did         TEXT         NOT NULL,
lifecycle_status  TEXT         NOT NULL DEFAULT 'active'
                              CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
deprecated_at     TIMESTAMPTZ,
retire_after      TIMESTAMPTZ,
notes             TEXT,
created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
```

**Never hard-delete catalog rows** — deprecate or retire them instead. The `service_heartbeat` table is the one exception (high-write, no ownership concept).

---

## 3. DDL Application Sequence

### Prerequisites

Install these PostgreSQL extensions before applying DDL:

```bash
# pg_partman 5.x (monthly auto-partitioning for time-series tables)
docker exec postgres-db apt-get install -y postgresql-16-partman
psql -d hiveCentral -c "CREATE SCHEMA IF NOT EXISTS partman;"
psql -d hiveCentral -c "CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;"

# pgcrypto (SHA-256 hash chain in governance.decision_log)
psql -d hiveCentral -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

Minimum PostgreSQL version: **16** (declarative partitioning + pg_partman 5.x required).

### Apply Order

Apply in strict dependency order — FK references require earlier schemas to exist:

```
Step  File                     Schema created
----  -----------------------  ----------------------
 1    000-roles.sql            (roles — run on postgres DB)
 2    001-core.sql             core
 3    002-identity.sql         control_identity
 4    004-model.sql            control_model
 5    005-credential.sql       control_credential
 6    006-workforce.sql        workforce
 7    010-project.sql          control_project
 8    009-sandbox.sql          sandbox
 9    010b-project-ext.sql     (extends control_project)
10    003-agency.sql           agency
11    007-template.sql         template
12    008-tooling.sql          tooling
13    011-dependency.sql       dependency
14    012-messaging.sql        messaging
15    013-observability.sql    observability
16    014-governance.sql       governance
17    015-efficiency.sql       efficiency
18    070-p1350-agent-personality-memory.sql  (extends workforce)
```

### Apply Commands

```bash
# Step 1 — roles (run against postgres DB as superuser)
PGOPTIONS='-c agenthive.admin_password=<vault> \
           -c agenthive.orchestrator_password=<vault> \
           -c agenthive.agency_password=<vault> \
           -c agenthive.a2a_password=<vault> \
           -c agenthive.observability_password=<vault> \
           -c agenthive.repl_password=<vault>' \
  psql -d postgres -f database/ddl/hivecentral/000-roles.sql

# IMPORTANT: Use PGOPTIONS GUC syntax above, NOT psql -v admin_password=<vault>
# The -v flag sets psql substitution variables (:admin_password), not GUC parameters
# (agenthive.admin_password), and will produce a runtime error.

# Steps 2–17 — apply to hiveCentral DB in order
cd database/ddl/hivecentral
psql -d hiveCentral -f 001-core.sql
psql -d hiveCentral -f 002-identity.sql
psql -d hiveCentral -f 004-model.sql
psql -d hiveCentral -f 005-credential.sql
psql -d hiveCentral -f 006-workforce.sql
psql -d hiveCentral -f 010-project.sql
psql -d hiveCentral -f 009-sandbox.sql
psql -d hiveCentral -f 010b-project-ext.sql
psql -d hiveCentral -f 003-agency.sql
psql -d hiveCentral -f 007-template.sql
psql -d hiveCentral -f 008-tooling.sql
psql -d hiveCentral -f 011-dependency.sql
psql -d hiveCentral -f 012-messaging.sql
psql -d hiveCentral -f 013-observability.sql
psql -d hiveCentral -f 014-governance.sql
psql -d hiveCentral -f 015-efficiency.sql

# Optional personality/memory extension (P1350)
psql -d hiveCentral -f 070-p1350-agent-personality-memory.sql
```

The full runbook for initial provisioning lives at `docs/migration/p501-runbook.md`.

---

## 4. Tenant Bootstrap Sequence

After hiveCentral is running, bootstrapping a new project tenant follows this sequence:

1. **Create the tenant DB** — `CREATE DATABASE <slug>;` on the Postgres host.
2. **Register in hiveCentral** — insert a row into `control_project.project` and `control_project.project_db`.
3. **Apply tenant DDL** — apply files from `database/ddl/tenant/` (P508 schema templates) against the tenant DB.
4. **Seed the project** — run the project-seed script (proposals, workflow templates, agent_role_profile seeds).
5. **Register with pgbouncer** — add the tenant DB to the pgbouncer `databases` config; reload.
6. **Verify** — `hive doctor --project <slug>` runs full readiness checks.

Existing tenants:
- `agenthive` — the AgentHive platform itself (project_id=1, self-hosted)
- `monkeyKing-audio` — audio-book generation project (P513)
- `georgia-singer` — AI singer project (P514)

---

## 5. Role Grant Matrix (core schema)

| Role | `core.installation` | `core.host` | `core.os_user` | `core.runtime_flag` | `core.service_heartbeat` |
|------|:---:|:---:|:---:|:---:|:---:|
| `agenthive_admin` | ALL | ALL | ALL | ALL | ALL |
| `agenthive_orchestrator` | SELECT | SELECT | SELECT | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE |
| `agenthive_agency` | — | SELECT | SELECT | SELECT | INSERT, UPDATE |
| `agenthive_a2a` | — | — | — | SELECT | INSERT, UPDATE |
| `agenthive_observability` | SELECT | SELECT | SELECT | SELECT | SELECT |
| `agenthive_repl` | replication slot access only | | | | |

**Least-privilege note:** `agenthive_orchestrator` holds SELECT-only on `host`, `os_user`, and `installation`. Catalog writes belong to provisioning workflows, not the orchestrator.

---

## 6. Key Integration Patterns

### Reading a runtime flag

```typescript
import { config } from '../shared/config/index.ts';

// Reads from hiveCentral.core.runtime_flag (via ConfigResolver, P827)
const maxInflight = await config.get('ORCHESTRATOR_MAX_INFLIGHT_OFFERS');
```

### Registering a new model route

Insert via SQL (admin only) or the MCP `register_model` tool (P1129):
```bash
hive mcp smoke --include tool-availability  # Verify MCP is healthy first
# Then use the mcp_agent register_model action
```

### Querying cross-project dependencies

```sql
SELECT * FROM dependency.cross_project_dependency
WHERE source_project_id = $1 OR target_project_id = $1;
```

### Checking agency liveness

```sql
SELECT agency_id, lifecycle_status, last_heartbeat_at
FROM agency.agency
WHERE lifecycle_status = 'active'
  AND last_heartbeat_at > now() - interval '2 minutes';
```

---

## 7. Reference

| Resource | Path / Location |
|----------|-----------------|
| DDL files | `database/ddl/hivecentral/` |
| DDL README (apply order + role matrix) | `database/ddl/hivecentral/README.md` |
| Multi-project architecture spec | `docs/multi-project-redesign.md` |
| Disaster recovery design | `docs/dr/hivecentral-dr-design.md` |
| P501 provisioning runbook | `docs/migration/p501-runbook.md` |
| Control-plane table classification | `database/control-plane-tables.md` |
| Gap analysis (current implementation status) | `docs/architecture/gap-analysis-2026-06.md` |
| Proposal group | `roadmap_proposal.proposal` rows P590–P608 |
| hiveCentral CONVENTIONS | `docs/hiveCentral/CONVENTIONS.md` |
