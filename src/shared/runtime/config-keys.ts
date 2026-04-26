/**
 * Configuration key registry for the canonical resolver.
 *
 * Each ConfigKey declares:
 * - name: The key identifier (env var name, yaml path, DB column)
 * - class: The resolution class (secret|structural|registry|flag)
 * - parse: Parser function (string -> typed value)
 * - required: Whether missing key throws RuntimeConfigMissing
 *
 * This is the single source of truth for all configuration keys used in AgentHive.
 */

import type { ConfigKey } from "./config";

/**
 * Secret keys: env only, never from yaml/DB. PGPASSWORD, OAUTH_CLIENT_SECRET, etc.
 */
export const SecretKeys = {
	PGPASSWORD: {
		name: "PGPASSWORD",
		class: "secret" as const,
		parse: (v: string) => v,
		required: true,
		description: "PostgreSQL password for agenthive database",
	} satisfies ConfigKey<string>,

	DISCORD_BOT_TOKEN: {
		name: "DISCORD_BOT_TOKEN",
		class: "secret" as const,
		parse: (v: string) => v,
		required: false,
		description: "Discord bot token for bridge integration",
	} satisfies ConfigKey<string | undefined>,

	GITHUB_TOKEN: {
		name: "GITHUB_TOKEN",
		class: "secret" as const,
		parse: (v: string) => v,
		required: false,
		description: "GitHub personal access token",
	} satisfies ConfigKey<string | undefined>,
};

/**
 * Structural keys: yaml canonical with env override.
 * Database connection, ports, paths, endpoints.
 */
