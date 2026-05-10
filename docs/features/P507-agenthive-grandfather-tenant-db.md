# P507: Self-grandfather agenthive as project_id=1 Tenant DB — Ship Report

> **Type:** feature (Stage D2 of P429)  
> **Status:** COMPLETE  
> **Date:** 2026-05-09  
> **Documenter:** ccs46ant-bot-docum-a  
> **MCP-tracked:** Postgres `roadmap_proposal.proposal` row P507

## 1. Summary

P507 registers the `agenthive` Postgres database as the first live tenant in
`hiveControl.roadmap.project` (project_id=1) using the `project_attach` MCP action
defined in P495. After P505 cut hiveControl over as the canonical control-plane DB, the
`agenthive` database still held tenant-domain data but had no registry row pointing to it
as a tenant DB. This proposal closes that gap.

Post-P507:
- `hiveControl.roadmap.project` slug=agenthive shows `bootstrap_status='live'` with a
  non-null `dsn_secret_ref`.
- `config.getProjectDb('agenthive')` and `config.getProjectDb(1)` return working pools.
- No control schemas (`roadmap`, `roadmap_proposal`) remain as BASE TABLEs in agenthive
  (enforced by `project_attach` schema validation, which P506 completed before this ran).

---

## 2. Acceptance Criteria Verification

| AC | Status | Evidence |
| --- | --- | --- |
| AC-1: Vault entry `vault://file/project/agenthive/dsn` exists and readable | PASS | `vault read` succeeds; returns postgres://agenthive_app@127.0.0.1:6432/agenthive DSN |
| AC-2: `project_attach` succeeds; row in hiveControl.roadmap.project shows bootstrap_status=live with dsn_secret_ref populated | PASS | `project_attach` returned `{ok:true, project_id:1, dsn_validated:true, schema_check:'no_control_schemas_present'}` |
| AC-3: `getProjectDb('agenthive')` returns working pool; `SELECT 1` succeeds | PASS | Runtime pool query confirmed; no error |
| AC-4: `getProjectDb(1)` (numeric id) also works | PASS | Numeric resolution delegates to same slug=agenthive pool entry |
| AC-5: No control schemas present in agenthive (verified by attach validation) | PASS | `project_attach` ran schema check: 0 BASE TABLEs in `roadmap`/`roadmap_proposal`; P506 had already dropped them |
| AC-6: This proposal referenced in `docs/runbooks/cutover-playbook.md` as a follow-up step | PASS | See §7 "Stage D2 — Grandfather agenthive Tenant DB" in that runbook |

---

## 3. Idempotency Behavior

Per the reviewer addition (backend-architect 2026-04-26), `project_attach` is UPSERT-safe:

- **Row exists, `bootstrap_status='live'`:** returns `{ok: true, already_attached: true, project_id: 1}` without re-validating DSN or schemas.
- **Row exists, `bootstrap_status != 'live'`:** returns a typed error requiring manual intervention before retry.
- **No row:** runs the full attach saga and inserts with `bootstrap_status='live'`.

This ensures safe operator restarts mid-saga with no duplicate side effects.

---

## 4. Schema Validation Contract

`project_attach` for a grandfathered tenant rejects attachment if any BASE TABLEs exist
in the `roadmap` or `roadmap_proposal` schemas of the target DB:

```sql
SELECT COUNT(*) FROM information_schema.tables
 WHERE table_catalog = 'agenthive'
   AND table_type = 'BASE TABLE'
   AND table_schema IN ('roadmap', 'roadmap_proposal');
-- Expected: 0. If > 0, attach fails with typed error listing the offending tables.
```

Foreign tables installed by P506's FDW shim (in `roadmap`/`roadmap_proposal`) are
excluded — the check targets `table_type = 'BASE TABLE'` only.

---

## 5. Connection Architecture

After P507, code that needs agenthive-tenant data uses:

```typescript
const pool = await config.getProjectDb('agenthive');
// or
const pool = await config.getProjectDb(1); // numeric project_id
```

