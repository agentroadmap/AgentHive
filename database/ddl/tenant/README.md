# Tenant Schema Bootstrap Templates

This directory contains the platform-provided DDL templates for tenant schema bootstrap.

## Files

### `000-tenant-bootstrap.sql`
Creates the tenant baseline schema (`${SCHEMA_PREFIX}meta`) with two foundational tables:

- **`migrations`**: Tracks DDL migrations applied to the tenant (filename, applied_at, applied_by, checksum).
- **`tenant_info`**: Stores tenant metadata as key-value pairs (slug, created_at, schema_prefix, bootstrap_version).

Includes **re-bootstrap protection** (AC-7): if the tenant already has a different slug stored, the script fails fast with an error, preventing accidental overwrite of the wrong tenant's schema.

### `001-tenant-health.sql`
Creates the `health()` function that returns tenant health status as JSON:
```json
{
  "ok": true,
  "slug": "monkeyKing-audio",
  "migrations_applied": 0,
  "now": "2026-06-08T12:00:00Z"
}
```

## Variable Substitution

These templates contain two placeholder variables that the saga (P495) substitutes at apply time:

### `${SCHEMA_PREFIX}`
- **Type**: PostgreSQL identifier (schema name)
- **Safe for substitution**: Yes, identifiers cannot be injection vectors.
- **Example values**: `agenthive_`, `audio_`, `song_`, `georgia_`
- **Used for**: Schema names, table names, function names within templates.

### `${SLUG}`
- **Type**: Text string (tenant slug)
- **Critical requirement**: MUST be validated against the kebab-case slug regex (P483/P495) **before substitution**.
  - Regex pattern: `[a-z0-9]([a-z0-9\-]*[a-z0-9])?` (alphanumeric and hyphens, no leading/trailing hyphens)
- **Safe for substitution into string literals**: Only if validation passes.
- **Alternative**: If the saga runner supports parameter binding (`$1`, `$2`), use positional parameters instead of string interpolation for extra SQL injection defense.
- **Example values**: `monkeyKing-audio`, `georgia-singer`, `test-project-1`

## Per-Project DDL Extension

After bootstrap, each project may extend the tenant schema with project-specific tables, views, and functions.

### Layout
```
database/ddl/tenant/
├── 000-tenant-bootstrap.sql          # Platform bootstrap (applied by saga)
├── 001-tenant-health.sql             # Platform health function (applied by saga)
├── README.md                          # This file
└── <project-slug>/
    ├── 100-asset-tables.sql          # Project-specific DDL
    ├── 101-indexes.sql
    └── 102-views.sql
```

**Example**: For project `monkeyKing-audio`, project-specific DDL lives in:
```
database/ddl/tenant/monkeyKing-audio/100-asset-tables.sql
```

### Responsibility & Automation
- **Platform responsibility**: Applies `000-*` and `001-*` templates via saga (P495).
- **Project team responsibility**: Authors and maintains `<project-slug>/*.sql` files.
- **Saga behavior**: Does NOT auto-apply per-project DDL. Operator runs these manually after `project_create` completes, or incorporates them into a project-specific bootstrap step.

### Conventions
- Per-project DDL files should reference `${SCHEMA_PREFIX}` for consistency (e.g., `CREATE TABLE ${SCHEMA_PREFIX}assets (...)`).
- Number files sequentially (100, 101, 102, …) to ensure deterministic apply order.
- Document dependencies: if `200-views.sql` depends on `150-functions.sql`, note this in a comment.

## Migration Runner (Out of Scope)

A future proposal (not yet scheduled) will introduce a tenant-migration CLI runner:
```bash
scripts/tenant-migrate.ts <slug>
```

This runner will:
1. Read files from `database/ddl/tenant/<slug>/` in sequence.
2. Query `${SCHEMA_PREFIX}meta.migrations` to detect already-applied migrations.
3. Apply new migrations and record them in the migrations table.
4. Use advisory locks (`pg_advisory_xact_lock`) to prevent concurrent runners from applying the same migration twice.

Until this runner is built, migrations are applied manually or via operator-orchestrated scripts.

## Slug Validation Checklist (for saga implementer)

Before substituting `${SLUG}` into these templates:

- [ ] Extract slug from the project registry (P429 hiveCentral design).
- [ ] Validate against regex: `^[a-z0-9]([a-z0-9\-]*[a-z0-9])?$`
- [ ] If validation fails, reject the project_create request with a clear error message.
- [ ] If validation passes, slug is safe for string interpolation.
- [ ] Optional: Use positional parameters (`$1`) instead of string interpolation for defense-in-depth.

## Acceptance Criteria Status

| AC | Requirement | Status |
|----|-------------|--------|
| 1 | Template files exist (`000-*` and `001-*`) | ✓ Satisfied |
| 2 | Substitution tested in P495 saga tests | Deferred to P495 |
| 3 | Tables populated after apply | ✓ Satisfied (via INSERT/seed rows) |
| 4 | `health()` function returns expected JSON | ✓ Satisfied |
| 5 | README explains substitution and per-project layout | ✓ Satisfied (this file) |
| 6 | P495 saga tests use these templates | Deferred to P495 |
| 7 | Re-bootstrap protection with slug mismatch guard | ✓ Satisfied (DO block in 000-*) |

## Testing Notes

- Templates contain literal `${...}` placeholders and will **not parse as raw SQL** in psql; this is expected.
- The saga (P495) substitutes these before execution.
- For manual testing or validation, substitute example values (e.g., `agenthive_` → `${SCHEMA_PREFIX}`, `test-tenant` → `${SLUG}`) and verify the output parses.
