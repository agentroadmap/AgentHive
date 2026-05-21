/**
 * P497: Connection pool registry.
 *
 * Public API:
 *   getControlPool()         — singleton control-plane pool (DSN-change detection)
 *   getProjectDb(slugOrId)   — LRU-cached tenant pool with promise deduplication
 *   evictProject(slugOrId)   — drain + remove a tenant pool
 *   poolStats()              — current PoolStatsSnapshot
 *   shutdown()               — ordered drain (tenants → control)
 *   pingProject(slug)        — test connectivity
 *   setVault(v)              — inject vault implementation (default: env-var read)
 *   resetForTesting()        — hard-reset all state; only for test isolation
 */

import { Client, Pool } from "pg";
import { agentContextStorage } from "../shared/identity/agent-context";
import { PoolAccessDenied } from "../infra/postgres/pool";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_LRU_MAX = 16;

// Mirror the search path that infra/postgres/pool.ts sets, so callers that
// switch from getPool() → getControlPool() see the same schema resolution.
const CONTROL_SEARCH_PATH =
  "roadmap_proposal,roadmap_workforce,roadmap_efficiency,roadmap,public";
const DEFAULT_POOL_MAX_CONTROL = 10;
const DEFAULT_POOL_MAX_TENANT = 8;
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_STMT_TIMEOUT_MS = 30_000;
const DEFAULT_CONN_TIMEOUT_MS = 5_000;

const RETRY_BACKOFF_SEQUENCE_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

// ── Eviction reasons ──────────────────────────────────────────────────────────

type EvictionReason = "lru" | "idle" | "stale" | "shutdown";

// ── Error classes ─────────────────────────────────────────────────────────────

export class ProjectNotRegistered extends Error {
  constructor(public readonly slugOrId: string | number) {
    super(
      String(slugOrId) === "hiveControl"
        ? "hiveControl is the control plane; use getControlPool() not getProjectDb()"
        : `Project not found in registry: ${slugOrId}`,
    );
    this.name = "ProjectNotRegistered";
    Object.setPrototypeOf(this, ProjectNotRegistered.prototype);
  }
}

export class RegistryUnavailable extends Error {
  constructor(public readonly cause: Error) {
    super(`hiveControl registry is unavailable: ${cause.message}`);
    this.name = "RegistryUnavailable";
    Object.setPrototypeOf(this, RegistryUnavailable.prototype);
  }
}

export class TenantSecretUnavailable extends Error {
  constructor(
    public readonly ref: string,
    public readonly cause: Error,
  ) {
    super(`Vault secret unavailable for ref "${ref}": ${cause.message}`);
    this.name = "TenantSecretUnavailable";
    Object.setPrototypeOf(this, TenantSecretUnavailable.prototype);
  }
}

export class TenantDbUnreachable extends Error {
  constructor(
    public readonly slug: string,
    public readonly dsnHost: string,
    public readonly cause: Error,
  ) {
    super(
      `Tenant DB unreachable for "${slug}" at ${dsnHost}: ${cause.message}`,
    );
    this.name = "TenantDbUnreachable";
    Object.setPrototypeOf(this, TenantDbUnreachable.prototype);
  }
}

export class DsnFormatInvalid extends Error {
  constructor(public readonly ref: string) {
    super(`Vault ref "${ref}" returned a value that is not a valid postgres DSN`);
    this.name = "DsnFormatInvalid";
    Object.setPrototypeOf(this, DsnFormatInvalid.prototype);
  }
}

export class PoolExhausted extends Error {
  constructor(
    public readonly poolName: string,
    public readonly max: number,
  ) {
    super(`Pool "${poolName}" is exhausted (max=${max})`);
    this.name = "PoolExhausted";
    Object.setPrototypeOf(this, PoolExhausted.prototype);
  }
}

// ── Metrics types ─────────────────────────────────────────────────────────────

interface PoolCounters {
  hits: number;
  misses: number;
  evictions: number;
  create_failures: number;
  create_retries: number;
  drain_timeouts: number;
}

function makeCounters(): PoolCounters {
  return {
    hits: 0,
    misses: 0,
    evictions: 0,
    create_failures: 0,
    create_retries: 0,
    drain_timeouts: 0,
  };
}

export interface PoolStatsEntry {
  name: string;
  source: "control" | "project";
  hits: number;
  misses: number;
  evictions: number;
  create_failures: number;
  create_retries: number;
  active_connections: number;
  idle_connections: number;
  drain_timeouts: number;
}

