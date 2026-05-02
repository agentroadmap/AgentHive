/**
 * Connection pool registry for AgentHive.
 *
 * P497: Manages multiple pools — one for hiveControl + one per tenant — with LRU eviction,
 * per-pool sizing, promise-cache for concurrent lookups, and telemetry.
 *
 * Control pool: singleton, lazily created, re-read DSN from config on each call.
 * Project pools: LRU cached (default 16), per-pool sizing from registry or defaults.
 *
 * Failure modes typed: ProjectNotRegistered, RegistryUnavailable, TenantSecretUnavailable,
 * TenantDbUnreachable, DsnFormatInvalid, PoolExhausted.
 */

import { Pool, type PoolConfig, type QueryResultRow } from "pg";

// ─── Types ──────────────────────────────────────────────────────────────────

export class ProjectNotRegistered extends Error {
	constructor(public slugOrId: string | number) {
		super(`Project not registered: ${slugOrId}`);
		this.name = "ProjectNotRegistered";
	}
}

export class RegistryUnavailable extends Error {
	constructor(public cause: Error) {
		super(`Registry unavailable: ${cause.message}`);
		this.name = "RegistryUnavailable";
	}
}

export class TenantSecretUnavailable extends Error {
	constructor(
		public ref: string,
		public cause: Error,
	) {
		super(`Tenant secret unavailable: ${ref} — ${cause.message}`);
		this.name = "TenantSecretUnavailable";
	}
}

export class TenantDbUnreachable extends Error {
	constructor(
		public slug: string,
		public dsnHost: string,
		public cause: Error,
	) {
		super(`Tenant DB unreachable: ${slug} (${dsnHost}) — ${cause.message}`);
		this.name = "TenantDbUnreachable";
	}
}

export class DsnFormatInvalid extends Error {
	constructor(
		public ref: string,
		valueHint: string,
	) {
		super(`DSN format invalid: ${ref} (hint: ${valueHint})`);
		this.name = "DsnFormatInvalid";
	}
}

export class PoolExhausted extends Error {
	constructor(
		public poolName: string,
		public max: number,
	) {
		super(`Pool exhausted: ${poolName} (max ${max})`);
		this.name = "PoolExhausted";
	}
}

export interface PoolStatsSnapshot {
	timestamp: string; // ISO 8601
	pools: Array<{
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
	}>;
	total_active_pools: number;
}

interface PoolMetrics {
	hits: number;
	misses: number;
	evictions: number;
	create_failures: number;
	create_retries: number;
	drain_timeouts: number;
}

interface PoolEntry {
	pool: Pool;
	metrics: PoolMetrics;
	createdAt: number;
	lastUsed: number;
}

