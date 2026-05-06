# P825 — SMDL V2: DB-Only Workflow Definitions

**Proposal:** P825  
**Status:** COMPLETE (2026-05-05)  
**Depends on:** P823

---

## Summary

Removed the `BUILTIN_SMDLS` TypeScript arrays from `smdl-loader.ts` and `smdl-mcp.ts`.
Workflow definitions (rfc-5, hotfix) are now pure DB rows seeded by SQL at deploy time.
Custom workflows require no code changes — insert them as DB rows via YAML+MCP or direct SQL.

---

## Motivation

`smdl-loader.ts` and `smdl-mcp.ts` each embedded a full copy of the RFC and hotfix
workflow templates as hardcoded TypeScript arrays. This meant:

- Adding a custom workflow type required a code change and redeploy.
- The scan-hardcoding scanner (`scan-hardcoding.ts`) flagged these files for bare
  workflow-state literals (`DRAFT`, `REVIEW`, `DEVELOP`, …), requiring explicit
  `.scanignore.yaml` allowlist entries to suppress false positives.
- `state-names.ts` already had the correct pattern — DB-backed, NOTIFY-reloaded —
  but the built-in loaders bypassed it.

---

## What was removed

| File | Removed |
|---|---|
| `src/core/workflow/smdl-loader.ts` | `BUILTIN_SMDLS` constant, `loadAllBuiltins()` function |
| `src/mcp/tools/workflow/smdl-mcp.ts` | `BUILTIN_SMDLS` constant, `loadBuiltinWorkflows()` function |
| `.scanignore.yaml` | Two allowlist entries for the above files |

The MCP `load_builtins` action (previously responsible for calling `loadBuiltinWorkflows()`)
now verifies that the seeded workflows already exist in the DB and returns status — it no
longer writes anything.

---

## What seeds the built-in workflows

`deploy/project-init/seed/proposal-types.sql` is the authoritative source for the
built-in `rfc-5` and `hotfix` workflow definitions. It inserts rows into:

- `workflow_templates` — one row per workflow (`smdl_id`, `name`, `smdl_definition` JSONB)
- `workflow_stages` — one row per stage in each workflow
- `workflow_transitions` — one row per allowed transition (from/to/labels/roles)
- `workflow_roles` — one row per role definition

This SQL runs during `project-init` (new tenant onboarding) and must be re-run after
schema migrations that reset these tables.

---

## Runtime architecture

```
Startup
  └─ init.ts
       └─ StateNamesRegistry.load(pool)   ← src/core/workflow/state-names.ts
            ├─ SELECT smdl_definition FROM roadmap.workflow_templates
            ├─ Builds in-memory stage/transition maps
            └─ LISTEN workflow_templates_changed  (dedicated PoolClient)

Live reload (no restart needed)
  └─ Any INSERT/UPDATE to workflow_templates fires:
       pg_notify('workflow_templates_changed', ...)
  └─ StateNamesRegistry catches notification → calls load() again
       (serialized via loadInFlight promise — P522 concurrency hardening)
```

### Key files

| File | Role |
|---|---|
| `src/core/workflow/smdl-loader.ts` | SMDL YAML parser + `materializeWorkflow()` — writes `workflow_templates` + child tables |
| `src/apps/mcp-server/tools/workflow/smdl-mcp.ts` | MCP tools: `workflow_load`, `workflow_list`, `workflow_visualize` |
| `src/core/workflow/state-names.ts` | In-process registry — `StateNamesRegistry`, `getRegistry()`, NOTIFY listener |
| `deploy/project-init/seed/proposal-types.sql` | SQL seed for built-in workflows |

---

## Adding a custom workflow (operator runbook)

### Option A — MCP tool (recommended)

```bash
# Author YAML following the SMDL spec:
# docs/pillars/1-proposal/state-machine-definition-language.md

mcp workflow_load yaml="$(cat my-workflow.yaml)"
# Returns: template ID, stage count, transition count, role count

mcp workflow_list
# Confirm new template appears
```

The `StateNamesRegistry` reloads automatically via Postgres NOTIFY — no service restart needed.

### Option B — Direct SQL

```sql
INSERT INTO workflow_templates (smdl_id, name, description, smdl_definition, version, is_system)
VALUES (
  'my-workflow',
  'My Workflow',
  'Description',
  '{"workflow": {...}}'::jsonb,
  '1.0.0',
  FALSE
)
ON CONFLICT (smdl_id) DO UPDATE SET
  smdl_definition = EXCLUDED.smdl_definition,
  modified_at = NOW();

-- Materialize stages/transitions/roles separately, then:
SELECT pg_notify('workflow_templates_changed', 'manual');
```

---

## Acceptance criteria (all passed)

| AC | Description |
|---|---|
| AC-1 | `BUILTIN_SMDLS` removed from `smdl-loader.ts` with no runtime fallback |
| AC-2 | `BUILTIN_SMDLS` and `loadBuiltinWorkflows()` removed from `smdl-mcp.ts` |
| AC-3 | `deploy/project-init/seed/proposal-types.sql` seeds equivalent workflow definitions for all former BUILTIN_SMDLS entries |
| AC-4 | `StateNamesRegistry` loads correctly from `agentHive2` workflow tables after V2 seed |
| AC-5 | `scan-hardcoding.ts` reports no bare workflow-state findings for `smdl-loader.ts` or `smdl-mcp.ts` |
| AC-6 | `.scanignore.yaml` allowlist entries for those two files removed |

---

## Rollback

If the seed SQL is missing or the `workflow_templates` table is empty:

1. `StateNamesRegistry.getView()` calls will return empty views (no crash — empty arrays).
2. Transition validation in `prop_transition` will reject all transitions (no valid transitions in DB).
3. Fix: re-run `deploy/project-init/seed/proposal-types.sql` against the target DB, then
   `SELECT pg_notify('workflow_templates_changed', 'rollback-fix');`

There is no code rollback path — the TypeScript arrays have been deleted. Restore from git
only if the seed SQL itself is broken.
