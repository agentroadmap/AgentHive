# hiveCentral Integration Guide

> **Status:** Planned — hiveCentral is NOT yet live. The single `agenthive` database currently serves both control-plane and tenant data. This guide documents the target integration path once a dedicated hiveCentral Postgres 16 instance is provisioned.
>
> **Tracking:** P429 (two-tier topology keystone), P820 (clean-sheet data model), P591 (disaster recovery design)

---

## Overview

hiveCentral is the dedicated control-plane database for AgentHive V2. It holds identity, model routes, credential vault, workflow templates, governance, and cross-project metadata. Each project tenant will have its own separate database; hiveCentral is the shared coordination layer.

**Current state:** 22 DDL files in `database/ddl/hivecentral/` define the full schema. None are applied to a live instance yet.

---

## Prerequisites

1. Provision a dedicated **Postgres 16** instance (separate from the existing `agenthive` tenant database).
2. Install the `pgcrypto` extension (required by `014-governance.sql`).
3. Set the `AGENTHIVE_V2_DB_URL` environment variable to the connection string:

```bash
AGENTHIVE_V2_DB_URL=postgresql://<user>:<password>@<host>:<port>/hivecentral
```

4. Ensure the applying role has `CREATEDB` and `CREATEROLE` privileges (needed by `000-roles.sql`).

---

## DDL Inventory & Apply Order

Apply files in the following order. **Do not skip files** — each builds on the previous.

| Apply Order | File | Schema | Purpose |
|-------------|------|--------|---------|
| 1 | `000-roles.sql` | *(roles)* | P592 per-service Postgres role bootstrap. **Must run first**, before any schema DDL. |
| 2 | `001-core.sql` | `core` | P592 bootstrap layer: installation singleton, host registry, OS user registry, runtime flags, service heartbeat. |
| 3 | `002-identity.sql` | `identity` | P593 principals, DID documents, public keys, audit actions. |
| 4 | `003-agency.sql` | `agency` | P594 work-execution contexts: provider, agency, session, capacity, liaison message kinds. |
| 5 | `004-model.sql` | `model` | P595 model_capability, model, model_route, host_model_policy; seeds 8 capability vocab + Claude routes. |
| 6 | `004-template.sql` | `template` | P598 immutable versioned workflow templates (first template schema slot). Apply **before** `007-template.sql`. |
| 7 | `005-credential.sql` | `credential` | P596 secret vault provider registry, named credential catalog, access grants, rotation audit log. |
| 8 | `005-dispatch-stub.sql` | `dispatch` | P595 coordination stub — reserves `dispatch.work_claim` with `cost_snapshot JSONB`. P603 adds full columns. |
| 9 | `006-workforce.sql` | `workforce` | P597 agent, skill, agent_skill, agent_project, skill_grant_log. |
| 10 | `007-template.sql` | `template` | Full workflow template schema: state machine, gate criteria, agent_role_profile (replaces `STAGE_DISPATCH_ROLES` literals). Extends `004-template.sql`. |
| 11 | `008-tooling.sql` | `tooling` | MCP tools, CLI tools, per-principal access grants. |
| 12 | `009-sandbox.sql` | `sandbox` | Sandbox definition: resource boundary policies, egress rules, filesystem mount grants. |
| 13 | `010-project.sql` | `control_project` | P601 project catalog, tenant DB bindings, host assignments, repo refs. |
| 14 | `010b-project-ext.sql` | `control_project` | Extensions: worktrees, members, budget policy, capacity config, route policy, sandbox grants. |
| 15 | `011-dependency.sql` | `dependency` | Cross-project dependency links with resolution tracking and `pg_notify`. |
| 16 | `012-messaging.sql` | `messaging` | A2A async messaging: topic bus, message log, subscriptions, dead-letter queue, cold-tier archive. |
| 17 | `013-observability-stub.sql` | `observability` | P595 stub — reserves `observability.model_routing_outcome` with 3 structured fields. P604 adds full logic. |
| 18 | `013-observability.sql` | `observability` | Full distributed tracing + execution telemetry; append-only, partitioned monthly. |
| 19 | `014-governance.sql` | `governance` | Policy versioning, audit decision log, compliance checks, event-sourcing spine. **Requires `pgcrypto`**. |
| 20 | `015-efficiency.sql` | `efficiency` | Cost attribution, dispatch metrics, token budget tracking. |
| 21 | `070-p1350-agent-personality-memory.sql` | `workforce` | P1350-B personality + long-term memory columns on `workforce.agent`. |

> **Note on ordering:** `004-template.sql` and `007-template.sql` both touch the `template` schema. Apply `004` first (at step 6), then `007` (at step 10). The stub files (`005-dispatch-stub.sql`, `013-observability-stub.sql`) are superseded by their full-schema counterparts in later proposals but must be applied first for FK consistency.

---

## Apply Script

```bash
#!/bin/bash
# Apply hiveCentral DDL in order
# Requires: AGENTHIVE_V2_DB_URL set

DDL_DIR="database/ddl/hivecentral"
FILES=(
  "000-roles.sql"
  "001-core.sql"
  "002-identity.sql"
  "003-agency.sql"
  "004-model.sql"
  "004-template.sql"
  "005-credential.sql"
  "005-dispatch-stub.sql"
  "006-workforce.sql"
  "007-template.sql"
  "008-tooling.sql"
  "009-sandbox.sql"
  "010-project.sql"
  "010b-project-ext.sql"
  "011-dependency.sql"
  "012-messaging.sql"
  "013-observability-stub.sql"
  "013-observability.sql"
  "014-governance.sql"
  "015-efficiency.sql"
  "070-p1350-agent-personality-memory.sql"
)

for f in "${FILES[@]}"; do
  echo "Applying $f..."
  psql "$AGENTHIVE_V2_DB_URL" -f "$DDL_DIR/$f" || { echo "FAILED on $f"; exit 1; }
done

echo "hiveCentral schema applied successfully."
```

---

## Environment Variable Reference

| Variable | Required | Purpose |
|----------|----------|---------|
| `AGENTHIVE_V2_DB_URL` | Yes | PostgreSQL connection string for the hiveCentral instance |
| `DATABASE_URL` | Yes (existing) | Connection to the current `agenthive` tenant DB (unchanged) |

In application code, use `config.getControlPool()` (post-P497) to get a pooled connection to hiveCentral. Do not hardcode the DSN.

---

## Deployment Checklist

- [ ] Provision Postgres 16 instance dedicated to hiveCentral
- [ ] Install `pgcrypto` extension: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
- [ ] Set `AGENTHIVE_V2_DB_URL` in `/etc/agenthive/env`
- [ ] Apply DDL files in order using the script above
- [ ] Run P429 migration (two-tier topology cutover) to wire application code to hiveCentral
- [ ] Validate with P591 disaster recovery runbook

---

## Related Documents

- `control-plane-ddl-sketch.md` — schema design rationale
- `control-plane-multi-project-architecture.md` — multi-project topology
- `CONVENTIONS.md §6.0` — DB topology and `config.getProjectDb(slug)` usage
- P429, P820, P591, P592–P607 proposals for per-schema detail
