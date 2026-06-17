# hiveCentral Integration Guide

> **Status (2026-06-16):** hiveCentral is NOT yet live. The current system runs a single `agenthive` Postgres database serving both control-plane and tenant data. This guide documents the DDL apply order and integration steps for when a dedicated hiveCentral instance is provisioned.

## Prerequisites

| Requirement | Details |
|------------|---------|
| Postgres | 16+ with `pgcrypto` and `pgvector` extensions |
| Env var | `AGENTHIVE_V2_DB_URL` — connection string to the dedicated hiveCentral instance |
| Extensions | `CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS vector;` |
| Apply user | Superuser or role with `CREATE SCHEMA` privilege |

## DDL Apply Order

Apply files in the order below. **Do not skip or reorder** — later files reference objects created in earlier ones.

| Order | File | Schema | Purpose |
|-------|------|--------|---------|
| 1 | `000-roles.sql` | (roles) | Per-service Postgres role bootstrap — run BEFORE any schema DDL |
| 2 | `001-core.sql` | `core` | Installation singleton, host registry, OS user registry, runtime flags, service heartbeat |
| 3 | `002-identity.sql` | `identity` | Principals, DID documents, public keys, audit actions |
| 4 | `003-agency.sql` | `agency` | Work-execution contexts: provider, agency, session, capacity, liaison message kinds |
| 5 | `004-model.sql` | `model` | model_capability, model, model_route, host_model_policy; seeds 8 capability vocab + Claude routes |
| 6 | `004-template.sql` | `template` | Immutable versioned workflow templates (first template schema slot) |
| 7 | `005-credential.sql` | `credential` | Secret vault provider registry, named credential catalog, access grants, rotation audit log |
| 8 | `005-dispatch-stub.sql` | `dispatch` | Coordination stub — reserves `dispatch.work_claim` with `cost_snapshot` JSONB; `013-observability.sql` adds full columns |
| 9 | `006-workforce.sql` | `workforce` | agent, skill, agent_skill, agent_project, skill_grant_log |
| 10 | `007-template.sql` | `template` | Full workflow template schema: state machine, gate criteria, agent_role_profile (replaces STAGE_DISPATCH_ROLES literals) |
| 11 | `008-tooling.sql` | `tooling` | MCP tools, CLI tools, per-principal access grants |
| 12 | `009-sandbox.sql` | `sandbox` | Sandbox definition: resource boundary policies, egress rules, filesystem mount grants |
| 13 | `010-project.sql` | `control_project` | Project catalog, tenant DB bindings, host assignments, repo refs |
| 14 | `010b-project-ext.sql` | `control_project` | Extensions: worktrees, members, budget policy, capacity config, route policy, sandbox grants |
| 15 | `011-dependency.sql` | `dependency` | Cross-project dependency links with resolution tracking and `pg_notify` |
| 16 | `012-messaging.sql` | `messaging` | A2A async messaging: topic bus, message log, subscriptions, dead-letter queue, cold-tier archive |
| 17 | `013-observability-stub.sql` | `observability` | Stub — reserves `observability.model_routing_outcome` with 3 structured fields |
| 18 | `013-observability.sql` | `observability` | Full distributed tracing + execution telemetry; append-only, partitioned monthly |
| 19 | `014-governance.sql` | `governance` | Policy versioning, audit decision log, compliance checks, event-sourcing spine; requires `pgcrypto` |
| 20 | `015-efficiency.sql` | `efficiency` | Cost attribution, dispatch metrics, token budget tracking |
| 21 | `070-p1350-agent-personality-memory.sql` | `workforce` | P1350-B personality + long-term memory columns on `workforce.agent` |

> **Template ordering note:** `004-template.sql` and `007-template.sql` both touch the `template` schema — `004` creates the schema and initial stub, `007` adds the full state-machine tables. Apply `004` before `007`.

## Apply Script

```bash
#!/usr/bin/env bash
# Apply hiveCentral DDL in order
set -euo pipefail

DDL_DIR="database/ddl/hivecentral"
DB="${AGENTHIVE_V2_DB_URL:?AGENTHIVE_V2_DB_URL must be set}"

FILES=(
  000-roles.sql
  001-core.sql
  002-identity.sql
  003-agency.sql
  004-model.sql
  004-template.sql
  005-credential.sql
  005-dispatch-stub.sql
  006-workforce.sql
  007-template.sql
  008-tooling.sql
  009-sandbox.sql
  010-project.sql
  010b-project-ext.sql
  011-dependency.sql
  012-messaging.sql
  013-observability-stub.sql
  013-observability.sql
  014-governance.sql
  015-efficiency.sql
  070-p1350-agent-personality-memory.sql
)

for f in "${FILES[@]}"; do
  echo "Applying $f..."
  psql "$DB" -f "$DDL_DIR/$f"
done

echo "hiveCentral DDL applied successfully."
```

## Environment Configuration

Add to `/etc/agenthive/env` or your `.env`:

```bash
# Connection string to the dedicated hiveCentral Postgres 16 instance
AGENTHIVE_V2_DB_URL=postgresql://<user>:<password>@<host>:5432/hiveCentral
```

The application reads this via `config.getHiveCentralDb()` (post-P592 control-plane bootstrap).

## Schema Map

```
hiveCentral
├── core              — installation singleton, runtime flags, heartbeat
├── identity          — DIDs, public keys, principal audit
├── agency            — providers, agencies, sessions, capacity
├── model             — model catalog, routes, host policy
├── template          — workflow state machines, gate criteria, agent roles
├── credential        — secret vault, named credentials, access grants
├── dispatch          — work claims, cost snapshots
├── workforce         — agents, skills, personality/memory (P1350)
├── tooling           — MCP + CLI tool grants
├── sandbox           — resource boundary policies
├── control_project   — project catalog, tenant DB bindings, worktrees
├── dependency        — cross-project links, pg_notify
├── messaging         — A2A topic bus, dead-letter, cold archive
├── observability     — distributed tracing, execution telemetry (partitioned)
├── governance        — policy versions, audit decisions, event-sourcing
└── efficiency        — cost attribution, dispatch metrics, token budgets
```

## Deployment Status

| Item | Status |
|------|--------|
| hiveCentral Postgres instance | Not provisioned |
| DDL files authored | Complete (22 files) |
| `AGENTHIVE_V2_DB_URL` wired in app | Pending |
| Control-plane migration | Pending (see GAP-1.1 in P3793) |
| Tenant DB separation | Pending (single `agenthive` DB serves all) |

Once provisioned, apply DDL in order above, set `AGENTHIVE_V2_DB_URL`, and restart the MCP server. The existing `agenthive` DB continues serving tenant data until the migration window.
