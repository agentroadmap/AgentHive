# Config Resolver Architecture

**P474 / P498** — Class-based configuration resolver with tenant DSN extension.

---

## Overview

`src/shared/runtime/config.ts` is the canonical runtime configuration resolver for AgentHive.
It enforces *class-based source constraints* — a `secret` key can never come from YAML or DB;
a `tenant_dsn` key can never be read as a plain value. Every required key that cannot be
resolved throws `RuntimeConfigMissing` — there are no silent hardcoded fallbacks.

---

## Resolution Order (7 levels, highest priority first)

| Level | Source | Applies to |
| :---: | :--- | :--- |
| 1 | Explicit call-site override (test injection / emergency) | all classes |
| 2 | Process env var (`process.env.KEY_NAME`) | `secret`, `structural` |
| 3 | Env file loaded at startup (`/etc/agenthive/env` → promoted to env) | `secret`, `structural` |
| 4 | `roadmap.yaml` structural defaults (checked into VCS) | `structural` only |
| 5 | Control-plane DB (`hiveCentral`) — `core.runtime_flag`, `control_*` tables | `registry` |
| 6 | Feature-flag DB row with `pg_notify runtime_flag_changed` live refresh | `flag` |
| 7 | `throw RuntimeConfigMissing` — never silently fall back to a hardcoded literal | — |

**Rule:** `secret` keys can only be satisfied at levels 1–3. If a `secret` value somehow
arrives via yaml or DB, `RuntimeConfigInvalidSource` is thrown.

---

## Configuration Classes

| Class | Allowed sources | Mutation authority | Example keys |
| :--- | :--- | :--- | :--- |
| `secret` | env / env-file only — never logged, never DB, never yaml | `operator` | `PGPASSWORD`, `DISCORD_BOT_TOKEN`, `GITHUB_TOKEN` |
| `structural` | yaml canonical + env override | `operator` | `PGHOST`, `PGPORT`, `AGENTHIVE_MCP_URL`, `PROJECT_ROOT` |
| `registry` | control DB + emergency env override | `operator` or `system` | `AGENTHIVE_DEFAULT_PROVIDER`, `MODEL_CONTEXT_WINDOW` |
| `flag` | control DB, live-reloadable via `pg_notify` | `system`, `operator` for emergency | `USE_OFFER_DISPATCH`, `ENABLE_MULTI_TENANT` |
| `tenant_dsn` | pool-bound; **never** readable via `get()` | — | per-project pool bindings (P497) |

---

## Multi-Tenant Scoping

For `registry` and `flag` class keys, resolution walks scopes in order:

1. `project_id`-scoped row (tenant-specific override)
2. `host_id`-scoped row (host-specific override)
3. `agency_id`-scoped row (agency-specific override)
4. `global` row
5. `roadmap.yaml` default
6. `throw RuntimeConfigMissing`

A missing `project_id` on a scoped lookup is a **fail-closed error** (`ProjectIdMissing`),
not a silent fallback to a global row.

---

## Module API

```typescript
// Initialise once at process startup
import { initConfig } from "src/shared/runtime/config";
await initConfig({ yamlConfig, pool, envFilePath: "/etc/agenthive/env" });

// Required value — throws RuntimeConfigMissing if missing
import { get } from "src/shared/runtime/config";
import { StructuralKeys } from "src/shared/runtime/config-keys";
const host = await get(StructuralKeys.PGHOST);

// Optional value — returns undefined if missing
import { getOptional } from "src/shared/runtime/config";
import { SecretKeys } from "src/shared/runtime/config-keys";
const token = await getOptional(SecretKeys.GITHUB_TOKEN);

// Tenant database pool — records audit entry, never read via get()
import { getProjectDb } from "src/shared/runtime/config";
const pool = await getProjectDb("my-project");   // slug or numeric project_id

// Reload from DB (clears in-process cache)
import { reload } from "src/shared/runtime/config";
await reload();

// Audit snapshot (used by mcp_ops action=config_audit)
import { getAuditSnapshot } from "src/shared/runtime/config";
const snap = getAuditSnapshot();
// snap.config    — ConfigAuditEntry[]   (all config keys accessed this process)
// snap.tenantDsn — TenantDsnAuditEntry[] (tenant pool lookups by slug)
```

