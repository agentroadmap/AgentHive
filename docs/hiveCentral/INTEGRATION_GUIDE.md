# hiveCentral Integration Guide

> **Status:** hiveCentral is NOT YET LIVE (see GAP-1.1 in P3793). The single `agenthive` DB currently serves both control-plane and tenant data. This guide documents the DDL and integration steps needed to bring hiveCentral online when the conditions in §5 are met.
>
> **Last updated:** 2026-06-16

---

## 1. DDL File Inventory

All 22 DDL files are in `database/ddl/hivecentral/`. Apply them in the numbered order below.

| File | Schema | Key Tables / Objects | Proposal |
|------|--------|---------------------|---------|
| `000-roles.sql` | (global) | Postgres role bootstrap for all hiveCentral services | P592 |
| `001-core.sql` | `core` | `installation`, `host_registry`, `os_user`, `runtime_flag`, `service_heartbeat` | P592 |
| `002-identity.sql` | `identity` | `principal`, `did_document`, `public_key`, audit actions | P593 |
| `003-agency.sql` | `agency` | `provider`, `agency`, `session`, `capacity`, message kind catalog | P594 |
| `004-model.sql` | `model` | `model_capability`, `model`, `model_route`, `host_model_policy`; views `v_active_routes`, `v_route_policy` | P595 |
| `004-template.sql` | `template` | Immutable versioned workflow templates (first stub) | P598 |
| `005-credential.sql` | `credential` | `credential_provider`, `credential`, `credential_grant`, rotation audit log | P596 |
| `005-dispatch-stub.sql` | `dispatch` | `dispatch.work_claim` with `cost_snapshot` JSONB (coordination stub for P603) | P595 |
| `006-workforce.sql` | `workforce` | `agent`, `skill`, `agent_skill`, `agent_project`, `skill_grant_log`; views `v_agent_capabilities` | P597 |
| `007-template.sql` | `template` | Full workflow template, state machine, gate criteria, agent role profiles | P598 |
| `008-tooling.sql` | `tooling` | MCP + CLI tool catalog, per-principal access grants | — |
| `009-sandbox.sql` | `sandbox` | Sandbox types, resource boundary policies, egress rules, filesystem mount grants | — |
| `010-project.sql` | `control_project` | Project catalog, tenant DB bindings, host assignments, repo references | P601 |
| `010b-project-ext.sql` | `control_project` | Worktrees, members, budget policy, capacity config, route policy, sandbox grants | — |
| `011-dependency.sql` | `dependency` | Cross-project dependency links with resolution tracking + pg_notify | — |
| `012-messaging.sql` | `messaging` | Topic bus, message log, subscriptions, dead-letter queue, cold-tier archive | — |
| `013-observability-stub.sql` | `observability` | `model_routing_outcome` with `selection_reason_kind`, `candidate_routes_scored`, `evaluation_policy_id` (stub) | P604 |
| `013-observability.sql` | `observability` | Full distributed tracing + execution telemetry (append-only, partitioned monthly) | — |
| `014-governance.sql` | `governance` | Policy versioning, audit decision log, compliance checks, event-sourcing spine | — |
| `015-efficiency.sql` | `efficiency` | Cost attribution, dispatch metrics, token budget tracking | — |
| `070-p1350-agent-personality-memory.sql` | `workforce` | `personality` + `memory_pointer` columns on `workforce.agent` | P1350/P1352 |
| `README.md` | — | DDL directory documentation (not a migration file) | — |

---

## 2. Prerequisites

Before applying the DDL:

1. **Postgres 16+** with `pgvector` extension installed.  
   Verify: `SELECT extversion FROM pg_extension WHERE extname = 'vector';`

2. **Database created:** `CREATE DATABASE hivecentral;`

3. **Environment variable set:**
   ```bash
   export AGENTHIVE_V2_DB_URL="postgresql://admin:<PASSWORD>@<HOST>:5432/hivecentral"
   ```
   This env var is defined but **not yet wired** in the AgentHive application code (as of 2026-06-16, see GAP-1.2 in P3793).

