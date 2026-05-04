/**
 * Canonical configuration resolver with class-based source enforcement.
 * P498 extension: tenant_dsn class for pool-bound DSN resources
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
 * - `tenant_dsn`: NOT readable via get()/getOptional() — use getProjectDb(slug)
 *
 * Usage:
 *   const port = config.get(StructuralKeys.PGPORT);
 *   const token = config.getOptional(SecretKeys.GITHUB_TOKEN);
 *   const dsn = await config.getProjectDb('tenant-slug');
 *   config.reload(); // Live reload on pg_notify
 *   config.audit(); // Get access audit log
 */

import type { Pool, PoolClient } from "pg";

export type ConfigClass = "secret" | "structural" | "registry" | "flag" | "tenant_dsn";

export interface ConfigKey<T> {
	name: string;
	class: ConfigClass;
	parse: (raw: string) => T;
	required: boolean;
	description?: string;
	yamlPath?: string;
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
 * RuntimeConfigInvalidSource: thrown when a secret/tenant_dsn key is read via get()/getOptional().
 */
export class RuntimeConfigInvalidSource extends Error {
	constructor(
		public keyName: string,
		public attemptedSource: string,
		public allowedSources: string[],
	) {
		super(
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
 * Audit log entry for tenant_dsn access.
 */
export interface TenantDsnAuditEntry {
	slug: string;
	accessor: string;
	lastAccessedAt: Date;
	accessCount: number;
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
	private audit: Map<string, ConfigAuditEntry> = new Map();
	private tenantDsnAudit: Map<string, TenantDsnAuditEntry> = new Map();
	private yamlConfig: Record<string, any> | null = null;
	private pool: Pool | null = null;
	private dbCache: Map<string, any> = new Map();
	private notifySubscription: PoolClient | null = null;
	private cachedControlDsn: string | null = null;

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

		// Load env file if provided
		if (opts.envFilePath) {
			await this.loadEnvFile(opts.envFilePath);
		}

		// Set up DB NOTIFY listener for flag changes
		if (this.pool) {
			await this.setupNotifyListener();
		}
	}

	/**
	 * Load environment variables from a file (e.g., /etc/agenthive/env).
	 * Strict parser: rejects shell expansion, backticks, command substitution.
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
					const [, key, rawValue] = match;
					// Reject dangerous shell syntax
					if (
						rawValue.includes("$(") ||
						rawValue.includes("`") ||
						rawValue.includes("${") ||
						rawValue.includes("<<")
					) {
						throw new Error(
							`[Config] Env file ${filePath}: line '${trimmed}' contains shell expansion. ` +
							"Environment files must use literal values only (no $(...), backticks, $\\{...\\}, or <<...)",
						);
					}
					if (!process.env[key]) {
						process.env[key] = rawValue;
					}
				}
			}
		} catch (err) {
			// If it's our syntax check error, re-throw; otherwise ignore file not found
			if (err instanceof Error && err.message.includes("[Config] Env file")) {
				throw err;
			}
		}
	}

	/**
	 * Set up a NOTIFY listener for config change events.
	 * Listens on both runtime_flag_changed and runtime_endpoint_changed channels.
	 */
	private async setupNotifyListener(): Promise<void> {
		if (!this.pool) return;
		try {
			const client = await this.pool.connect();
			// Listen for both runtime flag changes and endpoint changes
			await client.query("LISTEN runtime_flag_changed");
			await client.query("LISTEN runtime_endpoint_changed");
			client.on("notification", async () => {
				this.cache.clear();
				this.dbCache.clear();
				this.cachedControlDsn = null;
			});
			this.notifySubscription = client;
		} catch {
			// Non-fatal; resolver works without notifications
		}
	}

	/**
	 * Resolve a single config key using the class-based resolution order.
	 */
	private async resolve<T>(key: ConfigKey<T>): Promise<CachedValue<T>> {
		// Check cache first
		const cachedValue = this.cache.get(key.name);
		if (cachedValue !== undefined) {
			// Update audit log for cache hit
			const audit = this.audit.get(key.name);
			if (audit) {
				audit.lastAccessedAt = new Date();
				audit.accessCount++;
			}
			return cachedValue;
		}

		let value: T | undefined;
		let source: "env" | "yaml" | "db" | "default" = "default";

		// Step 1: Explicit override (constructor arg) — not implemented in v1, future enhancement
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
		if (value === undefined && key.class === "structural" && key.yamlPath) {
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

		// Special enforcement: secret and tenant_dsn keys have restricted access
		if (key.class === "secret" && (source === "yaml" || source === "db")) {
			throw new RuntimeConfigInvalidSource(
				key.name,
				source === "yaml" ? "roadmap.yaml" : "database",
				["env", "default"],
			);
		}

		// Build cache entry
		const cached: CachedValue<T> = {
			value: value as T,
			source,
			resolvedAt: new Date(),
		};
		this.cache.set(key.name, cached);

		// Record in audit log
		const audit = this.audit.get(key.name) || {
			keyName: key.name,
			keyClass: key.class,
			lastAccessedAt: new Date(),
			source,
			accessCount: 0,
		};
		audit.lastAccessedAt = new Date();
		audit.accessCount++;
		this.audit.set(key.name, audit);

		return cached;
	}

	/**
	 * Get a required config value.
	 * Throws RuntimeConfigInvalidSource for tenant_dsn keys.
	 */
	async get<T>(key: ConfigKey<T>): Promise<T> {
		if (key.class === "tenant_dsn") {
			throw new RuntimeConfigInvalidSource(
				key.name,
				"get()",
				["getProjectDb()"],
			);
		}
		const cached = await this.resolve(key);
		if (cached.value === undefined && key.required) {
			throw new RuntimeConfigMissing(key.name, key.class, "Value is undefined");
		}
		return cached.value as T;
	}

	/**
	 * Get an optional config value (may return undefined).
	 * Throws RuntimeConfigInvalidSource for tenant_dsn keys.
	 */
	async getOptional<T>(key: ConfigKey<T | undefined>): Promise<T | undefined> {
		if (key.class === "tenant_dsn") {
			throw new RuntimeConfigInvalidSource(
				key.name,
				"getOptional()",
				["getProjectDb()"],
			);
		}
		const cached = await this.resolve(key);
		return cached.value;
	}

	/**
	 * Resolve CONTROL_DSN with env-first resolution.
	 * Resolution order: env AGENTHIVE_CONTROL_DSN > yaml assembly > throw.
	 * NOTE: Does NOT cache env var to allow re-reading on each call (AC5).
	 */
	private resolveControlDsn(): string {
		// Step 1: env override (re-read on each call, no cache)
		const envDsn = process.env.AGENTHIVE_CONTROL_DSN;
		if (envDsn) {
			return envDsn;
		}

		// Step 2: yaml assembly fallback (cached)
		if (this.cachedControlDsn) {
			return this.cachedControlDsn;
		}

		if (this.yamlConfig?.databases?.control) {
			const ctrl = this.yamlConfig.databases.control;
			const host = ctrl.host || "127.0.0.1";
			const port = ctrl.port || 6432;
			const name = ctrl.name || "hiveControl";
			const role = ctrl.role || "agenthive_admin";
			const passwordRef = ctrl.password_ref || process.env.CONTROL_DB_PASSWORD_REF || "vault://file/control/db_password";

			// Assemble DSN; password will be fetched by pool registry (P497)
			const dsn = `postgres://${role}@${host}:${port}/${name}?application_name=agenthive-control&password_ref=${encodeURIComponent(passwordRef)}`;
			this.cachedControlDsn = dsn;
			return dsn;
		}

		// Step 3: throw if both absent
		throw new RuntimeConfigMissing(
			"AGENTHIVE_CONTROL_DSN",
			"structural",
			"AGENTHIVE_CONTROL_DSN env var must be set or databases.control block must exist in yaml",
		);
	}

	/**
	 * Get the control DSN (used internally for bootstrap).
	 */
	getControlDsn(): string {
		return this.resolveControlDsn();
	}

	/**
	 * Record tenant_dsn access in audit log.
	 */
	private recordTenantDsnAccess(slug: string, accessor: string): void {
		const key = `${slug}`;
		const existing = this.tenantDsnAudit.get(key);
		if (existing) {
			existing.lastAccessedAt = new Date();
			existing.accessCount++;
		} else {
			this.tenantDsnAudit.set(key, {
				slug,
				accessor,
				lastAccessedAt: new Date(),
				accessCount: 1,
			});
		}

		// Log to DB if pool exists (non-blocking)
		if (this.pool) {
			this.logTenantDsnAccessAsync(slug, accessor).catch(() => {
				// Non-fatal if logging fails
			});
		}
	}

	/**
	 * Async log tenant_dsn access to roadmap.tenant_dsn_access_log (non-blocking).
	 */
	private async logTenantDsnAccessAsync(slug: string, accessor: string): Promise<void> {
		if (!this.pool) return;
		try {
			await this.pool.query(
				`INSERT INTO roadmap.tenant_dsn_access_log (slug, accessor, accessed_at)
				 VALUES ($1, $2, NOW())
				 ON CONFLICT (slug, accessor, accessed_at) DO NOTHING`,
				[slug, accessor],
			);
		} catch {
			// Non-fatal; continue
		}
	}

	/**
	 * Get project database DSN for a given slug (tenant_dsn class).
	 * Records access in audit log.
	 */
	async getProjectDb(slug: string): Promise<string> {
		this.recordTenantDsnAccess(slug, "config.getProjectDb");

		// Placeholder: in production, this queries the pool registry (P497)
		// For now, return a synthetic DSN that would be resolved by P497
		const controlDsn = this.getControlDsn();
		return `project://${slug}?control=${encodeURIComponent(controlDsn)}`;
	}

	/**
	 * Clear the cache (useful for testing or after config reload).
	 */
	clear(): void {
		this.cache.clear();
		this.dbCache.clear();
		this.cachedControlDsn = null;
	}

	/**
	 * Reload from DB on pg_notify event.
	 */
	async reload(): Promise<void> {
		this.clear();
	}

	/**
	 * Get current audit log.
	 */
	getAudit(): ConfigAuditEntry[] {
		return [...this.audit.values()];
	}

	/**
	 * Get tenant_dsn audit log.
	 */
	getTenantDsnAudit(): TenantDsnAuditEntry[] {
		return [...this.tenantDsnAudit.values()];
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
			// Query depends on table structure; this is a simplified version
			// In real implementation, would need to handle schema-qualified queries
			const result = await this.pool.query(
				`SELECT ${column} FROM ${table} LIMIT 1`,
			);
			const value = result.rows[0]?.[column];
			this.dbCache.set(cacheKey, value);
			return value;
		} catch {
			// Table doesn't exist or query failed; continue
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
				this.notifySubscription.release();
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
 * Call once at process startup. If called multiple times, creates a new resolver.
 */
export async function initConfig(opts: {
	yamlConfig?: Record<string, any>;
	pool?: Pool;
	envFilePath?: string;
}): Promise<ConfigResolver> {
	// Close the previous resolver if it exists
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
 * Throws if not yet initialized.
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
 */
export async function get<T>(key: ConfigKey<T>): Promise<T> {
	return getResolver().get(key);
}

/**
 * Get an optional config value.
 */
export async function getOptional<T>(
	key: ConfigKey<T | undefined>,
): Promise<T | undefined> {
	return getResolver().getOptional(key);
}

/**
 * Get the control database DSN (for bootstrap).
 */
export function getControlDsn(): string {
	return getResolver().getControlDsn();
}

/**
 * Get project database DSN for a given slug (tenant_dsn class).
 * Records access in audit log.
 */
export async function getProjectDb(slug: string): Promise<string> {
	return getResolver().getProjectDb(slug);
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
 * Get tenant_dsn audit log.
 */
export function getTenantDsnAudit(): TenantDsnAuditEntry[] {
	if (!globalResolver) return [];
	return globalResolver.getTenantDsnAudit();
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