---

## Key Inventory (`src/shared/runtime/config-keys.ts`)

### SecretKeys

| Key | Required | Description |
| :--- | :---: | :--- |
| `PGPASSWORD` | no | PostgreSQL password; prefer `.pgpass` / libpq implicit auth |
| `DISCORD_BOT_TOKEN` | no | Discord bridge bot token |
| `GITHUB_TOKEN` | no | GitHub personal access token |

### StructuralKeys

#### Database connection

| Key | yamlPath | Default | Description |
| :--- | :--- | :--- | :--- |
| `PGHOST` | `database.host` | `127.0.0.1` | PostgreSQL hostname |
| `PGPORT` | `database.port` | `5432` | PostgreSQL port |
| `PGDATABASE` | `database.name` | `agenthive` | PostgreSQL database name |
| `PGUSER` | `database.user` | — | PostgreSQL username (required, no default) |
| `PG_SCHEMA` | `database.schema` | — | PostgreSQL schema name |
| `PGSERVICE` | — (env `PGSERVICE`) | — | Named service from `.pg_service.conf` |
| `PGPASSFILE` | `database.pgpass_path` | `~/.pgpass` | Path to `.pgpass` file |
| `PGPORT_DIRECT` | — (env only) | — | Direct Postgres port bypassing PgBouncer (LISTEN connections) |

#### Timeouts

| Key | Default | Description |
| :--- | :--- | :--- |
| `PG_CONNECTION_TIMEOUT_MS` | `5000` | Connection timeout |
| `PG_QUERY_TIMEOUT_MS` | `30000` | Query timeout |
| `PG_STATEMENT_TIMEOUT_MS` | `30000` | Statement timeout |

#### Control-plane DB

| Key | yamlPath | Default | Description |
| :--- | :--- | :--- | :--- |
| `AGENTHIVE_CONTROL_DSN` | `databases.control` | — | Full DSN for `hiveCentral` control-plane pool |
| `CONTROL_DB_HOST` | `databases.control.host` | `127.0.0.1` | Control DB hostname |
| `CONTROL_DB_PORT` | `databases.control.port` | `6432` | Control DB port (PgBouncer) |
| `CONTROL_DB_NAME` | `databases.control.name` | `hiveControl` | Control DB name |
| `CONTROL_DB_ROLE` | `databases.control.role` | `agenthive_admin` | Control DB role |
| `CONTROL_DB_PASSWORD_REF` | `databases.control.password_ref` | `vault://file/control/db_password` | Vault ref (not the password itself) |

`AGENTHIVE_CONTROL_DSN` uses `assembleFromYaml` to build the DSN from individual
`databases.control.*` keys when no explicit env override is set. See pool-registry for
DSN-flip detection on cutover (P518).

#### Endpoints and paths

| Key | yamlPath | Description |
| :--- | :--- | :--- |
| `AGENTHIVE_MCP_URL` | `mcp.url` | MCP server endpoint URL (env override; DB fallback via P787 `control_runtime_service`) |
| `AGENTHIVE_DAEMON_URL` | `daemon.url` | Daemon endpoint URL (env override; DB fallback via P787 `control_runtime_service`) |
| `PROJECT_ROOT` | `project.project_root` | AgentHive project root directory |
| `AGENTHIVE_WORKTREE_ROOT` | `paths.worktree_root` | Git worktree root directory |
| `AGENTHIVE_HOST` | — (env only) | Logical host identifier (shared operator host name) |

#### Vault (P496)

| Key | yamlPath | Default | Description |
| :--- | :--- | :--- | :--- |
| `AGENTHIVE_VAULT_ROOT` | `vault.root` | `/etc/agenthive/secrets` | Vault file root directory |
| `AGENTHIVE_VAULT_KIND` | `vault.kind` | `file` | Vault adapter: `file`, `aws`, or `gcp` |

