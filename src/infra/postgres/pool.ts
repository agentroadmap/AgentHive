/**
 * Postgres connection pool for AgentHive.
 *
 * Config precedence (highest first):
 * 1. Explicit PoolConfig passed to getPool()
 * 2. ~/.pgpass (via ConfigResolver.resolvePasswordSync)
 * 3. Environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)
 * 4. DATABASE_URL
 *
 * Connections default to the AgentHive domain search path:
 * roadmap_proposal, roadmap_workforce, roadmap_efficiency, roadmap, public.
 *
 * Pool connections use timeout safeguards:
 *   - connectionTimeoutMillis: 5 s (configurable via PG_CONNECTION_TIMEOUT_MS)
 *   - query_timeout: 30 s (configurable via PG_QUERY_TIMEOUT_MS)
 *   - statement_timeout: 30 s (configurable via PG_STATEMENT_TIMEOUT_MS)
 * So failures surface as thrown errors, not silent hangs.
 *
 * SECURITY: Only the environment variable is used at pool creation time.
 * No passwords are hardcoded.
 */

import {
	Client,
	Pool,
	type PoolClient,
	type PoolConfig,
	type QueryResult,
	type QueryResultRow,
} from "pg";
export type { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow };
import { agentContextStorage } from "../../shared/identity/agent-context.ts";
import { ConfigResolver } from "../../shared/runtime/config.ts";
import { StructuralKeys } from "../../shared/runtime/config-keys.ts";
import { AgentHiveConfigError } from "../../shared/runtime/endpoints.ts";

let pool: Pool | null = null;
let configuredSchema: string | null = null;
let poolSignature: string | null = null;
type PoolLifecycleMode = "long-running" | "one-shot";

let poolLifecycleMode: PoolLifecycleMode | null = null;
let allowPoolEndDepth = 0;
let poolWatchdogTimer: ReturnType<typeof setInterval> | null = null;
const originalPoolEnd = Symbol("agenthive.originalPoolEnd");

type GuardedPool = Pool & {
	[originalPoolEnd]?: Pool["end"];
};

export function setPoolLifecycleMode(mode: PoolLifecycleMode): void {
	poolLifecycleMode = mode;
	if (pool) installPoolEndGuard(pool);
}

export function getPoolLifecycleMode(): PoolLifecycleMode | null {
	return poolLifecycleMode;
}

function isLongRunningPoolMode(): boolean {
	return poolLifecycleMode === "long-running";
}

function installPoolEndGuard(target: Pool): void {
	const guarded = target as GuardedPool;
	if (guarded[originalPoolEnd]) return;

	const end = target.end.bind(target);
	guarded[originalPoolEnd] = end;
	target.end = (async () => {
		if (isLongRunningPoolMode() && allowPoolEndDepth === 0) {
			const stack = new Error().stack ?? "stack unavailable";
			console.error(
				"[PG] Ignored pool.end() in long-running pool lifecycle mode. " +
					"Use closePool() during process shutdown.\n" +
					stack,
			);
			return;
		}
		return end();
	}) as Pool["end"];
}

async function endPoolBypassingGuard(target: Pool): Promise<void> {
	const guarded = target as GuardedPool;
	const end = guarded[originalPoolEnd]?.bind(target) ?? target.end.bind(target);
	allowPoolEndDepth++;
	try {
		await end();
	} finally {
		allowPoolEndDepth--;
	}
}

function poolPoisonedMessage(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Cannot use a pool after calling end");
}

async function publishPoolPoisonedEvent(
	serviceName: string,
	error: unknown,
): Promise<void> {
	const resolvedConfig = resolvePoolConfig();
	const client = new Client({
		host: resolvedConfig.host,
		port: Number(process.env.PGPORT_DIRECT ?? resolvedConfig.port),
		user: resolvedConfig.user,
		password: resolvedConfig.password,
		database: resolvedConfig.database,
		options: resolvedConfig.options,
		connectionTimeoutMillis: resolvedConfig.connectionTimeoutMillis,
		statement_timeout: resolvedConfig.statementTimeoutMillis,
		application_name: `${serviceName}-pool-watchdog`,
	});
	try {
		await client.connect();
		const payload = JSON.stringify({
			event_type: "pool_poisoned",
			service: serviceName,
			service_name: serviceName,
			message: error instanceof Error ? error.message : String(error),
			observed_at: new Date().toISOString(),
		});
		await client.query("SELECT pg_notify($1, $2)", ["control_feed", payload]);
		await client.query("SELECT pg_notify($1, $2)", [
			"agent_lifecycle_events",
			payload,
		]);
	} finally {
		await client.end().catch(() => {});
	}
}

