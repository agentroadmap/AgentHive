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
		category: "dispatch" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	// P3563/P3565: master switch for the gate acceptance-criteria invariant on
	// TERMINAL gates (DEVELOP→MERGE, MERGE→COMPLETE). Default OFF. When OFF,
	// fn_guard_gate_advance reproduces P3566 (migration 289) behavior exactly.
	// The TS layer (verify_ac Pillar-3 origination + the diff-risk advance check)
	// and the DB trigger (fn_gate_ac_invariant_enabled) both read this key so the
	// env>DB>default cascade is consistent across SQL and TS.
	GATE_AC_INVARIANT_ENABLED: {
		name: "AGENTHIVE_GATE_AC_INVARIANT_ENABLED",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: false,
		description:
			"P3563/P3565: enforce gate acceptance-criteria invariant (Pillars 1-3 + diff-risk) on terminal gates. Default OFF.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<boolean>,

	// P1391 (verdict-semantics + gate-authority slice): master switch for the
	// three-verdict gate vocabulary (advance / request_for_change / reject) and
	// the elevated authorization guard on reject → obsolete. Default OFF.
	//
	// Flag OFF  ⇒ EXACT pre-P1391 behavior: the legacy verdict vocab
	//   {advance,hold,reject,waive,escalate} is accepted, only 'advance' acts,
	//   and reject → obsolete is UNREACHABLE (no destructive close without the
	//   guard). Safe to merge before enabling.
	// Flag ON   ⇒ new vocab restricted to {advance,request_for_change,reject};
	//   request_for_change → maturity 'new' (send back for ENHANCEMENT), reject
	//   is authority-gated and → maturity 'obsolete' with
	//   release_reason='proposal_rejected'. Atomic: whole new behavior or none.
	//
	// Read via env>DB>default by core/gate/gate-authority.ts:isGateAuthorityEnabled.
	GATE_AUTHORITY_ENABLED: {
		name: "AGENTHIVE_GATE_AUTHORITY_ENABLED",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: false,
		description:
			"P1391: enable three-verdict gate vocabulary (advance/request_for_change/reject) + elevated reject→obsolete authority guard. Default OFF.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<boolean>,

	// P3840 Part 2: master switch for the deliberate D1–D4 gate-offer pipeline.
	// Default OFF.
	//
	// Flag OFF ⇒ EXACTLY today's behavior: getRolesForQueue FILTERS OUT any role
	//   whose required_capabilities include 'gate_review' (the deliberate
	//   gate-review rows seeded by migration 295), so mature proposals resolve to
	//   an empty mature role set and the orchestrator posts no gate offers. Safe
	//   to merge + apply migration 295 before enabling: nothing dispatches.
	// Flag ON  ⇒ the gate-review rows are resolved as the (only) mature role; the
	//   orchestrator posts an OPEN gate-review offer (required_capabilities
	//   ['gate_review']) that the worker liaison can NOT auto-claim (it advertises
	//   no gate_review job) and that is NEVER auto-decided. A qualified gater
	//   claims it and calls gate_decision deliberately.
	//
	// Read via env>DB>default by role-resolver.ts:isDeliberateGateOffersEnabled.
	DELIBERATE_GATE_OFFERS_ENABLED: {
		name: "AGENTHIVE_DELIBERATE_GATE_OFFERS_ENABLED",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: false,
		description:
			"P3840: enable the deliberate D1–D4 gate-offer pipeline (gate-review roles for mature proposals). Default OFF — gate-review roles are filtered out of role resolution.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<boolean>,

	ENABLE_MULTI_TENANT: {
		name: "ENABLE_MULTI_TENANT",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		description: "Enable multi-tenant mode",
		category: "multi_tenant" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	ENABLE_AUDIT_LOG: {
		name: "ENABLE_AUDIT_LOG",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		description: "Enable audit logging",
		category: "audit" as ConfigKeyCategory,
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
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_LISTEN_REFRESH_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "How often A2A re-reads agent_registry for newly-registered local agencies (ms)",
		category: "mcp_endpoint" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	A2A_HOST_PG_RECONNECT_MS: {
		name: "A2A_HOST_PG_RECONNECT_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_PG_RECONNECT_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Backoff on PG connection loss before exit(1) (ms)",
		category: "mcp_endpoint" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	A2A_HOST_SHUTDOWN_TIMEOUT_MS: {
		name: "A2A_HOST_SHUTDOWN_TIMEOUT_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_SHUTDOWN_TIMEOUT_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Bounded wait for fn_pulse(offline) calls during SIGTERM (ms)",
		category: "mcp_endpoint" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	A2A_HOST_PRESENCE_REFRESH_MS: {
		name: "A2A_HOST_PRESENCE_REFRESH_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid A2A_HOST_PRESENCE_REFRESH_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "How often A2A calls fn_pulse('online') per child to keep last_heartbeat_at fresh for existing dispatchability/maintenance consumers (ms)",
		category: "mcp_endpoint" as ConfigKeyCategory,
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
		category: "liaison" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<number>,

	// ─── Orchestrator runtime-tunable flags (P1144) ───────────────────────────

	ORCHESTRATOR_SCAN_BATCH_LIMIT: {
		name: "ORCHESTRATOR_SCAN_BATCH_LIMIT",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 20,
		description: "scanQueues batch size per tick",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STALL_THRESHOLD_HOURS: {
		name: "ORCHESTRATOR_STALL_THRESHOLD_HOURS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 4,
		description: "Hours before mature proposal escalated",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STALL_BATCH_LIMIT: {
		name: "ORCHESTRATOR_STALL_BATCH_LIMIT",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 5,
		description: "Max stalls processed per tick",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_OFFER_REAP_MS: {
		name: "ORCHESTRATOR_OFFER_REAP_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Offer reap interval (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_POKE_IDLE_MIN: {
		name: "ORCHESTRATOR_POKE_IDLE_MIN",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 5,
		description: "Minutes idle before poke",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_POKE_STORM_CAP: {
		name: "ORCHESTRATOR_POKE_STORM_CAP",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 10,
		description: "Max pokes per cycle",
		category: "orchestrator" as ConfigKeyCategory,
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
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 20,
		description: "Max global in-flight work offers (backpressure cap); 0=disabled",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_SHUTDOWN_DRAIN_MS: {
		name: "ORCHESTRATOR_SHUTDOWN_DRAIN_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 240_000,
		description: "Bounded wait for drain on SIGTERM (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_IMPLICIT_GATE_POLL_MS: {
		name: "ORCHESTRATOR_IMPLICIT_GATE_POLL_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Implicit gate poll interval (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_ENHANCER_REVISE_MS: {
		name: "ORCHESTRATOR_ENHANCER_REVISE_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 90_000,
		description: "Enhancer-revise loop interval (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_RECONCILER_MS: {
		name: "ORCHESTRATOR_RECONCILER_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Reconciler loop interval (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STALE_ROW_REAPER_MS: {
		name: "ORCHESTRATOR_STALE_ROW_REAPER_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 300_000,
		description: "Stale-row reaper interval (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_STUCK_WORKER_MS: {
		name: "ORCHESTRATOR_STUCK_WORKER_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Stuck-worker watchdog interval (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	// P2709 AC-4: grace window after a gate hold/reject during which the
	// state-monitor reeval must NOT auto-advance maturity (anti-flap).
	PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC: {
		name: "PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 0) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 300,
		description:
			"State-monitor grace period (sec) after a gate hold/reject before maturity auto-advance is allowed (P2709)",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_HEARTBEAT_MS: {
		name: "ORCHESTRATOR_HEARTBEAT_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n)) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Orchestrator heartbeat interval (ms)",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	ORCHESTRATOR_OFFER_CLAIM_ENABLED: {
		name: "ORCHESTRATOR_OFFER_CLAIM_ENABLED",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		// P1432 AC-1 (matchmaker invariant): default OFF — the orchestrator must
		// not self-claim by default. A missing/reset flag falls back to
		// matchmaker-only; set true to explicitly re-enable the loop (emergency lever).
		defaultValue: false,
		description: "Kill switch: false (default) disables the orchestrator offer-claim loop",
		category: "orchestrator" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	// P3840: unified dispatch pool. When true, scanQueues() posts work/gate
	// offers for ALL non-terminal proposals from v_unified_dispatch_pool
	// (orchestration/unified-pool-builder.ts) rather than only the mature queue.
	ORCHESTRATOR_UNIFIED_POOL_ENABLED: {
		name: "ORCHESTRATOR_UNIFIED_POOL_ENABLED",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: false,
		description:
			"P3840: when true, scanQueues() uses v_unified_dispatch_pool for all non-terminal proposals; implicit-gate and enhancer-revise timers are disabled.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<boolean>,

	// V3-C6 (P1438) AC-14: legacy heartbeat-derived "offer_dispatch downlink" push.
	// After posting an open-pool work offer the orchestrator used to ALSO push a
	// targeted offer_dispatch to listDispatchableAgencies()[0] — selecting a target
	// from v_agency_status.dispatchable, which is computed from agency.last_heartbeat_at.
	// That is a mechanical presence floor: it routes dispatch by heartbeat, not by an
	// actual claim. In C6 the open-pool offer + emergent-presence claim already decide
	// dispatch, so this push is redundant AND a "no heartbeat-derived dispatchability
	// path for open-pool offers" violation. Default OFF; flip true only to roll back to
	// legacy push-dispatch (no code revert needed).
	ORCHESTRATOR_LEGACY_PUSH_DISPATCH_ENABLED: {
		name: "ORCHESTRATOR_LEGACY_PUSH_DISPATCH_ENABLED",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: false,
		description:
			"V3-C6 AC-14: when true, re-enables the legacy heartbeat-derived offer_dispatch downlink push (default false = pure open-pool dispatch)",
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
		category: "dispatch" as ConfigKeyCategory,
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
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid PAUSE_FAILURE_THRESHOLD: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Number of consecutive no-eligible-agency failures before first pause (P1291)",
		category: "pause_backoff" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PAUSE_BASE_BACKOFF_MS: {
		name: "PAUSE_BASE_BACKOFF_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid PAUSE_BASE_BACKOFF_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Base backoff duration in milliseconds for first pause cycle (default 1800000 = 30min)",
		category: "pause_backoff" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PAUSE_BACKOFF_MULTIPLIER: {
		name: "PAUSE_BACKOFF_MULTIPLIER",
		class: "flag" as const,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed < 1) {
				throw new Error(`Invalid PAUSE_BACKOFF_MULTIPLIER: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Exponential backoff multiplier for each pause cycle (default 2)",
		category: "pause_backoff" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PAUSE_MAX_BACKOFF_MS: {
		name: "PAUSE_MAX_BACKOFF_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const parsed = Number(JSON.parse(v));
			if (!Number.isFinite(parsed) || parsed <= 0) {
				throw new Error(`Invalid PAUSE_MAX_BACKOFF_MS: ${v}`);
			}
			return parsed;
		},
		required: true,
		description: "Hard cap on pause duration in milliseconds (default 86400000 = 24h)",
		category: "pause_backoff" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	// ─── P1359: Provider quota cooldown + automatic route fallback ────────────

	SPAWN_PROVIDER_MAX_ATTEMPTS: {
		name: "SPAWN_PROVIDER_MAX_ATTEMPTS",
		class: "flag" as const,
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
		category: "provider_quota" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	// ─── P3312: Adaptive matcher (unified matchWorkToRoute) ─────────────────
	// Default OFF; shadow mode writes matcher vs legacy choice to route_decision_log
	// without changing behavior. Flip true when P3310+P3311 are COMPLETE to activate.

	ADAPTIVE_MATCHER_ENABLED: {
		name: "ADAPTIVE_MATCHER_ENABLED",
		class: "flag" as const,
		parse: (v: string) => {
			try {
				return JSON.parse(v) === true;
			} catch {
				return v.toLowerCase() === "true" || v === "1";
			}
		},
		required: false,
		defaultValue: false,
		description:
			"P3312: when false (default), matchWorkToRoute runs in shadow mode only — logs matcher_choice vs legacy_choice without changing dispatch behavior. Flip true once P3310+P3311 are COMPLETE.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<boolean>,

	/**
	 * TUI cockpit layout — 'grid' (default, 2x2) or 'stacked' (single column).
	 * User-facing preference. Persisted in core.runtime_flag so a future web
	 * UI or in-TUI setting screen can update it without code changes.
	 * Env var AGENTHIVE_COCKPIT_LAYOUT overrides the DB value for local dev.
	 */
	TUI_COCKPIT_LAYOUT: {
		name: "AGENTHIVE_COCKPIT_LAYOUT",
		class: "flag" as const,
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
		category: "ui_ux" as ConfigKeyCategory,
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: true,
	} satisfies ConfigKey<"grid" | "stacked">,

	// ─── P3787: first-wave hardcoded-constant migration ───────────────────────

	DISPATCH_LOOP_THRESHOLD: {
		name: "AGENTHIVE_DISPATCH_LOOP_THRESHOLD",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 0) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 6,
		description: "Circuit-breaker: max failed runs per (proposal, role) in the last hour before gate_scanner_paused is set.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	GATE_CONVERGENCE_MAX_BLOCKING: {
		name: "AGENTHIVE_GATE_CONVERGENCE_MAX_BLOCKING",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 3,
		description: "Convergence guard: max blocking-review count since last transition before proposal is paused.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	GATE_CONVERGENCE_MAX_RUNS_PER_ROLE: {
		name: "AGENTHIVE_GATE_CONVERGENCE_MAX_RUNS_PER_ROLE",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 8,
		description: "Convergence guard: max per-role run count since last transition before proposal is paused.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	FEDERATION_SYNC_POLL_MS: {
		name: "FEDERATION_SYNC_POLL_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1000) throw new Error("must be >= 1000");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Federation sync polling interval in ms (default 30 s).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	FEDERATION_QUARANTINE_THRESHOLD: {
		name: "FEDERATION_QUARANTINE_THRESHOLD",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 3,
		description: "Federation: consecutive health-check failures before a peer is quarantined.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	FEDERATION_STALE_SYNC_MS: {
		name: "FEDERATION_STALE_SYNC_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 60_000) throw new Error("must be >= 60000");
			return n;
		},
		required: false,
		defaultValue: 3_600_000,
		description: "Federation: ms since last_sync_at before a peer sync is considered stale (default 1 h).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	FEDERATION_PING_TIMEOUT_MS: {
		name: "FEDERATION_PING_TIMEOUT_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 500) throw new Error("must be >= 500");
			return n;
		},
		required: false,
		defaultValue: 5_000,
		description: "Federation: timeout in ms for peer /health ping (default 5 s).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	SAGA_REPAIR_INTERVAL_MS: {
		name: "SAGA_REPAIR_INTERVAL_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 5_000) throw new Error("must be >= 5000");
			return n;
		},
		required: false,
		defaultValue: 60_000,
		description: "Saga repair worker: polling interval in ms (default 60 s).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	SAGA_REPAIR_MAX_ATTEMPTS: {
		name: "SAGA_REPAIR_MAX_ATTEMPTS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 10,
		description: "Saga repair worker: max retry attempts before escalating to operator.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	SAGA_REPAIR_BASE_BACKOFF_MIN: {
		name: "SAGA_REPAIR_BASE_BACKOFF_MIN",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 2,
		description: "Saga repair worker: base backoff multiplier in minutes for exponential retry delay.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	SAGA_REPAIR_MAX_BACKOFF_HOURS: {
		name: "SAGA_REPAIR_MAX_BACKOFF_HOURS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 24,
		description: "Saga repair worker: maximum retry backoff cap in hours.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	NOTIFICATION_MAX_ATTEMPTS: {
		name: "NOTIFICATION_MAX_ATTEMPTS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 5,
		description: "Notification router: max dispatch attempts per queue row before moving to DLQ.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	NOTIFICATION_POLL_MS: {
		name: "NOTIFICATION_POLL_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1000) throw new Error("must be >= 1000");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Notification router: backstop poll interval in ms (default 30 s).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	NOTIFICATION_BATCH_SIZE: {
		name: "NOTIFICATION_BATCH_SIZE",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1) throw new Error("invalid number");
			return n;
		},
		required: false,
		defaultValue: 25,
		description: "Notification router: max rows claimed per drain cycle.",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	PROVIDER_HEALTH_TTL_MS: {
		name: "PROVIDER_HEALTH_TTL_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 1000) throw new Error("must be >= 1000");
			return n;
		},
		required: false,
		defaultValue: 30_000,
		description: "Provider health cache TTL in ms; entries older than this are rechecked (default 30 s).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	AGENT_PROPOSAL_LEASE_TTL_MS: {
		name: "AGENT_PROPOSAL_LEASE_TTL_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 60_000) throw new Error("must be >= 60000");
			return n;
		},
		required: false,
		defaultValue: 1_800_000,
		description: "Agent proposal system: default lease TTL in ms (default 30 min).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,

	GATEWAY_WAKE_TIMEOUT_MS: {
		name: "GATEWAY_WAKE_TIMEOUT_MS",
		class: "flag" as const,
		parse: (v: string) => {
			const n = Number(JSON.parse(v));
			if (!Number.isFinite(n) || n < 500) throw new Error("must be >= 500");
			return n;
		},
		required: false,
		defaultValue: 10_000,
		description: "Transport registry: max time in ms to wait for a transport adapter to come online on wakeUp() (default 10 s).",
		dbTable: "core.runtime_flag",
		dbColumn: "value_jsonb",
		envOverride: false,
	} satisfies ConfigKey<number>,
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
