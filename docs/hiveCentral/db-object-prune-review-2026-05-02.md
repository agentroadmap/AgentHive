# DB Object Prune Review - 2026-05-02

## Scope

Reviewed the live `hiveCentral` and `agenthive` object inventory against:

- live row counts from both databases
- code references under `/data/code/worktree/codex`
- roadmap/design references in `docs/multi-project-redesign.md`, `docs/proposals/*`, and `docs/hiveCentral/data-model.md`

The goal is to identify objects that are likely not used now and not part of the forward hiveCentral roadmap. Zero rows alone is not sufficient evidence: most `hiveCentral` objects are intentionally scaffolded for the multi-tenant control plane.

## Do Not Treat As Dead

These categories look noisy but are expected:

- `partman.*` tables/functions and `partman.template_*` tables: extension/config/template objects for partition management.
- `public.pgcrypto`, `public.pg_trgm`, and `public.vector` functions/operators: extension objects, not application schema.
- Partition parents/defaults and near-term child partitions for `agency`, `messaging`, `governance`, `observability`, and `efficiency`: these are part of the data model even if currently empty.
- Empty `hiveCentral` schemas such as `control_identity`, `control_model`, `control_project`, `control_credential`, `sandbox`, `tooling`, `messaging`, `observability`, `efficiency`, and `governance`: they map directly to the current control-plane roadmap and should be considered planned scaffold, not unused debt.

## Likely Safe Prune Candidates

These have zero rows, no meaningful code references, and no clear future ownership in the current hiveCentral model. They should still be removed through a proposal/migration, not manually dropped.

| Database | Object | Type | Rationale |
| --- | --- | --- | --- |
| `agenthive` | `roadmap.schema_info` | table | Zero rows; no code references found; does not appear in the new hiveCentral model. Looks like an obsolete schema-inspection scratch table. |
| `agenthive` | `roadmap.v_agency_dashboard` | view | No code references found; superseded by explicit agency/session views in `hiveCentral` and current MCP handlers. |
| `agenthive` | `roadmap.v_assistance_open` | view | No code references found; `assistance_request` itself is empty and not part of the hiveCentral roadmap. |
| `agenthive` | `roadmap.v_liaison_protocol_health` | view | No code references found; liaison health is being remodeled around `agency_session`, `liaison_message`, and central observability. |

## Defer Or Consolidate, Do Not Drop Yet

These are suspicious, duplicated, or empty, but they have roadmap references, historical proposal ownership, or live data.

| Database | Object(s) | Recommendation |
| --- | --- | --- |
| `agenthive` | `roadmap.mcp_tool_registry`, `roadmap.mcp_tool_assignment` | Empty, but historically owned by P048/P079 and conceptually superseded by `hiveCentral.tooling.tool`, `tooling.mcp_tool`, and `tooling.tool_grant`. Mark as migration-to-tooling cleanup, not immediate drop. |
| `agenthive` | `roadmap.embedding_index_registry`, `roadmap.prompt_template`, `roadmap.webhook_subscription`, `roadmap.ui_preferences` | Empty and lightly referenced, but explicitly documented in older pillar work. Decide whether these still belong to tenant DB or should be rejected from the new model. |
| `agenthive` | `roadmap_proposal.frontier_audit_log` | Zero rows, but owned by P226. Since P226 was recently judged request-changes, obsolete or redesign it with that proposal rather than silently dropping. |
| `agenthive` | `roadmap_proposal.gate_stage_role` | Zero rows; DDL explicitly says dispatch wiring was deferred. It should be reconciled with the simplified queue/orchestrator umbrella before removal. |
| `agenthive` | `roadmap_workforce.authority_chain` | Zero rows but present in older trust/authority docs. The new model should decide whether authority moves to `control_identity`/governance or remains workforce-related. |
| `agenthive` | `roadmap.transition_queue` and `roadmap_proposal.transition_queue` | Duplicate-looking. `roadmap.transition_queue` has live data; `roadmap_proposal.transition_queue` is empty. Consolidate under the simplified queue proposal, do not drop independently. |
| `agenthive` | `roadmap.agent_role_profile_legacy` | Has live rows. Treat as a migration/compatibility table until role-profile cutover is confirmed. |
| `agenthive` | `roadmap.trace_span`, `roadmap.agent_execution_span`, `roadmap.model_routing_outcome`, `roadmap.decision_explainability`, `roadmap.proposal_lifecycle_event` | Tenant-side observability duplicates of planned `hiveCentral.observability.*`. Drop from tenant only after central writers/readers are live. |
| `hiveCentral` | Future partition children beyond near-term windows, especially monthly partitions through 2026-09 and yearly archives through 2030 | Not logical dead objects, but probably over-created. Prefer lower `pg_partman.premake` and let maintenance create partitions just-in-time. |
| `hiveCentral` | `workforce.agent_trust` | Suspicious placement. Trust appears in older workforce docs, but the new identity/control-plane model may want this under `control_identity` or governance. Confirm ownership before retaining long-term. |

## Recommended Cleanup Proposal

Create one small proposal, not many:

**Title:** Prune obsolete tenant-era DB objects and reduce hiveCentral partition overbuild

Acceptance criteria:

- Confirm no runtime references to `roadmap.schema_info`, `roadmap.v_agency_dashboard`, `roadmap.v_assistance_open`, and `roadmap.v_liaison_protocol_health`.
- Drop only those confirmed-dead objects in the first migration.
- Add a documented migration plan for `roadmap.mcp_tool_*` into `hiveCentral.tooling.*`.
- Add a documented migration plan for tenant observability tables into `hiveCentral.observability.*`.
- Reduce `pg_partman` premake/seeded future partitions where retention does not justify pre-creating many child tables.
- Require a compatibility query before dropping any table with nonzero rows.

## Bottom Line

The object count is high mostly because Claude created the full control-plane skeleton plus partition children, not because every object is dead. The safe immediate prune list is small. The higher-impact work is to stop creating duplicate tenant-era tables in `agenthive` while the same domain is being normalized into `hiveCentral`.
