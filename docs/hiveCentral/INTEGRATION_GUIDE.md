# hiveCentral Integration Guide

> **Status (2026-06-17):** hiveCentral is **not yet live**. The single `agenthive` database currently serves both control-plane and tenant data. This guide documents the target architecture and the steps required to bring hiveCentral online.

## Overview

hiveCentral is a dedicated PostgreSQL 16 instance that will host the AgentHive V2 control-plane schemas. Each product/project gets its own tenant database registered in hiveCentral, replacing the current single-DB `agenthive` arrangement.

## Prerequisites

- PostgreSQL 16 instance (dedicated host or container)
- `AGENTHIVE_V2_DB_URL` connection string set in environment
- `pgcrypto` extension available (required by `014-governance.sql`)
- `pgvector` extension available (required for embedding columns in project-init)

## DDL Apply Order

Apply all files under `database/ddl/hivecentral/` in the following order. **Order matters** — later files reference roles and schemas defined by earlier ones.

| Order | File | Schema | Purpose |
|-------|------|--------|---------|
| 1 | `000-roles.sql` | (roles) | Bootstrap per-service Postgres roles — **must run before any schema DDL** |
| 2 | `001-core.sql` | `core` | Installation singleton, host registry, OS user registry, runtime flags, service heartbeat |
| 3 | `002-identity.sql` | `identity` | Principals, DID documents, public keys, audit actions |
| 4 | `003-agency.sql` | `agency` | Work-execution contexts: provider, agency, session, capacity, liaison message kinds |
| 5 | `004-model.sql` | `model` | model_capability, model, model_route, host_model_policy; seeds 8 capability vocab + Claude routes |
| 6 | `004-template.sql` | `template` | Immutable versioned workflow templates (first template schema slot) |
| 7 | `005-credential.sql` | `credential` | Secret vault provider registry, named credential catalog, access grants, rotation audit log |
| 8 | `005-dispatch-stub.sql` | `dispatch` | Coordination stub — reserves `dispatch.work_claim` with `cost_snapshot JSONB`; `003-dispatch.sql` adds full columns |
| 9 | `006-workforce.sql` | `workforce` | Agent, skill, agent_skill, agent_project, skill_grant_log |
| 10 | `007-template.sql` | `template` | Full workflow template schema: state machine, gate criteria, agent_role_profile (replaces STAGE_DISPATCH_ROLES literals) |
| 11 | `008-tooling.sql` | `tooling` | MCP tools, CLI tools, per-principal access grants |
| 12 | `009-sandbox.sql` | `sandbox` | Sandbox definition: resource boundary policies, egress rules, filesystem mount grants |
| 13 | `010-project.sql` | `control_project` | Project catalog, tenant DB bindings, host assignments, repo refs |
| 14 | `010b-project-ext.sql` | `control_project` | Extensions: worktrees, members, budget policy, capacity config, route policy, sandbox grants |
| 15 | `011-dependency.sql` | `dependency` | Cross-project dependency links with resolution tracking and `pg_notify` |
| 16 | `012-messaging.sql` | `messaging` | A2A async messaging: topic bus, message log, subscriptions, dead-letter queue, cold-tier archive |
| 17 | `013-observability-stub.sql` | `observability` | Stub — reserves `observability.model_routing_outcome` with 3 structured fields |
| 18 | `013-observability.sql` | `observability` | Full distributed tracing + execution telemetry; append-only, partitioned monthly |
| 19 | `014-governance.sql` | `governance` | Policy versioning, audit decision log, compliance checks, event-sourcing spine; **requires pgcrypto** |
| 20 | `015-efficiency.sql` | `efficiency` | Cost attribution, dispatch metrics, token budget tracking |
| 21 | `070-p1350-agent-personality-memory.sql` | `workforce` | P1350-B personality + long-term memory columns on `workforce.agent` |