export const StructuralKeys = {
	PGHOST: {
		name: "PGHOST",
		class: "structural" as const,
		parse: (v: string) => v,
		required: true,
		description: "PostgreSQL hostname",
		yamlPath: "database.host",
		envOverride: true,
		defaultValue: "127.0.0.1",
	} satisfies ConfigKey<string>,

	PGPORT: {
		name: "PGPORT",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
				throw new Error(`Invalid port number: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "PostgreSQL port",
		yamlPath: "database.port",
		envOverride: true,
		defaultValue: 5432,
	} satisfies ConfigKey<number>,

	PGDATABASE: {
		name: "PGDATABASE",
		class: "structural" as const,
		parse: (v: string) => v,
		required: true,
		description: "PostgreSQL database name",
		yamlPath: "database.name",
		envOverride: true,
		defaultValue: "agenthive",
	} satisfies ConfigKey<string>,

	PGUSER: {
		name: "PGUSER",
		class: "structural" as const,
		parse: (v: string) => v,
		required: true,
		description: "PostgreSQL username",
		yamlPath: "database.user",
		envOverride: true,
		defaultValue: "xiaomi",
	} satisfies ConfigKey<string>,

	PG_SCHEMA: {
		name: "PG_SCHEMA",
		class: "structural" as const,
		parse: (v: string) => {
			const trimmed = v.trim();
			if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
				throw new Error(`Invalid schema name: ${trimmed}`);
			}
			return trimmed;
		},
		required: false,
		description: "PostgreSQL schema name",
		yamlPath: "database.schema",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	AGENTHIVE_MCP_URL: {
		name: "AGENTHIVE_MCP_URL",
		class: "structural" as const,
		parse: (v: string) => {
			try {
				new URL(v);
				return v;
			} catch {
				throw new Error(`Invalid MCP URL: ${v}`);
			}
		},
		required: true,
		description: "MCP server endpoint URL",
		yamlPath: "mcp.url",
		envOverride: true,
	} satisfies ConfigKey<string>,

	AGENTHIVE_DAEMON_URL: {
		name: "AGENTHIVE_DAEMON_URL",
		class: "structural" as const,
		parse: (v: string) => {
			try {
				new URL(v);
				return v;
			} catch {
				throw new Error(`Invalid daemon URL: ${v}`);
			}
		},
		required: false,
		description: "Daemon endpoint URL",
		yamlPath: "daemon.url",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	PROJECT_ROOT: {
		name: "PROJECT_ROOT",
		class: "structural" as const,
		parse: (v: string) => v,
		required: true,
		description: "AgentHive project root directory",
		yamlPath: "project.project_root",
		envOverride: true,
	} satisfies ConfigKey<string>,

	PG_CONNECTION_TIMEOUT_MS: {
		name: "PG_CONNECTION_TIMEOUT_MS",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid connection timeout: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "PostgreSQL connection timeout in ms",
		envOverride: true,
		defaultValue: 5000,
	} satisfies ConfigKey<number>,

	PG_QUERY_TIMEOUT_MS: {
		name: "PG_QUERY_TIMEOUT_MS",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid query timeout: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "PostgreSQL query timeout in ms",
		envOverride: true,
		defaultValue: 30000,
	} satisfies ConfigKey<number>,

	PG_STATEMENT_TIMEOUT_MS: {
		name: "PG_STATEMENT_TIMEOUT_MS",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid statement timeout: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "PostgreSQL statement timeout in ms",
		envOverride: true,
		defaultValue: 30000,
	} satisfies ConfigKey<number>,

	AGENTHIVE_WORKTREE_ROOT: {
		name: "AGENTHIVE_WORKTREE_ROOT",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Root directory for git worktrees",
		yamlPath: "paths.worktree_root",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	AGENTHIVE_HOST: {
		name: "AGENTHIVE_HOST",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Logical host identifier (shared operator host name)",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	AGENTHIVE_CONTROL_DSN: {
		name: "AGENTHIVE_CONTROL_DSN",
		class: "structural" as const,
		parse: (v: string) => v,
		required: true,
		description: "Control database DSN (hiveControl connection)",
		yamlPath: "databases.control",
		envOverride: true,
	} satisfies ConfigKey<string>,

	CONTROL_DB_HOST: {
		name: "CONTROL_DB_HOST",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Control database hostname",
		yamlPath: "databases.control.host",
		defaultValue: "127.0.0.1",
	} satisfies ConfigKey<string>,

	CONTROL_DB_PORT: {
		name: "CONTROL_DB_PORT",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
				throw new Error(`Invalid port number: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Control database port (PgBouncer)",
		yamlPath: "databases.control.port",
		defaultValue: 6432,
	} satisfies ConfigKey<number>,

	CONTROL_DB_NAME: {
		name: "CONTROL_DB_NAME",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Control database name",
		yamlPath: "databases.control.name",
		defaultValue: "hiveControl",
	} satisfies ConfigKey<string>,

	CONTROL_DB_ROLE: {
		name: "CONTROL_DB_ROLE",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Control database role",
		yamlPath: "databases.control.role",
		defaultValue: "agenthive_admin",
	} satisfies ConfigKey<string>,

	CONTROL_DB_PASSWORD_REF: {
		name: "CONTROL_DB_PASSWORD_REF",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Vault path for control DB password (from P496)",
		yamlPath: "databases.control.password_ref",
		envOverride: true,
		defaultValue: "vault://file/control/db_password",
	} satisfies ConfigKey<string>,

	AGENTHIVE_VAULT_ROOT: {
		name: "AGENTHIVE_VAULT_ROOT",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Vault file root directory (P496)",
		yamlPath: "vault.root",
		defaultValue: "/etc/agenthive/secrets",
	} satisfies ConfigKey<string>,

	AGENTHIVE_VAULT_KIND: {
		name: "AGENTHIVE_VAULT_KIND",
		class: "structural" as const,
		parse: (v: string) => {
			if (!["file", "aws", "gcp"].includes(v)) {
				throw new Error(`Invalid vault kind: ${v}. Must be file, aws, or gcp`);
			}
			return v;
		},
		required: false,
		description: "Vault adapter kind (P496/P515)",
		yamlPath: "vault.kind",
		defaultValue: "file",
	} satisfies ConfigKey<string>,

	AGENTHIVE_TENANT_POOL_LRU_MAX: {
		name: "AGENTHIVE_TENANT_POOL_LRU_MAX",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid LRU max: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "LRU cap for tenant pool registry (P497)",
		yamlPath: "pools.tenant_lru_max",
		defaultValue: 16,
	} satisfies ConfigKey<number>,

	AGENTHIVE_TENANT_POOL_MAX: {
		name: "AGENTHIVE_TENANT_POOL_MAX",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid pool max: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Per-pool size for tenant pools (P497)",
		yamlPath: "pools.tenant_max",
		defaultValue: 8,
	} satisfies ConfigKey<number>,

	AGENTHIVE_DRAIN_TIMEOUT_MS: {
		name: "AGENTHIVE_DRAIN_TIMEOUT_MS",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid drain timeout: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Pool drain grace period in ms (P497)",
		yamlPath: "pools.drain_timeout_ms",
		defaultValue: 30000,
	} satisfies ConfigKey<number>,

	AGENTHIVE_PG_PORT: {
		name: "AGENTHIVE_PG_PORT",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
				throw new Error(`Invalid port number: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "PostgreSQL direct port (P499)",
		yamlPath: "databases.pg_port",
		defaultValue: 6432,
	} satisfies ConfigKey<number>,

	AGENTHIVE_LISTEN_PORT: {
		name: "AGENTHIVE_LISTEN_PORT",
		class: "structural" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
				throw new Error(`Invalid port number: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "LISTEN bypass port (P499)",
		yamlPath: "databases.listen_port",
		defaultValue: 5432,
	} satisfies ConfigKey<number>,
};

/**
 * Registry keys: DB canonical with env override.
 * Feature flags, host/model policies, runtime settings from control_runtime table.
 */
export const RegistryKeys = {
	AGENTHIVE_DEFAULT_PROVIDER: {
		name: "AGENTHIVE_DEFAULT_PROVIDER",
		class: "registry" as const,
		parse: (v: string) => v,
		required: false,
		description: "Default model provider (Claude, Codex, etc)",
		dbTable: "control_runtime.host",
		dbColumn: "default_provider",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	AGENTHIVE_USE_OFFER_DISPATCH: {
		name: "AGENTHIVE_USE_OFFER_DISPATCH",
		class: "registry" as const,
		parse: (v: string) => v.toLowerCase() === "true" || v === "1",
		required: false,
		description: "Enable offer-dispatch workflow",
		dbTable: "control_runtime.flags",
		dbColumn: "use_offer_dispatch",
		envOverride: true,
	} satisfies ConfigKey<boolean>,
};

/**
 * Feature flag keys: DB sourced, cached per process, live-reloadable via pg_notify.
 */
export const FlagKeys = {
	// Currently feature flags are handled as generic registry entries in control_runtime.flags
	// Add specific flag keys here as needed
};

/**
 * Debug/diagnostic keys: env only, no parsing.
 */
export const DiagnosticKeys = {
	DEBUG: {
		name: "DEBUG",
		class: "secret" as const,
		parse: (v: string) => v.toLowerCase() === "true" || v === "1",
		required: false,
		description: "Enable debug logging",
	} satisfies ConfigKey<boolean>,

	DEBUG_PG: {
		name: "DEBUG_PG",
		class: "secret" as const,
		parse: (v: string) => v.toLowerCase() === "true" || v === "1",
		required: false,
		description: "Enable PostgreSQL debug logging",
	} satisfies ConfigKey<boolean>,

	DEBUG_STATE_NAMES: {
		name: "DEBUG_STATE_NAMES",
		class: "secret" as const,
		parse: (v: string) => v.toLowerCase() === "true" || v === "1",
		required: false,
		description: "Enable state-names registry debug logging",
	} satisfies ConfigKey<boolean>,
};

/**
 * Merge all keys into a single registry for introspection.
 */
export const AllConfigKeys = {
	...SecretKeys,
	...StructuralKeys,
	...RegistryKeys,
	...FlagKeys,
	...DiagnosticKeys,
} as const;

/**
 * Get a config key by name. Throws if key not found.
 */
export function getConfigKeyByName(name: string): ConfigKey<any> {
	const key = AllConfigKeys[name as keyof typeof AllConfigKeys];
	if (!key) {
		throw new Error(
			`[Config] Unknown configuration key: ${name}. ` +
			`Known keys: ${Object.keys(AllConfigKeys).join(", ")}`,
		);
	}
	return key;
}
