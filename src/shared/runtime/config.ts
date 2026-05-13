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

import { Client } from "pg";
import type { Pool, PoolClient } from "pg";

export type ConfigClass = "secret" | "structural" | "registry" | "flag" | "tenant_dsn";

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
 * RuntimeConfigMissing: thrown when a required config key cannot be resolved.
 */
export class RuntimeConfigMissing extends Error {
	constructor(
		public keyName: string,
		public keyClass: ConfigClass,
		details: string,
	) {
		super(
			`[RuntimeConfig] Required ${keyClass} key not found: ${keyName}\n${details}`,
		);
		this.name = "RuntimeConfigMissing";
		Object.setPrototypeOf(this, RuntimeConfigMissing.prototype);
	}
}

/**
 * RuntimeConfigInvalidSource: thrown when a key is read from a disallowed source.
 * Used for: secret keys read from yaml/DB, tenant_dsn keys read via get().
 */
export class RuntimeConfigInvalidSource extends Error {
	constructor(
		public keyName: string,
		public attemptedSource: string,
		public allowedSources: string[],
		message?: string,
	) {
		super(
			message ??
			`[RuntimeConfig] Key "${keyName}" cannot be read from ${attemptedSource}. ` +
			`Allowed sources: ${allowedSources.join(", ")}`,
		);
		this.name = "RuntimeConfigInvalidSource";
		Object.setPrototypeOf(this, RuntimeConfigInvalidSource.prototype);
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
	private dbCache: Map<string, any> = new Map();
	private notifySubscription: Client | null = null;

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
					.replace(/\\:/g, "\x00")
					.split(":")
					.map((p: string) => p.replace(/\x00/g, ":"));
				if (parts.length < 5) continue;
				const [h, p, d, u, ...rest] = parts;
				const pw = rest.join(":");
				const m = (pat: string, val: string) => pat === "*" || pat === val;
				if (m(h, host) && m(p, port) && m(d, database) && m(u, user)) {
					return pw;
				}
			}
		} catch { /* unreadable */ }
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
		const pgpassPath = opts.pgpassPath ??
			(process.env.PGPASSFILE || ((process.env.HOME || "") + "/.pgpass"));
		return ConfigResolver.parsePgpassFile(pgpassPath, opts.host, opts.port, opts.database, opts.user);
	}

	/**
	 * Initialize the resolver with optional yaml config and database pool.
	 */
	async init(opts: {
		yamlConfig?: Record<string, any>;
		pool?: Pool;
		envFilePath?: string;
	}): Promise<void> {
		this.yamlConfig = opts.yamlConfig || null;
		this.pool = opts.pool || null;

		if (opts.envFilePath) {
			await this.loadEnvFile(opts.envFilePath);
		}

		if (this.pool) {
			await this.setupNotifyListener();
		}
	}

	/**
	 * Load environment variables from a file (e.g., /etc/agenthive/env).
	 */
	private async loadEnvFile(filePath: string): Promise<void> {
		try {
			const { readFileSync } = await import("node:fs");
			const content = readFileSync(filePath, "utf-8");
			for (const line of content.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;
				const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
				if (match) {
					const [, key, value] = match;
					if (!process.env[key]) {
						process.env[key] = value;
					}
				}
			}
		} catch {
			// File not found or not readable — continue without it
		}
	}

	/**
	 * Set up a NOTIFY listener for config change events.
	 */
	private async setupNotifyListener(): Promise<void> {
		if (!this.pool) return;
		try {
			// Must use a direct pg.Client (NOT a pool checkout) — LISTEN is
			// incompatible with PgBouncer transaction-mode pooling (P499).
			const host = process.env.PGHOST ?? "127.0.0.1";
			const port = Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432);
			const user = process.env.PGUSER;
			const database = process.env.PGDATABASE ?? "agenthive";
			const client = new Client({ host, port, user, database, keepAlive: true });
			await client.connect();
			await client.query("LISTEN runtime_config_changed");
			client.on("notification", async () => {
				this.cache.clear();
				this.dbCache.clear();
			});
			this.notifySubscription = client;
		} catch {
			// Non-fatal; resolver works without notifications
		}
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

		// Step 5: Control DB registry (registry keys)
		if (value === undefined && key.class === "registry" && key.dbTable && this.pool) {
			const registryDbValue = await this.getDbValue(key.dbTable, key.dbColumn || key.name);
			if (registryDbValue !== undefined) {
				try {
					value = key.parse(String(registryDbValue));
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
		if (value === undefined && key.class === "flag" && key.dbTable && this.pool) {
			const flagDbValue = await this.getDbValue(key.dbTable, key.dbColumn || key.name);
			if (flagDbValue !== undefined) {
				try {
					value = key.parse(String(flagDbValue));
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
	 * Query a value from the control DB registry.
	 */
	private async getDbValue(table: string, column: string): Promise<any> {
		if (!this.pool) return undefined;

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
	 * Cleanup: close NOTIFY subscription.
	 */
	async cleanup(): Promise<void> {
		if (this.notifySubscription) {
			try {
				await this.notifySubscription.query("UNLISTEN runtime_config_changed");
				await this.notifySubscription.end();
				this.notifySubscription = null;
			} catch {
				// Already closed
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
export async function getProjectDb(slugOrId: string | number): Promise<import("pg").Pool> {
	const { getProjectDb: registryGetProjectDb } = await import("../../postgres/pool-registry.js");
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
