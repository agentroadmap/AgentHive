# Vault: Migrating `vault://file/` refs to `control_credential` (P1072 AC-9)

Before P1072, vault provider selection was env-only (`AGENTHIVE_VAULT_KIND`) and
secret references were hard-coded `vault://file/<path>` strings scattered across
config rows (e.g. `project.dsn_secret_ref`). P1072 makes provider selection
data-driven from `control_credential.vault_provider`, and lets credentials be
resolved by *name* via `control_credential.v_active_credentials`.

This guide describes how to bulk-migrate existing `vault://file/...` refs into
`control_credential` rows so they can be resolved by name and re-pointed at a
different backend (HCV/AWS) without code changes.

> **Read-only until you intend to migrate.** The steps below WRITE to
> hiveCentral. Run the inventory first, get an operator to review, then apply in
> a transaction. The vault layer keeps working off the env/file fallback until a
> provider row is marked `active` (see `initVaultFromDb()` precedence).

## Step 0 — Precedence recap

`initVaultFromDb()` resolves the active backend in this order:
1. `AGENTHIVE_VAULT_KIND` env set + non-empty → hard override, DB untouched.
2. The single `active` row in `control_credential.vault_provider`.
3. No active row / DB error → eager env/file fallback (`vault://file/...` still
   works exactly as before).

So migration is **non-breaking**: existing `vault://file/` refs keep resolving
through the file adapter until you both (a) seed an active provider and (b) move
your refs into credential rows. Step 1–3 can be done incrementally.

## Step 1 — Inventory existing file refs (read-only)

Find every `vault://file/` ref currently in use:

```sql
-- Example: refs stored on project rows (adjust to your real ref columns).
SELECT id, slug, dsn_secret_ref AS ref
  FROM roadmap.project
 WHERE dsn_secret_ref LIKE 'vault://file/%';
```

```bash
# And in the codebase / config, any literal file refs:
grep -rn "vault://file/" src config 2>/dev/null
```

Record each `(logical_name, vault_path)` pair, where `vault_path` is the ref
with the `vault://file/` scheme prefix stripped.

## Step 2 — Seed the active `file` vault provider (one row)

```sql
INSERT INTO control_credential.vault_provider
  (slug, provider_type, config, owner_did, lifecycle_status)
VALUES
  ('default-file', 'file', '{}'::jsonb, 'did:agent:operator', 'active');
```

Only ONE provider should be `active` at a time — `fetchActiveProvider()` reads
`WHERE lifecycle_status='active' ORDER BY updated_at DESC LIMIT 1`. The partial
index `vault_provider_type_active` backs this lookup.

## Step 3 — Bulk-insert credential rows from the inventory

For each `vault://file/<path>` ref, insert a credential row whose `vault_path`
is the **scheme-stripped** path. `fetchCredentialRef()` re-prepends the scheme
from the provider type, so do NOT store the `vault://file/` prefix here.

```sql
-- Bulk migrate: derive vault_path by stripping the scheme prefix.
WITH src(credential_name, ref, credential_type) AS (
  VALUES
    ('audiobook_dsn',        'vault://file/project/audiobook/dsn', 'db_password'),
    ('audiobook_db_password','vault://file/project/audiobook/db_password', 'db_password')
    -- … one row per inventory entry …
)
INSERT INTO control_credential.credential
  (credential_name, vault_provider_id, vault_path, credential_type,
   owner_did, lifecycle_status)
SELECT
  s.credential_name,
  vp.id,
  regexp_replace(s.ref, '^vault://file/', ''),   -- strip scheme → vault_path
  s.credential_type,
  'did:agent:operator',
  'active'
FROM src s
CROSS JOIN (SELECT id FROM control_credential.vault_provider
             WHERE slug = 'default-file') vp;
```

Verify the joined active view resolves them:

```sql
SELECT credential_name, provider_type, vault_path
  FROM control_credential.v_active_credentials
 ORDER BY credential_name;
```

`fetchCredentialRef(pool, 'audiobook_dsn')` will now return
`vault://file/project/audiobook/dsn` — identical to the original literal ref, so
downstream `VaultAdapter.read()` behaviour is unchanged.

## Step 4 — Re-point columns to resolve by name (optional, incremental)

Once a credential exists by name, application code can resolve it via
`fetchCredentialRef(pool, name)` instead of carrying the literal ref. Migrate
call sites incrementally; both styles read the same file on disk.

## Step 5 — Switching backends later (the payoff)

To move all `file` secrets to HashiCorp Vault or AWS, you (a) copy the secret
material into the new backend at the same logical paths, (b) insert a new
`active` provider row of type `hcp_vault`/`aws_secrets` and deprecate the `file`
one, and (c) `fetchCredentialRef()` automatically emits `vault://hcv/...` /
`vault://aws/...` refs for the same credential names — **no application code or
ref-column changes required.**

## Rollback

- Set the migrated provider row `lifecycle_status='deprecated'` (or delete the
  credential rows). With no `active` provider, `initVaultFromDb()` falls back to
  env/file and the original `vault://file/` literal refs keep working.
- `ON DELETE RESTRICT` on `credential.vault_provider_id` prevents deleting a
  provider that still owns credentials — delete/deprecate credentials first.
