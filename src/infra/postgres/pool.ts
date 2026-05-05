/**
 * Postgres connection pool for AgentHive.
 *
 * Config precedence (highest first):
 * 1. Explicit PoolConfig passed to getPool()
 * 2. Environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)
 * 3. DATABASE_URL
 *
 * Connections default to the AgentHive domain search path:
 * roadmap_proposal, roadmap_workforce, roadmap_efficiency, roadmap, public.
 *
 * For CLI contexts (no systemd env), PGPASSWORD is loaded from:
 *   - Project root `.env` file
 *   - Project root `.env.agent` file (worktree contexts)
 *   - `~/.agenthive.env` file
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

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	Pool,
	type PoolConfig,
	type QueryResult,
	type QueryResultRow,
} from "pg";
export type { Pool, PoolConfig, QueryResult, QueryResultRow };
import { StructuralKeys } from "../../shared/runtime/config-keys";
import { ConfigResolver } from "../../shared/runtime/config";
import { AgentHiveConfigError } from "../../shared/runtime/endpoints";

// Password resolution priority:
//   1. ~/.pgpass (ConfigResolver.resolvePasswordSync)
//   2. Existing PGPASSWORD env (set by caller / systemd)
//   3. .env files (for Docker/CI contexts without pgpass) — handled by fallback path
(function loadPGPassword() {
	const host = process.env.PGHOST ?? "127.0.0.1";
	const port = process.env.PGPORT ?? "5432";
	const database = process.env.PGDATABASE ?? "agenthive";
	const user = process.env.PGUSER ?? "admin";
	const pw = ConfigResolver.resolvePasswordSync({ host, port, database, user });
	if (pw !== undefined) {
		process.env.PGPASSWORD = pw;
		return;
	}
	// Fallback to .env file scanning for Docker/CI contexts
	if (process.env.PGPASSWORD) return;
	const candidates = [
		resolve(process.cwd(), ".env"),
		resolve(process.cwd(), ".env.agent"),
		join(process.env.HOME || "", ".agenthive.env"),
	];
	for (const envPath of candidates) {
		try {
			if (!existsSync(envPath)) continue;
			const content = readFileSync(envPath, "utf-8");
			for (const line of content.split("\n")) {
				const match = /^\s*PGPASSWORD\s*=\s*(.+)/.exec(line);
				if (match) {
					const value = match[1].trim();
					if (value === "***") continue; // skip sentinel, try next candidate
					process.env.PGPASSWORD = value;
					return;
				}
			}
		} catch {
			// fallthrough
		}
	}
})();

let pool: Pool | null = null;
let configuredSchema: string | null = normalizeSchemaName(
	process.env.PG_SCHEMA,
);
let poolSignature: string | null = null;

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
	const configuredPassword =
		typeof config?.password === "function" ? undefined : config?.password;

	const resolvedPassword =
		configuredPassword ??
		process.env.PGPASSWORD ??
		databaseUrlConfig.password ??
		process.env.__PGPASSWORD_FROM_CONFIG;

	const schema = normalizeSchemaName(
		config?.schema ?? configuredSchema ?? process.env.PG_SCHEMA,
	);

	return {
		host:
			config?.host ??
			process.env.PGHOST ??
			databaseUrlConfig.host ??
			(StructuralKeys.PGHOST.defaultValue ?? "127.0.0.1"),
		port:
			Number(config?.port ?? process.env.PGPORT ?? databaseUrlConfig.port) ||
			5432,
		user: requirePgUser(
			config?.user ?? process.env.PGUSER ?? databaseUrlConfig.user,
		),
		password: resolvedPassword,
		database:
			config?.database ??
			process.env.PGDATABASE ??
			databaseUrlConfig.database ??
			(StructuralKeys.PGDATABASE.defaultValue ?? "agenthive"),
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
		// (state-names, pipeline-cron, websocket-server, feature-flag-service)
		// each pin a slot for the lifetime of the process, so 10 is razor-thin
		// — a couple of leaked LISTENs (cf. P522) and the pool is dead. Bump
		// the default to 30 and let ops override via PG_POOL_MAX. Defense in
		// depth alongside the per-listener leak fixes.
		max: parsePositiveInteger(
			(config as PoolConfig | undefined)?.max ?? process.env.PG_POOL_MAX,
			30,
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
		void pool.end().catch(() => {});
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
		});
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
	if (dbConfig.password && !process.env.PGPASSWORD) {
		// Transfer config password into env so the singleton getter sees it.
		// This prevents the password from being stored in the Pg Pool options
		// object (which could be leaked in logs or debug dumps).
		process.env.__PGPASSWORD_FROM_CONFIG = dbConfig.password;
	}

	configuredSchema = normalizeSchemaName(
		dbConfig.schema ?? process.env.PG_SCHEMA,
	);

	return getPool({
		host: dbConfig.host ?? process.env.PGHOST ?? "127.0.0.1",
		port: Number(dbConfig.port || process.env.PGPORT || 5432),
		user: requirePgUser(dbConfig.user ?? process.env.PGUSER),
		password: process.env.PGPASSWORD ?? process.env.__PGPASSWORD_FROM_CONFIG,
		database: dbConfig.name ?? process.env.PGDATABASE,
		schema: configuredSchema,
	});
}

/**
 * Execute a parameterised query. All queries use prepared statements — safe
 * against SQL injection as long as callers never interpolate user input
 * directly into the `text` parameter.
 */
export async function query<T extends QueryResultRow = any>(
	text: string,
	params?: any[],
): Promise<QueryResult<T>> {
	const client = getPool();
	return client.query<T>(text, params);
}

/**
 * Close the pool gracefully — call during shutdown.
 */
export async function closePool(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
		poolSignature = null;
	}
	configuredSchema = normalizeSchemaName(process.env.PG_SCHEMA);
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

const DEFAULT_PROJECT_MAX = 3;    // connections per project pool
const MAX_PROJECT_POOLS = 10;     // max concurrent project pools
const IDLE_REAP_MS = 5 * 60_000;  // 5 min idle reaping

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
			  ORDER BY id`
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
				`Run loadProjects() first or check roadmap_workforce.projects.`
			);
		}

		if (this.projectPools.size >= MAX_PROJECT_POOLS) {
			throw new Error(
				`[PoolManager] Max project pools (${MAX_PROJECT_POOLS}) reached. ` +
				`Cannot create pool for project_id=${projectId}.`
			);
		}

		const newPool = new Pool({
			host: config.db_host,
			port: config.db_port,
			database: config.db_name,
			user: config.db_user,
			password: process.env.PGPASSWORD,
			max: DEFAULT_PROJECT_MAX,
			idleTimeoutMillis: IDLE_REAP_MS,
			allowExitOnIdle: true,
		});

		newPool.on("error", (err) => {
			console.error(`[PoolManager] Pool error for project ${projectId}:`, err.message);
		});

		this.projectPools.set(projectId, newPool);

		if (process.env.DEBUG_PG) {
			console.error(
				`[PoolManager] Created pool for project ${projectId} ` +
				`(${config.db_user}@${config.db_host}:${config.db_port}/${config.db_name})`
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
		params?: any[]
	): Promise<QueryResult<T>> {
		const p = this.getPool(projectId);
		return p.query<T>(text, params);
	}

	/**
	 * Execute a query against the meta pool (cross-project tables).
	 */
	async queryMeta<T extends QueryResultRow = any>(
		text: string,
		params?: any[]
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
