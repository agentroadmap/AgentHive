/**
 * Canonical configuration resolver with class-based source enforcement.
 *
 * Resolution order (immutable, enforced by class):
 * 1. Explicit override (constructor arg, CLI --flag)
 * 2. Process env var
 * 3. Process env file loaded at startup (/etc/agenthive/env) — promoted to env
 * 4. roadmap.yaml (structural defaults; file-level)
 * 5. Control DB registry (control_runtime.host, control_runtime.flags, etc.)
 * 6. Feature flag (when applicable; runtime_flag table)
 * 7. Throw RuntimeConfigMissing — no silent default
 *
 * Classification (CONSTRAINT, not suggestion — resolver must enforce):
 * - `secret`: env only (1–3) | PGPASSWORD, OAUTH_CLIENT_SECRET
 * - `structural`: yaml (4) with env override (1-3) | PGHOST, PGPORT, project_root
 * - `registry`: DB (5) with env override (1-3) | host_model_policy, model_routes
 * - `flag`: DB (6) | feature flags, cached per process
 * - `tenant_dsn`: pool-bound only; NEVER read via get()/getOptional() — use getProjectDb(slug)
 *
 * Usage:
 *   const port = config.get(StructuralKeys.PGPORT);
 *   const token = config.getOptional(SecretKeys.GITHUB_TOKEN);
 *   const pool = await config.getProjectDb('my-project');
 *   config.reload(); // Live reload on pg_notify
 *   config.audit(); // Get access audit log
 */

import type { Pool, PoolClient } from "pg";
import { Client } from "pg";

export type ConfigClass =
	| "secret"
	| "structural"
	| "registry"
	| "flag"
	| "tenant_dsn";

export interface ConfigKey<T> {
	name: string;
	class: ConfigClass;
	parse: (raw: string) => T;
	required: boolean;
	description?: string;
	yamlPath?: string;
	/**
	 * Optional yaml-assembly function for keys whose value is derived from
	 * multiple yaml paths (e.g. AGENTHIVE_CONTROL_DSN assembled from
	 * databases.control.{host,port,name,role}).  Takes precedence over yamlPath
	 * when no env var is set.
	 */
	assembleFromYaml?: (yaml: Record<string, any>) => T | undefined;
	dbTable?: string;
	dbColumn?: string;
	envOverride?: boolean;
	defaultValue?: T;
}

/**
 * Scope context for runtime_flag scoped lookups.
 * Priority order: project → host → agency → global.
 */
export interface ScopeContext {
	projectSlug?: string;
	hostId?: string;
	agencyId?: string;
}

/**
 * RuntimeConfigMissing: thrown when a required config key cannot be resolved.
 */
export class RuntimeConfigMissing extends Error {
	public keyName: string;
	public keyClass: ConfigClass;
	constructor(keyName: string, keyClass: ConfigClass, details: string) {
		super(
			`[RuntimeConfig] Required ${keyClass} key not found: ${keyName}\n${details}`,
		);
		this.keyName = keyName;
		this.keyClass = keyClass;
		this.name = "RuntimeConfigMissing";
		Object.setPrototypeOf(this, RuntimeConfigMissing.prototype);
	}
}

/**
 * RuntimeConfigInvalidSource: thrown when a key is read from a disallowed source.
 * Used for: secret keys read from yaml/DB, tenant_dsn keys read via get().
 */
export class RuntimeConfigInvalidSource extends Error {
	public keyName: string;
	public attemptedSource: string;
	public allowedSources: string[];
	constructor(
		keyName: string,
		attemptedSource: string,
		allowedSources: string[],
		message?: string,
	) {
		super(
			message ??
				`[RuntimeConfig] Key "${keyName}" cannot be read from ${attemptedSource}. ` +
					`Allowed sources: ${allowedSources.join(", ")}`,
		);
		this.keyName = keyName;
		this.attemptedSource = attemptedSource;
		this.allowedSources = allowedSources;
		this.name = "RuntimeConfigInvalidSource";
		Object.setPrototypeOf(this, RuntimeConfigInvalidSource.prototype);
	}
}

