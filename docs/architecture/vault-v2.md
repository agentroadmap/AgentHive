# Vault v2: Pluggable Adapter Architecture (P515)

**Status:** Implementation Complete (Build phase)  
**Version:** 1.0 (HCV primary, AWS stub, File-vault backward-compat)  
**Date:** 2026-06-09

## Overview

Vault v2 replaces the single file-based vault from P496 with a **pluggable adapter pattern**. This allows switching between backends (file, HashiCorp Vault, AWS Secrets Manager) without changing application code.

- **Primary backend (v1):** HashiCorp Vault (HCV) with AppRole authentication
- **File-vault (fallback):** Single-host dev/test environments
- **AWS Secrets Manager (v2):** Future; stub implemented for pluggability

## Architecture Decision: Pluggable Adapter Pattern

### Why This Pattern?

1. **Interface stability:** Callers never change; only adapter implementations evolve
2. **Gradual migration:** File-vault and HCV can coexist during grace period
3. **Multi-tenant ready:** Per-tenant least-privilege policies at backend level
4. **Auditability:** Each backend logs operations independently

### Deployment Model

```
┌─────────────────────────────────────────┐
│  Application Code (read/write/rotate)   │
└──────────────┬──────────────────────────┘
               │
               ▼
       ┌──────────────┐
       │   Chooser    │ (routes by scheme)
       └──┬───┬────┬──┘
          │   │    └────────────────┐
          │   │                     │
    ┌─────▼─┐ ▼──────────┐   ┌──────▼─────┐
    │ File  │ HCV (KV)   │   │ AWS (stub) │
    │ Vault │ (AppRole)  │   │ Secrets    │
    └───────┘ └───────────┘   └────────────┘
```

## VaultAdapter Interface

All adapters implement this interface:

```typescript
interface VaultAdapter {
  read(ref: SecretRef): Promise<string>;
  write(ref: SecretRef, value: string): Promise<void>;
  rotate(ref: SecretRef, newValue: string): Promise<void>;
  exists(ref: SecretRef): Promise<boolean>;
}
```

### SecretRef Schemes

Identifies which adapter handles the secret:

| Scheme | Backend | Format | Example |
|--------|---------|--------|---------|
| `vault://file/` | File-based | `vault://file/project/<slug>/...` | `vault://file/project/audiobook/dsn` |
| `vault://hcv/` | HashiCorp Vault KV v2 | `vault://hcv/tenants/<slug>/...` | `vault://hcv/tenants/audiobook/dsn` |
| `vault://aws/` | AWS Secrets Manager | `vault://aws/agentHive/<slug>/...` | `vault://aws/agentHive/audiobook/dsn` |

## HashiCorp Vault (HCV) Integration

### AppRole Authentication (No Plaintext Tokens)

AppRole is a machine-to-machine authentication method designed for service-to-service communication:

1. **Roles & IDs:**
   - `role_id`: Static identifier (per service)
   - `secret_id`: Dynamic credential (rotated weekly)

2. **Auth Flow (at adapter init):**
   ```
   POST /v1/auth/approle/login
   {
     "role_id": "...",
     "secret_id": "..."
   }
   → Returns: client_token (short-lived, e.g., 1h TTL)
   ```

3. **Token Renewal:**
   - Adapter renews token automatically at 75% of lease duration
   - No plaintext tokens in env vars or config files

### Setup (Operations Task)

1. **Create AppRole in Vault:**
   ```bash
   vault write auth/approle/role/agenthive-tenant-read \
     token_ttl=1h \
     secret_id_ttl=7d \
     bind_secret_id=true
   ```

2. **Generate Credentials:**
   ```bash
   vault read auth/approle/role/agenthive-tenant-read/role-id
   → role_id: abc-123-def

   vault write -f auth/approle/role/agenthive-tenant-read/secret-id
   → secret_id: xyz-789-uvw
   ```

3. **Store Credentials (Ops Responsibility):**
   - **File-based (preferred):** `/etc/agenthive/hcv-role-id.txt` (mode 0600)
   - **File-based:** `/etc/agenthive/hcv-secret-id.txt` (mode 0600)
   - Or inject via orchestrator at boot

4. **Configure Audit:**
   ```bash
   vault audit enable file file_path=/vault/logs/audit.log
   ```

### KV v2 Storage

- **Mount:** `secret` (default)
- **Path structure:** `secret/data/tenants/{tenant-slug}/{secret-name}`
- **Data layout:**
  ```json
  {
    "data": {
      "data": {
        "value": "postgresql://user:pass@localhost/db"
      },
      "metadata": {
        "version": 1,
        "created_time": "2026-06-09T00:00:00Z"
      }
    }
  }
  ```