export interface PoolStatsSnapshot {
  timestamp: string;
  pools: PoolStatsEntry[];
  total_active_pools: number;
}

// ── Vault interface ───────────────────────────────────────────────────────────

export interface VaultInterface {
  read(secretRef: string): Promise<string>;
}

// Default vault: resolves DSN from process.env by ref name.
// Replace via setVault() when P496 (real vault) lands.
const envVault: VaultInterface = {
  async read(ref: string): Promise<string> {
    const val = process.env[ref];
    if (!val) {
      throw new TenantSecretUnavailable(
        ref,
        new Error(`environment variable "${ref}" is not set`),
      );
    }
    return val;
  },
};

let _vault: VaultInterface = envVault;

export function setVault(v: VaultInterface): void {
  _vault = v;
}

function getVault(): VaultInterface {
  return _vault;
}

// ── Internal pool entry ───────────────────────────────────────────────────────

interface PoolEntry {
  pool: Pool;
  counters: PoolCounters;
  name: string;
  source: "control" | "project";
  lastUsedAt: number;
  draining: boolean;
}

// ── Global counters (survive pool eviction + re-creation) ─────────────────────

const _globalCounters = new Map<string, PoolCounters>();

function getOrMakeCounters(name: string): PoolCounters {
  let c = _globalCounters.get(name);
  if (!c) {
    c = makeCounters();
    _globalCounters.set(name, c);
  }
  return c;
}

// ── Registry row shape ────────────────────────────────────────────────────────

interface RegistryRow {
  slug: string;
  project_id: number;
  dsn_secret_ref: string;
  pool_max?: number | null;
  idle_ms?: number | null;
  stmt_timeout_ms?: number | null;
}

// ── Drain utility ─────────────────────────────────────────────────────────────

async function drainPool(entry: PoolEntry, reason: EvictionReason): Promise<void> {
  if (entry.draining) return;
  entry.draining = true;
  entry.counters.evictions++;

  let timedOut = false;
  const drainTimeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      timedOut = true;
      resolve();
    }, DEFAULT_DRAIN_TIMEOUT_MS);
    if (typeof (t as any).unref === "function") (t as any).unref();
  });

  await Promise.race([
    entry.pool.end().catch((err) => {
      if (!timedOut) {
        console.error(
          `[pool-registry] Drain error for "${entry.name}" (${reason}):`,
          (err as Error).message,
        );
      }
    }),
    drainTimeout,
  ]);

  if (timedOut) {
    entry.counters.drain_timeouts++;
    console.warn(
      `[pool-registry] Drain timeout for pool "${entry.name}" (${reason}); force-closing.`,
    );
  }
}

// ── Control pool ──────────────────────────────────────────────────────────────

function readControlDsnSignature(): string {
  if (process.env.AGENTHIVE_CONTROL_DSN) return process.env.AGENTHIVE_CONTROL_DSN;
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = process.env.PGPORT ?? "5432";
  const user = process.env.PGUSER ?? "xiaomi";
  const database = process.env.PGDATABASE ?? "agenthive";
  return `${user}@${host}:${port}/${database}`;
}

function buildControlPool(): Pool {
  const password = process.env.PGPASSWORD;
  if (!password) {
    throw new Error(
      "[pool-registry] PGPASSWORD is required for getControlPool(). " +
        "Set PGPASSWORD before starting.",
    );
  }

  const searchPathOptions = `-c search_path=${CONTROL_SEARCH_PATH}`;

  // When AGENTHIVE_CONTROL_DSN is set (P518 cutover), use it as a connection string.
  if (process.env.AGENTHIVE_CONTROL_DSN) {
    return new Pool({
      connectionString: process.env.AGENTHIVE_CONTROL_DSN,
      options: searchPathOptions,
      max: DEFAULT_POOL_MAX_CONTROL,
      idleTimeoutMillis: DEFAULT_IDLE_MS,
      connectionTimeoutMillis: DEFAULT_CONN_TIMEOUT_MS,
      statement_timeout: DEFAULT_STMT_TIMEOUT_MS,
      allowExitOnIdle: true,
    });
  }

  return new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "xiaomi",
    database: process.env.PGDATABASE ?? "agenthive",
    password,
    options: searchPathOptions,
    max: DEFAULT_POOL_MAX_CONTROL,
    idleTimeoutMillis: DEFAULT_IDLE_MS,
    connectionTimeoutMillis: DEFAULT_CONN_TIMEOUT_MS,
    statement_timeout: DEFAULT_STMT_TIMEOUT_MS,
    allowExitOnIdle: true,
  });
}

