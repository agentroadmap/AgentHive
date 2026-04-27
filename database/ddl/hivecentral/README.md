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

Every central catalog table includes the same **seven** hygiene fields:

```sql
owner_did         TEXT NOT NULL,
lifecycle_status  TEXT NOT NULL DEFAULT 'active'
                  CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
deprecated_at     TIMESTAMPTZ,
retire_after      TIMESTAMPTZ,
notes             TEXT,
created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
```

**All four states are required** — downstream schemas (P593–P605) must copy this exact CHECK constraint. Omitting `'blocked'` propagates a 3-state contract that is incorrect.

Domain-specific timestamp aliases (`bootstrapped_at`, `registered_at`, `modified_at`) are permitted as **additional** columns alongside `created_at`/`updated_at` — they do NOT replace them.

A shared `core.set_updated_at()` trigger function (defined once in `001-core.sql`) advances `updated_at` on every BEFORE UPDATE for the four catalog tables.

Catalog rows are **never deleted** — they are retired or blocked. A `lifecycle_status='retired'` row is invisible to dispatch but still resolvable for historical audit. A `lifecycle_status='blocked'` row is temporarily suspended.

### service_heartbeat hygiene exemption

`core.service_heartbeat` is an **operational/telemetry table**, not a catalog. The seven-field hygiene is explicitly **exempt** because:

- **No ownership concept**: heartbeats are anonymous service signals
- **No lifecycle**: rows are replaced via `ON CONFLICT DO UPDATE`, never deprecated or retired
- **Write volume**: unnecessary columns waste I/O at high beat frequency (~30 s interval per service)

`set_updated_at()` is NOT attached to `service_heartbeat`. This exemption applies only to `service_heartbeat`; all other `core.*` tables that accumulate catalog rows must carry all seven hygiene fields.

## PostgreSQL version requirement

`001-core.sql` uses `CREATE OR REPLACE TRIGGER` (PostgreSQL 14+). Minimum supported version: **PostgreSQL 14**.

For PostgreSQL ≤13 targets, replace each `CREATE OR REPLACE TRIGGER` with:
```sql
DROP TRIGGER IF EXISTS <name> ON <table>;
CREATE TRIGGER <name> ...;
```

## Apply order

These files run during P501 against a freshly created `hiveCentral` database. Passwords are passed as server-side GUC parameters via `PGOPTIONS` — **not** as psql `-v` substitution variables. The code uses `current_setting('agenthive.*_password')`, which reads GUC values set in `PGOPTIONS`; psql `-v` sets client-side text substitution (`:var`) and does NOT populate the GUC.

```bash
# As superuser, on the postgres DB — use PGOPTIONS for GUC-based passwords:
PGOPTIONS='-c agenthive.admin_password=<vault> \
           -c agenthive.orchestrator_password=<vault> \
           -c agenthive.agency_password=<vault> \
           -c agenthive.a2a_password=<vault> \
           -c agenthive.observability_password=<vault> \
           -c agenthive.repl_password=<vault>' \
  psql -d postgres -f 000-roles.sql

# Then on hiveCentral DB itself:
psql -d hiveCentral -f 001-core.sql
psql -d hiveCentral -f 002-identity.sql
# ... etc
```

Both files are fully idempotent — re-running is always safe.

The P501 runbook (`docs/migration/p501-runbook.md`) drives this sequence.

## Grant matrix (core schema)

| Role | Schema USAGE | Tables — Read | Tables — Write |
|---|---|---|---|
| `agenthive_admin` | ✓ | ALL | ALL |
| `agenthive_orchestrator` | ✓ | `host`, `os_user`, `installation`, views | `runtime_flag`, `service_heartbeat` |
| `agenthive_agency` | ✓ | `runtime_flag`, `host`, `os_user` | `service_heartbeat` |
| `agenthive_a2a` | ✓ | `runtime_flag` | `service_heartbeat` |
| `agenthive_observability` | ✓ | ALL | — |
| `agenthive_repl` | — (replication slot only) | — | — |

**Least-privilege note**: `agenthive_orchestrator` holds SELECT-only on `core.host` and `core.os_user`. Catalog writes (registering hosts, OS users) belong to provisioning workflows (P601), not the orchestrator. Granting INSERT/UPDATE on these two tables to the orchestrator would be a security violation.

## Reference

- `docs/multi-project-redesign.md` — the v3 architectural spec
- `docs/dr/hivecentral-dr-design.md` — control-plane disaster recovery (P591)
- `roadmap_proposal.proposal` rows P590..P608 — proposal tracking for each schema
