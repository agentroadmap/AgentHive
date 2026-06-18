# `hiveCentral` schema DDL

Target schema files for the v3 redesign control-plane database. These run **only** against `hiveCentral`, never against `agenthive` (which becomes the first project tenant DB after Wave 4) or any other tenant DB.

**16 physical schemas covering all 17 AC-1 logical families. Apply in dependency order (see below).**

## AC-1 Logical-Family → Physical-Schema Mapping

P820 AC-1 specifies 17 schema families. The physical DDL consolidates three families to reduce schema-count overhead:

| AC-1 Logical Family | Physical Schema | DDL File | Notes |
| :--- | :--- | :--- | :--- |
| core | `core` | 001-core.sql | installation, host, os_user, config_mutation_log |
| runtime | `core` | 001-core.sql | runtime_flag, service_heartbeat — co-located with core (same lifecycle, same ownership) |
| identity | `control_identity` | 002-identity.sql | principal, did_document, principal_key, audit_action |
| agency | `agency` | 003-agency.sql | agency_provider, agency, agency_session, liaison_message, agency_route_policy |
| model | `hivecentral` | 004-model.sql | model, model_route, host_model_policy |
| credential | `control_credential` | 005-credential.sql | vault_provider, credential, credential_grant, rotation_log |
| queue | `dispatch` | 005-dispatch-stub.sql + 005-dispatch-full.sql | work_claim, work_offer, proposal_lease, dispatch_audit, capacity_snapshot |
| proposal | `dispatch` | 005-dispatch-full.sql | proposal_lease is the hiveCentral-side record for each active proposal context; full proposal rows live in tenant DBs (cross-DB app-level FK) |
| workflow | `template` | 007-template.sql | workflow_template (immutable), state_name, gate_definition, agent_role_profile, proposal_template |
| workforce | `workforce` | 006-workforce.sql | agent, skill, agent_skill, agent_project, skill_grant_log |
| project | `control_project` | 010-project.sql + 010b-project-ext.sql | project, project_db, project_host, project_repo, project_worktree, project_budget_policy, project_capacity_config, project_route_policy |
| sandbox | `sandbox` | 009-sandbox.sql | sandbox_definition, boundary_policy, egress_rule, mount_grant |
| tooling | `tooling` | 008-tooling.sql | tool, mcp_tool, cli_tool, tool_grant |
| messaging | `messaging` | 012-messaging.sql | a2a_topic, a2a_message, a2a_subscription, a2a_dlq, a2a_message_archive |
| observability | `observability` | 013-observability.sql | trace_span, agent_execution_span, proposal_lifecycle_event, model_routing_outcome, decision_explainability |
| governance | `governance` | 014-governance.sql | policy_version (immutable), decision_log (hash-chained), compliance_check, event_log |
| efficiency | `efficiency` | 015-efficiency.sql | efficiency_metric, cost_ledger_summary, dispatch_metric_summary, route_token_budget |

`dependency` (011-dependency.sql) is an additional schema added beyond the 17 AC-1 families to capture cross-project proposal dependency edges; it has no AC-1 coverage gap.

**Consolidation decisions (AC-3):**
- `runtime` → `core`: runtime_flag and service_heartbeat share the same owner_did, lifecycle, and bootstrap timing as core catalog tables. Keeping them separate would require a circular FK (core needs runtime_flag before runtime can reference core.installation). Co-location is cleaner.
- `queue` + `proposal` → `dispatch`: In hiveCentral, a "proposal" is represented only by its dispatch-side records (offer, lease). Proposal content lives in the tenant DB. A separate proposal schema with only FK stubs would be misleading; merging into dispatch makes the cross-DB boundary explicit.
- `workflow` → `template`: Workflow templates are immutable reference data, not runtime state. Merging into a `template` schema alongside other immutable reference tables (gate_definition, agent_role_profile) keeps the runtime/reference distinction sharp.

## Layout