#### Pool tuning (P497)

| Key | Default | Description |
| :--- | :--- | :--- |
| `AGENTHIVE_TENANT_POOL_LRU_MAX` | `16` | Max cached tenant pools (LRU eviction) |
| `AGENTHIVE_TENANT_POOL_MAX` | `8` | Max connections per tenant pool |
| `AGENTHIVE_DRAIN_TIMEOUT_MS` | `30000` | Pool drain grace period (ms) |
| `AGENTHIVE_PG_PORT` | `6432` | PostgreSQL direct port (P499) |
| `AGENTHIVE_LISTEN_PORT` | `5432` | LISTEN bypass port (P499) |

### RegistryKeys

Backed by `hiveCentral` control tables. Resolved via `key.dbTable` + `key.dbColumn`.

| Key | Backing table | Description |
| :--- | :--- | :--- |
| `AGENTHIVE_DEFAULT_PROVIDER` | `control_model.model_route` | Default model provider |
| `PROJECT_SCHEMA_NAME` | `control_project.project` | Project database schema name |
| `PROJECT_TOKEN_BUDGET` | `core.runtime_flag` | Project token budget (USD ceiling) |
| `PROJECT_MAX_CONCURRENT_LEASES` | `core.runtime_flag` | Concurrency cap per project |
| `PROJECT_DEFAULT_WORKFLOW` | `core.runtime_flag` | Default workflow type |
| `PROJECT_SPENDING_THRESHOLD_WARN` | `core.runtime_flag` | Spending warning threshold |
| `PROJECT_SPENDING_THRESHOLD_HARD` | `core.runtime_flag` | Spending hard limit |
| `PROJECT_KB_EMBEDDING_MODEL` | `core.runtime_flag` | Knowledge-base embedding model (default: `text-embedding-3-small`) |
| `MODEL_CONTEXT_WINDOW` | `control_model.model` | Model context window (tokens) |
| `MODEL_COST_PER_INPUT_TOKEN` | `control_model.model` | Cost per million input tokens |
| `MODEL_COST_PER_OUTPUT_TOKEN` | `control_model.model` | Cost per million output tokens |
| `MODEL_MAX_SPEND_PER_CALL` | `control_model.host_model_policy` | Max spend per model call |
| `MODEL_PREFERRED_PROVIDER` | `control_model.model_route` | Preferred routing provider |
| `MODEL_FALLBACK_MODEL_ID` | `control_model.model_route` | Fallback model on routing failure |
| `MODEL_DEFAULT_TEMPERATURE` | `control_model.model_route` | Default model temperature |
| `MODEL_ALLOWED_HOST_POLICY` | `control_model.host_model_policy` | Allowed host policy |

### FlagKeys

Live-reloadable via `pg_notify runtime_config_changed`. Backed by `core.runtime_flag`.

| Key | Description |
| :--- | :--- |
| `USE_OFFER_DISPATCH` | Enable offer-dispatch workflow |
| `ENABLE_MULTI_TENANT` | Enable multi-tenant mode |
| `ENABLE_AUDIT_LOG` | Enable audit logging |

### DiagnosticKeys

Env-only diagnostic switches (class `secret` or `structural`).

| Key | Description |
| :--- | :--- |
| `DEBUG` | Enable debug logging |
| `DEBUG_PG` | Enable PostgreSQL debug logging |
| `DEBUG_STATE_NAMES` | Enable state-names registry debug |

---

## Tenant DSN Access Pattern

Tenant databases are accessed through the P497 pool registry, **not** via `config.get()`.

```typescript
// WRONG — throws RuntimeConfigInvalidSource
const pool = await config.get(SomeTenantDsnKey);

// CORRECT via config module (records audit entry)
const pool = await config.getProjectDb("my-project");   // slug or numeric id

// CORRECT directly from pool-registry
import { getProjectDb } from "src/postgres/pool-registry";
const pool = await getProjectDb("my-project");
```

