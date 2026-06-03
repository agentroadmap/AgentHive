# P431 — Control Database Bootstrap: `hiveCentral` with Versioned Schemas

**Status:** COMPLETE  
**Parent:** P429 (Control Plane Boundary)  
**Related:** P501 (Bootstrap Runbook), P592–P608 (Per-schema proposals), P502 (Logical Replication)  
**DDL files:** `database/ddl/hivecentral/`  
**Deployment runbook:** `docs/migration/p501-runbook.md`

---

## Problem

All control-plane state (hosts, services, users, projects, agencies, models, budgets, workflow definitions, dispatches, leases, and audit) lived in the `agenthive` tenant database alongside product data. This made:

- Multi-project operation impossible without shared-state contamination.
- AgentHive development disruptive to the platform running it.
- Credential and lease separation across tenant projects impractical.

---

## Solution

Introduce a **dedicated control-plane database** (`hiveCentral` by default, configurable via `${CONTROL_DB}`) on the existing Postgres instance. Bootstrap 15 control schemas via idempotent, numbered, schema-qualified DDL files. The `agenthive` database transitions to a first-class project tenant database.

---

## As-Built Schema Inventory

The original DDL sketch (`docs/architecture/control-plane-ddl-sketch.md`) proposed 10 schemas using `control_*` naming. The as-built implementation in `database/ddl/hivecentral/` uses 15 schemas with refined names to better reflect responsibility boundaries:

| DDL File | Schema Created | P# | Contents |
|---|---|---|---|
| `000-roles.sql` | *(Postgres roles — `postgres` DB only)* | P592 | `agenthive_admin`, `_orchestrator`, `_agency`, `_a2a`, `_observability`, `_repl` |
| `001-core.sql` | `core` | P592 | `installation`, `host`, `os_user`, `runtime_flag`, `service_heartbeat` |
| `002-identity.sql` | `control_identity` | P593 | `principal`, `did_document`, `principal_key`, `audit_action` |
| `004-model.sql` | `control_model` | P595 | `model`, `model_route`, `host_model_policy` |
| `005-credential.sql` | `control_credential` | P596 | `vault_provider`, `credential`, `credential_grant`, `rotation_log` |
| `006-workforce.sql` | `workforce` | P597 | `agent`, `agent_skill`, `agent_capability` |
| `010-project.sql` | `control_project` | P601 | `project`, `project_db`, `project_host`, `project_repo`, `project_*_grant` |
| `010b-project-ext.sql` | `control_project` (ext) | — | `project_worktree`, `project_member`, `project_budget_policy`, `project_capacity_config`, `project_route_policy`, `project_sandbox_grant` |
| `009-sandbox.sql` | `sandbox` | P600 | `sandbox_definition`, `boundary_policy`, `egress_rule`, `mount_grant` |
| `003-agency.sql` | `agency` | P594 | `agency_provider`, `agency`, `agency_session`, `liaison_message`, `agency_route_policy` |
| `007-template.sql` | `template` | P598 | `workflow_template`, `state_name`, `gate_definition`, `agent_role_profile`, `proposal_template` |
| `008-tooling.sql` | `tooling` | P599 | `tool`, `mcp_tool`, `cli_tool`, `tool_grant` |
| `011-dependency.sql` | `dependency` | P602 | `cross_project_dependency`, `dependency_kind_catalog` |
| `012-messaging.sql` | `messaging` | P603 | `a2a_topic`, `a2a_message`, `a2a_subscription`, `a2a_dlq`, `a2a_message_archive` |
| `013-observability.sql` | `observability` | P604 | `trace_span`, `agent_execution_span`, `proposal_lifecycle_event`, `model_routing_outcome`, `decision_explainability` |
| `014-governance.sql` | `governance` | P605 | `policy_version`, `decision_log` (hash-chained), `compliance_check`, `event_log` |
| `015-efficiency.sql` | `efficiency` | P606 | `efficiency_metric`, `cost_ledger_summary`, `dispatch_metric_summary`, `route_token_budget` |

### Schema naming evolution (sketch → as-built)