let _controlEntry: PoolEntry | null = null;
let _controlDsnSig: string | null = null;

/**
 * Returns the singleton control-plane pool.
 *
 * The DSN signature is re-read from env on every call so that a
 * CONTROL_DSN env-var flip (P518 cutover) is detected without restart.
 * When the signature changes, the old pool is drained asynchronously
 * and a fresh pool is built.
 */
export function getControlPool(): Pool {
  const sig = readControlDsnSignature();

  if (_controlEntry && _controlDsnSig !== sig) {
    const old = _controlEntry;
    _controlEntry = null;
    _controlDsnSig = null;
    void drainPool(old, "shutdown").catch(() => {});
  }

  if (!_controlEntry) {
    const pool = buildControlPool();
    pool.on("error", (err) => {
      console.error("[pool-registry] Control pool error:", err.message);
    });
    _controlEntry = {
      pool,
      counters: getOrMakeCounters("control"),
      name: "control",
      source: "control",
      lastUsedAt: Date.now(),
      draining: false,
    };
    _controlDsnSig = sig;
  }

  _controlEntry.counters.hits++;
  _controlEntry.lastUsedAt = Date.now();
  return _controlEntry.pool;
}

// ── Tenant pool LRU (Map preserves insertion order; oldest = first) ───────────

const _tenantPools = new Map<string, PoolEntry>();
const _inflightCreates = new Map<string, Promise<Pool>>();

let _idleEvictionTimer: ReturnType<typeof setInterval> | null = null;

function getLruMax(): number {
  const val = process.env.AGENTHIVE_TENANT_POOL_LRU_MAX;
  if (val) {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return DEFAULT_LRU_MAX;
}

function startIdleEvictionTimer(): void {
  if (_idleEvictionTimer) return;
  const halfIdle = Math.floor(DEFAULT_IDLE_MS / 2);
  _idleEvictionTimer = setInterval(async () => {
    const now = Date.now();
    for (const [key, entry] of _tenantPools) {
      if (
        !entry.draining &&
        entry.pool.idleCount === entry.pool.totalCount &&
        now - entry.lastUsedAt > DEFAULT_IDLE_MS
      ) {
        _tenantPools.delete(key);
        void drainPool(entry, "idle").catch(() => {});
      }
    }
  }, halfIdle);

  if (typeof (_idleEvictionTimer as any).unref === "function") {
    (_idleEvictionTimer as any).unref();
  }
}

// ── LISTEN connection for stale-registry eviction ────────────────────────────
// Must use a direct pg.Client (NOT PgBouncer transaction-mode — LISTEN is
// not supported by transaction-mode poolers; see P499).

let _listenClient: Client | null = null;

async function ensureListenConnection(): Promise<void> {
  if (_listenClient) return;

  // PGPORT_DIRECT overrides PgBouncer port when P499 is deployed.
  const host = process.env.PGHOST ?? "127.0.0.1";
  const port = Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432);

  const client = new Client({
    host,
    port,
    user: process.env.PGUSER ?? "xiaomi",
    database: process.env.PGDATABASE ?? "agenthive",
    password: process.env.PGPASSWORD,
    keepAlive: true,
  });

  try {
    await client.connect();
    await client.query("LISTEN pool_evict");

    client.on("notification", (msg) => {
      if (msg.channel !== "pool_evict" || !msg.payload) return;
      try {
        const data = JSON.parse(msg.payload) as {
          slug?: string;
          project_id?: number;
        };
        const key =
          data.slug ??
          (data.project_id !== undefined ? String(data.project_id) : null);
        if (key) {
          void evictProject(key).catch((err) => {
            console.error(
              `[pool-registry] Auto-evict error for "${key}":`,
              (err as Error).message,
            );
          });
        }
      } catch {
        // Malformed payload — ignore
      }
    });

    client.on("error", (err) => {
      console.error("[pool-registry] LISTEN client error:", err.message);
      _listenClient = null;
      const t = setTimeout(
        () => void ensureListenConnection().catch(() => {}),
        5_000,
      );
      if (typeof (t as any).unref === "function") (t as any).unref();
    });

    client.on("end", () => {
      _listenClient = null;
    });

    _listenClient = client;
  } catch (err) {
    console.error(
      "[pool-registry] Failed to establish LISTEN connection:",
      (err as Error).message,
    );
    void client.end().catch(() => {});
  }
}

