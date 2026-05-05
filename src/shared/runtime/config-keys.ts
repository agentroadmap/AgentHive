/**
 * Configuration key registry for the canonical resolver.
 *
 * Each ConfigKey declares:
 * - name: The key identifier (env var name, yaml path, DB column)
 * - class: The resolution class (secret|structural|registry|flag|tenant_dsn)
 * - parse: Parser function (string -> typed value)
 * - required: Whether missing key throws RuntimeConfigMissing
 *
 * This is the single source of truth for all configuration keys used in AgentHive.
 *
 * P498 additions: tenant_dsn class, AGENTHIVE_CONTROL_DSN (with assembleFromYaml),
 * control topology keys, vault keys, pool tuning keys.
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
		parse: (v: string) => {
			try {
				const u = new URL(v);
				if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
					throw new Error("not a postgres URL");
				}
				return v;
			} catch {
				throw new Error(`AGENTHIVE_CONTROL_DSN is not a valid postgres:// connection string: ${v}`);
			}
		},
		required: false,
		description: "Override DSN for control-plane pool (P518 hiveControl cutover). When set, supersedes individual PGHOST/PGPORT/PGUSER/PGDATABASE env vars for the control pool.",
		envOverride: true,
		assembleFromYaml: (yaml: Record<string, any>) => {
			const ctrl = yaml?.databases?.control;
			if (!ctrl) return undefined;
			const host = ctrl.host ?? "127.0.0.1";
			const port = ctrl.port ?? 5432;
			const name = ctrl.name;
			if (!name) return undefined;
			const role = ctrl.role ?? process.env.PGUSER ?? "xiaomi";
			// Password must come from env (secret); skip assembly if unavailable.
			const pass = process.env.PGPASSWORD;
			if (!pass) return undefined;
			return `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(pass)}@${host}:${port}/${encodeURIComponent(name)}`;
		},
	} satisfies ConfigKey<string | undefined>,

	AGENTHIVE_TENANT_POOL_LRU_MAX: {
		name: "AGENTHIVE_TENANT_POOL_LRU_MAX",
		class: "structural" as const,
		parse: (v: string) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(`AGENTHIVE_TENANT_POOL_LRU_MAX must be a positive integer, got: ${v}`);
			}
			return Math.trunc(n);
		},
		required: false,
		description: "Maximum number of concurrently cached tenant pools in the LRU registry (default: 16). Oldest pool is evicted when the cap is reached.",
		envOverride: true,
		defaultValue: 16,
	} satisfies ConfigKey<number>,

	PGPORT_DIRECT: {
		name: "PGPORT_DIRECT",
		class: "structural" as const,
		parse: (v: string) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0 || n > 65535) {
				throw new Error(`Invalid PGPORT_DIRECT port number: ${v}`);
			}
			return n;
		},
		required: false,
		description: "Direct Postgres port, bypassing PgBouncer (used for LISTEN connections when P499 is deployed). Defaults to PGPORT when not set.",
		envOverride: true,
	} satisfies ConfigKey<number | undefined>,
};

/**
 * Control topology keys: individual components of the control-plane DSN.
 * Yaml canonical (databases.control.*) with env override.
 * Used when AGENTHIVE_CONTROL_DSN is not set directly.
 */