export function startPoolPoisonWatchdog(
	serviceName: string,
	intervalMs = 60_000,
): void {
	if (poolWatchdogTimer) return;
	poolWatchdogTimer = setInterval(() => {
		void query("SELECT 1").catch((error) => {
			if (!poolPoisonedMessage(error)) return;
			console.error(
				`[PG] Pool poisoned in ${serviceName}:`,
				error instanceof Error ? error.message : error,
			);
			void publishPoolPoisonedEvent(serviceName, error).catch((publishError) => {
				console.error(
					"[PG] Failed to publish pool_poisoned event:",
					publishError instanceof Error ? publishError.message : publishError,
				);
			});
		});
	}, intervalMs);
	poolWatchdogTimer.unref?.();
}

export function stopPoolPoisonWatchdog(): void {
	if (!poolWatchdogTimer) return;
	clearInterval(poolWatchdogTimer);
	poolWatchdogTimer = null;
}

// Build search path from structural config
// Default: ["roadmap_proposal", "roadmap_workforce", "roadmap_efficiency", "roadmap", "public"]
// But can be overridden via PG_SCHEMA env or config if needed
function getDefaultSearchPath(): string[] {
	// For Phase 1, keep the hardcoded default; Phase 2 can parameterize via ConfigResolver
	return [
		"roadmap_proposal",
		"roadmap_workforce",
		"roadmap_efficiency",
		"roadmap",
		"public",
	];
}

const DEFAULT_SEARCH_PATH = getDefaultSearchPath();

type AgentHivePoolConfig = PoolConfig & {
	schema?: string | null;
};

type ResolvedPoolConfig = {
	host: string;
	port: number;
	user: string;
	password?: string;
	database: string;
	options?: string;
	schema: string | null;
	connectionTimeoutMillis: number;
	queryTimeoutMillis: number;
	statementTimeoutMillis: number;
	max: number;
	// P3564: prune idle sockets so a checkout after a Postgres/pgbouncer
	// restart doesn't return a dead socket ("Connection terminated due to
	// connection timeout").
	idleTimeoutMillis: number;
};

type ParsedDatabaseUrl = {
	host?: string;
	port?: number;
	user?: string;
	password?: string;
	database?: string;
};

function normalizeSchemaName(schema?: string | null): string | null {
	if (!schema) return null;
	const trimmed = schema.trim();
	if (!trimmed) return null;
	if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
		throw new Error(`[PG] Invalid schema name "${schema}".`);
	}
	return trimmed;
}

function buildSearchPathOptions(
	options: string | undefined,
	schema: string | null,
): string | undefined {
	const parts = [options?.trim()].filter(Boolean) as string[];
	const searchPath = schema
		? [schema, ...DEFAULT_SEARCH_PATH.filter((entry) => entry !== schema)]
		: DEFAULT_SEARCH_PATH;
	parts.push(`-c search_path=${searchPath.join(",")}`);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function parseDatabaseUrl(value?: string): ParsedDatabaseUrl {
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			host: url.hostname || undefined,
			port: url.port ? Number(url.port) : undefined,
			user: url.username || undefined,
			password: url.password || undefined,
			database: url.pathname.replace(/^\/+/, "") || undefined,
		};
	} catch {
		return {};
	}
}