4. **Network access** to the hiveCentral Postgres instance from all AgentHive services.

---

## 3. Applying the DDL

Apply files in strict numerical order. Gaps (e.g., `005-credential.sql` before `006-workforce.sql`) are intentional — dependencies go upward by number.

```bash
# Set connection for hiveCentral (NOT the live agenthive DB)
export PGDATABASE=hivecentral
export PGHOST=<host>
export PGPORT=5432
export PGUSER=admin
export PGPASSWORD=<password>

DDL_DIR=/data/code/AgentHive/database/ddl/hivecentral

# Apply in order (skip README.md)
for f in \
  "$DDL_DIR/000-roles.sql" \
  "$DDL_DIR/001-core.sql" \
  "$DDL_DIR/002-identity.sql" \
  "$DDL_DIR/003-agency.sql" \
  "$DDL_DIR/004-model.sql" \
  "$DDL_DIR/004-template.sql" \
  "$DDL_DIR/005-credential.sql" \
  "$DDL_DIR/005-dispatch-stub.sql" \
  "$DDL_DIR/006-workforce.sql" \
  "$DDL_DIR/007-template.sql" \
  "$DDL_DIR/008-tooling.sql" \
  "$DDL_DIR/009-sandbox.sql" \
  "$DDL_DIR/010-project.sql" \
  "$DDL_DIR/010b-project-ext.sql" \
  "$DDL_DIR/011-dependency.sql" \
  "$DDL_DIR/012-messaging.sql" \
  "$DDL_DIR/013-observability-stub.sql" \
  "$DDL_DIR/013-observability.sql" \
  "$DDL_DIR/014-governance.sql" \
  "$DDL_DIR/015-efficiency.sql" \
  "$DDL_DIR/070-p1350-agent-personality-memory.sql"; do
  echo "Applying $f..."
  psql -f "$f" || { echo "FAILED: $f"; exit 1; }
done

echo "hiveCentral DDL applied successfully."
```