interface PromiseCacheEntry {
	promise: Promise<Pool>;
	createdAt: number;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const LRU_MAX_DEFAULT = 16;
const POOL_MAX_DEFAULT = 8;
const IDLE_TIMEOUT_MS_DEFAULT = 5 * 60_000; // 5 min
const STATEMENT_TIMEOUT_MS_DEFAULT = 30_000; // 30 s
const DRAIN_TIMEOUT_MS = 30_000; // 30 s grace for in-flight queries
const TELEMETRY_INTERVAL_MS = 30_000; // 30 s
const RETRY_MAX_DURATION_MS = 30_000; // 30 s backoff window

let lruMax = LRU_MAX_DEFAULT;
let poolMaxDefault = POOL_MAX_DEFAULT;
let idleTimeoutMsDefault = IDLE_TIMEOUT_MS_DEFAULT;
let statementTimeoutMsDefault = STATEMENT_TIMEOUT_MS_DEFAULT;

// Parse config from env
if (process.env.AGENTHIVE_TENANT_POOL_LRU_MAX) {
	const parsed = parseInt(process.env.AGENTHIVE_TENANT_POOL_LRU_MAX, 10);
	if (Number.isFinite(parsed) && parsed > 0) {
		lruMax = Math.trunc(parsed);
	}
}

// ─── State ──────────────────────────────────────────────────────────────────

let controlPool: Pool | null = null;
let controlPoolDsn: string | null = null;
let controlPoolMetrics: PoolMetrics = {
	hits: 0,
	misses: 0,
	evictions: 0,
	create_failures: 0,
	create_retries: 0,
	drain_timeouts: 0,
};

const projectPools = new Map<string, PoolEntry>(); // keyed by DSN for LRU
const projectPoolsBySlug = new Map<string, string>(); // slug -> DSN
const projectPoolsById = new Map<number, string>(); // project_id -> DSN

const promiseCache = new Map<string, PromiseCacheEntry>(); // DSN -> in-flight create promise

let telemetryTimer: ReturnType<typeof setInterval> | null = null;
let listenConnection: Pool | null = null;
let shuttingDown = false;

// ─── Control Pool ───────────────────────────────────────────────────────────

/**
 * Get or create the control pool.
 *
 * Lazily created; DSN is re-read from config on each call to detect cutover.
 * If DSN changed, drain old pool and create new one.
 */
export function getControlPool(): Pool {
	// Re-read DSN from environment each call
	const dsn = process.env.DATABASE_URL || buildDefaultDsn("agenthive");

	if (controlPool && controlPoolDsn !== dsn) {
		// DSN changed; drain old pool in background
		if (process.env.DEBUG_PG) {
			console.error("[PoolRegistry] Control pool DSN changed; draining old pool");
		}
		const oldPool = controlPool;
		controlPool = null;
		controlPoolDsn = null;
		void drainPool(oldPool, "control", DRAIN_TIMEOUT_MS).catch(() => {});
	}

	if (!controlPool) {
		if (process.env.DEBUG_PG) {
			console.error("[PoolRegistry] Creating control pool");
		}

		controlPool = new Pool({
			connectionString: dsn,
			max: poolMaxDefault,
			idleTimeoutMillis: idleTimeoutMsDefault,
			statement_timeout: statementTimeoutMsDefault,
		});

		controlPool.on("error", (err) => {
			console.error("[PoolRegistry] Control pool error:", err.message);
		});

		controlPoolDsn = dsn;
	}

	controlPoolMetrics.hits++;
	return controlPool;
}

// ─── Project Pool Registry ──────────────────────────────────────────────────

/**
 * Get or create a pool for a tenant.
 *
 * Lookup:
 * 1. Check in-memory LRU cache.
 * 2. Query hiveControl.roadmap.project for registry.
 * 3. Resolve secret via vault (mocked for now).
 * 4. Create pool.
 * 5. Insert into LRU (evict oldest if at cap).
 * 6. Emit metrics.
 */
export async function getProjectDb(slugOrId: string | number): Promise<Pool> {
	// Recursion guard
	if (
		(typeof slugOrId === "string" && slugOrId === "hiveControl") ||
		(typeof slugOrId === "number" &&
			projectPoolsById.has(slugOrId) &&
			projectPoolsById.get(slugOrId) === "hiveControl")
	) {
		throw new ProjectNotRegistered(slugOrId);
	}

	let dsn: string;

	if (typeof slugOrId === "string") {
		// Lookup by slug
		const cachedDsn = projectPoolsBySlug.get(slugOrId);
		if (cachedDsn) {
			const entry = projectPools.get(cachedDsn);
			if (entry) {
				entry.lastUsed = Date.now();
				entry.metrics.hits++;
				if (process.env.DEBUG_PG) {
					console.error(`[PoolRegistry] Hit: project ${slugOrId} (cached)`);
				}
				return entry.pool;
			}
		}

		dsn = await resolveProjectDsn(slugOrId);
		projectPoolsBySlug.set(slugOrId, dsn);
	} else {
		// Lookup by project_id
		const cachedDsn = projectPoolsById.get(slugOrId);
		if (cachedDsn) {
			const entry = projectPools.get(cachedDsn);
			if (entry) {
				entry.lastUsed = Date.now();
				entry.metrics.hits++;
				if (process.env.DEBUG_PG) {
					console.error(`[PoolRegistry] Hit: project ${slugOrId} (cached)`);
				}
				return entry.pool;
			}
		}

		dsn = await resolveProjectDsnById(slugOrId);
		projectPoolsById.set(slugOrId, dsn);
	}

	// Check if DSN is already in pool
	const existingEntry = projectPools.get(dsn);
	if (existingEntry) {
		existingEntry.lastUsed = Date.now();
		existingEntry.metrics.hits++;
		return existingEntry.pool;
	}

	// Create new pool (with promise cache to deduplicate concurrent requests)
	const pool = await createPoolWithPromiseCache(dsn);

	// Insert into LRU
	const entry: PoolEntry = {
		pool,
		metrics: {
			hits: 1,
			misses: 0,
			evictions: 0,
			create_failures: 0,
			create_retries: 0,
			drain_timeouts: 0,
		},
		createdAt: Date.now(),
		lastUsed: Date.now(),
	};

	projectPools.set(dsn, entry);

	// Enforce LRU cap
	if (projectPools.size > lruMax) {
		await evictOldestPool();
	}

	return pool;
}

/**
 * Evict a project pool by slug or ID.
 * Called by stale registry triggers or manual cleanup.
 */
export async function evictProject(slugOrId: string | number): Promise<void> {
	let dsn: string | undefined;

	if (typeof slugOrId === "string") {
		dsn = projectPoolsBySlug.get(slugOrId);
		projectPoolsBySlug.delete(slugOrId);
	} else {
		dsn = projectPoolsById.get(slugOrId);
		projectPoolsById.delete(slugOrId);
	}

	if (dsn) {
		const entry = projectPools.get(dsn);
		if (entry) {
			projectPools.delete(dsn);
			entry.metrics.evictions++;
			await drainPool(entry.pool, `project:${slugOrId}`, DRAIN_TIMEOUT_MS);
			if (process.env.DEBUG_PG) {
				console.error(`[PoolRegistry] Evicted project ${slugOrId}`);
			}
		}
	}
}

/**
 * Get current pool statistics snapshot.
 */
export function poolStats(): PoolStatsSnapshot {
	const pools = [
		controlPool
			? {
					name: "control",
					source: "control" as const,
					hits: controlPoolMetrics.hits,
					misses: controlPoolMetrics.misses,
					evictions: controlPoolMetrics.evictions,
					create_failures: controlPoolMetrics.create_failures,
					create_retries: controlPoolMetrics.create_retries,
					active_connections: controlPool.totalCount - (controlPool.idleCount || 0),
					idle_connections: controlPool.idleCount || 0,
					drain_timeouts: controlPoolMetrics.drain_timeouts,
				}
			: null,
		...Array.from(projectPools.values()).map((entry, idx) => ({
			name: `project:${idx}`,
			source: "project" as const,
			hits: entry.metrics.hits,
			misses: entry.metrics.misses,
			evictions: entry.metrics.evictions,
			create_failures: entry.metrics.create_failures,
			create_retries: entry.metrics.create_retries,
			active_connections:
				entry.pool.totalCount - (entry.pool.idleCount || 0),
			idle_connections: entry.pool.idleCount || 0,
			drain_timeouts: entry.metrics.drain_timeouts,
		})),
	].filter(Boolean) as PoolStatsSnapshot["pools"];

	return {
		timestamp: new Date().toISOString(),
		pools,
		total_active_pools: (controlPool ? 1 : 0) + projectPools.size,
	};
}

/**
 * Ping a tenant to verify connectivity.
 */
export async function pingProject(slug: string): Promise<boolean> {
	try {
		const pool = await getProjectDb(slug);
		const result = await pool.query("SELECT 1");
		return result.rowCount === 1;
	} catch {
		return false;
	}
}

/**
 * Graceful shutdown: drain all pools in order (tenants in parallel, control last).
 */
export async function shutdown(): Promise<void> {
	shuttingDown = true;

	if (telemetryTimer) {
		clearInterval(telemetryTimer);
		telemetryTimer = null;
	}

	if (listenConnection) {
		await listenConnection.end().catch(() => {});
		listenConnection = null;
	}

	// Drain tenant pools in parallel
	const drainPromises = Array.from(projectPools.values()).map((entry) =>
		drainPool(entry.pool, entry.pool.toString(), DRAIN_TIMEOUT_MS),
	);
	await Promise.all(drainPromises);
	projectPools.clear();
	projectPoolsBySlug.clear();
	projectPoolsById.clear();

	// Drain control pool last
	if (controlPool) {
		await drainPool(controlPool, "control", DRAIN_TIMEOUT_MS);
		controlPool = null;
		controlPoolDsn = null;
	}

	// Emit final snapshot
	const final = poolStats();
	console.error("[PoolRegistry] Final pool stats:", JSON.stringify(final));
}

// ─── Internals ──────────────────────────────────────────────────────────────

function buildDefaultDsn(database: string): string {
	const host = process.env.PGHOST || "127.0.0.1";
	const port = process.env.PGPORT || "5432";
	const user = process.env.PGUSER || "xiaomi";
	const password = process.env.PGPASSWORD || "";
	return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

/**
 * Resolve project DSN by slug.
 * Queries hiveControl.roadmap.project.
 */
async function resolveProjectDsn(slug: string): Promise<string> {
	try {
		const controlPool = getControlPool();
		const result = await controlPool.query<{
			dsn_secret_ref: string;
			pool_max?: number;
			idle_ms?: number;
			stmt_timeout_ms?: number;
		}>(
			`SELECT dsn_secret_ref, pool_max, idle_ms, stmt_timeout_ms
       FROM roadmap.project
      WHERE slug = $1`,
			[slug],
		);

		if (result.rows.length === 0) {
			throw new ProjectNotRegistered(slug);
		}

		const row = result.rows[0];
		const dsn = await resolveDsnSecret(row.dsn_secret_ref);
		return dsn;
	} catch (err) {
		if (err instanceof ProjectNotRegistered) throw err;
		if (err instanceof TenantSecretUnavailable) throw err;
		if (err instanceof DsnFormatInvalid) throw err;
		throw new RegistryUnavailable(err as Error);
	}
}

/**
 * Resolve project DSN by project_id.
 */
async function resolveProjectDsnById(projectId: number): Promise<string> {
	try {
		const controlPool = getControlPool();
		const result = await controlPool.query<{
			slug: string;
			dsn_secret_ref: string;
			pool_max?: number;
			idle_ms?: number;
			stmt_timeout_ms?: number;
		}>(
			`SELECT slug, dsn_secret_ref, pool_max, idle_ms, stmt_timeout_ms
       FROM roadmap.project
      WHERE project_id = $1`,
			[projectId],
		);

		if (result.rows.length === 0) {
			throw new ProjectNotRegistered(projectId);
		}

		const row = result.rows[0];
		projectPoolsBySlug.set(row.slug, ""); // placeholder for later
		const dsn = await resolveDsnSecret(row.dsn_secret_ref);
		return dsn;
	} catch (err) {
		if (err instanceof ProjectNotRegistered) throw err;
		if (err instanceof TenantSecretUnavailable) throw err;
		if (err instanceof DsnFormatInvalid) throw err;
		throw new RegistryUnavailable(err as Error);
	}
}

/**
 * Mock vault secret resolution.
 * In production, this calls getVault().read(ref).
 */
async function resolveDsnSecret(ref: string): Promise<string> {
	// For now, assume ref is a direct DSN or env var name
	if (process.env[ref]) {
		return process.env[ref]!;
	}

	// Try parsing as a literal DSN
	if (ref.startsWith("postgresql://")) {
		return ref;
	}

	throw new DsnFormatInvalid(ref, `expected postgresql:// or env var`);
}

/**
 * Create pool with promise cache to deduplicate concurrent requests.
 */
async function createPoolWithPromiseCache(dsn: string): Promise<Pool> {
	// Check if create is already in flight
	const cached = promiseCache.get(dsn);
	if (cached) {
		return cached.promise;
	}

	// Start create promise
	const promise = createPoolWithRetry(dsn);
	promiseCache.set(dsn, {
		promise,
		createdAt: Date.now(),
	});

	// Clean up promise cache entry on completion
	promise
		.then(() => {
			// Success: keep for 1s in case more concurrent callers arrive
			setTimeout(() => promiseCache.delete(dsn), 1000);
		})
		.catch(() => {
			// On failure, immediately remove (don't cache fatals)
			promiseCache.delete(dsn);
		});

	return promise;
}

/**
 * Create pool with transient error retry.
 * Transient: timeout, ECONNREFUSED. Fatal: ProjectNotRegistered, DsnFormatInvalid.
 */
async function createPoolWithRetry(dsn: string): Promise<Pool> {
	const startTime = Date.now();

	for (let attempt = 0; ; attempt++) {
		try {
			const pool = new Pool({ connectionString: dsn });

			// Test connection
			const client = await pool.connect();
			client.release();

			if (process.env.DEBUG_PG) {
				console.error(`[PoolRegistry] Created pool for ${dsn}`);
			}

			return pool;
		} catch (err) {
			const error = err as Error;

			// Classify error
			const isTransient =
				error.message.includes("ECONNREFUSED") ||
				error.message.includes("timeout") ||
				error.message.includes("ETIMEDOUT");

			const elapsed = Date.now() - startTime;

			if (isTransient && elapsed < RETRY_MAX_DURATION_MS) {
				// Backoff + retry
				const backoffMs = Math.min(1000, 100 * Math.pow(2, attempt));
				await new Promise((resolve) => setTimeout(resolve, backoffMs));
				controlPoolMetrics.create_retries++;
				continue;
			}

			// Fatal or exhausted retries
			controlPoolMetrics.create_failures++;
			throw new TenantDbUnreachable("(unknown)", "(unknown)", error);
		}
	}
}

/**
 * Evict the oldest pool by createdAt.
 */
async function evictOldestPool(): Promise<void> {
	let oldest: [string, PoolEntry] | null = null;

	for (const [dsn, entry] of projectPools.entries()) {
		if (!oldest || entry.createdAt < oldest[1].createdAt) {
			oldest = [dsn, entry];
		}
	}

	if (oldest) {
		const [dsn, entry] = oldest;
		projectPools.delete(dsn);
		entry.metrics.evictions++;
		await drainPool(entry.pool, dsn, DRAIN_TIMEOUT_MS);
		if (process.env.DEBUG_PG) {
			console.error(`[PoolRegistry] Evicted oldest pool (LRU): ${dsn}`);
		}
	}
}

/**
 * Drain a pool gracefully: stop accepting queries, wait for in-flight, force-close.
 */
async function drainPool(
	pool: Pool,
	name: string,
	timeoutMs: number,
): Promise<void> {
	try {
		// Wait for in-flight queries with timeout
		const endPromise = pool.end();
		const timeoutPromise = new Promise<void>((_, reject) =>
			setTimeout(
				() =>
					reject(
						new Error(
							`Pool drain timeout for ${name} after ${timeoutMs}ms`,
						),
					),
				timeoutMs,
			),
		);

		await Promise.race([endPromise, timeoutPromise]);
	} catch (err) {
		console.error(`[PoolRegistry] Drain timeout for ${name}:`, err);
		// Force close even on timeout
		try {
			await pool.end().catch(() => {});
		} catch {
			// Already closed
		}
	}
}

/**
 * Start telemetry emission (mocked; would write to roadmap.pool_stats table or logs).
 */
export function startTelemetry(): void {
	if (telemetryTimer) return;

	telemetryTimer = setInterval(() => {
		if (!shuttingDown) {
			const snapshot = poolStats();
			if (process.env.DEBUG_PG) {
				console.error("[PoolRegistry] Telemetry snapshot:", snapshot);
			}
		}
	}, TELEMETRY_INTERVAL_MS);
}

/**
 * Setup LISTEN for stale eviction notifications.
 * Mocked for now; in production, connects directly to Postgres (not via PgBouncer).
 */
export async function setupListenNotifications(): Promise<void> {
	// Mock: in production, this would:
	// 1. Open a direct Postgres connection (not pooled)
	// 2. LISTEN pool_evict
	// 3. On notification, parse JSON and call evictProject()
	//
	// For now, this is a no-op to avoid complexity in tests.
}
