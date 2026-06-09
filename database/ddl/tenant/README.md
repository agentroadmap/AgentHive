# P513 / P508: Tenant DDL Templates

This directory contains SQL templates applied by the P495 saga during tenant database bootstrap (Stage F1).

## Files

### `000-tenant-bootstrap.sql`

Core tenant infrastructure setup. Applied after database creation, as the tenant role (e.g., `monkeyKing_audio_owner`).

**Substitutions:**
- `{{schema_prefix}}` — namespace for tenant tables (e.g., `audio_`)
- `{{tenant_role}}` — Postgres role name (e.g., `monkeyKing_audio_owner`)
- `{{tenant_name}}` — human-readable name for audit (e.g., `Monkey King Audio`)

**Creates:**
- `{{schema_prefix}}meta.migrations` — audit table for tracking DDL application
- `{{schema_prefix}}meta.tenant_info` — tenant identity record
- `{{schema_prefix}}meta.audit_log` — read-only view for operator observability

**Critical (AC-6):**
- `REVOKE ALL ON SCHEMA public FROM {{tenant_role}}`
- `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {{tenant_role}}`

This enforces cross-tenant isolation: the tenant role cannot read `agenthive.roadmap` or any shared control-plane tables.

### `001-tenant-health.sql`

Health check and isolation verification functions. Applied after `000-tenant-bootstrap.sql`.

**Substitutions:**
Same as above.

**Creates:**
- `{{schema_prefix}}meta.health()` — Returns (status, checked_at, schema_name, migrations_count, tenant_info_count)
  - **AC-7 compliance:** Confirms pool connectivity + schema availability without depending on domain DDL
  - Called by: integration tests, monitoring, smoke tests
  
- `{{schema_prefix}}meta.verify_isolation()` — Returns test results for AC-6 isolation guard
  - Verifies tenant role cannot access public schema

## Workflow

### Saga Execution (P495)

1. **Step 2:** Registry insert → record project in `roadmap.project` with `bootstrap_status='pending'`
2. **Step 3:** Create Postgres role `{{tenant_role}}`
3. **Step 4:** Vault writes DSN to `vault://file/project/{{slug}}/dsn`
4. **Step 5:** `CREATE DATABASE {{db_name}} OWNER {{tenant_role}}`
5. **Step 6:** Apply templates
   - Connect as Postgres admin (via vault DSN)
   - Apply `000-tenant-bootstrap.sql` with substitutions
   - Apply `001-tenant-health.sql` with substitutions
   - Update `roadmap.project.bootstrap_status = 'schema_loaded'`
6. **Step 7:** Ops bundle (P509) — cron, monitoring, PgBouncer registration
7. **Step 8:** Update `roadmap.project.bootstrap_status = 'live'`

### Template Idempotency

Both templates are idempotent:
- Tables created with `IF NOT EXISTS`
- Migration records use `ON CONFLICT (name) DO NOTHING`
- Functions created with `OR REPLACE`
- tenant_info insert uses `ON CONFLICT (schema_prefix) DO NOTHING`

**Re-applying the same templates is safe**, even after a failed step. Checksum tracking in the migrations table can be used by repair workers.

## Acceptance Criteria Mapping

| AC | Template Coverage | Notes |
| --- | --- | --- |
| **AC-2** | `000-tenant-bootstrap.sql` creates `{{schema_prefix}}meta.*` | Bootstrap schema installed; health() callable |
| **AC-6** | Both templates enforce role isolation | REVOKE in 000; verify_isolation() in 001 |
| **AC-7** | `001-tenant-health.sql` provides health() | Smoke test: `SELECT * FROM audio_meta.health()` |

## Example Substitution

For `monkeyKing-audio`:

```sql
-- Before:
REVOKE ALL ON SCHEMA public FROM {{tenant_role}};
CREATE TABLE IF NOT EXISTS {{schema_prefix}}meta.migrations (...)
CREATE FUNCTION {{schema_prefix}}meta.health() ...

-- After:
REVOKE ALL ON SCHEMA public FROM monkeyKing_audio_owner;
CREATE TABLE IF NOT EXISTS audio_meta.migrations (...)
CREATE FUNCTION audio_meta.health() ...
```

## Testing

Unit test: `src/test/p513-tenant-isolation.test.ts`

Smoke test script: `scripts/smoke-test-tenant.ts`

```bash
# With control + tenant DSNs set:
AGENTHIVE_CONTROL_DSN=... TEST_MONKEYKINGAUDIO_DSN=... \
  npx ts-node scripts/smoke-test-tenant.ts --verbose
```

## Operator Runbook

See `/data/code/AgentHive/docs/deployment-runbook-p513.md` for full deployment sequence, including vault setup, saga invocation, and validation steps.
