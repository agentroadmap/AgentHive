# Tenant Schema Bootstrap Templates

This directory contains the canonical bootstrap templates for tenant databases. These templates are applied once at project creation time by the P495 tenant provisioning saga.

## Files

- **`000-tenant-bootstrap.sql`**: Creates the tenant's metadata schema with tables for migrations tracking and tenant info (slug, creation timestamp, schema prefix, bootstrap version). Includes re-bootstrap protection guards.
- **`001-tenant-health.sql`**: Defines a `health()` function that returns a JSON status object with tenant slug, migrations count, and current timestamp.

## Substitution Rules

The saga (P495) reads each template file and performs two substitutions:

1. **`${SCHEMA_PREFIX}`**: An identifier prefix for all tenant-owned schemas and functions (e.g., `audio_`, `song_`, `agenthive_`).
   - **Safe for direct substitution** in SQL identifiers (schema names, function names, table names).
   - Example: `CREATE SCHEMA ${SCHEMA_PREFIX}meta` becomes `CREATE SCHEMA audio_meta`.

2. **`${SLUG}`**: The project slug (e.g., `monkeyKing-audio`, `georgia-singer`), a unique identifier for the tenant.
   - **Must be validated** against the slug regex from P483/P495 (kebab-case: alphanumeric + dashes only) **before substitution**.
   - If validation passes, slug is safe for INSERT string literals.
   - Alternative: the saga runner MAY use positional parameters (`$1`, `$2`) to bind slug and schema_prefix as values instead of string interpolation.

## Re-Bootstrap Protection

The `000-tenant-bootstrap.sql` template includes a guard block that prevents accidental re-bootstrapping of a tenant with a mismatched slug:

1. **Schema exists check**: If the `${SCHEMA_PREFIX}meta` schema already exists, continue to the next check.
2. **Table exists check**: If the `${SCHEMA_PREFIX}meta.tenant_info` table already exists, query its slug value.
3. **Slug mismatch check**: If the stored slug differs from the incoming `${SLUG}`, the saga raises an exception and fails fast.

This prevents data loss or configuration corruption if the saga is accidentally re-run against the wrong database.

## Per-Project DDL Extension

After bootstrap, each tenant project may add its own project-specific DDL under:

```
database/ddl/tenant/<slug>/
```

Example structure:
```
database/ddl/tenant/monkeyKing-audio/
  100-asset-tables.sql
  101-asset-metadata.sql
```

**Important notes**:
- Per-project DDL is the **responsibility of the project team**, not the platform.
- The P495 saga does **NOT** auto-apply per-project DDL; operators run these manually after initial project creation.
- All per-project DDL files should use `${SCHEMA_PREFIX}` for consistency with the bootstrap schema prefix.

## Future: Per-Tenant Migration Runner

Out of scope for P508, but planned: a CLI tool `scripts/tenant-migrate.ts <slug>` that:

1. Connects to the tenant's database using project routing (config.getProjectDb).
2. Reads migration files from `database/ddl/tenant/<slug>/`.
3. Checks the `<schema_prefix>meta.migrations` table for previously applied migrations.
4. **Uses PostgreSQL advisory locks** (`SELECT pg_advisory_xact_lock(hashtext('<slug>::migrations'))`) to prevent concurrent runners from applying the same migration twice.
5. Applies new migrations and records them in the migrations table.

See the future proposal (tenant-migration-runner) for implementation.

## Integration with P495 Saga

The P495 tenant provisioning saga orchestrates the following:

1. **Input validation**: Validates the incoming slug and schema_prefix against allowed formats.
2. **Template substitution**: Reads this directory's templates, substitutes `${SCHEMA_PREFIX}` and `${SLUG}`.
3. **Database creation**: Creates a new tenant database (PostgreSQL createdb command).
4. **Bootstrap execution**: Runs the substituted `000-tenant-bootstrap.sql` and `001-tenant-health.sql` scripts against the new tenant database in a transaction.
5. **Health verification**: Calls `SELECT <schema_prefix>meta.health()` to verify the bootstrap succeeded.

## Schema Design Principles

- **Tenant application data only**: Bootstrap templates contain ONLY schema structures needed by tenant applications (migrations table, tenant_info KV store, health function). No control-plane tables or hiveCentral references.
- **No FK to hiveCentral**: Tenant schemas are isolated. If a project needs to reference control-plane data (e.g., project ID), use the project's `config.getProjectDb(slug)` routing and pass the value as an application-layer field, not a database FK.

## Example: Applying Bootstrap to a Test Database

To manually test the bootstrap templates:

```bash
# Create test database
createdb agenthive_tenant_test_508

# Substitute and apply (example using bash with sed)
slug="test-project-508"
schema_prefix="test_"

sed "s/\${SCHEMA_PREFIX}/${schema_prefix}/g; s/\${SLUG}/${slug}/g" \
  database/ddl/tenant/000-tenant-bootstrap.sql | \
  psql -d agenthive_tenant_test_508

sed "s/\${SCHEMA_PREFIX}/${schema_prefix}/g; s/\${SLUG}/${slug}/g" \
  database/ddl/tenant/001-tenant-health.sql | \
  psql -d agenthive_tenant_test_508

# Verify health
psql -d agenthive_tenant_test_508 -c "SELECT test_meta.health();"

# Cleanup
dropdb agenthive_tenant_test_508
```

Expected health() output:
```json
{
  "ok": true,
  "slug": "test-project-508",
  "migrations_applied": 0,
  "now": "2026-06-10T14:30:00Z"
}
```