export const ControlTopologyKeys = {
	CONTROL_DB_HOST: {
		name: "CONTROL_DB_HOST",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Control-plane DB hostname (read from databases.control.host in roadmap.yaml)",
		yamlPath: "databases.control.host",
		envOverride: true,
		defaultValue: "127.0.0.1",
	} satisfies ConfigKey<string>,

	CONTROL_DB_PORT: {
		name: "CONTROL_DB_PORT",
		class: "structural" as const,
		parse: (v: string) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0 || n > 65535) {
				throw new Error(`Invalid CONTROL_DB_PORT: ${v}`);
			}
			return n;
		},
		required: false,
		description: "Control-plane DB port",
		yamlPath: "databases.control.port",
		envOverride: true,
		defaultValue: 5432,
	} satisfies ConfigKey<number>,

	CONTROL_DB_NAME: {
		name: "CONTROL_DB_NAME",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Control-plane database name (default: hiveControl)",
		yamlPath: "databases.control.name",
		envOverride: true,
		defaultValue: "hiveControl",
	} satisfies ConfigKey<string>,

	CONTROL_DB_ROLE: {
		name: "CONTROL_DB_ROLE",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "PostgreSQL role (user) for the control-plane connection",
		yamlPath: "databases.control.role",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	CONTROL_DB_PASSWORD_REF: {
		name: "CONTROL_DB_PASSWORD_REF",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Vault reference name for the control DB password (default: PGPASSWORD). The vault resolves this ref to the actual secret value.",
		yamlPath: "databases.control.password_ref",
		envOverride: true,
		defaultValue: "PGPASSWORD",
	} satisfies ConfigKey<string>,
};

/**
 * Vault keys: vault implementation configuration.
 * Yaml canonical (vault.*) with env override.
 */
export const VaultKeys = {
	AGENTHIVE_VAULT_ROOT: {
		name: "AGENTHIVE_VAULT_ROOT",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Vault root path (e.g. /run/agenthive/secrets or HashiCorp Vault mount path)",
		yamlPath: "vault.root",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	AGENTHIVE_VAULT_KIND: {
		name: "AGENTHIVE_VAULT_KIND",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Vault implementation kind: env | file | hashicorp (default: env)",
		yamlPath: "vault.kind",
		envOverride: true,
		defaultValue: "env",
	} satisfies ConfigKey<string>,
};

/**
 * Pool tuning keys: connection pool sizing and timeout overrides.
 * All env-only (no yaml path) — operational knobs set per-host.
 */
export const PoolTuningKeys = {
	AGENTHIVE_TENANT_POOL_MAX: {
		name: "AGENTHIVE_TENANT_POOL_MAX",
		class: "structural" as const,
		parse: (v: string) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(`AGENTHIVE_TENANT_POOL_MAX must be a positive integer, got: ${v}`);
			}
			return Math.trunc(n);
		},
		required: false,
		description: "Max connections per tenant pool (default: 8)",
		envOverride: true,
		defaultValue: 8,
	} satisfies ConfigKey<number>,

	AGENTHIVE_DRAIN_TIMEOUT_MS: {
		name: "AGENTHIVE_DRAIN_TIMEOUT_MS",
		class: "structural" as const,
		parse: (v: string) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(`AGENTHIVE_DRAIN_TIMEOUT_MS must be positive, got: ${v}`);
			}
			return n;
		},
		required: false,
		description: "Pool drain grace period in ms (default: 30000)",
		envOverride: true,
		defaultValue: 30_000,
	} satisfies ConfigKey<number>,

	AGENTHIVE_PG_PORT: {
		name: "AGENTHIVE_PG_PORT",
		class: "structural" as const,
		parse: (v: string) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0 || n > 65535) {
				throw new Error(`Invalid AGENTHIVE_PG_PORT: ${v}`);
			}
			return n;
		},
		required: false,
		description: "Process-wide Postgres port override for AgentHive components (takes precedence over PGPORT)",
		envOverride: true,
	} satisfies ConfigKey<number | undefined>,

	AGENTHIVE_LISTEN_PORT: {
		name: "AGENTHIVE_LISTEN_PORT",
		class: "structural" as const,
		parse: (v: string) => {
			const n = Number(v);
			if (!Number.isFinite(n) || n <= 0 || n > 65535) {
				throw new Error(`Invalid AGENTHIVE_LISTEN_PORT: ${v}`);
			}
			return n;
		},
		required: false,
		description: "MCP server listen port (default: 6421)",
		yamlPath: "mcp.port",
		envOverride: true,
		defaultValue: 6421,
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
	...ControlTopologyKeys,
	...VaultKeys,
	...PoolTuningKeys,
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
