# `hiveCentral` schema DDL

Target schema files for the v3 redesign control-plane database. These run **only** against `hiveCentral`, never against `agenthive` (which becomes the first project tenant DB after Wave 4) or any other tenant DB.

**16 schemas. Apply in dependency order (see below).**

P820 family mapping: The 17 logical families named in AC-1 map to 16 physical schemas.
`runtime` is absorbed into `core` (core.runtime_flag + core.service_heartbeat cover it —
no separate runtime schema). `queue` maps to `dispatch`. `proposal` stays in tenant DBs
(application-level FK only — see P820 DESIGN DECISION in 005-dispatch-full.sql).

## Layout

```
000-roles.sql          Per-service Postgres roles (run first, on the postgres DB)
001-core.sql           P592 — core: installation, host, os_user, runtime_flag, service_heartbeat
                              NOTE: also covers the "runtime" P820 family (no separate schema)
002-identity.sql       P593 — control_identity: principal, did_document, principal_key, audit_action
004-model.sql          P595 — hivecentral: model_capability, model, model_route, host_model_policy
005-credential.sql     P596 — control_credential: vault_provider, credential, credential_grant, rotation_log
005-dispatch-stub.sql  P603 stub — dispatch: work_claim (cost-snapshot billing record, pre-claim)
005-dispatch-full.sql  P820 — dispatch (full): work_offer, proposal_lease, dispatch_audit,
                              capacity_snapshot, reaper fns, v_active_leases, v_pending_offers
006-workforce.sql      P597 — workforce: agent, agent_skill, agent_capability
010-project.sql        P601 — control_project: project, project_db, project_host, project_repo, project_*_grant
010b-project-ext.sql          control_project ext: project_worktree, project_member, project_budget_policy,
                              project_capacity_config (P744), project_route_policy (P747 D1), project_sandbox_grant
009-sandbox.sql        P600 — sandbox: sandbox_definition, boundary_policy, egress_rule, mount_grant
003-agency.sql         P594 — agency: agency_provider, agency, agency_session, liaison_message, agency_route_policy (P747 D2)
007-template.sql      P598 — template: workflow_template (immutable), state_name, gate_definition, agent_role_profile, proposal_template
008-tooling.sql       P599 — tooling: tool, mcp_tool, cli_tool, tool_grant
011-dependency.sql    P602 — dependency: cross_project_dependency, dependency_kind_catalog
012-messaging.sql     P603 — messaging: a2a_topic, a2a_message, a2a_subscription, a2a_dlq, a2a_message_archive
013-observability.sql P604 — observability: trace_span, agent_execution_span, proposal_lifecycle_event,
                              model_routing_outcome (P747 D6), decision_explainability
014-governance.sql    P605 — governance: policy_version (immutable), decision_log (hash-chained), compliance_check, event_log
015-efficiency.sql    P606 — efficiency: efficiency_metric, cost_ledger_summary, dispatch_metric_summary, route_token_budget (P747 D4)
```

## Catalog hygiene fields (uniform across every central catalog)

Every central catalog table carries exactly **seven** hygiene fields:

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

The four `lifecycle_status` states are:
- `active` — normal operating state
- `deprecated` — soft-deleted; still resolvable for history but invisible to dispatch
- `retired` — permanently decommissioned; `deprecated_at` is set
- `blocked` — temporarily suspended; not deprecated, may return to `active`

Catalog rows are **never hard-deleted** — they are deprecated or retired.

### service_heartbeat hygiene-field exemption

`core.service_heartbeat` carries **no** catalog hygiene fields (`owner_did`, `lifecycle_status`,
`deprecated_at`, `retire_after`, `notes`, `created_at`, `updated_at` are all absent). Rationale:
- No ownership concept: heartbeats are anonymous service signals, not managed entities
- No lifecycle: rows are replaced via `ON CONFLICT (service_id) DO UPDATE`, never deprecated
- Write volume: each service writes a row every 30 s; unnecessary columns waste I/O

The `set_updated_at()` trigger is **not** attached to `core.service_heartbeat`.

## Role grant matrix

| Role                    | core.installation | core.host | core.os_user | core.runtime_flag | core.service_heartbeat | Views           |
|-------------------------|:-----------------:|:---------:|:------------:|:-----------------:|:----------------------:|:---------------:|
| `agenthive_admin`       | ALL               | ALL       | ALL          | ALL               | ALL                    | ALL             |
| `agenthive_orchestrator`| SELECT            | SELECT    | SELECT       | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE | SELECT     |
| `agenthive_agency`      | —                 | SELECT    | SELECT       | SELECT            | INSERT, UPDATE         | —               |
| `agenthive_a2a`         | —                 | —         | —            | SELECT            | INSERT, UPDATE         | —               |
| `agenthive_observability`| SELECT           | SELECT    | SELECT       | SELECT            | SELECT                 | SELECT          |
| `agenthive_repl`        | replication slot access only                                                               |