All files are designed to be **idempotent** (use `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, or `ALTER ... IF NOT EXISTS` patterns). Re-running is safe.

---

## 4. Schema Topology

```
┌─────────────────────────────────────────┐
│              hiveCentral DB             │
│  (control-plane, shared across all      │
│   projects and agents)                  │
├─────────────────────────────────────────┤
│ core        – host, user, runtime flags │
│ identity    – DIDs, principals, keys    │
│ agency      – providers, sessions       │
│ model       – routes, capability vocab  │
│ credential  – secrets vault             │
│ workforce   – agent registry, skills    │
│ template    – workflow state machines   │
│ tooling     – MCP/CLI tool catalog      │
│ sandbox     – execution isolation       │
│ control_project – project registry      │
│ messaging   – A2A message bus           │
│ observability – tracing, telemetry      │
│ governance  – policy, audit, compliance │
│ efficiency  – cost, dispatch metrics    │
└─────────────────────────────────────────┘

            ↓ one DB per project tenant

┌────────────────────┐  ┌─────────────────────────┐
│  agenthive DB      │  │  monkeyKing-audio DB     │
│  (project tenant)  │  │  (planned, not live)     │
│  roadmap.* tables  │  │                          │
└────────────────────┘  └─────────────────────────┘
```

**Separation of concerns:**
- **hiveCentral** owns identity, model routing, agent registry, workflow templates, credentials, and cross-project governance — shared infrastructure.
- **Per-project tenant DBs** own proposals, leases, dispatches, gate decisions, and project-specific operational data.
- The link between them is `control_project.project` in hiveCentral, which holds `schema_name` pointing to the tenant DB.

---

## 5. Deployment Status and Preconditions

**Current state (2026-06-16):** hiveCentral is **not live**. The application runs against a single `agenthive` DB that mixes control-plane and tenant data. See GAP-1.1, GAP-1.2, GAP-1.3 in proposal P3793.

**Preconditions before going live:**

| # | Precondition | Tracking |
|---|-------------|---------|
| 1 | AGENTHIVE_V2_DB_URL wired in application config and service startup | P3793 GAP-1.2 |
| 2 | `config.getProjectDb(slug)` routing live (post-P474) | P474 COMPLETE |
| 3 | Tenant bootstrap DDL applied for each project (`agenthive`, `monkeyKing-audio`, `georgia-singer`) | P3793 GAP-1.3 |
| 4 | pgbouncer pool routing updated to support dual-DB connections | P3564 REVIEW |
| 5 | P429 follow-up: migration plan from current single-DB to two-tier topology | P429 COMPLETE (DDL exists, not yet deployed) |
| 6 | Data migration script: copy existing `roadmap.*` control-plane rows to hiveCentral schemas | Not yet filed |

**Related proposals:** P429 (hiveCentral DDL, COMPLETE), P601 (project schema), P592-P598 (schema proposals), P3793 (gap analysis), P745 (vNext data model umbrella), P821 (V2 single-database architecture), P823 (database baseline), P757 (B3 control-plane table migration), P756 (B2 DB bootstrap), P430-P436 (control DB boundary series).
> Status: **Pre-deployment** — hiveCentral is not yet live. The single `agenthive` database currently serves both control-plane and tenant data. This guide documents the target architecture and migration path.

## Overview

hiveCentral is the dedicated control-plane database for AgentHive V2. It separates platform governance (identity, model routing, observability, workflow templates) from tenant-scoped proposal data. Each project tenant gets its own DB; hiveCentral holds the shared infrastructure layer.

## Prerequisites

- PostgreSQL 16 with `pgvector` and `pgcrypto` extensions
- A dedicated Postgres instance (separate from the `agenthive` tenant DB)
- Environment variable `AGENTHIVE_V2_DB_URL` pointing to the new instance

## DDL Apply Order

Apply DDL files from `database/ddl/hivecentral/` in the following order. **The order is mandatory** — later schemas reference types and tables from earlier ones.

| Step | File | Schema | Purpose |
|------|------|--------|---------|
| 0 | `000-roles.sql` | (roles) | Per-service Postgres role bootstrap — run before any schema DDL |
| 1 | `001-core.sql` | `core` | Installation singleton, host registry, OS user registry, runtime flags, service heartbeat |
| 2 | `002-identity.sql` | `identity` | Principals, DID documents, public keys, audit actions |
| 3 | `003-agency.sql` | `agency` | Work-execution contexts: provider, agency, session, capacity, liaison message kinds |
| 4 | `004-model.sql` | `model` | `model_capability`, `model`, `model_route`, `host_model_policy`; seeds 8 capability vocab + Claude routes |
| 5 | `004-template.sql` | `template` | Immutable versioned workflow templates (first template schema slot) |
| 6 | `005-credential.sql` | `credential` | Secret vault provider registry, named credential catalog, access grants, rotation audit log |
| 7 | `005-dispatch-stub.sql` | `dispatch` | Coordination stub — reserves `dispatch.work_claim` with `cost_snapshot` JSONB; step 13 adds full columns |
| 8 | `006-workforce.sql` | `workforce` | Agent, skill, `agent_skill`, `agent_project`, `skill_grant_log` |
| 9 | `007-template.sql` | `template` | Full workflow template schema: state machine, gate criteria, `agent_role_profile`; replaces hardcoded `STAGE_DISPATCH_ROLES` |
| 10 | `008-tooling.sql` | `tooling` | MCP tools, CLI tools, per-principal access grants |
| 11 | `009-sandbox.sql` | `sandbox` | Sandbox definition: resource boundary policies, egress rules, filesystem mount grants |
| 12 | `010-project.sql` | `control_project` | Project catalog, tenant DB bindings, host assignments, repo refs |
| 13 | `010b-project-ext.sql` | `control_project` | Extensions: worktrees, members, budget policy, capacity config, route policy, sandbox grants |
| 14 | `011-dependency.sql` | `dependency` | Cross-project dependency links with resolution tracking and `pg_notify` |
| 15 | `012-messaging.sql` | `messaging` | A2A async messaging: topic bus, message log, subscriptions, dead-letter queue, cold-tier archive |
| 16 | `013-observability-stub.sql` | `observability` | Stub — reserves `observability.model_routing_outcome` with 3 structured fields; step 17 adds full logic |
| 17 | `013-observability.sql` | `observability` | Full distributed tracing + execution telemetry; append-only, partitioned monthly |
| 18 | `014-governance.sql` | `governance` | Policy versioning, audit decision log, compliance checks, event-sourcing spine; requires `pgcrypto` |
| 19 | `015-efficiency.sql` | `efficiency` | Cost attribution, dispatch metrics, token budget tracking |
| 20 | `070-p1350-agent-personality-memory.sql` | `workforce` | P1350-B personality + long-term memory columns on `workforce.agent` |

> **Note:** `004-template.sql` and `007-template.sql` both modify the `template` schema. Apply `004` before `007` — the later file extends the earlier one.

## Applying the DDL

```bash
export AGENTHIVE_V2_DB_URL="postgresql://<user>:<pass>@<host>:5432/hivecentral"

# Apply in order
for f in $(ls database/ddl/hivecentral/*.sql | sort); do
  echo "Applying $f..."
  psql "$AGENTHIVE_V2_DB_URL" -f "$f"
done
```

If you need to apply a single file:

```bash
psql "$AGENTHIVE_V2_DB_URL" -f database/ddl/hivecentral/001-core.sql
```

## Connecting from Application Code

After hiveCentral is provisioned, resolve the connection via `config.getHiveCentralDb()` (post-P474 API). Do **not** add `WHERE project_id = $1` filters to control-plane tables — `project_id` in hiveCentral is a tenant-DB pointer, not a row discriminator.

```typescript
// Correct — use getHiveCentralDb() for control-plane queries
const db = await config.getHiveCentralDb();
const routes = await db.query('SELECT * FROM model.model_route WHERE is_active = true');

// Correct — use getProjectDb(slug) for tenant-scoped data
const tenantDb = await config.getProjectDb('my-project');
```

## Schema Overview

| Schema | Responsibility |
|--------|---------------|
| `core` | Platform bootstrap: host registry, runtime flags, heartbeat |
| `identity` | DID-based principal identity and public-key management |
| `agency` | Agent work-execution contexts and liaison messaging |
| `model` | Model catalog, capability vocab, routing policy |
| `template` | Immutable workflow state-machine templates |
| `credential` | Secret vault and rotation audit |
| `dispatch` | Work claim coordination (stub → full via P603) |
| `workforce` | Agent registry, skills, personality memory |
| `tooling` | MCP and CLI tool access grants |
| `sandbox` | Resource boundary and egress policies |
| `control_project` | Project catalog and tenant DB bindings |
| `dependency` | Cross-project dependency resolution |
| `messaging` | A2A async topic bus and dead-letter queue |
| `observability` | Distributed tracing, partitioned monthly (stub → full via P604) |
| `governance` | Policy versioning, audit log, compliance spine |
| `efficiency` | Cost attribution and token budget tracking |

## Migration Path from V1

The current V1 `agenthive` database will be incrementally migrated:

1. **Provision** a dedicated Postgres 16 instance for hiveCentral.
2. **Apply DDL** in the order above.
3. **Seed** capability vocab and Claude model routes from `004-model.sql` seeds.
4. **Migrate** control-plane rows from `agenthive` (identity, model routes, templates) to hiveCentral.
5. **Update** `AGENTHIVE_V2_DB_URL` in `/etc/agenthive/env` and restart services.
6. **Verify** with `hive service status` and health checks.

See P474 (project DB resolution) and P592–P604 (DDL proposal series) for detailed migration specs.
