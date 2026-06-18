# hiveCentral Integration Guide

> **Status:** hiveCentral is **NOT YET LIVE** (see GAP-1.1 in P3793). The single `agenthive` DB currently serves both control-plane and tenant data. This guide documents the topology, env vars, and DDL steps needed when the preconditions in §5 are met.
>
> **Last updated:** 2026-06-17 (P3846 doc sweep)
>
> **Full DDL reference:** `database/ddl/hivecentral/README.md` — apply order, role grant matrix, hygiene field spec.

---

## 1. Schema Topology

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

## 2. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTHIVE_V2_DB_URL` | Yes (when live) | Connection string for the hiveCentral control-plane DB. Format: `postgresql://admin:<PASSWORD>@<HOST>:5432/hivecentral` |
| `DATABASE_URL` | Yes | Connection string for the current `agenthive` tenant DB (pgbouncer port 6432 for queries; direct 5432 for LISTEN/NOTIFY) |

> **Note:** `AGENTHIVE_V2_DB_URL` is defined in the environment but **not yet wired** in the AgentHive application code as of 2026-06-17. See GAP-1.2 in P3793. The application still resolves all DB connections through `DATABASE_URL`. Use `config.getProjectDb(slug)` for project-scoped connections (post-P474).

---

## 3. DDL File Inventory

All 22 DDL files live in `database/ddl/hivecentral/`. See that directory's `README.md` for the full apply-order table, role grant matrix, and catalog hygiene field spec.

| File | Schema | Key Tables / Objects | Proposal |
|------|--------|---------------------|---------|
| `000-roles.sql` | (global) | Postgres role bootstrap — run against the `postgres` DB, not hiveCentral | P592 |
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
| `013-observability-stub.sql` | `observability` | `model_routing_outcome` with `selection_reason_kind`, `candidate_routes_scored` (stub) | P604 |
| `013-observability.sql` | `observability` | Full distributed tracing + execution telemetry (append-only, partitioned monthly) | — |
| `014-governance.sql` | `governance` | Policy versioning, audit decision log, compliance checks, event-sourcing spine | — |
| `015-efficiency.sql` | `efficiency` | Cost attribution, dispatch metrics, token budget tracking | — |
| `070-p1350-agent-personality-memory.sql` | `workforce` | `personality` + `memory_pointer` columns on `workforce.agent` | P1350/P1352 |

---

## 4. Applying the DDL

**Prerequisites** before running any DDL against hiveCentral:

1. **Postgres 16+** with `pgvector` extension: `SELECT extversion FROM pg_extension WHERE extname = 'vector';`
2. **Database created:** `CREATE DATABASE hivecentral;`
3. **pg_partman 5.x** — for monthly auto-partitioning on append-only tables:
   ```sql
   CREATE SCHEMA IF NOT EXISTS partman;
   CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
   ```
4. **pgcrypto 1.3** — for SHA-256 hash chain in `governance.decision_log`:
   ```sql
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   ```

Apply in **strict dependency order** (see `database/ddl/hivecentral/README.md` §Apply order for the rationale):

```bash
# Step 1: roles — run against the postgres DB (NOT hiveCentral)
PGOPTIONS='-c agenthive.admin_password=<vault> \
           -c agenthive.orchestrator_password=<vault> \
           -c agenthive.agency_password=<vault> \
           -c agenthive.a2a_password=<vault> \
           -c agenthive.observability_password=<vault> \
           -c agenthive.repl_password=<vault>' \
  psql -d postgres -f database/ddl/hivecentral/000-roles.sql

# Steps 2–17: apply to hiveCentral in dependency order
DDL_DIR=database/ddl/hivecentral
for f in \
  001-core.sql 002-identity.sql 004-model.sql \
  005-credential.sql 006-workforce.sql 010-project.sql \
  009-sandbox.sql 010b-project-ext.sql 003-agency.sql \
  007-template.sql 008-tooling.sql 011-dependency.sql \
  012-messaging.sql 013-observability.sql 014-governance.sql \
  015-efficiency.sql 070-p1350-agent-personality-memory.sql; do
  echo "Applying $f..."
  psql -d hivecentral -f "$DDL_DIR/$f" || { echo "FAILED: $f"; exit 1; }
done
echo "hiveCentral DDL applied."
```

All files use `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`, or `ALTER … IF NOT EXISTS` — re-running is safe.

> ⚠️ **File 004 applies before 003**: `004-model.sql` and `004-template.sql` must run before `003-agency.sql` due to FK dependencies. The file naming is intentional — see `database/ddl/hivecentral/README.md` §Apply order.

---

## 5. Tenant Bootstrap Sequence

After hiveCentral DDL is applied, each project tenant requires a bootstrap record in `control_project.project`:

```sql
-- Register the agenthive project tenant
INSERT INTO control_project.project (slug, display_name, schema_name, db_url, owner_did)
VALUES ('agenthive', 'AgentHive', 'roadmap', '<AGENTHIVE_DB_URL>', '<ADMIN_DID>');

-- Future tenants follow the same pattern:
-- ('monkeyKing-audio', 'MonkeyKing Audio', 'public', '<MK_DB_URL>', '<ADMIN_DID>');
-- ('georgia-singer', 'Georgia Singer', 'public', '<GS_DB_URL>', '<ADMIN_DID>');
```

After bootstrap, `config.getProjectDb(slug)` resolves the correct tenant DB URL from the hiveCentral registry.

---

## 6. Deployment Preconditions

**Current state (2026-06-17):** hiveCentral is not live. The application runs against a single `agenthive` DB mixing control-plane and tenant data. See GAP-1 in P3793.

| # | Precondition | Tracking |
|---|-------------|---------|
| 1 | `AGENTHIVE_V2_DB_URL` wired in application config and service startup | P3793 GAP-1.2 |
| 2 | `config.getProjectDb(slug)` routing live | P474 COMPLETE |
| 3 | Tenant bootstrap DDL applied for each project | P3793 GAP-1.3 |
| 4 | pgbouncer pool routing updated for dual-DB connections | P3564 REVIEW |
| 5 | Migration plan: current single-DB → two-tier topology | P429 COMPLETE (DDL exists, not deployed) |
| 6 | Data migration: copy existing `roadmap.*` control-plane rows to hiveCentral schemas | Not yet filed |

**Related proposals:** P429 (hiveCentral DDL), P601 (project schema), P592–P598 (per-schema proposals), P3793 (gap analysis), P3564 (pgbouncer pool).
