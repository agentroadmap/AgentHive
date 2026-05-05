# Config Resolver Architecture

**P474 / P498** — Class-based configuration resolver with tenant DSN extension.

## Overview

`src/shared/runtime/config.ts` is the single source of truth for all runtime configuration in AgentHive. It enforces source constraints by key class: a secret key can never come from YAML; a tenant_dsn key can never be read as a value.

## Configuration Classes

| Class | Source | Example keys |
| :--- | :--- | :--- |
| `secret` | env only (never yaml/DB) | `PGPASSWORD`, `DISCORD_BOT_TOKEN` |
| `structural` | yaml canonical + env override | `PGHOST`, `AGENTHIVE_CONTROL_DSN` |
| `registry` | control DB + env override | `AGENTHIVE_DEFAULT_PROVIDER` |
| `flag` | control DB, live-reloadable | feature flags |
| `tenant_dsn` | pool-bound; never read via `get()` | per-tenant pool bindings |

## Resolution Order

1. Explicit env var override
2. `/etc/agenthive/env` file (promoted to env at startup)
3. `roadmap.yaml` (for `structural` keys only)
4. Control DB `control_runtime.*` (for `registry` and `flag` keys)
5. `defaultValue` from key definition
6. Throw `RuntimeConfigMissing` if `required: true`

## Key Groups (P498)

### StructuralKeys (extended)

- **`AGENTHIVE_CONTROL_DSN`** — Override DSN for the control-plane pool. Resolves via 3 paths:
  1. `AGENTHIVE_CONTROL_DSN` env var (highest priority)
  2. Assembly from `databases.control.{host,port,name,role}` in `roadmap.yaml` + `PGPASSWORD` env (P429 cutover)
  3. `undefined` — falls back to legacy `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE` resolution in pool-registry

### ControlTopologyKeys (new in P498)

Individual components of the control-plane DSN, sourced from `databases.control.*` in `roadmap.yaml`:

| Key | yamlPath | Default |
| :--- | :--- | :--- |
| `CONTROL_DB_HOST` | `databases.control.host` | `127.0.0.1` |
| `CONTROL_DB_PORT` | `databases.control.port` | `5432` |
| `CONTROL_DB_NAME` | `databases.control.name` | `hiveControl` |
| `CONTROL_DB_ROLE` | `databases.control.role` | — |
| `CONTROL_DB_PASSWORD_REF` | `databases.control.password_ref` | `PGPASSWORD` |

`CONTROL_DB_PASSWORD_REF` is **structural** (not secret): it holds a vault reference string (e.g. `"PGPASSWORD"`), not the actual password. The vault resolves the ref to the real secret at connection time.

### VaultKeys (new in P498)

| Key | yamlPath | Default |
| :--- | :--- | :--- |
| `AGENTHIVE_VAULT_ROOT` | `vault.root` | — |
| `AGENTHIVE_VAULT_KIND` | `vault.kind` | `env` |

### PoolTuningKeys (new in P498)

| Key | Default | Description |
| :--- | :--- | :--- |
| `AGENTHIVE_TENANT_POOL_MAX` | `8` | Max connections per tenant pool |
| `AGENTHIVE_DRAIN_TIMEOUT_MS` | `30000` | Pool drain grace period (ms) |
| `AGENTHIVE_PG_PORT` | — | Process-wide Postgres port override |
| `AGENTHIVE_LISTEN_PORT` | `6421` | MCP server listen port |

## Tenant DSN Access Pattern

Tenant databases are accessed through the P497 pool registry, **not** via config `get()`:

```typescript
// WRONG — throws RuntimeConfigInvalidSource
const pool = await config.get(SomeTenantDsnKey);

// CORRECT
const pool = await config.getProjectDb("my-project");
// or directly:
import { getProjectDb } from "@/postgres/pool-registry";
const pool = await getProjectDb("my-project");
```

Every call to `config.getProjectDb(slug)` records a synthetic audit entry under the key `tenant_dsn:<slug>`.

## Audit Snapshot

`getAuditSnapshot()` returns a grouped snapshot for observability:

```typescript
interface ConfigAuditSnapshot {
  config: ConfigAuditEntry[];    // all config keys accessed this process
  tenantDsn: TenantDsnAuditEntry[]; // tenant pool lookups by slug
}
```

Available via `mcp_ops action=config_audit` or directly as `getAuditSnapshot()`.

## Control Pool DSN-Flip Detection (P518 Cutover)

`getControlPool()` in pool-registry reads `process.env.AGENTHIVE_CONTROL_DSN` on every call. When the value changes (e.g. after `P518` migrates the control plane to a new host), the old pool is drained asynchronously and a new pool is built — without a process restart. This enables zero-downtime cutover.

## roadmap.yaml Extensions (P498)

```yaml
databases:
  control:
    name: hiveControl
    host: 127.0.0.1
    port: 5432
    role: control_plane
    password_ref: PGPASSWORD   # vault ref; not the password itself

pools:
  control:
    max: 10
  tenant:
    max: 8

vault:
  kind: env    # env | file | hashicorp
  root: ""
```

## Error Types

| Error | When |
| :--- | :--- |
| `RuntimeConfigMissing` | Required key not found in any source |
| `RuntimeConfigInvalidSource` | Key read from disallowed source (secret from yaml; tenant_dsn via get()) |
