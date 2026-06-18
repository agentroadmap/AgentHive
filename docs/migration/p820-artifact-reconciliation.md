# P820 Migration-Artifact Reconciliation

**Status**: Reference only (pre-implementation)  
**Updated**: 2026-06-18  
**Scope**: Classifies all P501-P520 proposals and P745 B1-B6 deliverables against the P820 clean-sheet DDL model.

No implementation runs against this classification until P820 AC-8 (operator review-and-approval) is recorded.

---

## Purpose

P820 AC-7 requires that each existing migration/cutover artifact be classified as:
- **Reusable** — input is directly applicable to the clean-sheet model without modification
- **Superseded** — the clean-sheet approach removes the need for this artifact entirely
- **Repurposed** — the concept survives but the implementation must target the new DDL (not the old schema)
- **Deferred** — depends on P820 AC-8 gate passing before any operator can execute

---

## P501-P520 Proposal Range

The P501-P520 range was authored when P745/P429 intended to clone agenthive → hiveCentral via `pg_dump`/`pg_restore` and then remove control-plane tables from the source. P820 replaces that approach with a fresh DDL deploy.

| Proposal | Title (abbreviated) | Classification | Rationale |
| :--- | :--- | :--- | :--- |
| **P501** | hiveCentral DB bootstrap (pg_dump/restore) | **Superseded** | P820 DDL is applied fresh (001-core.sql…015-efficiency.sql); no pg_dump/restore needed. The P501 runbook (`docs/migration/p501-runbook.md`) is archived as historical reference only. Role creation from P501 Phase 1 is subsumed by `000-roles.sql`. |
| **P502** | Logical replication agenthive→hiveCentral | **Superseded** | A clean-sheet deploy has no existing data to replicate. If historical control-plane data must be lifted, that is a post-AC-8 one-time ETL, not ongoing logical replication. |
| **P503** | Replication consistency verification | **Superseded** | No replication means no consistency check to run. Replaced by post-AC-8 data-migration smoke tests once a cutover plan is approved. |
| **P504** | Cutover rehearsal (dual-write + read-switch) | **Superseded** | The clean-sheet path does not require dual-write. The rehearsal concept is replaced by the dry-run documented in `docs/migration/p501-runbook.md` (schema-apply only; no data). |
| **P505** | Control-plane switchover (cut traffic) | **Deferred + Repurposed** | The concept of switching CONTROL_DB_URL to hiveCentral survives, but the switch cannot happen before P820 AC-8 approves the model and B3 data migration is completed. The switchover procedure must be rewritten against the clean schema. |
| **P506** | Drop roadmap.* schemas from agenthive | **Deferred** | Requires B3 (data migration) to complete first, which itself requires P820 AC-8. Do not run until operator green-lights post-review implementation sequence. |
| **P507** | Self-grandfather agenthive as project_id=1 tenant | **Repurposed** | The concept (registering agenthive as first tenant in control_project.project) is correct and is reflected in `010-project.sql` seed rows and `fn_provision_project`. The P507 implementation artifact targeted the old `hiveControl.roadmap.project` schema — must be rewritten against `control_project.project` + `control_project.project_db` in the P820 DDL. |
| **P508** | Sequence enumeration + bump script | **Superseded** | Fresh DDL starts all sequences at 1. No bump script needed unless historical rows are migrated, which is post-AC-8 scope. |
| **P509** | PgBouncer configuration update | **Deferred + Repurposed** | The concept (routing services to new hiveCentral pool) survives; the INI template must reference the P820 schema role names from `000-roles.sql`, not the old schema names. Cannot run before AC-8 + B5 code rewire. |
| **P510** | Schema parity verification | **Superseded** | Designed to verify that pg_restore produced agenthive-equivalent tables. Not applicable to a clean design; P820 DDL is the new ground truth. |
| **P511–P519** | Post-cutover cleanup items | **Deferred** | All depend on B3 data migration completing after P820 AC-8. Executor must reconcile each against the P820 schema before running. |
| **P520** | Post-cutover schema rationalization | **Superseded** | P820 IS the schema rationalization; no post-cutover cleanup of the old `roadmap.*` shape is needed because the clean-sheet DDL never imported it. |