> **Note:** `004-template.sql` and `007-template.sql` both touch the `template` schema. Apply 004 before 007 — 007 replaces the minimal stub with the full schema.

## Apply Script

```bash
export PGHOST=<hiveCentral-host>
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD=<password>
export PGDATABASE=hivecentral   # or your chosen DB name

DDL_DIR="database/ddl/hivecentral"

for f in \
  000-roles.sql \
  001-core.sql \
  002-identity.sql \
  003-agency.sql \
  004-model.sql \
  004-template.sql \
  005-credential.sql \
  005-dispatch-stub.sql \
  006-workforce.sql \
  007-template.sql \
  008-tooling.sql \
  009-sandbox.sql \
  010-project.sql \
  010b-project-ext.sql \
  011-dependency.sql \
  012-messaging.sql \
  013-observability-stub.sql \
  013-observability.sql \
  014-governance.sql \
  015-efficiency.sql \
  070-p1350-agent-personality-memory.sql; do
  echo "Applying $f..."
  psql -f "$DDL_DIR/$f"
done
```

## Environment Variable

Set `AGENTHIVE_V2_DB_URL` to point application code at hiveCentral:

```
AGENTHIVE_V2_DB_URL=postgresql://<user>:<password>@<host>:<port>/hivecentral
```

Code that resolves configuration via `config.getProjectDb(slug)` (post-P474) will use this to look up tenant DB connection strings registered in `control_project.project`.

## Schema Quick Reference

| Schema | Key Tables | Description |
|--------|-----------|-------------|
| `core` | `installation`, `host_registry`, `runtime_flag` | Platform bootstrap and hot-reload config |
| `identity` | `principal`, `did_document`, `public_key` | Cryptographic agent identity |
| `agency` | `provider`, `agency`, `liaison_session` | Work-execution context hierarchy |
| `model` | `model`, `model_route`, `host_model_policy` | LLM routing and cost data |
| `template` | `workflow_template`, `state`, `transition`, `agent_role_profile` | SMDL workflow definitions |
| `credential` | `vault_provider`, `named_credential`, `access_grant` | Secret management |
| `dispatch` | `work_claim` | Atomic claim coordination |
| `workforce` | `agent`, `skill`, `agent_skill` | Agent registry and capabilities |
| `tooling` | `mcp_tool`, `cli_tool`, `tool_grant` | Tool surface and access control |
| `sandbox` | `sandbox`, `egress_rule`, `mount_grant` | Execution isolation policies |
| `control_project` | `project`, `worktree`, `member` | Project catalog and tenant bindings |
| `dependency` | `dependency_link` | Cross-project dependency graph |
| `messaging` | `topic`, `message_log`, `subscription`, `dead_letter` | A2A async messaging bus |
| `observability` | `trace_span`, `execution_telemetry` | Distributed tracing (partitioned monthly) |
| `governance` | `policy_version`, `audit_decision`, `event_spine` | Hash-chained audit and compliance |
| `efficiency` | `cost_attribution`, `dispatch_metric` | Token budget and cost tracking |

## Current Single-DB Workaround

Until hiveCentral is provisioned, the `agenthive` database hosts all control-plane data in the `roadmap` schema. The `roadmap_workforce` schema holds agent/agency tables. Application code reads `PGHOST`/`PGPORT`/`PGDATABASE` from `/etc/agenthive/env` and routes all queries through PgBouncer on port 6432.

Do **not** add `WHERE project_id = $1` filters to control-plane tables — `project_id` is a tenant-DB pointer, not a row discriminator.

## Related Proposals

| Proposal | Description |
|----------|-------------|
| P590 | hiveCentral data-model overhaul (parent) |
| P756 | hiveCentral DB bootstrap (provisioning script + role grants) |
| P757 | Migrate control-plane tables from `agenthive` to hiveCentral |
| P821 | AgentHive V2 single-database architecture |
| P431 | Control Database Bootstrap |