/**
 * ProjectIdMissing: thrown fail-closed when a project-scoped core.runtime_flag
 * key (name starts with PROJECT_) is resolved without a projectSlug in scopeContext.
 */
export class ProjectIdMissing extends Error {
	public keyName: string;
	constructor(keyName: string) {
		super(
			`[RuntimeConfig] Key "${keyName}" requires project scope but no projectSlug was provided to ConfigResolver.init(). Pass scopeContext.projectSlug.`,
		);
		this.keyName = keyName;
		this.name = "ProjectIdMissing";
		Object.setPrototypeOf(this, ProjectIdMissing.prototype);
	}
}

/**
 * Audit log entry for config access.
 */
export interface ConfigAuditEntry {
	keyName: string;
	keyClass: ConfigClass;
	lastAccessedAt: Date;
	source: "env" | "yaml" | "db" | "default";
	accessCount: number;
}

/**
 * Audit entry for tenant_dsn lookups via getProjectDb().
 * Recorded under synthetic key `tenant_dsn:<slug>`.
 */
export interface TenantDsnAuditEntry {
	syntheticKey: string;
	slug: string;
	lastAccessedAt: Date;
	accessCount: number;
}

/**
 * Grouped audit snapshot returned by getConfigAudit().
 */
export interface ConfigAuditSnapshot {
	config: ConfigAuditEntry[];
	tenantDsn: TenantDsnAuditEntry[];
}

/**
 * TTL-bearing cache entry for core.runtime_flag dbCache entries.
 */
interface FlagCacheEntry {
	value: any;
	resolvedAt: number;
}

const FLAG_CACHE_TTL_MS = 300_000; // 5 minutes
const RUNTIME_FLAG_TABLE = "core.runtime_flag";

export const DEFAULT_ENV_FILE_PATH = "/etc/agenthive/env";

export async function loadRuntimeEnvFile(
	filePath = DEFAULT_ENV_FILE_PATH,
): Promise<void> {
	try {
		const { readFileSync } = await import("node:fs");
		const content = readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
			if (!match) continue;
			const [, key, value] = match;
			if (!process.env[key]) {
				process.env[key] = value;
			}
		}
	} catch {
		// File not found or not readable — continue without it
	}
}

/**
 * Internal cache for resolved config values.
 */
interface CachedValue<T> {
	value: T;
	source: "env" | "yaml" | "db" | "default";
	resolvedAt: Date;
}

class ConfigResolver {
	private cache: Map<string, CachedValue<any>> = new Map();
	private auditMap: Map<string, ConfigAuditEntry> = new Map();
	private tenantDsnAuditMap: Map<string, TenantDsnAuditEntry> = new Map();
	private yamlConfig: Record<string, any> | null = null;
	private pool: Pool | null = null;
	/** dbCache: keyed as `runtime_flag:<flag_name>:<scope>` for flag entries (FlagCacheEntry),
	 *  or `${table}:${column}` for non-flag entries (plain any). */
	private dbCache: Map<string, FlagCacheEntry | any> = new Map();
	private notifySubscription: PoolClient | null = null;
	private scopeContext: ScopeContext = {};
	/** Dedicated Pool used for LISTEN when PGPORT_DIRECT bypasses PgBouncer. */
	private directListenPool: Pool | null = null;