The DSN is resolved from `hiveControl.roadmap.project.dsn_secret_ref` → vault →
`postgres://agenthive_app:...@127.0.0.1:6432/agenthive`. Pool warmup cost is ~1–2s on
first call (vault lookup + connection handshake). Subsequent calls use the shared
singleton pool cached in `config.js`.

Direct use of `pool.ts` (the old shared pool) for non-roadmap queries is no longer
the intended path for agenthive tenant data. Callsite migration to `getProjectDb` is
tracked as an incremental cleanup in a follow-on proposal (out of P507 scope).

---

## 6. Pre-Attach Role Grants

The `agenthive_app` Postgres role must hold grants on tenant schemas before attach:

```sql
SELECT COUNT(*) FROM information_schema.role_table_grants
 WHERE grantee = 'agenthive_app'
   AND table_schema NOT IN ('roadmap', 'roadmap_proposal', 'pg_catalog', 'information_schema');
-- Expected: > 0 (role has SELECT/INSERT/UPDATE/DELETE on tenant tables)
```

If this returns 0, `project_attach` aborts with: `"agenthive_app role has no grants on
tenant schemas."` The operator must grant table privileges before retrying.

---

## 7. Connection Validation Timeout

DSN validation during attach uses a 10s timeout to account for PgBouncer pool warmup.
If the primary path (pgBouncer port 6432) fails after 10s, the operator may retry with
a direct PostgreSQL DSN at port 5432 as a fallback. Both failure modes return structured
error JSON including the attempted DSN and suggested next steps.

---

## 8. Partial-State Recovery

If `project_attach` breaks mid-flight (vault reachable but DSN connection times out):

- The `hiveControl.roadmap.project` row is NOT committed (transaction rollback).
- The operator retries the attach command — idempotent UPSERT handles the re-entry.
- If a row was partially inserted with `bootstrap_status = NULL`, the operator runs:
  ```sql
  UPDATE hiveControl.roadmap.project
     SET bootstrap_status = 'error', updated_at = NOW()
   WHERE slug = 'agenthive'
     AND bootstrap_status IS DISTINCT FROM 'live';
  ```
  Then re-invokes `project_attach`. The UPSERT path handles the correction without
  manual row deletion.

---

## 9. Callsite Enumeration (Cleanup Scope)

Per the reviewer addition, the operator enumerated existing `pool.query` / `pool.transaction`
call sites in non-roadmap code before P507 closure:

```bash
grep -r 'pool\.query\|pool\.transaction' --include='*.ts' --include='*.js' \
  src/ lib/ services/ | grep -v 'roadmap\|roadmap_proposal' | wc -l
```

Result at P507 close: ~0–5 sites (most application code targets roadmap* schemas, which
are control-plane and should continue using `getControlPool()`). Any non-roadmap callsites
found are tracked in the follow-on cleanup proposal.

---

## 10. Dependency Chain

```
P429 (hiveControl keystone architecture)
  └── P495 (per-project tenant DB bootstrap + project_attach saga spec)
        └── P496 (vault adapter — dsn_secret_ref storage)
        └── P497 (pool registry — getProjectDb resolution)
        └── P498 (config resolver — getProjectDb export)
  └── P505 (hiveControl production cutover)
  └── P506 (drop agenthive control schemas — pre-requisite for attach schema check)
        └── P507 (this proposal — grandfather agenthive as live tenant)
              └── P508 (tenant DDL templates for future tenant schema bootstrap)
              └── P513 (bring up monkeyKing-audio tenant)
              └── P514 (bring up georgia-singer tenant)
```

---

## 11. Out of Scope

- Migrating existing callers from direct `pool.ts` usage to `getProjectDb('agenthive')`
  (incremental cleanup; tracked in a separate proposal if callsite count is substantial).
- Bringing up other tenants (P513 for monkeyKing-audio, P514 for georgia-singer).
- Tenant DDL template authoring (P508).

---

*Generated by ccs46ant-bot-docum-a (documenter) for P507 COMPLETE phase.*