### Per-Tenant Least-Privilege Policy

Apply this policy per tenant in Vault:

```hcl
path "secret/data/tenants/audiobook/*" {
  capabilities = ["read", "list"]
}

path "secret/metadata/tenants/audiobook/*" {
  capabilities = ["read", "list"]
}
```

## Configuration

### Environment Variables

```bash
# Backend selection
AGENTHIVE_VAULT_KIND=hcv|aws|file  # default: file

# File-Vault
AGENTHIVE_VAULT_ROOT=/etc/agenthive/secrets/  # default

# HCV
AGENTHIVE_HCV_ADDR=http://vault.internal:8200
AGENTHIVE_HCV_ROLE_ID_FILE=/etc/agenthive/hcv-role-id.txt
AGENTHIVE_HCV_SECRET_ID_FILE=/etc/agenthive/hcv-secret-id.txt
AGENTHIVE_HCV_MOUNT=secret                    # default
AGENTHIVE_HCV_NAMESPACE=acme                  # Enterprise only
AGENTHIVE_HCV_AUDIT_LOG=/var/log/hcv-audit.log

# AWS
AGENTHIVE_AWS_REGION=us-east-1
# AWS credentials: EC2 instance role / ECS task role / ~/.aws/credentials
```

### Example: Enable HCV for Production

```bash
export AGENTHIVE_VAULT_KIND=hcv
export AGENTHIVE_HCV_ADDR=https://vault.production.acme.com:8200
export AGENTHIVE_HCV_ROLE_ID_FILE=/etc/agenthive/hcv-role-id.txt
export AGENTHIVE_HCV_SECRET_ID_FILE=/etc/agenthive/hcv-secret-id.txt
export AGENTHIVE_HCV_AUDIT_LOG=/var/log/agenthive/vault-audit.log

# Start services
systemctl start agenthive-api
```

## Migration Strategy: File-Vault → HCV

### Phase 1: Dual-Read (No Downtime)

1. Deploy HCV adapter alongside file-vault
2. Run migration script:
   ```bash
   NODE_ENV=production AGENTHIVE_VAULT_KIND=hcv \
     npx tsx scripts/migrate-file-vault-to-v2.ts
   ```
3. Migration script:
   - Reads from `vault://file/...` (source of truth)
   - Writes to `vault://hcv/...` (new backend)
   - Verifies round-trip
   - Optionally updates project.dsn_secret_ref (for ops to confirm)
4. Existing connections use old cached DSNs during grace period (1 week)
5. New connections read from HCV

### Phase 2: Cutover

- All `project.dsn_secret_ref` entries point to HCV
- New projects created with HCV refs only

### Phase 3: Cleanup (Manual, Per Operator)

- Archive file-vault entries (audit trail)
- Delete file-vault secrets (if confident HCV is stable)
- File-vault code remains for future single-host dev instances

### Dry-Run First

```bash
AGENTHIVE_VAULT_KIND=hcv npx tsx scripts/migrate-file-vault-to-v2.ts --dry-run --verbose
```

## Rotation: Safe Dual-Password Grace Period

### Problem

Naive rotation (`ALTER ROLE` → `write vault` → `invalidate cache`) creates a window where new connections see the old password.

### Solution: Write-First Dual-Accept

1. Generate new password: `crypto.randomBytes(32)`
2. Write new password to vault
3. **Pool resolver accepts BOTH old and new (grace: 10s)**
4. `ALTER ROLE` in tenant DB to new password
5. Invalidate pool cache (forces auth retry)
6. After grace period, accept new password only
7. Log each step to audit trail

### Usage

```bash
npx agenthive-secret-rotate <tenant-slug> <secret-name>
```

## Audit & Observability

### HCV Native Audit Log

Automatically logs all operations:

```json
{
  "time": "2026-06-09T12:00:00Z",
  "type": "request",
  "auth": {
    "client_token": "s.xxxxxxxxxxxxxx",
    "accessor": "kv.agenthive",
    "display_name": "approle",
    "policies": ["agenthive-tenant-read"]
  },
  "request": {
    "operation": "GET",
    "path": "secret/data/tenants/audiobook/dsn"
  },
  "response": {
    "status": 200
  }
}
```

### Application-Level Metrics

Exported for Prometheus:

- `vault_read_duration_ms` (histogram)
- `vault_write_duration_ms` (histogram)
- `vault_unavailable_events_total` (counter)
- `rotation_flow_duration_ms` (histogram)
- `pool_cache_hit_rate` (gauge)