Every `config.getProjectDb(slug)` call records a synthetic audit entry under `tenant_dsn:<slug>`.
This appears in the `tenantDsn` array of `getAuditSnapshot()`.

---

## Audit Snapshot

```typescript
interface ConfigAuditSnapshot {
  config: ConfigAuditEntry[];        // config keys accessed this process
  tenantDsn: TenantDsnAuditEntry[];  // tenant pool lookups
}

interface ConfigAuditEntry {
  keyName: string;
  keyClass: ConfigClass;
  lastAccessedAt: Date;
  source: "env" | "yaml" | "db" | "default";
  accessCount: number;
}
```

Available via:
- `mcp_ops action=config_audit` (MCP surface)
- `import { getAuditSnapshot } from "src/shared/runtime/config"` (direct)

---

## Vault / Secrets Strategy

AI agents can emit cleartext passwords anywhere they see them. The layered defence:

| Layer | Mechanism | Status |
| :---: | :--- | :--- |
| 0 | `SecretKeys` class — env/vault only; never yaml, DB, or logs | **live** |
| 1 | `~/.pgpass` (chmod 600) — libpq reads automatically; no password in CLI args | **live** |
| 2 | `~/.pg_service.conf` named connections (`PGSERVICE=agenthive2`) — no host/port/db in commands | **live** |
| 3 | `pass` (GPG-encrypted `~/.password-store/`) — encrypted at rest | medium-term |
| 4 | HashiCorp Vault / AWS Secrets Manager — `AGENTHIVE_VAULT_KIND=file|aws|gcp` | production |

Vault `SecretRef` format: `vault://file/<path>`, `vault://hcv/<path>`, `vault://aws/<name>`.
The **path** (a `structural` key) lives in config; the **secret value** never does.

**Convention (enforced in CONVENTIONS.md §19):**  
Agents must never generate `psql` commands with `-W password` or connection strings containing
credentials. CI enforces this via grep scan.

---

## pg_notify Channels

| Channel | Source | Consumer |
| :--- | :--- | :--- |
| `runtime_config_changed` | DB trigger on `core.runtime_flag` write | `ConfigResolver.setupNotifyListener()` — clears `cache` + `dbCache` on notification |
| `runtime_endpoint_changed` | DB trigger on `core.control_runtime_service` write | `src/shared/runtime/endpoints.ts` — clears endpoint URL cache |

> **Note:** The P474 design doc refers to `runtime_flag_changed` as the flag-reload channel, but the implementation uses `runtime_config_changed` (see `config.ts:231`). Use `runtime_config_changed` in all DB trigger definitions and tooling.

---

## CI Enforcement

Two complementary layers:

### ESLint plugin (`eslint-plugin-config-discipline`)

- Forbids `process.env.X` outside `src/shared/runtime/config.ts` and `*.test.ts`
- Flags string literals matching `/\/data\/code\//` or `/:6420|:6421|:3001/`

### Bash pre-commit hook (`scripts/ci/check-hardcoded.sh`)

```bash
grep -rn '/data/code/' src/ scripts/ --include='*.ts' | grep -v '.test.ts'
grep -rn ':6420\|:6421\|:3001' src/ --include='*.ts' | grep -v 'config-keys.ts'
grep -rn '8\.8\.8\.8' src/ --include='*.ts'
grep -rn 'psql.*-W\|psql.*--password' scripts/ deploy/
```

Also available standalone as `scripts/ci-env-check.sh`.

---

## Error Types

| Error class | When thrown |
| :--- | :--- |
| `RuntimeConfigMissing` | Required key not resolved in any source |
| `RuntimeConfigInvalidSource` | Key read from disallowed source: `secret` from yaml/DB; `tenant_dsn` via `get()` |
| `RuntimeConfigValidationFailed` | `key.validate()` rejected the resolved value |
| `RuntimeConfigMutationForbidden` | `set()` called by actor without sufficient `mutationAuthority` (Phase 3) |
| `ProjectIdMissing` | Scoped `registry`/`flag` lookup attempted without a `project_id` |