Notes:
- `agenthive_orchestrator` holds **SELECT-only** on `host`, `os_user`, and `installation`. It must NOT hold INSERT/UPDATE on these catalog tables — catalog writes belong to provisioning workflows (not the orchestrator); granting write access is a least-privilege violation.
- `agenthive_agency` holds SELECT on `os_user` so it can look up the OS user a process runs as.
- `agenthive_a2a` needs SELECT on `runtime_flag` to pick up per-project config and INSERT/UPDATE on `service_heartbeat` to publish its own heartbeat.

## Prerequisites

Before applying any DDL to `hiveCentral`, the following PostgreSQL extensions must be installed:

- **pg_partman 5.x** — monthly auto-partitioning for all append-only time-series tables.
  Install inside the PostgreSQL container: `apt-get install postgresql-16-partman`
  Then in `hiveCentral`:
  ```sql
  CREATE SCHEMA IF NOT EXISTS partman;
  CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
  ```
- **pgcrypto 1.3** — SHA-256 hash chain in `governance.decision_log`.
  ```sql
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  ```

## Apply order

Minimum PostgreSQL version: **16** (declarative partitioning + pg_partman 5.x).

Apply in strict dependency order — each file depends on schemas created by earlier files:

```
Step  File                     Schema created
----  -----------------------  --------------
 1    000-roles.sql            (roles — run against postgres DB, not hiveCentral)
 2    001-core.sql             core  [covers "runtime" P820 family]
 3    002-identity.sql         control_identity
 4    004-model.sql            hivecentral  (model, model_route, host_model_policy)
 5    005-credential.sql       control_credential
 6    005-dispatch-stub.sql    dispatch  (work_claim billing stub — must precede full)
 7    005-dispatch-full.sql    dispatch  (work_offer, proposal_lease, dispatch_audit,
                               capacity_snapshot, reaper fns — covers "queue" P820 family)
 8    006-workforce.sql        workforce
 9    010-project.sql          control_project
10    009-sandbox.sql          sandbox
11    010b-project-ext.sql     (extends control_project; adds FK to sandbox)
12    003-agency.sql           agency
13    007-template.sql         template  [covers "workflow" P820 family]
14    008-tooling.sql          tooling
15    011-dependency.sql       dependency
16    012-messaging.sql        messaging
17    013-observability.sql    observability
18    014-governance.sql       governance
19    015-efficiency.sql       efficiency
```

P820 family coverage:
- `proposal` family: NOT in hiveCentral DDL (design decision — stays in tenant DB).
  All dispatch tables reference proposal_id as application-level FK. See 005-dispatch-full.sql.
- `runtime` family: absorbed into `core` (core.runtime_flag, core.service_heartbeat).
- `queue` family: implemented as `dispatch` schema (005-dispatch-stub.sql + 005-dispatch-full.sql).
- `workflow` family: implemented as `template` schema (007-template.sql).

```bash
# As superuser, on the postgres DB — passwords passed via PGOPTIONS GUC custom parameters:
PGOPTIONS='-c agenthive.admin_password=<vault> \
           -c agenthive.orchestrator_password=<vault> \
           -c agenthive.agency_password=<vault> \
           -c agenthive.a2a_password=<vault> \
           -c agenthive.observability_password=<vault> \
           -c agenthive.repl_password=<vault>' \
  psql -d postgres -f 000-roles.sql

# NOTE: Do NOT use psql -v admin_password=<vault> — that sets the psql client
# substitution variable :admin_password, not the GUC agenthive.admin_password
# read by current_setting(). Using -v produces a runtime error.

# Then on hiveCentral DB itself (steps 2–19 in order):
psql -d hiveCentral -f 001-core.sql
psql -d hiveCentral -f 002-identity.sql
psql -d hiveCentral -f 004-model.sql
psql -d hiveCentral -f 005-credential.sql
psql -d hiveCentral -f 005-dispatch-stub.sql
psql -d hiveCentral -f 005-dispatch-full.sql
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
```

The P501 runbook (`docs/migration/p501-runbook.md`) drives this sequence.

## Reference

- `docs/multi-project-redesign.md` — the v3 architectural spec
- `docs/dr/hivecentral-dr-design.md` — control-plane disaster recovery (P591)
- `roadmap_proposal.proposal` rows P590..P608 — proposal tracking for each schema