function parsePositiveInteger(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

/**
 * Require a resolved PGUSER value or throw.
 *
 * P448 deprecation schedule:
 *   V1 (2026-Q2, this release): silent "xiaomi" fallback removed; throws with
 *     a deprecation warning in logs so operators see what needs fixing.
 *   V2 (2026-Q3): remove the console.warn — only the throw remains.
 *
 * Operators: set PGUSER (and PGHOST, PGDATABASE) in /etc/agenthive/env.
 * See scripts/systemd/env.template for a migration guide.
 */
function requirePgUser(resolved: string | undefined): string {
	if (resolved) return resolved;
	// V1: emit deprecation warning so the operator log captures it before the throw
	// V2 (2026-Q3, P448): remove the console.warn below, keep only the throw
	console.warn(
		"[PG] DEPRECATION (P448/V1): PGUSER is not set and the silent 'xiaomi' " +
			"fallback has been removed. Source /etc/agenthive/env before the next " +
			"service restart. This will be a hard error in 2026-Q3 (P448/V2).",
	);
	throw new AgentHiveConfigError(
		"[PG] PGUSER is required but not set. " +
			"Set PGUSER (and PGHOST, PGDATABASE) in /etc/agenthive/env. " +
			"See scripts/systemd/env.template for a migration guide.",
	);
}

function resolvePoolConfig(config?: AgentHivePoolConfig): ResolvedPoolConfig {
	const databaseUrlConfig = parseDatabaseUrl(process.env.DATABASE_URL);

	// Resolve connection coordinates first so we can pass them to pgpass lookup.
	const host =
		config?.host ??
		process.env.PGHOST ??
		databaseUrlConfig.host ??
		(StructuralKeys.PGHOST.defaultValue ?? "127.0.0.1");
	// P499: default to PgBouncer port (6432) so query clients go through the pooler.
	// LISTEN clients must set PGPORT_DIRECT=5432 (bypass) — handled in pool-registry.ts.
	const port =
		Number(config?.port ?? process.env.PGPORT ?? databaseUrlConfig.port) ||
		Number(process.env.AGENTHIVE_PG_PORT ?? 6432);
	const database =
		config?.database ??
		process.env.PGDATABASE ??
		databaseUrlConfig.database ??
		StructuralKeys.PGDATABASE.defaultValue ??
		"agenthive";

	// Live-DB guard: refuse to connect the node:test runner to the live "agenthive"
	// database. Integration/e2e/control tests write real rows (proposals, agencies,
	// registry, control-feed events) with no teardown and there is no reaper — a full
	// `npm test` run against live agenthive pollutes the control plane and false-wakes
	// the cold-wake liaison. Opt out explicitly with AGENTHIVE_ALLOW_LIVE_DB=1 for the
	// handful of tests that legitimately need the live DB.
	const inNodeTestRunner =
		process.env.NODE_TEST_CONTEXT != null ||
		process.execArgv.some((a) => a === "--test" || a.startsWith("--test")) ||
		process.argv.some((a) => a === "--test");
	if (
		inNodeTestRunner &&
		database === "agenthive" &&
		process.env.AGENTHIVE_ALLOW_LIVE_DB !== "1"
	) {
		throw new Error(
			'[pool] Refusing to connect the test runner to the LIVE database "agenthive". ' +
				"Tests must run against an isolated database (set PGDATABASE to a test DB), or " +
				"set AGENTHIVE_ALLOW_LIVE_DB=1 to explicitly override this guard.",
		);
	}

	const user = config?.user ?? process.env.PGUSER ?? databaseUrlConfig.user;

	const configuredPassword =
		typeof config?.password === "function" ? undefined : config?.password;

	// Password resolution: explicit config > ~/.pgpass > __PGPASSWORD_FROM_CONFIG.
	// ConfigResolver.resolvePasswordSync checks PGPASSWORD env first, then ~/.pgpass.
	const resolvedPassword =
		configuredPassword ??
		ConfigResolver.resolvePasswordSync({
			host,
			port: String(port),
			database: database ?? "agenthive",
			user: user ?? "",
		}) ??
		process.env.__PGPASSWORD_FROM_CONFIG;

	const schema = normalizeSchemaName(
		config?.schema ?? configuredSchema ?? process.env.PG_SCHEMA,
	);

	return {
		host,
		port,
		user: requirePgUser(user),
		password: resolvedPassword,
		database: database ?? StructuralKeys.PGDATABASE.defaultValue ?? "agenthive",
		options: buildSearchPathOptions(
			config?.options ?? process.env.PG_OPTIONS,
			schema,
		),
		schema,
		connectionTimeoutMillis: parsePositiveInteger(
			(config as PoolConfig | undefined)?.connectionTimeoutMillis ??
				process.env.PG_CONNECTION_TIMEOUT_MS,
			StructuralKeys.PG_CONNECTION_TIMEOUT_MS.defaultValue ?? 5000,
		),
		queryTimeoutMillis: parsePositiveInteger(
			(config as PoolConfig | undefined)?.query_timeout ??
				process.env.PG_QUERY_TIMEOUT_MS,
			StructuralKeys.PG_QUERY_TIMEOUT_MS.defaultValue ?? 30000,
		),
		statementTimeoutMillis: parsePositiveInteger(
			(config as PoolConfig | undefined)?.statement_timeout ??
				process.env.PG_STATEMENT_TIMEOUT_MS,
			StructuralKeys.PG_STATEMENT_TIMEOUT_MS.defaultValue ?? 30000,
		),
		// Pool size: pg-pool defaults to 10. Long-lived LISTEN clients
		// (state-names, orchestrator, websocket-server, feature-flag-service)
		// each pin a slot for the lifetime of the process, so 10 is razor-thin
		// — a couple of leaked LISTENs (cf. P522) and the pool is dead. Bump
		// the default to 30 and let ops override via PG_POOL_MAX. Defense in
		// depth alongside the per-listener leak fixes.
		max: parsePositiveInteger(
			(config as PoolConfig | undefined)?.max ?? process.env.PG_POOL_MAX,
			30,
		),
		// P3564: 30s idle reap. Long enough to keep warm connections for an
		// interactive TUI / busy service, short enough that sockets killed by a
		// DB bounce are pruned before the next checkout. Override with any
		// positive value via PG_POOL_IDLE_TIMEOUT_MS.
		idleTimeoutMillis: parsePositiveInteger(
			process.env.PG_POOL_IDLE_TIMEOUT_MS,
			30_000,
		),
	};
}

function getPoolSignature(config: ResolvedPoolConfig): string {
	return JSON.stringify({
		host: config.host,
		port: config.port,
		user: config.user,
		database: config.database,
		options: config.options ?? null,
		schema: config.schema,
		connectionTimeoutMillis: config.connectionTimeoutMillis,
		queryTimeoutMillis: config.queryTimeoutMillis,
		statementTimeoutMillis: config.statementTimeoutMillis,
		max: config.max,
	});
}

/**
 * Initialize the Postgres connection pool.
 *
 * @param config - Explicit PoolConfig (highest priority)
 * @returns A singleton Pg connection pool
 */
export function getPool(config?: AgentHivePoolConfig): Pool {
	const resolvedConfig = resolvePoolConfig(config);
	const nextSignature = getPoolSignature(resolvedConfig);
	configuredSchema = resolvedConfig.schema;

	if (pool && poolSignature !== nextSignature) {
		if (isLongRunningPoolMode()) {
			console.warn(
				`[PG] getPool() signature change refused in long-running mode; keeping existing pool. new=${nextSignature} current=${poolSignature}\n${new Error().stack}`,
			);
			return pool;
		}
		void endPoolBypassingGuard(pool).catch(() => {});
		pool = null;
		poolSignature = null;
	}

	if (!pool) {
		if (process.env.DEBUG_PG) {
			console.error(
				`[PG] Opening pool ${resolvedConfig.user}@${resolvedConfig.host}:${resolvedConfig.port}/${resolvedConfig.database} schema=${resolvedConfig.schema ?? "(default)"}`,
			);
		}
		pool = new Pool({
			host: resolvedConfig.host,
			port: resolvedConfig.port,
			user: resolvedConfig.user,
			password: resolvedConfig.password,
			database: resolvedConfig.database,
			options: resolvedConfig.options,
			connectionTimeoutMillis: resolvedConfig.connectionTimeoutMillis,
			query_timeout: resolvedConfig.queryTimeoutMillis,
			statement_timeout: resolvedConfig.statementTimeoutMillis,
			max: resolvedConfig.max,
			allowExitOnIdle: true,
			// P3564: TCP keepalive surfaces a dead peer (e.g. after a Postgres
			// restart) instead of blocking until connectionTimeoutMillis, and
			// idleTimeoutMillis reaps idle clients so the next checkout opens a
			// fresh socket rather than returning a stale one.
			keepAlive: true,
			keepAliveInitialDelayMillis: 10_000,
			idleTimeoutMillis: resolvedConfig.idleTimeoutMillis,
		});
		installPoolEndGuard(pool);
		poolSignature = nextSignature;

		pool.on("error", (err) => {
			console.error("[PG] Unexpected pool error:", err.message);
		});
	}
	return pool;
}

/**
 * Initialize pool from a parsed config object (e.g., from roadmap.yaml).
 * The password is passed via a dedicated env var to avoid storing it
 * anywhere on disk or in logs.
 */
export function initPoolFromConfig(dbConfig: Record<string, any>): Pool {
	if (dbConfig.password) {
		// Stage explicit config password for resolvePoolConfig to pick up.
		// Never stored in PGPASSWORD to avoid leaking into child processes.
		process.env.__PGPASSWORD_FROM_CONFIG = dbConfig.password;
	}

	configuredSchema = normalizeSchemaName(
		dbConfig.schema ?? process.env.PG_SCHEMA,
	);

	return getPool({
		host: dbConfig.host ?? process.env.PGHOST ?? "127.0.0.1",
		port: Number(dbConfig.port || process.env.PGPORT || 5432),
		user: requirePgUser(dbConfig.user ?? process.env.PGUSER),
		database: dbConfig.name ?? process.env.PGDATABASE,
		schema: configuredSchema,
	});
}

// ─── Pool Access Control (P844) ──────────────────────────────────────────────

/**
 * PoolAccessDenied error — thrown when an agent principal attempts unauthorized
 * pool access. MCP handlers catch this and return a redacted error message.
 */
export class PoolAccessDenied extends Error {
	constructor(principalId: string, projectSlug: string) {
		super(
			`[P844] Pool access denied: agent ${principalId} has no role for project ${projectSlug}`,
		);
		this.name = "PoolAccessDenied";
	}
}

/**
 * Internal query function that bypasses the agent-denial guard.
 * ONLY called by checkAgentProjectRole() and writePoolAudit().
 * Never exported; never called directly from application code.
 */
async function internalQuery<T extends QueryResultRow = any>(
	text: string,
	params?: any[],
): Promise<QueryResult<T>> {
	const client = getPool();
	return client.query<T>(text, params);
}

/**
 * Check if an agent principal has a project role.
 * Uses internalQuery to avoid circular denial.
 */
async function checkAgentProjectRole(
	principalId: string,
	projectSlug: string,
): Promise<boolean> {
	const result = await internalQuery<{ exists: boolean }>(
		`SELECT EXISTS(
       SELECT 1 FROM control_identity.agent_project_roles
       WHERE agent_principal_did = $1 AND project_slug = $2
     ) AS exists`,
		[principalId, projectSlug],
	);
	return result.rows[0]?.exists ?? false;
}

/**
 * Write a pool access decision to the audit table.
 * Uses internalQuery to avoid circular denial.
 * Failures are non-fatal — logging outages should not block access checks.
 */
async function writePoolAudit(
	principalId: string | null,
	projectSlug: string | null,
	result: "allowed" | "denied" | "bootstrap_passthrough",
	callSite: string,
): Promise<void> {
	try {
		await internalQuery(
			`INSERT INTO control_identity.pool_access_audit
         (principal_id, project_slug, result, call_site)
       VALUES ($1, $2, $3, $4)`,
			[principalId, projectSlug, result, callSite],
		);
	} catch {
		// Audit write failure is non-fatal — access decision proceeds
	}
}

/**
 * Execute a parameterised query. All queries use prepared statements — safe
 * against SQL injection as long as callers never interpolate user input
 * directly into the `text` parameter.
 *
 * P844: Gates agent principal access to hiveCentral.
 * - Agents are DENIED all access (reads and writes)
 * - Non-agent principals (operator, agency) are allowed with audit logging
 * - Unauthenticated callers (no agentContextStorage) bypass the guard
 */
export async function query<T extends QueryResultRow = any>(
	text: string,
	params?: any[],
): Promise<QueryResult<T>> {
	const ctx = agentContextStorage.getStore();

	// Agent principals are denied all access to the control plane
	if (ctx?.verified?.principal_kind === "agent") {
		await writePoolAudit(
			ctx.verified.principal_id,
			"hiveCentral",
			"denied",
			"query",
		);
		throw new PoolAccessDenied(ctx.verified.principal_id, "hiveCentral");
	}

	// Non-agent principals (operator/agency/bootstrap) are allowed
	if (ctx?.verified) {
		await writePoolAudit(
			ctx.verified.principal_id,
			"hiveCentral",
			"bootstrap_passthrough",
			"query",
		);
	}

	// Proceed with the query
	return internalQuery<T>(text, params);
}

/**
 * Close the pool gracefully — call during shutdown.
 *
 * P1123: in "long-running" mode this is a no-op (with stack-trace log). Long-
 * running services should never end the shared pool mid-process; doing so
 * poisons every downstream consumer (broadcastSnapshot, LISTEN reconnect,
 * TimeoutCron, ledger writes) for the rest of the process lifetime.
 */
export async function closePool(): Promise<void> {
	stopPoolPoisonWatchdog();
	if (pool) {
		await endPoolBypassingGuard(pool);
		pool = null;
		poolSignature = null;
	}
	configuredSchema = null;
}

// ─── PoolManager (P300) ──────────────────────────────────────────────────────

export interface ProjectConfig {
	id: number;
	name: string;
	db_name: string;
	git_root: string;
	discord_channel_id: string | null;
	db_host: string;
	db_port: number;
	db_user: string;
	is_active: boolean;
}

const DEFAULT_PROJECT_MAX = 3; // connections per project pool
const MAX_PROJECT_POOLS = 10; // max concurrent project pools
const IDLE_REAP_MS = 5 * 60_000; // 5 min idle reaping

/**
 * PoolManager — multi-project connection pool orchestrator.
 *
 * - metaPool: always points to the agenthive database (cross-project tables)
 * - projectPools: lazy-created per-project pools, keyed by project_id
 */
export class PoolManager {
	private projectPools: Map<number, Pool> = new Map();
	private projectConfigs: Map<number, ProjectConfig> = new Map();
	private _metaPool: Pool;
	private reapTimer: ReturnType<typeof setInterval> | null = null;
	private lastUsed: Map<number, number> = new Map();

	private constructor(metaPool: Pool) {
		this._metaPool = metaPool;
	}

	get metaPool(): Pool {
		return this._metaPool;
	}

	/**
	 * Bootstrap the PoolManager from environment / existing getPool().
	 * Reads roadmap_workforce.projects to discover registered projects.
	 */
	static async init(): Promise<PoolManager> {
		const mp = getPool();
		const pm = new PoolManager(mp);
		await pm.loadProjects();
		pm.startIdleReaping();
		return pm;
	}

	/**
	 * Reload project configs from DB. Call after adding/modifying projects.
	 */
	async loadProjects(): Promise<void> {
		const { rows } = await this._metaPool.query<ProjectConfig>(
			`SELECT id, name, db_name, git_root, discord_channel_id,
			        db_host, db_port, db_user, is_active
			   FROM roadmap_workforce.projects
			  WHERE is_active = true
			  ORDER BY id`,
		);
		this.projectConfigs.clear();
		for (const row of rows) {
			this.projectConfigs.set(row.id, row);
		}
	}

	/**
	 * Get a pool for the given project_id. Creates lazily.
	 * Falls back to metaPool for project_id=1 (default project shares agenthive DB).
	 */
	getPool(projectId: number): Pool {
		if (projectId === 1) {
			// Default project uses the same DB as metaPool
			return this._metaPool;
		}

		this.lastUsed.set(projectId, Date.now());

		if (this.projectPools.has(projectId)) {
			return this.projectPools.get(projectId)!;
		}

		const config = this.projectConfigs.get(projectId);
		if (!config) {
			throw new Error(
				`[PoolManager] Unknown project_id=${projectId}. ` +
					`Known: ${[...this.projectConfigs.keys()].join(", ") || "none"}. ` +
					`Run loadProjects() first or check roadmap_workforce.projects.`,
			);
		}

		if (this.projectPools.size >= MAX_PROJECT_POOLS) {
			throw new Error(
				`[PoolManager] Max project pools (${MAX_PROJECT_POOLS}) reached. ` +
					`Cannot create pool for project_id=${projectId}.`,
			);
		}

		const newPool = new Pool({
			host: config.db_host,
			port: config.db_port,
			database: config.db_name,
			user: config.db_user,
			password: ConfigResolver.resolvePasswordSync({
				host: config.db_host,
				port: String(config.db_port),
				database: config.db_name,
				user: config.db_user,
			}),
			max: DEFAULT_PROJECT_MAX,
			idleTimeoutMillis: IDLE_REAP_MS,
			allowExitOnIdle: true,
		});

		newPool.on("error", (err) => {
			console.error(
				`[PoolManager] Pool error for project ${projectId}:`,
				err.message,
			);
		});

		this.projectPools.set(projectId, newPool);

		if (process.env.DEBUG_PG) {
			console.error(
				`[PoolManager] Created pool for project ${projectId} ` +
					`(${config.db_user}@${config.db_host}:${config.db_port}/${config.db_name})`,
			);
		}

		return newPool;
	}

	/**
	 * Get project config by ID.
	 */
	getProjectConfig(projectId: number): ProjectConfig | undefined {
		return this.projectConfigs.get(projectId);
	}

	/**
	 * List all known project configs.
	 */
	listProjects(): ProjectConfig[] {
		return [...this.projectConfigs.values()];
	}

	/**
	 * Execute a query against a specific project's pool.
	 */
	async queryProject<T extends QueryResultRow = any>(
		projectId: number,
		text: string,
		params?: any[],
	): Promise<QueryResult<T>> {
		const p = this.getPool(projectId);
		return p.query<T>(text, params);
	}

	/**
	 * Execute a query against the meta pool (cross-project tables).
	 */
	async queryMeta<T extends QueryResultRow = any>(
		text: string,
		params?: any[],
	): Promise<QueryResult<T>> {
		return this._metaPool.query<T>(text, params);
	}

	/**
	 * Idle reaping: close project pools not used in the last IDLE_REAP_MS.
	 */
	private startIdleReaping(): void {
		this.reapTimer = setInterval(() => {
			const now = Date.now();
			for (const [id, lastSeen] of this.lastUsed) {
				if (now - lastSeen > IDLE_REAP_MS && this.projectPools.has(id)) {
					const p = this.projectPools.get(id)!;
					void p.end().catch(() => {});
					this.projectPools.delete(id);
					this.lastUsed.delete(id);
					if (process.env.DEBUG_PG) {
						console.error(`[PoolManager] Reaped idle pool for project ${id}`);
					}
				}
			}
		}, IDLE_REAP_MS);
	}

	/**
	 * Shutdown all pools gracefully.
	 */
	async close(): Promise<void> {
		if (this.reapTimer) {
			clearInterval(this.reapTimer);
			this.reapTimer = null;
		}
		for (const [, p] of this.projectPools) {
			await p.end().catch(() => {});
		}
		this.projectPools.clear();
		this.lastUsed.clear();
	}
}

// Singleton PoolManager instance (lazy-initialized)
let poolManager: PoolManager | null = null;

/**
 * Get or create the singleton PoolManager.
 */
export async function getPoolManager(): Promise<PoolManager> {
	if (!poolManager) {
		poolManager = await PoolManager.init();
	}
	return poolManager;
}
