> **Type:** runbook
> **MCP-tracked:** P510
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P510
> **Parent program:** P429 (AgentHive Control Plane multi-tenancy)

# P429 Cleanup Runbook: Dropping `project_id` from Shared Control-Plane Tables

## Background

Migration 051 (`051-p482-phase2-project-id-propagation.sql`) added
`project_id BIGINT NOT NULL DEFAULT 1` to 10 control-plane tables under the
then-current assumption of single-DB multi-tenancy with row-level
discriminators. After the P505 cutover and P507 grandfather work, those columns
are dead weight — `hiveCentral` is the control plane and tenant data lives in
per-tenant DBs, not in `project_id`-discriminated rows.

P510 is the scheduled sunset proposal that drops those columns. It advances only
after `now() > P505.completed_at + 30 days AND P507.completed_at IS NOT NULL`.

## Tables Dropped (Stage E1)

These shared control-plane tables had `project_id` removed by P510:

| Table | Schema |
| --- | --- |
| `proposal` | `roadmap_proposal` |
| `proposal_dependencies` | `roadmap_proposal` |
| `proposal_discussions` | `roadmap_proposal` |
| `proposal_acceptance_criteria` | `roadmap_proposal` |
| `proposal_reviews` | `roadmap_proposal` |
| `proposal_event` | `roadmap_proposal` |
| `agent_registry` | `roadmap_workforce` |
| `workflows` | `roadmap` |
| `workflow_templates` | `roadmap` |
| `gate_decision_log` | `roadmap` |
| `host_model_policy` | `roadmap` |
| `message_ledger` | `roadmap` |
| `cubics` | `roadmap` |

`runtime_flag` is deferred pending P473 placement decision. Tables in
`roadmap.knowledge_*`, `roadmap.federation_*`, and `roadmap.spending_*` are
assessed per-column based on query audit results before drop.

## Tables That Retain `project_id`

These policy and audit tables are keyed by project (FK to `roadmap.project`).
They are **not** affected and must not be modified:

| Table | Reason |
| --- | --- |
| `roadmap.project_route_allowlist` | per-project policy FK |
| `roadmap.project_capability_scope` | per-project policy FK |
| `roadmap.project_budget_cap` | per-project policy FK |
| `roadmap.dispatch_route_audit` | carries project_id for audit fidelity |
| `roadmap.project_repair_queue` | per-project repair tracking FK |

## Pre-Drop Gates

All three must pass before the drop migration runs:

### Gate 1 — Sunset timer

```sql
SELECT
  p505.completed_at AS p505_completed_at,
  p507.completed_at AS p507_completed_at,
  now() > p505.completed_at + INTERVAL '30 days'  AS timer_ok,
  p507.completed_at IS NOT NULL                    AS p507_stable
FROM
  (SELECT completed_at FROM roadmap_proposal.proposal WHERE proposal_number = 505) p505,
  (SELECT completed_at FROM roadmap_proposal.proposal WHERE proposal_number = 507) p507;
```

Both `timer_ok` and `p507_stable` must be `true`.

### Gate 2 — Query audit (zero residual reads)

Confirm no queries targeting `WHERE project_id = …` on shared tables in the
last 30 days. Use `pg_stat_statements` extended with custom counters if
available, or a 30-day sampling window from the observability schema:

```sql
SELECT query, calls, mean_exec_time
  FROM pg_stat_statements
 WHERE query ILIKE '%project_id%'
   AND query NOT ILIKE '%roadmap.project%'
   AND query NOT ILIKE '%project_route_allowlist%'
   AND query NOT ILIKE '%project_capability_scope%'
   AND query NOT ILIKE '%project_budget_cap%'
   AND query NOT ILIKE '%dispatch_route_audit%'
   AND query NOT ILIKE '%project_repair_queue%'
 ORDER BY calls DESC;
```

Expected result: zero rows, or only rows that reference the legitimate
policy/audit tables above. Any hit on a shared control-plane table must be
traced and fixed before proceeding.

### Gate 3 — Codebase grep

```sh
rg 'project_id\s*[=<>]' src/ scripts/ -t ts
```

Expected result: only call sites that read from `roadmap.project` (the
registry) or the five legitimate policy/audit tables. Any reference to a
shared control-plane table is a blocker.

## The Drop Migration

File name: `NNN-p510-drop-project-id-from-shared-tables.sql`

```sql
BEGIN;

ALTER TABLE roadmap_proposal.proposal                 DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap_proposal.proposal_dependencies    DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap_proposal.proposal_discussions     DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap_proposal.proposal_acceptance_criteria DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap_proposal.proposal_reviews         DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap_proposal.proposal_event           DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap_workforce.agent_registry          DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap.workflows                         DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap.workflow_templates                DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap.gate_decision_log                 DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap.host_model_policy                 DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap.message_ledger                    DROP COLUMN IF EXISTS project_id;
ALTER TABLE roadmap.cubics                            DROP COLUMN IF EXISTS project_id;

-- Drop composite indexes installed by migration 051 that are now orphaned
DROP INDEX IF EXISTS roadmap_workforce.idx_agent_registry_project_status;
DROP INDEX IF EXISTS roadmap.idx_workflows_project_stage;
DROP INDEX IF EXISTS roadmap_proposal.idx_proposal_discussions_project_proposal;
DROP INDEX IF EXISTS roadmap_proposal.idx_proposal_reviews_project_proposal;
DROP INDEX IF EXISTS roadmap.idx_cubics_project_status;

COMMIT;
```

Use `IF EXISTS` on all clauses so the migration is idempotent on replay.

## Post-Drop Verification

```sh
# Confirm columns are gone
psql -d hiveCentral -c "
  SELECT table_schema, table_name
    FROM information_schema.columns
   WHERE column_name = 'project_id'
     AND table_schema IN ('roadmap', 'roadmap_proposal', 'roadmap_workforce')
   ORDER BY table_schema, table_name;
"
```

Expected: only the five legitimate policy/audit tables appear. No shared
control-plane table should be in this result.

Run the full test suite and confirm the application starts cleanly:

```sh
bun test
sudo systemctl restart agenthive-orchestrator
```

Final grep sweep to confirm no stray references on the dropped columns:

```sh
rg 'project_id' src/ scripts/ -t ts | grep -v 'roadmap\.project\b' | grep -v 'project_route_allowlist\|project_capability_scope\|project_budget_cap\|dispatch_route_audit\|project_repair_queue'
```

Expected: zero output.

## Rollback

The drop is not directly reversible without re-running migration 051 in full
(which also adds composite PKs and FK constraints). If rollback is needed within
the maintenance window, restore from the pre-migration snapshot taken per the
backup gate.

If the need for rollback is discovered post-window, file a new proposal rather
than reverting in place — re-adding `DEFAULT 1` columns to control-plane tables
would reintroduce the anti-pattern and block any future multi-tenancy work.

## Related Proposals

| Proposal | Role |
| --- | --- |
| P429 | Parent: AgentHive Control Plane architecture |
| P483 | Added `project_id` columns (migration 051; P482 project-registry work superseded by P483) |
| P505 | Control-plane DB cutover — sunset timer starts here |
| P507 | Grandfather / stability confirmation |
| P510 | **This proposal** — Stage E1 column drop |
| P511 | Next: drop FDW shims |
| P512 | Next: remove single-DB test mode |
