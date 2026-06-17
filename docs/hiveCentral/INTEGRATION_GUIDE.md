# hiveCentral Integration Guide

> Status: **Pre-deployment** — DDL files are committed; the `hiveCentral` database has not yet been provisioned on the shared host. See [deployment status](#deployment-status) below.

## Overview

`hiveCentral` is the AgentHive V2 control-plane database. It replaces the control-plane schemas (`roadmap`, `core`, `agent_registry`, etc.) currently colocated in the `agenthive` tenant DB. Each product tenant (monkeyKing-audio, georgia-singer, …) gets its own isolated Postgres database; `hiveCentral` provides the shared registry, identity, dispatch, and governance layers.

## Prerequisites

- PostgreSQL 16+
- Extensions: `pgcrypto`, `pgvector`
- Environment variable `AGENTHIVE_V2_DB_URL` set to the hiveCentral DSN

```bash
# Example DSN
export AGENTHIVE_V2_DB_URL="postgresql://admin:<password>@127.0.0.1:5432/hiveCentral"
```

## DDL File Inventory and Apply Order

All files live in `database/ddl/hivecentral/`. Apply them in the numbered order shown — files without a numeric prefix (`000`) come first; files with the same prefix may be applied in alphabetical order.

| Order | File | Schema | Purpose |
|-------|------|--------|---------|
| 1 | `000-roles.sql` | (roles) | Creates Postgres roles and grants: `hiveCentral_ro`, `hiveCentral_app`, `hiveCentral_admin` |
| 2 | `001-core.sql` | `core` | Platform-level config, runtime flags, feature flags, migration-history ledger |
| 3 | `002-identity.sql` | `identity` | Cryptographic agent identities, DID registry, public-key store |
| 4 | `003-agency.sql` | `agency` | Agency registration, liaison state machine, presence heartbeat |
| 5 | `004-model.sql` | `model` | Model catalog, capability declarations, per-model cost matrix |
| 6 | `004-template.sql` | `template` | Base workflow templates shared across projects (applied after `004-model.sql`) |
| 7 | `005-credential.sql` | `credential` | Vault-backed credential store for API keys, DSNs, OAuth tokens |
| 8 | `005-dispatch-stub.sql` | `dispatch` | Stub schema for the dispatch queue (foreign-key target for `006-workforce.sql`) |
| 9 | `006-workforce.sql` | `workforce` | Queue-role profiles, agent capability registry, skill certifications |
| 10 | `007-template.sql` | `template` | Extended template definitions (proposal type configs, workflow stages) |
| 11 | `008-tooling.sql` | `tooling` | MCP tool surface registry, action declarations, clearance levels |
| 12 | `009-sandbox.sql` | `sandbox` | Cubic/worktree lifecycle, allocation ledger, recycling policy |
| 13 | `010-project.sql` | `project` | Project registry (tenant pointer), project capacity config, route policies |
| 14 | `010b-project-ext.sql` | `project` | Project extensions: OAuth app config, per-project feature-flag overrides |
| 15 | `011-dependency.sql` | `dependency` | Cross-project proposal dependency graph (ports P602) |
| 16 | `012-messaging.sql` | `messaging` | Unified A2A message ledger, DLQ, nonce uniqueness, ACK/reply semantics |
| 17 | `013-observability-stub.sql` | `observability` | Stub schema (tables referenced by triggers in later files) |
| 18 | `013-observability.sql` | `observability` | Full observability schema: spans, lifecycle events, routing decisions (ports P604) |
| 19 | `014-governance.sql` | `governance` | Hash-chained gate decision log, audit spine, amendment records (ports P605) |
| 20 | `015-efficiency.sql` | `efficiency` | Per-agent cost quotas, fair-share debt, starvation prevention (ports P3000) |
| 21 | `070-p1350-agent-personality-memory.sql` | `workforce` | Personality JSONB + long-term memory schema for permanent agents (P1352/P1356) |

## Deployment Status

| Component | Status | Notes |
|-----------|--------|-------|
| DDL files committed | ✅ Done | `database/ddl/hivecentral/` — 22 files |
| `hiveCentral` DB provisioned | ❌ Not started | Requires `AGENTHIVE_V2_DB_URL` + Postgres 16 instance |
| DDL applied | ❌ Not started | Use apply script (see below) |
| Application code wired | ❌ Not started | P757–P759 (B3–B5 of P745) |
| Control-plane tables migrated | ❌ Not started | P757 (B3): migrate agenthive→hiveCentral |
| Tenant DB split complete | ❌ Not started | P506/P507 (Stage C3/D2 of P429) |

## Applying the DDL

```bash
# Set connection details
export PGPASSWORD=<password>
PSQL="psql -U admin -h 127.0.0.1 -p 5432 -d hiveCentral"

# Create the database first (as superuser)
psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE \"hiveCentral\";"

# Apply DDL in order
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
  $PSQL -f "$DDL_DIR/$f"
done
```

## Schema Summary

| Schema | Tables (approx.) | Role |
|--------|-----------------|------|
| `core` | runtime_flag, feature_flag, migration_history | Platform config + versioning |
| `identity` | agent_registry, did_document, public_key | Cryptographic agent identity |
| `agency` | agency, liaison_session, presence | Agency lifecycle + liveness |
| `model` | model_metadata, model_routes, capability | LLM catalog + routing |
| `template` | workflow_template, proposal_type_config, workflow_stage | Workflow definitions |
| `credential` | control_credential, vault_entry | Secret management |
| `dispatch` | work_offer, proposal_lease, dispatch_log | Queue + claim lifecycle |
| `workforce` | agent_role_profile, agent_skill, queue_role_profile | Capability registry |
| `tooling` | mcp_tool, tool_action, tool_clearance | MCP surface contract |
| `sandbox` | cubic, worktree_allocation, recycling_log | Workspace lifecycle |
| `project` | project, project_capacity_config, project_route_policy | Tenant registry |
| `dependency` | proposal_dependency, dependency_graph | Cross-project DAG |
| `messaging` | message_ledger, dlq_entry, ack_record | A2A messaging |
| `observability` | span, lifecycle_event, route_decision_log | Telemetry |
| `governance` | gate_decision_log, audit_spine, amendment | Decision audit chain |
| `efficiency` | agent_cost_quota, fair_share_debt, quota_dispatch_override | Budget governance |

## Related Proposals

- **P745** — hiveCentral vNext data model (umbrella)
- **P821** — AgentHive V2 single-database architecture design
- **P823** — agentHive2 database baseline (deploy/ DDL + seed)
- **P757** — B3: migrate control-plane tables out of agenthive into hiveCentral
- **P756** — B2: hiveCentral DB bootstrap (provisioning script + role grants + credentials)
- **P430–P436** — Control DB boundary classification + bootstrap series