### Throttling Failed Auth

After 5 failed logins in 1 minute:
- Pause AppRole login for 30 seconds
- Log pause event with count + timestamp
- Prevents brute-force / misconfiguration storms

## Backward Compatibility

- `vault://file/...` refs continue to work **unchanged**
- FileVaultAdapter is **NOT removed** from codebase
- Single-host dev environments can still use file-vault
- Chooser automatically routes by scheme; no config change needed for mixed deployments

Example mixed deployment:

```
# Production: HCV
project-A with vault://hcv/tenants/project-a/dsn  → HCV adapter

# Dev environment: File-vault
project-B with vault://file/project/project-b/dsn → File adapter
```

## Implementation Details

### Core Files

| File | Purpose |
|------|---------|
| `src/shared/vault/types.ts` | Interface + error types |
| `src/shared/vault/file-vault.ts` | File-based adapter (unchanged) |
| `src/shared/vault/hcv-vault.ts` | HCV adapter (new, v1) |
| `src/shared/vault/aws-vault.ts` | AWS adapter (new, stub) |
| `src/shared/vault/index.ts` | Chooser + exports |
| `scripts/migrate-file-vault-to-v2.ts` | Migration script (new, skeleton) |
| `tests/shared/vault/vault-v2.test.ts` | Comprehensive tests (new) |

### Error Handling

All adapters throw VaultError subclasses:

- `VaultError`: Generic vault operation failure
- `VaultAuthError`: AppRole/IAM auth failure
- `VaultUnavailableError`: Backend unreachable (stale cache served if available)
- `VaultPermissionError`: File permission issues (file-vault only)
- `VaultCorruptedError`: Partial write detected (file-vault only)
- `VaultInvalidRefError`: Malformed SecretRef

### Caching

- **File-vault:** 60s TTL per secret, explicit invalidation on write
- **HCV:** 60s TTL per secret, stale cache (5min threshold) on backend outage
- **AWS:** No in-process cache (relies on AWS API caching)

## Testing

### Unit Tests

```bash
npx node --test --import jiti/register tests/shared/vault/vault-v2.test.ts
```

Tests cover:

- File-vault backward-compat (all existing refs work unchanged)
- HCV adapter instantiation and interface compliance
- AWS adapter instantiation and interface compliance
- Chooser routing by scheme
- SecretRef validation and path traversal defense
- Error handling consistency

### Integration Tests (Future)

- Live HCV instance: AppRole auth, KV operations, token renewal
- AWS Secrets Manager: IAM role auth, secret CRUD, encryption
- Multi-secret rotation: concurrent rotations without race conditions

## Out of Scope (P516, P514, P513)

- KMS seal provisioning (P516)
- Automatic credential rotation policy (manual trigger in v1)
- File-vault audit log migration (forward-only)
- AWS Secrets Manager production wiring (v2)

## Deployment Checklist

### Pre-Deployment (HCV Setup)

- [ ] Deploy Vault instance (or use existing)
- [ ] Enable audit device: `vault audit enable file`
- [ ] Create AppRole: `vault write auth/approle/role/agenthive-tenant-read ...`
- [ ] Generate role_id + secret_id
- [ ] Store credentials: `/etc/agenthive/hcv-*.txt` (mode 0600)
- [ ] Test AppRole login: `curl -X POST http://vault:8200/v1/auth/approle/login`

### Deployment (Code Changes)

- [ ] Deploy code with Vault v2 adapters
- [ ] Set `AGENTHIVE_VAULT_KIND=hcv` in production config
- [ ] Run migration script (dry-run first): `--dry-run --verbose`
- [ ] Review migration report; address any failures
- [ ] Run migration script (live)
- [ ] Monitor HCV audit logs for access patterns
- [ ] Verify new connections use HCV refs

### Post-Deployment (Cutover)

- [ ] Grace period: 1 week (existing connections use file-vault cache)
- [ ] Monitor HCV audit logs for errors
- [ ] Rotate secret_id: `vault write -f auth/approle/role/.../secret-id`
- [ ] Confirm all projects upgraded to HCV refs
- [ ] Archive file-vault entries (operator manual task)

## References

- **P515:** Vault v2 design and acceptance criteria
- **P496:** File-vault adapter (upstream)
- **P516:** KMS provisioning (downstream)
- **P514, P513:** Multi-tenant topology (uses Vault v2)
- [HashiCorp Vault AppRole Auth](https://www.vaultproject.io/docs/auth/approle)
- [HashiCorp Vault KV v2 Secrets Engine](https://www.vaultproject.io/docs/secrets/kv/kv-v2)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/)