	// Parse ~/.pgpass for a matching password entry (hostname:port:database:username:password)
	static parsePgpassFile(
		pgpassPath: string,
		host: string,
		port: string,
		database: string,
		user: string,
	): string | undefined {
		try {
			const { readFileSync } = require("node:fs");
			const content = readFileSync(pgpassPath, "utf-8") as string;
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const parts = trimmed
					.replace(/\\:/g, "\uF000")
					.split(":")
					.map((p: string) => p.replace(/\uF000/g, ":"));
				if (parts.length < 5) continue;
				const [h, p, d, u, ...rest] = parts;
				const pw = rest.join(":");
				const m = (pat: string, val: string) => pat === "*" || pat === val;
				if (m(h, host) && m(p, port) && m(d, database) && m(u, user)) {
					return pw;
				}
			}
		} catch {
			/* unreadable */
		}
		return undefined;
	}

	// Synchronously resolve the DB password: PGPASSWORD env → ~/.pgpass → undefined
	static resolvePasswordSync(opts: {
		host: string;
		port: string;
		database: string;
		user: string;
		pgpassPath?: string;
	}): string | undefined {
		if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
		const pgpassPath =
			opts.pgpassPath ??
			(process.env.PGPASSFILE || `${process.env.HOME || ""}/.pgpass`);
		return ConfigResolver.parsePgpassFile(
			pgpassPath,
			opts.host,
			opts.port,
			opts.database,
			opts.user,
		);
	}

	/**
	 * Initialize the resolver with optional yaml config, database pool, and scope context.
	 */
	async init(opts: {
		yamlConfig?: Record<string, any>;
		pool?: Pool;
		envFilePath?: string;
		scopeContext?: ScopeContext;
	}): Promise<void> {
		this.yamlConfig = opts.yamlConfig || null;
		this.pool = opts.pool || null;
		this.scopeContext = opts.scopeContext || {};

		if (opts.envFilePath) {
			await loadRuntimeEnvFile(opts.envFilePath);
		}

		if (this.pool) {
			await this.setupNotifyListener();
		}
	}

	/**
	 * Set up a NOTIFY listener for runtime_flag_changed events.
	 * Uses PGPORT_DIRECT for PgBouncer bypass if available.
	 * Never throws — LISTEN is best-effort; TTL cache covers the hot-reload gap.
	 */
	private async setupNotifyListener(): Promise<void> {
		try {
			let client: PoolClient;

			const directPortEnv = process.env.PGPORT_DIRECT;
			if (directPortEnv) {
				const directPort = Number(directPortEnv);
				if (
					Number.isFinite(directPort) &&
					directPort > 0 &&
					directPort <= 65535
				) {
					// Create a dedicated direct-Postgres pool (bypasses PgBouncer transaction mode)
					const { Pool } = await import("pg");
					const poolOptions = (this.pool as any).options ?? {};
					this.directListenPool = new Pool({
						...poolOptions,
						port: directPort,
						max: 1,
					});
					client = await this.directListenPool.connect();
				} else {
					client = await this.pool.connect();
				}
			} else {
				client = await this.pool.connect();
			}

			// P827 AC-4: LISTEN only on runtime_flag_changed. The former
			// `runtime_config_changed` LISTEN was a DEAD channel — no trigger
			// emits it — so it never fired and is removed. runtime_endpoint_changed
			// is intentionally NOT listened here (endpoints.ts owns it).
			await client.query("LISTEN runtime_flag_changed");

			client.on("notification", (msg) => {
				// P827 AC-5: targeted eviction lives in handleFlagNotification
				// (only the matching (flag_name, scope) entry; full flush only on
				// a malformed payload). The previous unconditional
				// cache.clear()/dbCache.clear() here DEFEATED that targeting —
				// every notify wiped the whole cache — so it is removed.
				this.handleFlagNotification(msg.payload);
			});

			client.on("error", () => {
				this.notifySubscription = null;
			});

			this.notifySubscription = client;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(
				`[ConfigResolver] LISTEN unavailable: hot-reload disabled. ${msg}`,
			);
		}
	}

	/**
	 * Handle a runtime_flag_changed pg_notify payload.
	 * On parse success: targeted eviction of (flag_name, scope) entry.
	 * On parse failure: full dbCache flush as safe fallback.
	 */
	private handleFlagNotification(payload: string | undefined): void {
		if (!payload) {
			this.dbCache.clear();
			return;
		}
		try {
			const parsed = JSON.parse(payload) as {
				flag_name?: string;
				scope?: string;
			};
			if (
				typeof parsed.flag_name === "string" &&
				typeof parsed.scope === "string"
			) {
				const dbCacheKey = `runtime_flag:${parsed.flag_name}:${parsed.scope}`;
				this.dbCache.delete(dbCacheKey);
				// Evict the top-level resolved cache entry so next get() re-resolves
				this.cache.delete(parsed.flag_name);
			} else {
				this.dbCache.clear();
			}
		} catch {
			this.dbCache.clear();
		}
	}

	/**
	 * Scoped priority lookup for core.runtime_flag entries.
	 * Order: project:<slug> → host:<id> → agency:<id> → global
	 * Each candidate scope is checked individually with per-entry TTL cache.
	 */
	private async getScopedFlagValue(flagName: string): Promise<any> {
		if (!this.pool) return undefined;

		const candidates: string[] = [];
		if (this.scopeContext.projectSlug) {
			candidates.push(`project:${this.scopeContext.projectSlug}`);
		}
		if (this.scopeContext.hostId) {
			candidates.push(`host:${this.scopeContext.hostId}`);
		}
		if (this.scopeContext.agencyId) {
			candidates.push(`agency:${this.scopeContext.agencyId}`);
		}
		candidates.push("global");

		for (const scope of candidates) {
			const cacheKey = `runtime_flag:${flagName}:${scope}`;
			const cached = this.dbCache.get(cacheKey);

			if (
				cached !== undefined &&
				typeof cached === "object" &&
				cached !== null &&
				"resolvedAt" in cached
			) {
				const entry = cached as FlagCacheEntry;
				if (Date.now() - entry.resolvedAt < FLAG_CACHE_TTL_MS) {
					return entry.value;
				}
				// TTL expired — evict and re-fetch
				this.dbCache.delete(cacheKey);
			}

			try {
				const result = await this.pool.query(
					`SELECT value_jsonb FROM ${RUNTIME_FLAG_TABLE}
					  WHERE flag_name = $1 AND scope = $2 AND lifecycle_status = 'active'
					  LIMIT 1`,
					[flagName, scope],
				);
				if (result.rows.length > 0) {
					const value = result.rows[0].value_jsonb;
					const entry: FlagCacheEntry = { value, resolvedAt: Date.now() };
					this.dbCache.set(cacheKey, entry);
					return value;
				}
			} catch {
				// DB error for this scope — continue to next candidate
			}
		}

		return undefined;
	}

	/**
	 * Resolve a single config key using the class-based resolution order.
	 *
	 * tenant_dsn keys throw immediately — they are pool-bound resources that
	 * must be accessed via getProjectDb(), not via get()/getOptional().
	 */
	private async resolve<T>(key: ConfigKey<T>): Promise<CachedValue<T>> {
		// tenant_dsn enforcement: these keys are pool-bound, not value-bound.
		if (key.class === "tenant_dsn") {
			throw new RuntimeConfigInvalidSource(
				key.name,
				"get()",
				["getProjectDb(slug)"],
				`[RuntimeConfig] tenant_dsn keys cannot be read via get(). Use config.getProjectDb(slug) instead. For per-tenant databases, pool binding is required.`,
			);
		}

		// Check cache first
		const cachedValue = this.cache.get(key.name);
		if (cachedValue !== undefined) {
			const audit = this.auditMap.get(key.name);
			if (audit) {
				audit.lastAccessedAt = new Date();
				audit.accessCount++;
			}
			return cachedValue;
		}

		let value: T | undefined;
		let source: "env" | "yaml" | "db" | "default" = "default";

		// Step 2 & 3: Process env var (or promoted from /etc/agenthive/env)
		const envValue = process.env[key.name];
		if (envValue !== undefined) {
			try {
				value = key.parse(envValue);
				source = "env";
			} catch (err) {
				throw new RuntimeConfigMissing(
					key.name,
					key.class,
					`Invalid env value: ${envValue}\n${(err as Error).message}`,
				);
			}
		}

		// Step 4: roadmap.yaml (structural defaults)
		if (value === undefined && key.class === "structural") {
			// Try assembleFromYaml first (multi-path assembly like AGENTHIVE_CONTROL_DSN)
			if (key.assembleFromYaml && this.yamlConfig) {
				const assembled = key.assembleFromYaml(this.yamlConfig);
				if (assembled !== undefined) {
					value = assembled;
					source = "yaml";
				}
			} else if (key.yamlPath) {
				const yamlValue = this.getYamlValue(key.yamlPath);
				if (yamlValue !== undefined) {
					try {
						value = key.parse(String(yamlValue));
						source = "yaml";
					} catch (err) {
						throw new RuntimeConfigMissing(
							key.name,
							key.class,
							`Invalid yaml value at ${key.yamlPath}: ${yamlValue}\n${(err as Error).message}`,
						);
					}
				}
			}
		}

		// Fail-closed: PROJECT_ keys on core.runtime_flag require projectSlug
		if (
			value === undefined &&
			(key.class === "registry" || key.class === "flag") &&
			key.dbTable === RUNTIME_FLAG_TABLE &&
			key.name.startsWith("PROJECT_") &&
			!this.scopeContext.projectSlug
		) {
			throw new ProjectIdMissing(key.name);
		}

		// Step 5: Control DB registry (registry keys)
		if (
			value === undefined &&
			key.class === "registry" &&
			key.dbTable &&
			this.pool
		) {
			const registryDbValue = await this.getDbValue(
				key.dbTable,
				key.dbColumn || key.name,
				key.name,
			);
			if (registryDbValue !== undefined) {
				try {
					const raw =
						typeof registryDbValue === "string"
							? registryDbValue
							: JSON.stringify(registryDbValue);
					value = key.parse(raw);
					source = "db";
				} catch (err) {
					throw new RuntimeConfigMissing(
						key.name,
						key.class,
						`Invalid DB value from ${key.dbTable}: ${registryDbValue}\n${(err as Error).message}`,
					);
				}
			}
		}

		// Step 6: Feature flags (DB, cached, live-reloadable)
		if (
			value === undefined &&
			key.class === "flag" &&
			key.dbTable &&
			this.pool
		) {
			const flagDbValue = await this.getDbValue(
				key.dbTable,
				key.dbColumn || key.name,
				key.name,
			);
			if (flagDbValue !== undefined) {
				try {
					const raw =
						typeof flagDbValue === "string"
							? flagDbValue
							: JSON.stringify(flagDbValue);
					value = key.parse(raw);
					source = "db";
				} catch (err) {
					throw new RuntimeConfigMissing(
						key.name,
						key.class,
						`Invalid flag value from ${key.dbTable}: ${flagDbValue}\n${(err as Error).message}`,
					);
				}
			}
		}

		// Step 7: Default value (if provided and non-required)
		if (value === undefined && key.defaultValue !== undefined) {
			value = key.defaultValue;
			source = "default";
		}

		// Step 8: Throw if required and not found
		if (value === undefined && key.required) {
			throw new RuntimeConfigMissing(
				key.name,
				key.class,
				`No value found in env, yaml, or DB. Required keys must be explicitly set.`,
			);
		}

		// Enforcement: secret keys can NEVER come from yaml or DB
		if (key.class === "secret" && (source === "yaml" || source === "db")) {
			throw new RuntimeConfigInvalidSource(
				key.name,
				source === "yaml" ? "roadmap.yaml" : "database",
				["env", "default"],
			);
		}

		const cached: CachedValue<T> = {
			value: value as T,
			source,
			resolvedAt: new Date(),
		};
		this.cache.set(key.name, cached);

		const audit = this.auditMap.get(key.name) || {
			keyName: key.name,
			keyClass: key.class,
			lastAccessedAt: new Date(),
			source,
			accessCount: 0,
		};
		audit.lastAccessedAt = new Date();
		audit.accessCount++;
		this.auditMap.set(key.name, audit);

		return cached;
	}

	/**
	 * Get a required config value.
	 */
	async get<T>(key: ConfigKey<T>): Promise<T> {
		const cached = await this.resolve(key);
		if (cached.value === undefined && key.required) {
			throw new RuntimeConfigMissing(key.name, key.class, "Value is undefined");
		}
		return cached.value as T;
	}

	/**
	 * Get an optional config value (may return undefined).
	 */
	async getOptional<T>(key: ConfigKey<T | undefined>): Promise<T | undefined> {
		const cached = await this.resolve(key);
		return cached.value;
	}

	/**
	 * Record a tenant DSN access in the audit map under `tenant_dsn:<slug>`.
	 */
	recordTenantDsnAccess(slug: string): void {
		const syntheticKey = `tenant_dsn:${slug}`;
		const existing = this.tenantDsnAuditMap.get(syntheticKey);
		if (existing) {
			existing.lastAccessedAt = new Date();
			existing.accessCount++;
		} else {
			this.tenantDsnAuditMap.set(syntheticKey, {
				syntheticKey,
				slug,
				lastAccessedAt: new Date(),
				accessCount: 1,
			});
		}
	}

	/**
	 * Clear the cache (useful for testing or after config reload).
	 */
	clear(): void {
		this.cache.clear();
		this.dbCache.clear();
	}

	/**
	 * Reload from DB on pg_notify event.
	 */
	async reload(): Promise<void> {
		this.clear();
	}

	/**
	 * Get current audit log (config keys).
	 */
	getAudit(): ConfigAuditEntry[] {
		return [...this.auditMap.values()];
	}

	/**
	 * Get tenant DSN audit log.
	 */
	getTenantDsnAudit(): TenantDsnAuditEntry[] {
		return [...this.tenantDsnAuditMap.values()];
	}

	/**
	 * Get grouped audit snapshot for mcp_ops config_audit.
	 */
	getAuditSnapshot(): ConfigAuditSnapshot {
		return {
			config: this.getAudit(),
			tenantDsn: this.getTenantDsnAudit(),
		};
	}

	/**
	 * Extract value from yaml config using dot-notation path.
	 */
	private getYamlValue(path: string): any {
		if (!this.yamlConfig) return undefined;
		const parts = path.split(".");
		let current: any = this.yamlConfig;
		for (const part of parts) {
			if (current === null || typeof current !== "object") {
				return undefined;
			}
			current = current[part];
		}
		return current;
	}

	/**
	 * Query a runtime flag value by flag_name + scope from core.runtime_flag.
	 * Caches per (flag_name, scope) key; cache is cleared on runtime_flag_changed notify.
	 */
	private async getActiveFlagValue(
		flagName: string,
		scope = "global",
	): Promise<any> {
		if (!this.pool) return undefined;
		const cacheKey = `runtime_flag:${flagName}:${scope}`;
		if (this.dbCache.has(cacheKey)) return this.dbCache.get(cacheKey);
		try {
			const result = await this.pool.query(
				`SELECT value_jsonb FROM core.runtime_flag WHERE flag_name = $1 AND scope = $2 AND lifecycle_status = 'active' LIMIT 1`,
				[flagName, scope],
			);
			const value = result.rows[0]?.value_jsonb;
			this.dbCache.set(cacheKey, value);
			return value;
		} catch {
			return undefined;
		}
	}

	/**
	 * Query a value from the control DB registry.
	 * Routes core.runtime_flag lookups through getScopedFlagValue() (scoped + TTL cache).
	 * All other tables use the single-row LIMIT 1 fallback (no TTL, no scope).
	 */
	private async getDbValue(
		table: string,
		column: string,
		flagName?: string,
	): Promise<any> {
		if (!this.pool) return undefined;

		if (table === RUNTIME_FLAG_TABLE && flagName) {
			return this.getScopedFlagValue(flagName);
		}

		const cacheKey = `${table}:${column}`;
		if (this.dbCache.has(cacheKey)) {
			return this.dbCache.get(cacheKey);
		}

		try {
			const result = await this.pool.query(
				`SELECT ${column} FROM ${table} LIMIT 1`,
			);
			const value = result.rows[0]?.[column];
			this.dbCache.set(cacheKey, value);
			return value;
		} catch {
			return undefined;
		}
	}

	/**
	 * Cleanup: close NOTIFY subscription and direct listen pool.
	 * Safe to call multiple times (idempotent).
	 */
	async cleanup(): Promise<void> {
		if (!this.notifySubscription) return;
		try {
			await this.notifySubscription.query("UNLISTEN runtime_flag_changed");
			this.notifySubscription.release();
		} catch {
			// Already closed or errored — ignore
		} finally {
			this.notifySubscription = null;
		}

		if (this.directListenPool) {
			try {
				await this.directListenPool.end();
			} catch {
				// ignore
			} finally {
				this.directListenPool = null;
			}
		}
	}
}

