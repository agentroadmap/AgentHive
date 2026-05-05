/**
 * Canonical configuration resolver with class-based source enforcement.
 *
 * Resolution order (immutable, enforced by class):
 * 1. Explicit override (constructor arg, CLI --flag)
 * 2. Process env var
 * 3. Process env file loaded at startup (/etc/agenthive/env) — instance-local, does NOT mutate process.env
 * 4. roadmap.yaml (structural defaults; file-level)
 * 5. Control DB registry (control_runtime.host, control_runtime.flags, etc.) — Phase 2 (P827)
 * 6. Feature flag (when applicable; runtime_flag table) — Phase 2 (P827)
 * 7. Throw RuntimeConfigMissing — no silent default
 *
 * Classification (CONSTRAINT, not suggestion — resolver must enforce):
 * - `secret`: env only (1–3) | PGPASSWORD, OAUTH_CLIENT_SECRET — NEVER cached in-process
 * - `structural`: yaml (4) with env override (1-3) | PGHOST, PGPORT, project_root
 * - `registry`: DB (5) with env override (1-3) | host_model_policy, model_routes — Phase 2
 * - `flag`: DB (6) | feature flags, cached per process — Phase 2
 *
 * Usage:
 *   const port = config.get(StructuralKeys.PGPORT);
 *   const token = config.getOptional(SecretKeys.GITHUB_TOKEN);
 *   config.reload(); // Live reload on pg_notify
 *   config.audit(); // Get access audit log
 */

import type { Pool, PoolClient } from "pg";

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
 * RuntimeConfigInvalidSource: thrown when a key is read from a disallowed source.
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
 * Internal cache for resolved config values.
 */
interface CachedValue<T> {
	value: T;
	source: "env" | "yaml" | "db" | "default";
	resolvedAt: Date;
}

class ConfigResolver {
	private cache: Map<string, CachedValue<unknown>> = new Map();
	private audit: Map<string, ConfigAuditEntry> = new Map();
	private envFileVars: Map<string, string> = new Map();
	private yamlConfig: Record<string, unknown> | null = null;
	private pool: Pool | null = null;
	private dbCache: Map<string, unknown> = new Map();
	private notifySubscription: PoolClient | null = null;

	/**
	 * Parse ~/.pgpass for a matching password entry.
	 * Format: hostname:port:database:username:password (colons escaped as \:)
	 */
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

	/**
	 * Synchronously resolve the DB password for the given connection params.
	 * Resolution order: ~/.pgpass file match → PGPASSWORD env → undefined
	 * pgpass wins over env so that stale PGPASSWORD values in the environment
	 * don't shadow a correctly-configured pgpass file.
	 * Used by pool.ts startup IIFE where async resolution is not available.
	 */
	static resolvePasswordSync(opts: {
		host: string;
		port: string;
		database: string;
		user: string;
		pgpassPath?: string;
	}): string | undefined {
		const pgpassPath = opts.pgpassPath ??
			(process.env.PGPASSFILE ||
			 ((process.env.HOME || "") + "/.pgpass"));
		const fromPgpass = ConfigResolver.parsePgpassFile(
			pgpassPath,
			opts.host,
			opts.port,
			opts.database,
			opts.user,
		);
		if (fromPgpass !== undefined) return fromPgpass;
		return process.env.PGPASSWORD || undefined;
	}

	/**
	 * Initialize the resolver with optional yaml config and database pool.
	 */
	async init(opts: {
		yamlConfig?: Record<string, unknown>;
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
	 * Stores in instance-local map — does NOT mutate global process.env.
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
					this.envFileVars.set(key, rawValue);
				}
			}
		} catch (err) {
			if (err instanceof Error && err.message.includes("[Config] Env file")) {
				throw err;
			}
		}
	}

	/**
	 * Set up a NOTIFY listener for config change events.
	 * Listens on runtime_flag_changed and runtime_endpoint_changed channels.
	 */
	private async setupNotifyListener(): Promise<void> {
		if (!this.pool) return;
		try {
			const client = await this.pool.connect();
			await client.query("LISTEN runtime_flag_changed");
			await client.query("LISTEN runtime_endpoint_changed");
			client.on("notification", () => {
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
		// Non-secret keys: check cache first (secrets never cached — heap dump risk)
		if (key.class !== "secret") {
			const cachedValue = this.cache.get(key.name);
			if (cachedValue !== undefined) {
				const auditEntry = this.audit.get(key.name);
				if (auditEntry) {
					auditEntry.lastAccessedAt = new Date();
					auditEntry.accessCount++;
				}
				return cachedValue as CachedValue<T>;
			}
		}

		let value: T | undefined;
		let source: "env" | "yaml" | "db" | "default" = "default";

		// Step 2: Process env var (highest priority)
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

		// Step 3: Env file vars (instance-local; does not override process.env)
		if (value === undefined) {
			const fileValue = this.envFileVars.get(key.name);
			if (fileValue !== undefined) {
				try {
					value = key.parse(fileValue);
					source = "env";
				} catch (err) {
					throw new RuntimeConfigMissing(
						key.name,
						key.class,
						`Invalid env file value: ${fileValue}\n${(err as Error).message}`,
					);
				}
			}
		}

		// Step 4: roadmap.yaml (structural only)
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

		// Steps 5-6: DB registry / flags — Phase 2 stub (P827)
		if (
			value === undefined &&
			(key.class === "registry" || key.class === "flag") &&
			key.dbTable &&
			this.pool
		) {
			const dbValue = await this.getDbValue(
				key.dbTable,
				key.dbColumn || key.name,
			);
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

		// Step 7: Default value
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

		// Enforce: secret keys must not resolve from yaml or DB
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

		// Secret keys are never stored in-process cache (heap dump risk)
		if (key.class !== "secret") {
			this.cache.set(key.name, cached);
		}

		const auditEntry = this.audit.get(key.name) || {
			keyName: key.name,
			keyClass: key.class,
			lastAccessedAt: new Date(),
			source,
			accessCount: 0,
		};
		auditEntry.lastAccessedAt = new Date();
		auditEntry.accessCount++;
		this.audit.set(key.name, auditEntry);

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
	private getYamlValue(path: string): unknown {
		if (!this.yamlConfig) return undefined;
		const parts = path.split(".");
		let current: unknown = this.yamlConfig;
		for (const part of parts) {
			if (current === null || typeof current !== "object") {
				return undefined;
			}
			current = (current as Record<string, unknown>)[part];
		}
		return current;
	}

	/**
	 * Phase 2 stub: DB registry/flag resolution deferred to P827.
	 * P827 will replace this with schema-aware parameterized queries.
	 */
	private async getDbValue(_table: string, _column: string): Promise<unknown> {
		return undefined;
	}

	/**
	 * Cleanup: close NOTIFY subscription.
	 */
	async cleanup(): Promise<void> {
		if (this.notifySubscription) {
			try {
				await this.notifySubscription.query("UNLISTEN runtime_flag_changed");
				await this.notifySubscription.query(
					"UNLISTEN runtime_endpoint_changed",
				);
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
	yamlConfig?: Record<string, unknown>;
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
 * Get the global resolver instance. Throws if not yet initialized.
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

// Convenience re-exports for the synchronous resolution path used by pool.ts
export const resolvePasswordSync = ConfigResolver.resolvePasswordSync.bind(ConfigResolver);