| DDL sketch name | As-built name | Rationale |
|---|---|---|
| `control_runtime` | `core` | Foundation layer; `core` avoids `control_` prefix collision with credential/identity schemas |
| `control_models` | `control_model` (singular) | Naming convention alignment |
| `control_workforce` | `workforce` | Dropped `control_` prefix; agency/agent identity schemas are peers |
| `control_audit` | `governance` | Broader scope — policy versioning + hash-chained decision logs, not just audit events |
| `control_dispatch` | Subsumed into `agency` + `workforce` | Dispatch is lifecycle on offers/leases; kept close to agency/workforce context |
| `control_workflow` | `template` | Workflow *definitions* (templates, state names, gate rules) separated from runtime state |
| *(new)* | `control_credential` | Credential vault extracted from identity; supports rotation and per-grant scoping |
| *(new)* | `sandbox` | Egress and mount isolation policies |
| *(new)* | `tooling` | MCP/CLI tool registry and per-agency grants |
| *(new)* | `dependency` | Cross-project dependency tracking |
| *(new)* | `messaging` | A2A messaging, DLQ, and archive |
| *(new)* | `observability` | Trace spans, routing outcomes, explainability |
| *(new)* | `efficiency` | Cost ledger summaries, dispatch metrics, route token budgets |

---

## Role Model

Six Postgres roles are created by `000-roles.sql`, all idempotent (`ALTER` if already present). Credentials are passed at deploy time via `PGOPTIONS` server GUC settings — **never via psql `-v` client variables**, which set client-side substitution vars rather than the `current_setting()` GUC values the DDL reads.

| Role | Privilege profile |
|---|---|
| `agenthive_admin` | SUPERUSER — migrations and DBA only |
| `agenthive_orchestrator` | SELECT on catalogs (`host`, `os_user`, `installation`); SELECT+INSERT+UPDATE on `runtime_flag` and `service_heartbeat` |
| `agenthive_agency` | SELECT on `host`, `os_user`, `runtime_flag`; INSERT+UPDATE on `service_heartbeat` |
| `agenthive_a2a` | SELECT on `runtime_flag`; INSERT+UPDATE on `service_heartbeat` |
| `agenthive_observability` | SELECT-only across all schemas |
| `agenthive_repl` | Replication slot access only |

**Least-privilege note:** `agenthive_orchestrator` holds SELECT-only on `host`, `os_user`, and `installation`. Catalog writes belong to provisioning workflows, not the orchestrator.

---

## Catalog Hygiene Convention

Every central catalog table carries exactly seven hygiene fields:

```sql
owner_did         TEXT        NOT NULL,
lifecycle_status  TEXT        NOT NULL DEFAULT 'active'
                              CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
deprecated_at     TIMESTAMPTZ,
retire_after      TIMESTAMPTZ,
notes             TEXT,
created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
```

Catalog rows are **never hard-deleted** — they transition through `active → deprecated → retired`. The `blocked` state suspends a row without deprecating it.

**Exception:** `core.service_heartbeat` carries no hygiene fields. Rationale: no ownership concept, high write volume (every 30 s per service), rows replaced via `ON CONFLICT DO UPDATE`.

---

## Prerequisites

Before applying any DDL to `hiveCentral`:

- **PostgreSQL 16+** (declarative partitioning + `CREATE OR REPLACE TRIGGER`)
- **pg_partman 5.x** — monthly auto-partitioning for append-only time-series tables
  ```sql
  CREATE SCHEMA IF NOT EXISTS partman;
  CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
  ```
- **pgcrypto 1.3** — SHA-256 hash chain in `governance.decision_log`
  ```sql
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  ```

---

## Apply Order

Files must be applied in strict dependency order (later schemas reference earlier ones):

