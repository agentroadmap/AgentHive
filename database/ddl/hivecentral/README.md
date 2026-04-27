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

Every central catalog table includes the same five anti-swamp fields:

```sql
owner_did         TEXT NOT NULL,
lifecycle_status  TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active','deprecated','retired')),
deprecated_at     TIMESTAMPTZ,
retire_after      TIMESTAMPTZ,
notes             TEXT
```

Catalog rows are **never deleted** — they are retired. A `lifecycle_status='retired'` row is invisible to dispatch but still resolvable for historical audit.

## Apply order

These files run during P501 against a freshly created `hiveCentral` database:

```bash
# As superuser, on the postgres DB:
psql -d postgres -f 000-roles.sql \
  -v admin_password=<vault> \
  -v orchestrator_password=<vault> \
  -v agency_password=<vault> \
  -v a2a_password=<vault> \
  -v observability_password=<vault> \
  -v repl_password=<vault>

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