/**
 * Global singleton resolver instance.
 */
let globalResolver: ConfigResolver | null = null;

/**
 * Initialize the global config resolver.
 * Call once at process startup.
 */
export async function initConfig(opts: {
	yamlConfig?: Record<string, any>;
	pool?: Pool;
	envFilePath?: string;
	scopeContext?: ScopeContext;
}): Promise<ConfigResolver> {
	if (globalResolver) {
		await globalResolver.cleanup();
	}
	const resolver = new ConfigResolver();
	await resolver.init(opts);
	globalResolver = resolver;
	return resolver;
}

/**
 * Get the global resolver instance.
 */
function getResolver(): ConfigResolver {
	if (!globalResolver) {
		throw new Error(
			"[Config] Resolver not initialized. Call initConfig() at process startup.",
		);
	}
	return globalResolver;
}

/**
 * Get a required config value.
 * Throws RuntimeConfigInvalidSource for tenant_dsn keys.
 */
export async function get<T>(key: ConfigKey<T>): Promise<T> {
	return getResolver().get(key);
}

/**
 * Get an optional config value.
 * Throws RuntimeConfigInvalidSource for tenant_dsn keys.
 */
export async function getOptional<T>(
	key: ConfigKey<T | undefined>,
): Promise<T | undefined> {
	return getResolver().getOptional(key);
}

