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

import type { ConfigKey, ConfigKeyCategory } from "./config";

export type { ConfigKeyCategory };

/**
 * Secret keys: env only, never from yaml/DB. PGPASSWORD, OAUTH_CLIENT_SECRET, etc.
 */
export const SecretKeys = {
	PGPASSWORD: {
		name: "PGPASSWORD",
		class: "secret" as const,
		parse: (v: string) => v,
		required: false,
		description:
			"PostgreSQL password (rely on .pgpass / libpq implicit auth if not set)",
	} satisfies ConfigKey<string | undefined>,

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
		// P448: no defaultValue — PGUSER is deployment-specific, must be explicit
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

	PGSERVICE: {
		name: "PGSERVICE",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description:
			"PostgreSQL service name (.pgpass/.pg_service.conf) for connection",
		envOverride: true,
	} satisfies ConfigKey<string | undefined>,

	PGPASSFILE: {
		name: "PGPASSFILE",
		class: "structural" as const,
		parse: (v: string) => v,
		required: false,
		description: "Path to .pgpass file for implicit PostgreSQL auth",
		yamlPath: "database.pgpass_path",
		envOverride: true,
		defaultValue: "~/.pgpass",
	} satisfies ConfigKey<string>,

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
		description:
			"Direct Postgres port, bypassing PgBouncer (used for LISTEN connections when P499 is deployed). Defaults to PGPORT when not set.",
		envOverride: true,
	} satisfies ConfigKey<number | undefined>,
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
		dbTable: "control_model.model_route",
		dbColumn: "default_provider",
		envOverride: false,
	} satisfies ConfigKey<string | undefined>,

	PROJECT_SCHEMA_NAME: {
		name: "PROJECT_SCHEMA_NAME",
		class: "registry" as const,
		parse: (v: string) => {
			const trimmed = v.trim();
			if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(trimmed)) {
				throw new Error(`Invalid schema name: ${trimmed}`);
			}
			return trimmed;
		},
		required: false,
		description: "Project database schema name",
		dbTable: "control_project.project",
		dbColumn: "schema_name",
		envOverride: false,
	} satisfies ConfigKey<string | undefined>,

	PROJECT_TOKEN_BUDGET: {
		name: "PROJECT_TOKEN_BUDGET",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error(`Invalid token budget: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Project token budget for API calls",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	PROJECT_MAX_CONCURRENT_LEASES: {
		name: "PROJECT_MAX_CONCURRENT_LEASES",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid max concurrent leases: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Maximum concurrent leases for a project",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	PROJECT_DEFAULT_WORKFLOW: {
		name: "PROJECT_DEFAULT_WORKFLOW",
		class: "registry" as const,
		parse: (v: string) => v,
		required: false,
		description: "Default workflow type for project proposals",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<string | undefined>,

	PROJECT_SPENDING_THRESHOLD_WARN: {
		name: "PROJECT_SPENDING_THRESHOLD_WARN",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = parseFloat(v);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error(`Invalid spending threshold: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Project spending threshold for warnings (in currency units)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	PROJECT_SPENDING_THRESHOLD_HARD: {
		name: "PROJECT_SPENDING_THRESHOLD_HARD",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = parseFloat(v);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error(`Invalid spending threshold: ${v}`);
			}
			return parsed;
		},
		required: false,
		description:
			"Project spending threshold for hard limits (in currency units)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	PROJECT_KB_EMBEDDING_MODEL: {
		name: "PROJECT_KB_EMBEDDING_MODEL",
		class: "registry" as const,
		parse: (v: string) => v,
		required: false,
		description: "Knowledge base embedding model",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
		defaultValue: "text-embedding-3-small",
	} satisfies ConfigKey<string>,

	MODEL_CONTEXT_WINDOW: {
		name: "MODEL_CONTEXT_WINDOW",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = Number(v);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid context window: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Model context window in tokens",
		dbTable: "control_model.model",
		dbColumn: "context_window_tokens",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	MODEL_COST_PER_INPUT_TOKEN: {
		name: "MODEL_COST_PER_INPUT_TOKEN",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = parseFloat(v);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error(`Invalid cost: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Cost per million input tokens",
		dbTable: "control_model.model",
		dbColumn: "cost_per_million_input",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	MODEL_COST_PER_OUTPUT_TOKEN: {
		name: "MODEL_COST_PER_OUTPUT_TOKEN",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = parseFloat(v);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error(`Invalid cost: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Cost per million output tokens",
		dbTable: "control_model.model",
		dbColumn: "cost_per_million_output",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	MODEL_MAX_SPEND_PER_CALL: {
		name: "MODEL_MAX_SPEND_PER_CALL",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = parseFloat(v);
			if (!Number.isFinite(parsed) || parsed < 0) {
				throw new Error(`Invalid max spend: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Maximum spend per model API call",
		dbTable: "control_model.host_model_policy",
		dbColumn: "max_spend_per_call",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	MODEL_PREFERRED_PROVIDER: {
		name: "MODEL_PREFERRED_PROVIDER",
		class: "registry" as const,
		parse: (v: string) => v,
		required: false,
		description: "Preferred model provider for routing",
		dbTable: "control_model.model_route",
		dbColumn: "preferred_provider",
		envOverride: false,
	} satisfies ConfigKey<string | undefined>,

	MODEL_FALLBACK_MODEL_ID: {
		name: "MODEL_FALLBACK_MODEL_ID",
		class: "registry" as const,
		parse: (v: string) => v,
		required: false,
		description: "Fallback model ID for routing failures",
		dbTable: "control_model.model_route",
		dbColumn: "fallback_model_id",
		envOverride: false,
	} satisfies ConfigKey<string | undefined>,

	MODEL_DEFAULT_TEMPERATURE: {
		name: "MODEL_DEFAULT_TEMPERATURE",
		class: "registry" as const,
		parse: (v: string) => {
			const parsed = parseFloat(v);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
				throw new Error(`Invalid temperature: ${v}`);
			}
			return parsed;
		},
		required: false,
		description: "Default temperature for model requests",
		dbTable: "control_model.model_route",
		dbColumn: "default_temperature",
		envOverride: false,
	} satisfies ConfigKey<number | undefined>,

	MODEL_ALLOWED_HOST_POLICY: {
		name: "MODEL_ALLOWED_HOST_POLICY",
		class: "registry" as const,
		parse: (v: string) => v,
		required: false,
		description: "Allowed host policy for model routing",
		dbTable: "control_model.host_model_policy",
		dbColumn: "allowed_hosts",
		envOverride: false,
	} satisfies ConfigKey<string | undefined>,
};

/**
 * Feature flag keys: DB sourced, cached per process, live-reloadable via pg_notify.
 */
export const FlagKeys = {
	USE_OFFER_DISPATCH: {
		name: "USE_OFFER_DISPATCH",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			// Parse JSON or boolean string from JSONB value_jsonb
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		description: "Enable offer-dispatch workflow",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	ENABLE_MULTI_TENANT: {
		name: "ENABLE_MULTI_TENANT",
		class: "flag" as const,
		category: "feature_flag" as ConfigKeyCategory,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		description: "Enable multi-tenant mode",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	ENABLE_AUDIT_LOG: {
		name: "ENABLE_AUDIT_LOG",
		class: "flag" as const,
		category: "feature_flag" as ConfigKeyCategory,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		description: "Enable audit logging",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,


	// ─── P1132 A2A host service tunables ────────────────────────────────────
	// Seeded by scripts/migrations/167-p1132-a2a-host-flag-seeds.sql.
	// Operator changes via SQL UPDATE core.runtime_flag SET value_jsonb=...
	// Live-reload via runtime_config_changed NOTIFY (no restart).

	A2A_HOST_LISTEN_REFRESH_MS: {
		name: "A2A_HOST_LISTEN_REFRESH_MS",
		class: "flag" as const,
		category: "a2a" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_LISTEN_REFRESH_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "How often A2A re-reads agent_registry for newly-registered local agencies (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	A2A_HOST_PG_RECONNECT_MS: {
		name: "A2A_HOST_PG_RECONNECT_MS",
		class: "flag" as const,
		category: "a2a" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_PG_RECONNECT_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Backoff on PG connection loss before exit(1) (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	A2A_HOST_SHUTDOWN_TIMEOUT_MS: {
		name: "A2A_HOST_SHUTDOWN_TIMEOUT_MS",
		class: "flag" as const,
		category: "a2a" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_SHUTDOWN_TIMEOUT_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Bounded wait for fn_pulse(offline) calls during SIGTERM (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	A2A_HOST_PRESENCE_REFRESH_MS: {
		name: "A2A_HOST_PRESENCE_REFRESH_MS",
		class: "flag" as const,
		category: "a2a" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_PRESENCE_REFRESH_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "How often A2A calls fn_pulse('online') per child to keep last_heartbeat_at fresh for existing dispatchability/maintenance consumers (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,


	// ─── Liaison runtime context refresh (P1370) ────────────────────────────────
	// Seeded by a P1370 migration. Operator changes via SQL UPDATE core.runtime_flag SET value_jsonb=...
	// Live-reload via runtime_config_changed NOTIFY (no restart).

	LIAISON_CONTEXT_REFRESH_MS: {
		name: "LIAISON_CONTEXT_REFRESH_MS",
		class: "flag" as const,
		category: "a2a" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed < 1000 || parsed > 600_000) {
				throw new Error(`Invalid LIAISON_CONTEXT_REFRESH_MS: ${v}. Must be between 1000 and 600000 ms`);
			}
			return parsed;
		},
		required: false,
		defaultValue: 60_000,
		description: "Liaison context re-hydration interval (ms). Valid range: 1000-600000 (1s-10m)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<number>,

	// ─── Orchestrator runtime-tunable flags (P1144) ───────────────────────────

	ORCHESTRATOR_SCAN_BATCH_LIMIT: {
		name: "ORCHESTRATOR_SCAN_BATCH_LIMIT",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 20,
		description: "scanQueues batch size per tick",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STALL_THRESHOLD_HOURS: {
		name: "ORCHESTRATOR_STALL_THRESHOLD_HOURS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 4,
		description: "Hours before mature proposal escalated",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STALL_BATCH_LIMIT: {
		name: "ORCHESTRATOR_STALL_BATCH_LIMIT",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 5,
		description: "Max stalls processed per tick",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_OFFER_REAP_MS: {
		name: "ORCHESTRATOR_OFFER_REAP_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Offer reap interval (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_POKE_IDLE_MIN: {
		name: "ORCHESTRATOR_POKE_IDLE_MIN",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 5,
		description: "Minutes idle before poke",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_POKE_STORM_CAP: {
		name: "ORCHESTRATOR_POKE_STORM_CAP",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 10,
		description: "Max pokes per cycle",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	// Phase 1 (hot-configurable cap): global in-flight work-offer backpressure
	// limit. Read per-postWorkOffer call via config (cached + cleared on
	// runtime_flag_changed NOTIFY), so `UPDATE core.runtime_flag` takes effect on
	// the next dispatch with NO orchestrator restart. Supersedes the legacy
	// AGENTHIVE_MAX_INFLIGHT_OFFERS env const in post-work-offer.ts. Set to 0 to
	// disable backpressure entirely.
	ORCHESTRATOR_MAX_INFLIGHT_OFFERS: {
		name: "ORCHESTRATOR_MAX_INFLIGHT_OFFERS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 20,
		description: "Max global in-flight work offers (backpressure cap); 0=disabled",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_SHUTDOWN_DRAIN_MS: {
		name: "ORCHESTRATOR_SHUTDOWN_DRAIN_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 240_000,
		description: "Bounded wait for drain on SIGTERM (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_IMPLICIT_GATE_POLL_MS: {
		name: "ORCHESTRATOR_IMPLICIT_GATE_POLL_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Implicit gate poll interval (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_ENHANCER_REVISE_MS: {
		name: "ORCHESTRATOR_ENHANCER_REVISE_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 90_000,
		description: "Enhancer-revise loop interval (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_RECONCILER_MS: {
		name: "ORCHESTRATOR_RECONCILER_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Reconciler loop interval (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STALE_ROW_REAPER_MS: {
		name: "ORCHESTRATOR_STALE_ROW_REAPER_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 300_000,
		description: "Stale-row reaper interval (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STUCK_WORKER_MS: {
		name: "ORCHESTRATOR_STUCK_WORKER_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Stuck-worker watchdog interval (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_HEARTBEAT_MS: {
		name: "ORCHESTRATOR_HEARTBEAT_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Orchestrator heartbeat interval (ms)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_OFFER_CLAIM_ENABLED: {
		name: "ORCHESTRATOR_OFFER_CLAIM_ENABLED",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: true,
		description: "Kill switch: false disables offer-claim loop",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	// V3-C6 (P1438): when true, each agency liaison runs its own AgencyClaimLoop
	// (self-claim). Composes with ORCHESTRATOR_OFFER_CLAIM_ENABLED: cutover sets
	// orchestrator's loop off + this on; rollback flips both back (no code revert).
	AGENCY_OFFER_CLAIM_ENABLED: {
		name: "AGENCY_OFFER_CLAIM_ENABLED",
		class: "flag" as const,
		category: "agency" as ConfigKeyCategory,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: false,
		description: "V3-C6: true makes each agency liaison self-claim work offers",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	// ─── P1291 per-(proposal, role) pause fuse tunables ──────────────────────
	// Seeded by a P1291 migration. Operator changes via SQL UPDATE core.runtime_flag SET value_jsonb=...
	// Live-reload via runtime_config_changed NOTIFY (no restart).

	PAUSE_FAILURE_THRESHOLD: {
		name: "PAUSE_FAILURE_THRESHOLD",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid PAUSE_FAILURE_THRESHOLD: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Number of consecutive no-eligible-agency failures before first pause (P1291)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PAUSE_BASE_BACKOFF_MS: {
		name: "PAUSE_BASE_BACKOFF_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid PAUSE_BASE_BACKOFF_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Base backoff duration in milliseconds for first pause cycle (default 1800000 = 30min)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PAUSE_BACKOFF_MULTIPLIER: {
		name: "PAUSE_BACKOFF_MULTIPLIER",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed < 1) {
				throw new Error(`Invalid PAUSE_BACKOFF_MULTIPLIER: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Exponential backoff multiplier for each pause cycle (default 2)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PAUSE_MAX_BACKOFF_MS: {
		name: "PAUSE_MAX_BACKOFF_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid PAUSE_MAX_BACKOFF_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Hard cap on pause duration in milliseconds (default 86400000 = 24h)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	// ─── P1359: Provider quota cooldown + automatic route fallback ────────────

	SPAWN_PROVIDER_MAX_ATTEMPTS: {
		name: "SPAWN_PROVIDER_MAX_ATTEMPTS",
		class: "flag" as const,
		category: "agency" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error(`Invalid SPAWN_PROVIDER_MAX_ATTEMPTS: ${v}`);
			}
			return n;
		},
		required: false,
		defaultValue: 3,
		description: "Max retry attempts when spawn hits provider-specific quota (P1359)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	/**
	 * TUI cockpit layout — 'grid' (default, 2x2) or 'stacked' (single column).
	 * User-facing preference. Persisted in core.runtime_flag so a future web
	 * UI or in-TUI setting screen can update it without code changes.
	 * Env var AGENTHIVE_COCKPIT_LAYOUT overrides the DB value for local dev.
	 */
	TUI_COCKPIT_LAYOUT: {
		name: "AGENTHIVE_COCKPIT_LAYOUT",
		class: "flag" as const,
		category: "ui" as ConfigKeyCategory,
		parse: (v: string) => {
			// Accept JSON-encoded string from the DB ("\"stacked\"") and a
			// bare env value (stacked). JSON.parse handles both.
			let raw: string;
			try {
				const decoded = JSON.parse(v);
				raw = typeof decoded === "string" ? decoded : v;
			} catch {
				raw = v;
			}
			const trimmed = raw.trim().toLowerCase();
			if (trimmed !== "grid" && trimmed !== "stacked") {
				throw new Error(
					`Invalid cockpit layout: ${v}. Must be 'grid' or 'stacked'.`,
				);
			}
			return trimmed as "grid" | "stacked";
		},
		required: false,
		defaultValue: "grid" as "grid" | "stacked",
		description:
			"TUI cockpit panel layout: 'grid' (2x2) or 'stacked' (single column).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<"grid" | "stacked">,

	// ─── P3787: First-wave hardcoded-constant migration ──────────────────────

	DISPATCH_LOOP_THRESHOLD_PER_HOUR: {
		name: "DISPATCH_LOOP_THRESHOLD_PER_HOUR",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1 || n > 1000) throw new Error("must be integer 1–1000");
			return n;
		},
		required: false,
		defaultValue: 6,
		description: "Max dispatch runs per (proposal, role) per hour before circuit-breaker pauses the proposal",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	GATE_CONVERGENCE_MAX_BLOCKING: {
		name: "GATE_CONVERGENCE_MAX_BLOCKING",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("must be integer 1–100");
			return n;
		},
		required: false,
		defaultValue: 3,
		description: "Max cumulative blocking reviews since last state/maturity transition before proposal is paused",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	GATE_CONVERGENCE_MAX_RUNS_PER_ROLE: {
		name: "GATE_CONVERGENCE_MAX_RUNS_PER_ROLE",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1 || n > 200) throw new Error("must be integer 1–200");
			return n;
		},
		required: false,
		defaultValue: 8,
		description: "Max dispatch runs per role since last state/maturity transition before proposal is paused",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	FEDERATION_SYNC_POLL_INTERVAL_MS: {
		name: "FEDERATION_SYNC_POLL_INTERVAL_MS",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1_000 || n > 3_600_000) throw new Error("must be integer 1000–3600000");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Interval (ms) between federation peer sync polls",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	FEDERATION_HEALTH_QUARANTINE_THRESHOLD: {
		name: "FEDERATION_HEALTH_QUARANTINE_THRESHOLD",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("must be integer 1–100");
			return n;
		},
		required: false,
		defaultValue: 3,
		description: "Consecutive health-check failures before a peer is quarantined",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	FEDERATION_PING_TIMEOUT_MS: {
		name: "FEDERATION_PING_TIMEOUT_MS",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 500 || n > 60_000) throw new Error("must be integer 500–60000");
			return n;
		},
		required: false,
		defaultValue: 5_000,
		description: "Timeout (ms) for federation peer ping/health-check HTTP request",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	SAGA_REPAIR_INTERVAL_MS: {
		name: "SAGA_REPAIR_INTERVAL_MS",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 5_000 || n > 3_600_000) throw new Error("must be integer 5000–3600000");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Interval (ms) between saga repair-worker cycles",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	SAGA_REPAIR_MAX_ATTEMPTS: {
		name: "SAGA_REPAIR_MAX_ATTEMPTS",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("must be integer 1–100");
			return n;
		},
		required: false,
		defaultValue: 10,
		description: "Max retry attempts for a failed saga item before escalation",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	SAGA_REPAIR_MAX_BACKOFF_HOURS: {
		name: "SAGA_REPAIR_MAX_BACKOFF_HOURS",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1 || n > 168) throw new Error("must be integer 1–168");
			return n;
		},
		required: false,
		defaultValue: 24,
		description: "Maximum backoff cap (hours) for saga repair exponential-backoff",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	NOTIFICATION_POLL_INTERVAL_MS: {
		name: "NOTIFICATION_POLL_INTERVAL_MS",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1_000 || n > 600_000) throw new Error("must be integer 1000–600000");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Backstop polling interval (ms) for the notification-queue drain loop",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	NOTIFICATION_BATCH_SIZE: {
		name: "NOTIFICATION_BATCH_SIZE",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1 || n > 500) throw new Error("must be integer 1–500");
			return n;
		},
		required: false,
		defaultValue: 25,
		description: "Max notification rows claimed per drain-loop batch",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PROVIDER_HEALTH_CACHE_TTL_MS: {
		name: "PROVIDER_HEALTH_CACHE_TTL_MS",
		class: "flag" as const,
		category: "model_routing" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1_000 || n > 3_600_000) throw new Error("must be integer 1000–3600000");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "TTL (ms) for provider-health cache entries; stale entries are re-probed",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	AGENT_PROPOSAL_LEASE_TTL_MS: {
		name: "AGENT_PROPOSAL_LEASE_TTL_MS",
		class: "flag" as const,
		category: "orchestration" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 60_000 || n > 86_400_000) throw new Error("must be integer 60000–86400000");
			return n;
		},
		required: false,
		defaultValue: 1_800_000,
		description: "Default lease TTL (ms) for in-memory agent proposal leases (30 min)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	TRANSPORT_WAKE_TIMEOUT_MS: {
		name: "TRANSPORT_WAKE_TIMEOUT_MS",
		class: "flag" as const,
		category: "system" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1_000 || n > 300_000) throw new Error("must be integer 1000–300000");
			return n;
		},
		required: false,
		defaultValue: 10_000,
		description: "Max time (ms) to wait for a transport adapter to wake from offline state",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	// ─── P3787 / P3782 AC-12: remaining leaked process.env feature flags ─────

	LIAISON_LLM_TIMEOUT_MS: {
		name: "LIAISON_LLM_TIMEOUT_MS",
		class: "flag" as const,
		category: "a2a" as ConfigKeyCategory,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1_000 || n > 600_000) throw new Error("must be integer 1000–600000");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Default LLM invocation timeout (ms) for liaison agents; per-provider env overrides (AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_{PROVIDER}) still take precedence",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<number>,

	SELF_CLAIM_AGENCIES: {
		name: "SELF_CLAIM_AGENCIES",
		class: "flag" as const,
		category: "agency" as ConfigKeyCategory,
		parse: (v: string) => {
			const parsed = JSON.parse(v);
			if (typeof parsed === "string") return parsed;
			throw new Error("must be a comma-separated string of agency identities");
		},
		required: false,
		defaultValue: "",
		description: "Comma-separated agency identities allowed to self-claim offers when AGENCY_OFFER_CLAIM_ENABLED=true; empty = all agencies",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<string>,
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
		class: "structural" as const,
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
export function getConfigKeyByName(name: string): ConfigKey<unknown> {
	const key = AllConfigKeys[name as keyof typeof AllConfigKeys];
	if (!key) {
		throw new Error(
			`[Config] Unknown configuration key: ${name}. ` +
				`Known keys: ${Object.keys(AllConfigKeys).join(", ")}`,
		);
	}
	return key;
}