```
Step  File                 Schema
----  -------------------  ------------------
 1    000-roles.sql        (postgres DB — roles only)
 2    001-core.sql         core
 3    002-identity.sql     control_identity
 4    004-model.sql        control_model
 5    005-credential.sql   control_credential
 6    006-workforce.sql    workforce
 7    010-project.sql      control_project
 8    009-sandbox.sql      sandbox
 9    010b-project-ext.sql control_project (ext; requires sandbox)
10    003-agency.sql       agency
11    007-template.sql     template
12    008-tooling.sql      tooling
13    011-dependency.sql   dependency
14    012-messaging.sql    messaging
15    013-observability.sql observability
16    014-governance.sql   governance
17    015-efficiency.sql   efficiency
```

The full deployment sequence with pre-flight checks, PgBouncer configuration, parity verification, and rollback procedure is in [`docs/migration/p501-runbook.md`](../migration/p501-runbook.md).

---

## Idempotency

All DDL files use `CREATE … IF NOT EXISTS` and `ALTER … IF EXISTS` patterns throughout. Re-running any file against an already-bootstrapped database is safe.

Roles use `DO $$ … $$` blocks that check `pg_roles` before `CREATE` and fall through to `ALTER` if the role exists.

---

## Repair and Rollback

### Partial-bootstrap repair

If bootstrap fails mid-sequence (e.g., at step 8 of 17), re-run from the failing step. Steps 1–7 are idempotent and will no-op. The failing step will either succeed (if the error was transient) or emit a clear error to diagnose.

### Full rollback

```bash
# Drop the failed control DB — agenthive remains untouched
psql -U admin -d postgres -c "DROP DATABASE IF EXISTS ${CONTROL_DB};"

# Services continue using agenthive (original configuration unchanged)
# Remediate the issue, then re-run p501-runbook.md from Phase 0
```

The rollback window is zero-downtime: because `hiveCentral` is a new parallel database, dropping it has no effect on the running `agenthive` services.

---

## Compatibility Views (Transition Window)

During the transition window before full tenant-DB cutover, existing runtime code reading from `agenthive` uses compatibility views that proxy to the matching tables in `hiveCentral`. These views are defined per-schema in the P501 runbook and are dropped after P505 (cutover) completes.

---

## Seed Data

After schema bootstrap, the following seed data is required before services start:

| Schema | Table | Required seed rows |
|---|---|---|
| `core` | `installation` | Singleton installation row |
| `core` | `host` | At least one host (`bot`) |
| `control_model` | `model` | Claude, Codex, Gemini model catalog entries |
| `control_model` | `model_route` | Active routes per model × provider × agent |
| `control_model` | `host_model_policy` | Per-host allowed providers |
| `workforce` | `agent` | Service agent registrations |
| `agency` | `agency` | `hermes`, `claude`, `codex`, `copilot` agency rows |
| `control_project` | `project` | AgentHive as `project_id=1`; audiobook, singer tenants |

Seed scripts live in `database/ddl/v4/` and `database/ddl/hivecentral/` alongside the schema files. The P501 runbook Phase 6 covers seeding.

---

## Service Restart Sequence

After `hiveCentral` bootstrap and before any service reads from it:

1. Update `/etc/agenthive/env` to set `PGDATABASE=${CONTROL_DB}` for control-plane services.
2. Restart in order: **MCP server → orchestrator → offer-provider → pipeline-cron**.
3. Verify service heartbeats in `core.service_heartbeat` before proceeding.

> Services need `sudo` to restart. Code changes must be merged to `main` for services to pick them up.

---

## Open Questions (deferred to later proposals)

1. **Multi-agency dispatch:** One or multiple active claims per dispatch? Currently enforced as one-active via unique constraint; relax in P900+ if parallel review is needed.
2. **Credential storage:** `credential_ref` pointer model vs. in-DB encrypted vault. P596 chose the pointer model; full vault solution deferred.
3. **Budget scope hierarchy:** Recursive parent-scope enforcement (dispatch → proposal → project → global) vs. flat lookup. Recommend recursive short-circuit; P747+ covers enforcement.
4. **Audit retention:** Hot storage 1 year → cold archive indefinitely. Partitioning via pg_partman supports this; archival jobs deferred.
5. **Proposal table placement:** Proposal metadata rows live in project tenant databases; lightweight dispatch references live in `hiveCentral.agency`. See CONVENTIONS.md §6.0.