---

## `roadmap.yaml` Shape

```yaml
database:
  host: 127.0.0.1
  port: 5432
  name: agenthive
  user: agenthive_admin
  schema: roadmap
  pgpass_path: ~/.pgpass    # optional; default ~/.pgpass

databases:
  control:
    host: 127.0.0.1
    port: 6432              # PgBouncer
    name: hiveControl
    role: agenthive_admin
    password_ref: vault://file/control/db_password   # NOT the password

mcp:
  url: http://127.0.0.1:6421/sse

daemon:
  url: http://127.0.0.1:6420

project:
  project_root: /data/code/AgentHive

paths:
  worktree_root: /data/code/worktree

vault:
  kind: file                # file | aws | gcp
  root: /etc/agenthive/secrets

pools:
  tenant_lru_max: 16
  tenant_max: 8
  drain_timeout_ms: 30000
```

---

## Phased Delivery

| Phase | Scope | Status |
| :--- | :--- | :--- |
| 1 | `SecretKeys` + `StructuralKeys`, no DB; CI hook; `pool.ts` literal removal | complete |
| 2 | `RegistryKeys` + `FlagKeys` against `hiveCentral core.runtime_flag`; LISTEN `runtime_flag_changed` | complete |
| 3 | Mutation surface + `core.config_mutation_log`; security gate required before merge | deferred to separate proposal |

---

## Control Pool DSN-Flip (P518)

`getControlPool()` in pool-registry reads `process.env.AGENTHIVE_CONTROL_DSN` on every call.
When the value changes after a `P518` migration, the old pool drains asynchronously and a new
pool is built — no process restart required. This enables zero-downtime control-plane cutover.

---

## Runtime Endpoint Resolution (P787)

MCP and daemon URLs follow a specialised two-level resolution path in
`src/shared/runtime/endpoints.ts` that is separate from the config resolver hierarchy:

1. **Env** — `MCP_URL` or `AGENTHIVE_MCP_URL` (checked first, always wins)
2. **DB** — `roadmap.control_runtime_service WHERE service_key = 'mcp' AND lifecycle_status = 'active'`
3. **Throw** — `AgentHiveConfigError` with actionable message

Env overrides are checked synchronously; the DB lookup requires `await`. New callers
should use `getMcpUrlAsync()` / `getDaemonUrlAsync()` to gain DB-fallback resolution.
Sync helpers (`getMcpUrl()` / `getDaemonUrl()`) remain available for contexts that
cannot `await`, but they are env-only by design.

Cache invalidation is live: an `AFTER UPDATE` trigger fires
`pg_notify('runtime_endpoint_changed', ...)` and running processes clear their
in-process cache without a restart.

See `docs/architecture/runtime-endpoint-resolution.md` for the full design.

---

## Known Issues

- **Duplicate key definitions in `config-keys.ts`:** `AGENTHIVE_TENANT_POOL_LRU_MAX`, `AGENTHIVE_TENANT_POOL_MAX`, and `AGENTHIVE_DRAIN_TIMEOUT_MS` are declared twice in `StructuralKeys` (lines ~320–366 and ~421–467). TypeScript silently takes the last definition. The second set (with `Math.trunc` validation and `envOverride: true`) is canonical. A cleanup proposal should deduplicate these.
- **`RuntimeConfigValidationFailed` and `RuntimeConfigMutationForbidden` not yet thrown:** These error classes are defined in the proposal spec and documented in the Error Types table but are not yet instantiated in the current `config.ts` implementation. Phase 3 mutation surface will activate them.

---

## Out of Scope (P474)

- Web dashboard UI for config mutation — P387
- Full Vault/AWS Secrets Manager integration — P496+
- Feature-flag provider swap (LaunchDarkly) — future
- Mutation audit log `core.config_mutation_log` — Phase 3 (separate proposal)
