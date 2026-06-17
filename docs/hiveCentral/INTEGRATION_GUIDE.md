# hiveCentral Integration Guide

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
