/**
 * Postgres connection pool for AgentHive.
 *
 * Config precedence (highest first):
 * 1. Explicit PoolConfig passed to getPool()
 * 2. Environment variables (PG_HOST, PG_PORT, PG_USER, PG_PASSWORD, PG_DATABASE)
 * 3. DATABASE_URL
 *
 * Connections default to the AgentHive domain search path:
 * roadmap_proposal, roadmap_workforce, roadmap_efficiency, roadmap, public.
 *
 * For CLI contexts (no systemd env), PG_PASSWORD is loaded from:
 *   - Project root `.env` file
 *   - `~/.agenthive.env` file
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

// Attempt to load PG_PASSWORD from .env files if not set in environment
(function loadPGPassword() {
	if (process.env.PG_PASSWORD) return;
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
				const match = /^\s*PG_PASSWORD\s*=\s*(.+)/.exec(line);
				if (match) {
					process.env.PG_PASSWORD = match[1].trim();
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

const DEFAULT_SEARCH_PATH = [
	"roadmap_proposal",
	"roadmap_workforce",
	"roadmap_efficiency",
	"roadmap",
	"public",
];

type AgentHivePoolConfig = PoolConfig & {
	schema?: string | null;
};

type ResolvedPoolConfig = {
	host: string;
	port: number;
	user: string;
	password: string;
	database: string;
	options?: string;
	schema: string | null;
	connectionTimeoutMillis: number;
	queryTimeoutMillis: number;
	statementTimeoutMillis: number;
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

function resolvePoolConfig(config?: AgentHivePoolConfig): ResolvedPoolConfig {
	const databaseUrlConfig = parseDatabaseUrl(process.env.DATABASE_URL);
	const configuredPassword =
		typeof config?.password === "function" ? undefined : config?.password;

	const resolvedPassword =
		configuredPassword ??
		process.env.PG_PASSWORD ??
		databaseUrlConfig.password ??
		process.env.__PG_PASSWORD_FROM_CONFIG;

	if (!resolvedPassword) {
		throw new Error(
			"[PG] PG_PASSWORD environment variable is required. " +
				"Set PG_PASSWORD before starting the MCP server.",
		);
	}

	const schema = normalizeSchemaName(
		config?.schema ?? configuredSchema ?? process.env.PG_SCHEMA,
	);

	return {
		host:
			config?.host ??
			process.env.PG_HOST ??
			databaseUrlConfig.host ??
			"127.0.0.1",
		port:
			Number(config?.port ?? process.env.PG_PORT ?? databaseUrlConfig.port) ||
			5432,
		user:
			config?.user ?? process.env.PG_USER ?? databaseUrlConfig.user ?? "admin",
		password: resolvedPassword,
		database:
			config?.database ??
			process.env.PG_DATABASE ??
			databaseUrlConfig.database ??
			"agenthive",
		options: buildSearchPathOptions(
			config?.options ?? process.env.PG_OPTIONS,
			schema,
		),
		schema,
		connectionTimeoutMillis: parsePositiveInteger(
			(config as PoolConfig | undefined)?.connectionTimeoutMillis ??
				process.env.PG_CONNECTION_TIMEOUT_MS,
			5000,
		),
		queryTimeoutMillis: parsePositiveInteger(
			(config as PoolConfig | undefined)?.query_timeout ??
				process.env.PG_QUERY_TIMEOUT_MS,
			30000,
		),
		statementTimeoutMillis: parsePositiveInteger(
			(config as PoolConfig | undefined)?.statement_timeout ??
				process.env.PG_STATEMENT_TIMEOUT_MS,
			30000,
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
	if (dbConfig.password && !process.env.PG_PASSWORD) {
		// Transfer config password into env so the singleton getter sees it.
		// This prevents the password from being stored in the Pg Pool options
		// object (which could be leaked in logs or debug dumps).
		process.env.__PG_PASSWORD_FROM_CONFIG = dbConfig.password;
	}

	configuredSchema = normalizeSchemaName(
		dbConfig.schema ?? process.env.PG_SCHEMA,
	);

	return getPool({
		host: dbConfig.host ?? process.env.PG_HOST ?? "127.0.0.1",
		port: Number(dbConfig.port) ?? Number(process.env.PG_PORT) ?? 5432,
		user: dbConfig.user ?? process.env.PG_USER ?? "admin",
		password: process.env.PG_PASSWORD ?? process.env.__PG_PASSWORD_FROM_CONFIG,
		database: dbConfig.name ?? process.env.PG_DATABASE ?? "agenthive",
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