/**
 * Get a tenant database pool by project slug or numeric project_id.
 *
 * Forwards to the P497 pool registry (pool-registry.getProjectDb).
 * Records the access in the audit map under `tenant_dsn:<slug>`.
 *
 * Throws ProjectNotRegistered, RegistryUnavailable, TenantDbUnreachable,
 * TenantSecretUnavailable, or DsnFormatInvalid — all from pool-registry.
 */
export async function getProjectDb(
	slugOrId: string | number,
): Promise<import("pg").Pool> {
	const { getProjectDb: registryGetProjectDb } = await import(
		"../../postgres/pool-registry.js"
	);
	const slug = String(slugOrId);
	const pool = await registryGetProjectDb(slugOrId);
	if (globalResolver) {
		globalResolver.recordTenantDsnAccess(slug);
	}
	return pool;
}

/**
 * Reload config from DB (clears cache).
 */
export async function reload(): Promise<void> {
	return getResolver().reload();
}

/**
 * Get the audit log of all config accesses this process.
 */
export function getAudit(): ConfigAuditEntry[] {
	if (!globalResolver) return [];
	return globalResolver.getAudit();
}

/**
 * Get grouped audit snapshot: config keys + tenant_dsn lookups.
 * Used by mcp_ops action=config_audit.
 */
export function getAuditSnapshot(): ConfigAuditSnapshot {
	if (!globalResolver) return { config: [], tenantDsn: [] };
	return globalResolver.getAuditSnapshot();
}

/**
 * Clear the config cache (testing only).
 */
export function clearCache(): void {
	if (!globalResolver) return;
	globalResolver.clear();
}

/**
 * Cleanup and close NOTIFY subscription.
 */
export async function cleanup(): Promise<void> {
	if (!globalResolver) return;
	await globalResolver.cleanup();
	globalResolver = null;
}

export { ConfigResolver };
