# `hiveCentral` schema DDL

Target schema files for the v3 redesign control-plane database. These run **only** against `hiveCentral`, never against `agenthive` (which becomes the first project tenant DB after Wave 4) or any other tenant DB.

## Layout

```
000-roles.sql         Per-service Postgres roles (run first, on the postgres DB)
001-core.sql          P592 — installation, host, os_user, runtime_flag, service_heartbeat
002-identity.sql      P593 — principal, did_document, principal_key, audit_action  [pending]
003-agency.sql        P594 — agency_provider, agency, agency_session, liaison_message catalog  [pending]
004-model.sql         P595 — model, model_route, host_model_policy  [pending]
005-credential.sql    P596 — vault_provider, credential, credential_grant, rotation_log  [pending]
006-workforce.sql     P597 — agent, agent_skill, agent_capability  [pending]
007-template.sql      P598 — workflow_template (immutable versioned)  [pending]
008-tooling.sql       P599 — tool, tool_grant  [pending]
009-sandbox.sql       P600 — sandbox_definition, boundary_policy, mount_grant  [pending]
010-project.sql       P601 — project, project_db, project_host, project_repo, project_*_grant  [pending]
011-dependency.sql    P602 — cross_project_dependency, dependency_kind_catalog  [pending]
012-messaging.sql     P603 — a2a_topic, a2a_message, a2a_subscription, a2a_dlq, a2a_message_archive  [pending]
013-observability.sql P604 — trace_span, agent_execution_span, lifecycle_event, routing_outcome, explainability  [pending]
014-governance.sql    P605 — decision_log (hash-chained), policy_version, compliance_check, event_log  [pending]
015-efficiency.sql    P606 — efficiency_metric, cost_ledger_summary, dispatch_metric_summary  [pending]
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

## Apply order

Minimum PostgreSQL version: **14** (required for `CREATE OR REPLACE TRIGGER` syntax used in
`001-core.sql`). For PostgreSQL ≤ 13 targets, use `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`
instead.

These files run during P501 against a freshly created `hiveCentral` database:

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

# Then on hiveCentral DB itself:
psql -d hiveCentral -f 001-core.sql
psql -d hiveCentral -f 002-identity.sql
# ... etc
```

The P501 runbook (`docs/migration/p501-runbook.md`) drives this sequence.

## Reference

- `docs/multi-project-redesign.md` — the v3 architectural spec
- `docs/dr/hivecentral-dr-design.md` — control-plane disaster recovery (P591)
- `roadmap_proposal.proposal` rows P590..P608 — proposal tracking for each schema