---

## P745 B1-B6 Deliverables

| Deliverable | Proposal | Title | Classification | Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **B1** | P755 | control-plane boundary classification (`database/control-plane-tables.md`) | **Reusable** | The table register (`database/control-plane-tables.md`) accurately classifies control-plane vs tenant-scoped tables in the live `agenthive` DB. It served as the authoritative input list when designing P820's 17 schema families. Do not run DDL from this artifact; it is documentation only. |
| **B2** | P756 | hiveCentral DB bootstrap (provisioning script + roles) | **Repurposed** | The role model (6 roles: admin, orchestrator, agency, a2a, observability, repl) and password-via-GUC pattern from P756 survive intact in `000-roles.sql`. However the schema install path (pg_dump/restore from agenthive) is replaced by the P820 apply sequence in `database/ddl/hivecentral/README.md`. |
| **B3** | P757 | Migrate control-plane tables out of agenthive into hiveCentral | **Deferred** | Cannot execute before P820 AC-8 operator review gate. When the gate passes, a migration script must be written that reads from `database/control-plane-tables.md` (B1) and loads rows into the P820 DDL target tables. The old B3 implementation artifact targeted the agenthive-clone schema and must not be run. |
| **B4** | P758 | Tenant-DB provisioning + project registry | **Repurposed** | The concept survives as `control_project.fn_provision_project(slug, dsn_secret_ref)` defined in `010-project.sql`. The project registry shape (`control_project.project`, `control_project.project_db`) is the P820-canonical target, replacing any old `hiveCentral.roadmap.project` shape from the B4 artifact. |
| **B5** | P759 | Code rewire — every `getPool()` caller routes to hiveCentral or tenant pool | **Deferred** | The audit in `docs/features/P759-getpool-rewire-deferred.md` identified the call sites. No code changes may be made until P820 AC-8 passes and the pool factory is updated to target P820 schema roles. |
| **B6** | P760 | project_capacity_config schema + seed | **Repurposed** | The concept survives as `control_project.project_capacity_config` defined in `010b-project-ext.sql`. The B6 seed values (default row for project_id=1) must be applied post-AC-8 against the P820 DDL table, not the old schema. |

---

## Audit Query — Cross-DB Application-Level FKs

The following query runs against a **tenant DB** and verifies that every `proposal_id` in dispatch tables has a matching entry in the tenant's proposal table. It must be run post-B3 migration as a data-integrity checkpoint:

```sql
-- Run against each tenant DB after B3 data migration
-- Checks dispatch.proposal_lease cross-DB FK integrity
SELECT
    pl.lease_id,
    pl.proposal_id,
    'proposal_lease' AS source_table
FROM dispatch.proposal_lease pl
WHERE NOT EXISTS (
    SELECT 1 FROM roadmap.proposal p WHERE p.id = pl.proposal_id
)
UNION ALL
SELECT
    wo.offer_id::text,
    wo.proposal_id,
    'work_offer' AS source_table
FROM dispatch.work_offer wo
WHERE NOT EXISTS (
    SELECT 1 FROM roadmap.proposal p WHERE p.id = wo.proposal_id
);
-- Expected result: 0 rows (all cross-DB FKs valid)
```

---

## Do-Not-Run Gate

**No artifact in the P501-P520 range or P745 B3/B5 may be executed against a production system before P820 AC-8 is recorded.** The AC-8 record must include:
- Operator identity (human, not agent)
- Review date
- Explicit "approved to proceed" statement covering B3, B5, and the switchover sequence

AC-8 is a hard blocker on `fn_guard_gate_advance` for any child proposals (B3, B5, P505, P506, P509) that depend on P820's logical model being frozen.