// ── Tenant pool creation ──────────────────────────────────────────────────────

function isFatalError(err: unknown): boolean {
  return (
    err instanceof ProjectNotRegistered ||
    err instanceof DsnFormatInvalid
  );
}

function isTransientVaultError(err: TenantSecretUnavailable): boolean {
  const cause = err.cause as NodeJS.ErrnoException | undefined;
  return cause?.code === "ECONNREFUSED" || cause?.code === "ETIMEDOUT";
}

function isTransient(err: unknown): boolean {
  if (isFatalError(err)) return false;
  if (err instanceof TenantSecretUnavailable) return isTransientVaultError(err);
  if (err instanceof TenantDbUnreachable) return true;
  if (err instanceof RegistryUnavailable) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as any).unref === "function") (t as any).unref();
  });
}

async function createTenantPoolOnce(canonical: string): Promise<Pool> {
  // Query hiveControl for the project registry row
  let row: RegistryRow;
  try {
    const ctrl = getControlPool();
    const result = await ctrl.query<RegistryRow>(
      `SELECT slug,
              project_id,
              dsn_secret_ref,
              pool_max,
              idle_ms,
              stmt_timeout_ms
         FROM roadmap.project
        WHERE slug = $1
           OR project_id::text = $1
        LIMIT 1`,
      [canonical],
    );
    if (!result.rows[0]) throw new ProjectNotRegistered(canonical);
    row = result.rows[0];
  } catch (err) {
    if (err instanceof ProjectNotRegistered) throw err;
    throw new RegistryUnavailable(err as Error);
  }

  // Resolve DSN from vault
  let dsn: string;
  try {
    dsn = await getVault().read(row.dsn_secret_ref);
  } catch (err) {
    if (err instanceof TenantSecretUnavailable) throw err;
    throw new TenantSecretUnavailable(row.dsn_secret_ref, err as Error);
  }

  // Validate DSN format (fatal — do not retry)
  let dsnHost: string;
  try {
    const parsed = new URL(dsn);
    if (
      parsed.protocol !== "postgres:" &&
      parsed.protocol !== "postgresql:"
    ) {
      throw new Error("not a postgres URL");
    }
    dsnHost = parsed.hostname;
  } catch {
    throw new DsnFormatInvalid(row.dsn_secret_ref);
  }

  const poolMax = row.pool_max ?? DEFAULT_POOL_MAX_TENANT;
  const idleMs = row.idle_ms ?? DEFAULT_IDLE_MS;
  const stmtTimeout = row.stmt_timeout_ms ?? DEFAULT_STMT_TIMEOUT_MS;

  const pool = new Pool({
    connectionString: dsn,
    max: poolMax,
    idleTimeoutMillis: idleMs,
    connectionTimeoutMillis: DEFAULT_CONN_TIMEOUT_MS,
    statement_timeout: stmtTimeout,
    allowExitOnIdle: true,
  });

  // Verify connectivity before caching
  try {
    const client = await pool.connect();
    client.release();
  } catch (err) {
    void pool.end().catch(() => {});
    throw new TenantDbUnreachable(canonical, dsnHost, err as Error);
  }

  pool.on("error", (err) => {
    console.error(
      `[pool-registry] Tenant pool error for "${canonical}":`,
      err.message,
    );
  });

  return pool;
}

async function createTenantPool(canonical: string): Promise<Pool> {
  const counters = getOrMakeCounters(canonical);
  counters.misses++;

  let totalBackoffMs = 0;
  let lastErr: unknown;

  for (let i = 0; i <= RETRY_BACKOFF_SEQUENCE_MS.length; i++) {
    try {
      const pool = await createTenantPoolOnce(canonical);

      // Enforce LRU cap before inserting
      const lruMax = getLruMax();
      if (_tenantPools.size >= lruMax) {
        const [oldestKey, oldestEntry] = _tenantPools
          .entries()
          .next().value as [string, PoolEntry];
        _tenantPools.delete(oldestKey);
        void drainPool(oldestEntry, "lru").catch(() => {});
      }

      const entry: PoolEntry = {
        pool,
        counters,
        name: canonical,
        source: "project",
        lastUsedAt: Date.now(),
        draining: false,
      };
      _tenantPools.set(canonical, entry);

      startIdleEvictionTimer();
      void ensureListenConnection().catch(() => {});

      return pool;
    } catch (err) {
      lastErr = err;

      // Fatal errors: throw immediately, no retry, no caching
      if (isFatalError(err)) throw err;

      const backoffMs = RETRY_BACKOFF_SEQUENCE_MS[i];
      if (backoffMs === undefined || totalBackoffMs + backoffMs > 30_000) break;

      if (isTransient(err)) {
        counters.create_retries++;
        await sleep(backoffMs);
        totalBackoffMs += backoffMs;
      } else {
        break;
      }
    }
  }

  counters.create_failures++;
  throw lastErr;
}

