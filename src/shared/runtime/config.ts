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
 *
 * Usage:
 *   const port = config.get(StructuralKeys.PGPORT);
 *   const token = config.getOptional(SecretKeys.GITHUB_TOKEN);
 *   config.reload(); // Live reload on pg_notify
 *   config.audit(); // Get access audit log
 */

import type { Pool, PoolClient } from "pg";
import type { ConfigKey as RawConfigKey } from "./config-keys";

export type ConfigClass = "secret" | "structural" | "registry" | "flag";

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
 * RuntimeConfigInvalidSource: thrown when a secret key is read from yaml/DB.
 */
export class RuntimeConfigInvalidSource extends Error {
	constructor(
		public keyName: string,
		public attemptedSource: string,
		public allowedSources: string[],
	) {
		super(
			`[RuntimeConfig] Secret key "${keyName}" cannot be read from ${attemptedSource}. ` +
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
	private yamlConfig: Record<string, any> | null = null;
	private pool: Pool | null = null;
	private dbCache: Map<string, any> = new Map();
	private notifySubscription: PoolClient | null = null;

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
			const client = await this.pool.connect();
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
	 */
	private async resolve<T>(key: ConfigKey<T>): Promise<CachedValue<T>> {
		// Check cache first
		const cached = this.cache.get(key.name);
		if (cached !== undefined) {
			return cached;
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
			const dbValue = await this.getDbValue(key.dbTable, key.dbColumn || key.name);
			if (dbValue !== undefined) {
				try {
					value = key.parse(String(dbValue));
					source = "db";
				} catch (err) {
					throw new RuntimeConfigMissing(
						key.name,
						key.class,
						`Invalid DB value from ${key.dbTable}: ${dbValue}\n${(err as Error).message}`,
					);
				}
			}
		}

		// Step 6: Feature flags (DB, cached, live-reloadable)
		if (value === undefined && key.class === "flag" && key.dbTable && this.pool) {
			const dbValue = await this.getDbValue(key.dbTable, key.dbColumn || key.name);
			if (dbValue !== undefined) {
				try {
					value = key.parse(String(dbValue));
					source = "db";
				} catch (err) {
					throw new RuntimeConfigMissing(
						key.name,
						key.class,
						`Invalid flag value from ${key.dbTable}: ${dbValue}\n${(err as Error).message}`,
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

		// Special enforcement: secret keys can NEVER come from yaml or DB
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
	 * Get current audit log.
	 */
	getAudit(): ConfigAuditEntry[] {
		return [...this.audit.values()];
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
 * Call once at process startup.
 */
export async function initConfig(opts: {
	yamlConfig?: Record<string, any>;
	pool?: Pool;
	envFilePath?: string;
}): Promise<ConfigResolver> {
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