```
000-roles.sql           Per-service Postgres roles (run first, on the postgres DB)
001-core.sql            P592 — core: installation, host, os_user, runtime_flag, service_heartbeat, config_mutation_log
002-identity.sql        P593 — control_identity: principal, did_document, principal_key, audit_action
004-model.sql           P595 — control_model: model, model_route, host_model_policy
005-credential.sql      P596 — control_credential: vault_provider, credential, credential_grant, rotation_log
005-dispatch-stub.sql   P595 stub — dispatch: work_claim (cost_snapshot contract; extended by dispatch-full)
005-dispatch-full.sql   P820 — dispatch: work_offer, proposal_lease, dispatch_audit (append-only), capacity_snapshot
006-workforce.sql       P597 — workforce: agent, agent_skill, agent_capability
010-project.sql         P601 — control_project: project, project_db, project_host, project_repo, project_*_grant
010b-project-ext.sql           control_project ext: project_worktree, project_member, project_budget_policy,
                                project_capacity_config (P744), project_route_policy (P747 D1), project_sandbox_grant
009-sandbox.sql         P600 — sandbox: sandbox_definition, boundary_policy, egress_rule, mount_grant
003-agency.sql          P594 — agency: agency_provider, agency, agency_session, liaison_message, agency_route_policy (P747 D2)
007-template.sql        P598 — template: workflow_template (immutable), state_name, gate_definition, agent_role_profile, proposal_template
008-tooling.sql         P599 — tooling: tool, mcp_tool, cli_tool, tool_grant
011-dependency.sql      P602 — dependency: cross_project_dependency, dependency_kind_catalog
012-messaging.sql       P603 — messaging: a2a_topic, a2a_message, a2a_subscription, a2a_dlq, a2a_message_archive
013-observability.sql   P604 — observability: trace_span, agent_execution_span, proposal_lifecycle_event,
                                model_routing_outcome (P747 D6), decision_explainability
014-governance.sql      P605 — governance: policy_version (immutable), decision_log (hash-chained), compliance_check, event_log
015-efficiency.sql      P606 — efficiency: efficiency_metric, cost_ledger_summary, dispatch_metric_summary, route_token_budget (P747 D4)
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

### core schema

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

### control_identity schema

| Role                     | principal | did_document | principal_key | audit_action |
|--------------------------|:---------:|:------------:|:-------------:|:------------:|
| `agenthive_admin`        | ALL       | ALL          | ALL           | ALL          |
| `agenthive_orchestrator` | SELECT    | SELECT       | SELECT        | SELECT       |
| `agenthive_agency`       | SELECT    | SELECT       | SELECT        | INSERT       |
| `agenthive_a2a`          | —         | —            | —             | —            |
| `agenthive_observability`| SELECT    | SELECT       | SELECT        | SELECT       |

Notes: Agencies may INSERT to `audit_action` to log their own authentication events; they cannot modify principal or key catalog rows.

### hivecentral (control_model) schema

| Role                     | model | model_route | host_model_policy |
|--------------------------|:-----:|:-----------:|:-----------------:|
| `agenthive_admin`        | ALL   | ALL         | ALL               |
| `agenthive_orchestrator` | SELECT| SELECT      | SELECT            |
| `agenthive_agency`       | SELECT| SELECT      | —                 |
| `agenthive_a2a`          | SELECT| SELECT      | —                 |
| `agenthive_observability`| SELECT| SELECT      | SELECT            |

### control_credential schema

| Role                     | vault_provider | credential | credential_grant | rotation_log |
|--------------------------|:--------------:|:----------:|:----------------:|:------------:|
| `agenthive_admin`        | ALL            | ALL        | ALL              | ALL          |
| `agenthive_orchestrator` | SELECT         | SELECT     | SELECT           | SELECT       |
| `agenthive_agency`       | —              | —          | SELECT           | —            |
| `agenthive_a2a`          | —              | —          | —                | —            |
| `agenthive_observability`| SELECT         | —          | —                | SELECT       |

Notes: Agencies may SELECT `credential_grant` to verify they hold a valid grant, but may never SELECT `credential` (which contains vault URIs) directly — they must use the provisioned env/secret path.

### dispatch schema

| Role                     | work_claim | work_offer | proposal_lease | dispatch_audit | capacity_snapshot | Views |
|--------------------------|:----------:|:----------:|:--------------:|:--------------:|:-----------------:|:-----:|
| `agenthive_admin`        | ALL        | ALL        | ALL            | INSERT         | ALL               | ALL   |
| `agenthive_orchestrator` | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE | INSERT | SELECT, INSERT | SELECT |
| `agenthive_agency`       | SELECT, UPDATE | SELECT | SELECT, UPDATE | INSERT        | SELECT            | SELECT|
| `agenthive_a2a`          | —          | —          | —              | —              | —                 | —     |
| `agenthive_observability`| SELECT     | SELECT     | SELECT         | SELECT         | SELECT            | SELECT|

Notes:
- `dispatch_audit` is append-only; only INSERT is granted (no UPDATE/DELETE to any role). A trigger enforces this.
- `capacity_snapshot` INSERT is granted to `agenthive_orchestrator` for polling cycles; agencies SELECT their own capacity rows.

### workforce schema

| Role                     | agent | skill | agent_skill | agent_project | skill_grant_log |
|--------------------------|:-----:|:-----:|:-----------:|:-------------:|:---------------:|
| `agenthive_admin`        | ALL   | ALL   | ALL         | ALL           | INSERT          |
| `agenthive_orchestrator` | SELECT, INSERT, UPDATE | SELECT | SELECT, INSERT, UPDATE | SELECT, INSERT | INSERT |
| `agenthive_agency`       | SELECT| SELECT| SELECT      | SELECT        | SELECT          |
| `agenthive_a2a`          | —     | —     | —           | —             | —               |
| `agenthive_observability`| SELECT| SELECT| SELECT      | SELECT        | SELECT          |

### agency schema

| Role                     | agency_provider | agency | agency_session | liaison_message | agency_route_policy | agency_capacity |
|--------------------------|:---------------:|:------:|:--------------:|:---------------:|:-------------------:|:---------------:|
| `agenthive_admin`        | ALL             | ALL    | ALL            | ALL             | ALL                 | ALL             |
| `agenthive_orchestrator` | SELECT          | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE | SELECT | SELECT | SELECT, INSERT, UPDATE |
| `agenthive_agency`       | —               | SELECT | SELECT, UPDATE | INSERT, SELECT  | SELECT              | SELECT          |
| `agenthive_a2a`          | SELECT          | —      | —              | SELECT          | —                   | —               |
| `agenthive_observability`| SELECT          | SELECT | SELECT         | SELECT          | SELECT              | SELECT          |

### control_project schema

| Role                     | project | project_db | project_host | project_worktree | project_budget_policy | project_capacity_config | project_route_policy |
|--------------------------|:-------:|:----------:|:------------:|:----------------:|:---------------------:|:-----------------------:|:--------------------:|
| `agenthive_admin`        | ALL     | ALL        | ALL          | ALL              | ALL                   | ALL                     | ALL                  |
| `agenthive_orchestrator` | SELECT  | SELECT     | SELECT       | SELECT           | SELECT                | SELECT, INSERT, UPDATE  | SELECT               |
| `agenthive_agency`       | SELECT  | —          | SELECT       | SELECT           | —                     | —                       | SELECT               |
| `agenthive_a2a`          | SELECT  | —          | —            | —                | —                     | —                       | SELECT               |
| `agenthive_observability`| SELECT  | SELECT     | SELECT       | SELECT           | SELECT                | SELECT                  | SELECT               |

Notes: `project_db` (contains `tenant_db_url` DSN reference) is not readable by agencies or a2a — DSN access is mediated by the pool factory using the provisioned vault path.

### template schema

| Role                     | workflow_template | state_name | gate_definition | agent_role_profile | proposal_template |
|--------------------------|:-----------------:|:----------:|:---------------:|:-----------------:|:-----------------:|
| `agenthive_admin`        | ALL               | ALL        | ALL             | ALL               | ALL               |
| `agenthive_orchestrator` | SELECT            | SELECT     | SELECT          | SELECT            | SELECT            |
| `agenthive_agency`       | SELECT            | SELECT     | SELECT          | SELECT            | SELECT            |
| `agenthive_a2a`          | SELECT            | —          | —               | SELECT            | —                 |
| `agenthive_observability`| SELECT            | SELECT     | SELECT          | SELECT            | SELECT            |

Notes: Template tables are immutable reference data. No role (including admin) holds UPDATE on them — changes require a new version row.

### sandbox, tooling, dependency schemas

| Role                     | sandbox.* (all) | tooling.* (all) | dependency.* (all) |
|--------------------------|:---------------:|:---------------:|:------------------:|
| `agenthive_admin`        | ALL             | ALL             | ALL                |
| `agenthive_orchestrator` | SELECT          | SELECT          | SELECT, INSERT, UPDATE |
| `agenthive_agency`       | SELECT          | SELECT          | SELECT             |
| `agenthive_a2a`          | —               | SELECT          | —                  |
| `agenthive_observability`| SELECT          | SELECT          | SELECT             |

### messaging schema

| Role                     | a2a_topic | a2a_message | a2a_subscription | a2a_dlq | a2a_message_archive |
|--------------------------|:---------:|:-----------:|:----------------:|:-------:|:-------------------:|
| `agenthive_admin`        | ALL       | ALL         | ALL              | ALL     | ALL                 |
| `agenthive_orchestrator` | SELECT    | SELECT      | SELECT           | SELECT  | SELECT              |
| `agenthive_agency`       | SELECT    | INSERT, SELECT | SELECT, INSERT, UPDATE | SELECT | SELECT         |
| `agenthive_a2a`          | SELECT    | INSERT, SELECT | SELECT, INSERT, UPDATE | SELECT | SELECT         |
| `agenthive_observability`| SELECT    | SELECT      | SELECT           | SELECT  | SELECT              |

### observability schema

| Role                     | trace_span | agent_execution_span | proposal_lifecycle_event | model_routing_outcome | decision_explainability |
|--------------------------|:----------:|:--------------------:|:------------------------:|:---------------------:|:-----------------------:|
| `agenthive_admin`        | ALL        | ALL                  | ALL                      | ALL                   | ALL                     |
| `agenthive_orchestrator` | INSERT     | INSERT               | INSERT                   | INSERT                | SELECT                  |
| `agenthive_agency`       | INSERT     | INSERT               | —                        | INSERT                | —                       |
| `agenthive_a2a`          | INSERT     | —                    | —                        | —                     | —                       |
| `agenthive_observability`| SELECT     | SELECT               | SELECT                   | SELECT                | SELECT                  |

Notes: All observability tables are effectively append-only event logs; only INSERT is granted to producers.

### governance schema

| Role                     | policy_version | decision_log | compliance_check | event_log |
|--------------------------|:--------------:|:------------:|:----------------:|:---------:|
| `agenthive_admin`        | ALL            | INSERT       | ALL              | INSERT    |
| `agenthive_orchestrator` | SELECT         | INSERT       | SELECT, INSERT   | INSERT    |
| `agenthive_agency`       | SELECT         | —            | SELECT           | —         |
| `agenthive_a2a`          | SELECT         | —            | —                | INSERT    |
| `agenthive_observability`| SELECT         | SELECT       | SELECT           | SELECT    |

Notes: `decision_log` and `event_log` are append-only (hash-chained). No UPDATE/DELETE granted to any role.

### efficiency schema

| Role                     | efficiency_metric | cost_ledger_summary | dispatch_metric_summary | route_token_budget |
|--------------------------|:-----------------:|:-------------------:|:-----------------------:|:------------------:|
| `agenthive_admin`        | ALL               | ALL                 | ALL                     | ALL                |
| `agenthive_orchestrator` | SELECT, INSERT    | SELECT, INSERT      | SELECT, INSERT          | SELECT, UPDATE     |
| `agenthive_agency`       | SELECT            | —                   | —                       | SELECT             |
| `agenthive_a2a`          | —                 | —                   | —                       | —                  |
| `agenthive_observability`| SELECT            | SELECT              | SELECT                  | SELECT             |

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
Step  File                      Schema created / extended
----  ------------------------  ----------------------------------------
 1    000-roles.sql             (roles — run against postgres DB, not hiveCentral)
 2    001-core.sql              core
 3    002-identity.sql          control_identity
 4    004-model.sql             control_model (hivecentral)
 5    005-credential.sql        control_credential
 6    005-dispatch-stub.sql     dispatch (work_claim stub)
 7    006-workforce.sql         workforce
 8    010-project.sql           control_project
 9    009-sandbox.sql           sandbox
10    010b-project-ext.sql      (extends control_project; adds FK to sandbox)
11    003-agency.sql            agency
12    005-dispatch-full.sql     dispatch (work_offer, proposal_lease, dispatch_audit, capacity_snapshot)
13    007-template.sql          template
14    008-tooling.sql           tooling
15    011-dependency.sql        dependency
16    012-messaging.sql         messaging
17    013-observability.sql     observability
18    014-governance.sql        governance
19    015-efficiency.sql        efficiency
```

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

# Then on hiveCentral DB itself (steps 2–17 in order):
psql -d hiveCentral -f 001-core.sql
psql -d hiveCentral -f 002-identity.sql
psql -d hiveCentral -f 004-model.sql
psql -d hiveCentral -f 005-credential.sql
psql -d hiveCentral -f 005-dispatch-stub.sql
psql -d hiveCentral -f 006-workforce.sql
psql -d hiveCentral -f 010-project.sql
psql -d hiveCentral -f 009-sandbox.sql
psql -d hiveCentral -f 010b-project-ext.sql
psql -d hiveCentral -f 003-agency.sql
psql -d hiveCentral -f 005-dispatch-full.sql
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
