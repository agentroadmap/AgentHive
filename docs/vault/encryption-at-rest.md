# Vault: Encryption-at-Rest & No-Log Policy (P1072 AC-7)

This document defines how AgentHive handles secret material once vault provider
selection moved from environment variables to the `control_credential` control
plane (hiveCentral) — and the hard rule that secret **values** are never logged.

## 1. The control plane stores pointers, not secrets

Verified live schema (hiveCentral, `\d`):

`control_credential.vault_provider`
| column | type | note |
| --- | --- | --- |
| `id` | bigint | PK |
| `slug` | text | unique provider name |
| `provider_type` | text | CHECK `env \| file \| hcp_vault \| aws_secrets` |
| `config` | jsonb | provider config — paths/mount/region, **no secret values** |
| `owner_did` | text | |
| `lifecycle_status` | text | CHECK `active \| deprecated \| retired \| blocked` |

`control_credential.credential`
| column | type | note |
| --- | --- | --- |
| `id` | bigint | PK |
| `credential_name` | text | unique logical name |
| `vault_provider_id` | bigint | FK → vault_provider |
| `vault_path` | text | **location reference**, not the secret |
| `credential_type` | text | CHECK `api_key \| oauth_token \| tls_cert \| db_password \| generic` |
| `last_rotated_at`, `rotation_interval_hours` | | rotation metadata |
| `owner_did`, `lifecycle_status`, `notes` | | |

**There is no plaintext `credential` value column.** The control plane records
only *where* a secret lives (`vault_path`) and metadata about it. The decrypted
secret bytes never touch these tables.

## 2. Where secrets actually live (encrypted at rest)

| provider_type | backend | at-rest protection |
| --- | --- | --- |
| `file` | `file-vault.ts` | `0600` files under `AGENTHIVE_VAULT_ROOT`, owner-only, symlink-guarded |
| `hcp_vault` | `hcv-vault.ts` | HashiCorp Vault KV v2 — Vault's own seal/encryption |
| `aws_secrets` | `aws-vault.ts` | AWS Secrets Manager — KMS-encrypted |
| `env` | process env | not at-rest; injected by orchestrator, not stored in DB |

The DB layer (`db-provider.ts`) reads a **reference** and hands it to the
scheme-routing adapter (`index.ts`). The secret value is only materialized when
a caller invokes `VaultAdapter.read(ref)` against the backing store.

## 3. No-log guarantee

Hard rule for the entire `src/shared/vault/` package:

> Log **refs, `provider_type`, and slugs** — **never** a secret value returned
> by `VaultAdapter.read()`.

Enforcement points:

- `db-provider.ts` never receives a decrypted value — it only resolves refs, so
  there is nothing secret to leak. (See module header.)
- `index.ts` init logs (`[vault] Adapter initialized from DB: provider_type=…
  (slug=…)`) emit only `provider_type` and `slug`. No value, no `vault_path`
  body, no `config` contents.
- No `console.*`/logger call in this package is passed the result of `read()`.

Reviewers and future contributors: adding a log line that interpolates a secret
value (or a full credential `config` blob that may contain inline material) is a
policy violation and must be rejected in review.