// ── Pool Access Control (P844) ────────────────────────────────────────────────

/**
 * Check if an agent principal has a project role.
 * Uses the control pool to query agent_project_roles.
 */
async function checkAgentProjectRole(
  principalId: string,
  projectSlug: string,
): Promise<boolean> {
  try {
    const ctrlPool = await getControlPool();
    const result = await ctrlPool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM control_identity.agent_project_roles
         WHERE agent_principal_did = $1 AND project_slug = $2
       ) AS exists`,
      [principalId, projectSlug],
    );
    return result.rows[0]?.exists ?? false;
  } catch (err) {
    // If the role check itself fails (e.g., table doesn't exist during bootstrap),
    // deny access conservatively
    console.error(`[P844] checkAgentProjectRole failed:`, err);
    return false;
  }
}

/**
 * Write a pool access decision to the audit table.
 * Uses the control pool to avoid circular dependencies.
 * Failures are non-fatal — logging outages should not block access checks.
 */
async function writePoolAudit(
  principalId: string | null,
  projectSlug: string | null,
  result: "allowed" | "denied" | "bootstrap_passthrough",
  callSite: string,
): Promise<void> {
  try {
    const ctrlPool = await getControlPool();
    await ctrlPool.query(
      `INSERT INTO control_identity.pool_access_audit
         (principal_id, project_slug, result, call_site)
       VALUES ($1, $2, $3, $4)`,
      [principalId, projectSlug, result, callSite],
    );
  } catch {
    // Audit write failure is non-fatal — access decision proceeds
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a pool for the given project slug or numeric project_id.
 *
 * Concurrent calls for the same key share the in-flight create promise
 * (no duplicate pools created).  Fatal errors (ProjectNotRegistered,
 * DsnFormatInvalid) are NOT cached — the next call retries from scratch.
 */
export async function getProjectDb(slugOrId: string | number): Promise<Pool> {
  const canonical = String(slugOrId);

  // Recursion guard: hiveControl IS the control plane
  if (canonical === "hiveControl") {
    throw new ProjectNotRegistered("hiveControl");
  }

  // P844: Gate agent principal access to project DBs
  const ctx = agentContextStorage.getStore();
  if (ctx?.verified?.principal_kind === "agent") {
    // Agents must have an explicit project role
    const allowed = await checkAgentProjectRole(
      ctx.verified.principal_id,
      canonical,
    );
    await writePoolAudit(
      ctx.verified.principal_id,
      canonical,
      allowed ? "allowed" : "denied",
      "getProjectDb",
    );
    if (!allowed) {
      throw new PoolAccessDenied(ctx.verified.principal_id, canonical);
    }
  } else if (ctx?.verified) {
    // Non-agent principals (operator/agency) are allowed with audit
    await writePoolAudit(
      ctx.verified.principal_id,
      canonical,
      "bootstrap_passthrough",
      "getProjectDb",
    );
  }

  // LRU hit — move to end (MRU position)
  const existing = _tenantPools.get(canonical);
  if (existing && !existing.draining) {
    _tenantPools.delete(canonical);
    _tenantPools.set(canonical, existing);
    existing.counters.hits++;
    existing.lastUsedAt = Date.now();
    return existing.pool;
  }

  // In-flight deduplication: concurrent callers share the same promise
  const inflight = _inflightCreates.get(canonical);
  if (inflight) return inflight;

  const createPromise = createTenantPool(canonical)
    .then((pool) => {
      _inflightCreates.delete(canonical);
      return pool;
    })
    .catch((err) => {
      _inflightCreates.delete(canonical);
      throw err;
    });

  _inflightCreates.set(canonical, createPromise);
  return createPromise;
}

/**
 * Drain and remove a tenant pool.  No-op if the pool is not cached.
 */
export async function evictProject(slugOrId: string | number): Promise<void> {
  const canonical = String(slugOrId);
  _inflightCreates.delete(canonical);

  const entry = _tenantPools.get(canonical);
  if (!entry) return;

  _tenantPools.delete(canonical);
  await drainPool(entry, "stale");
}

/**
 * Snapshot of in-process pool metrics.
 * Counters are cumulative since process start (survive eviction/re-creation).
 */
export function poolStats(): PoolStatsSnapshot {
  const pools: PoolStatsEntry[] = [];

  if (_controlEntry) {
    pools.push({
      name: "control",
      source: "control",
      hits: _controlEntry.counters.hits,
      misses: _controlEntry.counters.misses,
      evictions: _controlEntry.counters.evictions,
      create_failures: _controlEntry.counters.create_failures,
      create_retries: _controlEntry.counters.create_retries,
      active_connections:
        _controlEntry.pool.totalCount - _controlEntry.pool.idleCount,
      idle_connections: _controlEntry.pool.idleCount,
      drain_timeouts: _controlEntry.counters.drain_timeouts,
    });
  }

  for (const [name, entry] of _tenantPools) {
    pools.push({
      name,
      source: "project",
      hits: entry.counters.hits,
      misses: entry.counters.misses,
      evictions: entry.counters.evictions,
      create_failures: entry.counters.create_failures,
      create_retries: entry.counters.create_retries,
      active_connections: entry.pool.totalCount - entry.pool.idleCount,
      idle_connections: entry.pool.idleCount,
      drain_timeouts: entry.counters.drain_timeouts,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    pools,
    total_active_pools: (_controlEntry ? 1 : 0) + _tenantPools.size,
  };
}

/**
 * Test if a tenant DB is reachable.  Returns false on any error.
 */
export async function pingProject(slug: string): Promise<boolean> {
  try {
    const pool = await getProjectDb(slug);
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Ordered shutdown:
 *   1. Stop idle-eviction timer
 *   2. Drain tenant pools in parallel (30 s grace each)
 *   3. Close LISTEN client
 *   4. Drain control pool last
 *   5. Emit final stats to stderr
 */
export async function shutdown(): Promise<void> {
  // 1. Stop idle-eviction timer
  if (_idleEvictionTimer) {
    clearInterval(_idleEvictionTimer);
    _idleEvictionTimer = null;
  }

  // 2. Drain all tenant pools in parallel
  const tenantDrains: Promise<void>[] = [];
  for (const [key, entry] of _tenantPools) {
    _tenantPools.delete(key);
    tenantDrains.push(drainPool(entry, "shutdown").catch(() => {}));
  }
  await Promise.all(tenantDrains);

  // 3. Close LISTEN client
  if (_listenClient) {
    try {
      await _listenClient.query("UNLISTEN pool_evict");
      await _listenClient.end();
    } catch {
      // Ignore errors during shutdown
    }
    _listenClient = null;
  }

  // 4. Drain control pool last (tenant drain may have issued registry queries)
  if (_controlEntry) {
    const ctrl = _controlEntry;
    _controlEntry = null;
    _controlDsnSig = null;
    await drainPool(ctrl, "shutdown").catch(() => {});
  }

  // 5. Final snapshot to logs
  console.info(
    "[pool-registry] shutdown complete. final stats:",
    JSON.stringify(poolStats()),
  );

  _globalCounters.clear();
}

/**
 * Hard-reset all module state.  ONLY call from test setup/teardown.
 * Drains all pools before clearing state.
 */
export async function resetForTesting(opts?: {
  vault?: VaultInterface;
}): Promise<void> {
  await shutdown().catch(() => {});
  _globalCounters.clear();
  _inflightCreates.clear();
  _vault = opts?.vault ?? envVault;
}

/**
 * Non-fatal connectivity probe for the agentHive2 (V2) DB.
 * Called at server startup when AGENTHIVE_V2_DB_URL is set (P826).
 * Resolves the residual export gap documented in P826 "Known gap" note.
 */
export async function verifyAgentHive2Connection(schema?: string): Promise<void> {
  const dsn = process.env.AGENTHIVE_V2_DB_URL;
  if (!dsn) return;
  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    if (schema) {
      await client.query(
        `SET search_path TO "${schema.replace(/"/g, '""')}",public`,
      );
    }
    await client.query("SELECT 1");
    console.info(
      `[pool-registry] agentHive2 connection verified (schema: ${schema ?? "default"})`,
    );
  } catch (err) {
    console.warn(
      `[pool-registry] agentHive2 connection failed: ${(err as Error).message}`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}
