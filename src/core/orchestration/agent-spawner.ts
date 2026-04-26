/**
 * AgentHive — Agent Spawner (Mode B: CLI process fork)
 *
 * Spawns agent subprocesses inside their dedicated git worktrees.
 * Provider-agnostic: supports Anthropic CLI, OpenAI-compatible, and Google CLI.
 *
 * Security perimeter per spawn:
 *   - cwd        → agent's git worktree (/data/code/worktree/<name>)
 *   - DATABASE_URL → agent's Postgres login user (agent_<name>)
 *   - GIT_CONFIG_GLOBAL → per-agent gitconfig (author identity)
 *   - GIT_CONFIG_NOSYSTEM=1 → never inherit host-level git config
 *
 * The orchestrator calls spawnAgent() with a task payload.
 * The agent process exits when the task is complete; stdout/stderr
 * are captured and stored in agent_runs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { getMcpUrl, getDaemonUrl } from "../../shared/runtime/endpoints.ts";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { query } from "../../infra/postgres/pool.ts";
import { RfcStates, HotfixStates } from "../workflow/state-names.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKTREE_ROOT = "/data/code/worktree";
const GITCONFIG_ROOT = "/data/code/AgentHive/.git/worktrees-config";

// P245: host identity used for host-level spawn policy lookup.
// Resolved once at module load; systemd units set AGENTHIVE_HOST explicitly
// (e.g. agenthive-orchestrator on hermes → AGENTHIVE_HOST=hermes).
const AGENTHIVE_HOST = process.env.AGENTHIVE_HOST ?? hostname();

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentProvider = string;

export interface WorktreeConfig {
	/** Worktree directory name (e.g. "claude-andy") */
	name: string;
	/** Provider type */
	provider: AgentProvider;
	/** Postgres login user */
	dbUser: string;
	/** DB password (from .env.agent — never hardcoded) */
	dbPassword: string;
	/** Branch name */
	branch: string;
}

export interface SpawnRequest {
	/** Worktree name (e.g. "claude-andy") */
	worktree: string;
	/** Task content sent as prompt / message */
	task: string;
	/** Proposal context (optional) */
	proposalId?: number;
	/** Stage context */
	stage: string;
	/** Preferred model override (provider decides default) */
	model?: string;
	/** P405: Agent provider override — model_routes controls routing, not worktree metadata */
	provider?: string;
	/** Max tokens for this invocation */
	maxTokens?: number;
	/** Wall-clock timeout in milliseconds (default 300 000 = 5 min) */
	timeoutMs?: number;
	/** P300: Project-aware worktree root (defaults to WORKTREE_ROOT) */
	worktreeRoot?: string;
	/** Display label for context package (e.g. "worker-4620 (skeptic-alpha)") */
	agentLabel?: string;
	/** Descriptive activity label (e.g. "researching", "enhancing", "reviewing") */
	activity?: string;
	/**
	 * P466: warm-boot briefing id assembled by the parent (orchestrator) before
	 * dispatch. Set as AGENTHIVE_BRIEFING_ID env in the spawned child so the
	 * child can call `briefing_load(<id>)` on boot. Without this the child
	 * runs in legacy "blind" mode (only the task prompt for context).
	 */
	briefingId?: string;
}

export interface SpawnResult {
	agentRunId: string;
	worktree: string;
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

// ─── Provider CLI builders ────────────────────────────────────────────────────

// ─── Provider CLI builders ────────────────────────────────────────────────────
// Each builder receives the resolved ModelRoute so it can use base_url / api_spec
// directly from the registry rather than inferring them from the worktree name.

export interface ModelRoute {
	modelName: string;
	routeProvider: string;
	agentProvider: string;
	agentCli: string;
	/** Full path to the CLI binary from DB. NULL = rely on system PATH. */
	cliPath: string | null;
	apiSpec: string;
	baseUrl: string;
	planType: string | null;
	costPer1kInput: number;
	costPerMillionInput: number;
	costPerMillionOutput: number;
	/** DB-driven credential env var names (migration 039) */
	apiKeyEnv: string | null;
	apiKeyFallbackEnv: string | null;
	baseUrlEnv: string | null;
	/** The env var the CLI actually reads for auth (e.g. ANTHROPIC_API_KEY for claude CLI) */
	cliApiKeyEnv: string | null;
	/** Actual API key values stored in DB (primary and secondary/fallback) */
	apiKeyPrimary: string | null;
	apiKeySecondary: string | null;
	/** Comma-separated Hermes toolsets to grant; null = defaults */
	spawnToolsets: string | null;
	/** Whether agents spawned on this route may spawn their own subagents */
	spawnDelegate: boolean;
}

// Lazy-loaded Claude settings.json env vars (read once, cached)
let claudeSettingsEnv: Record<string, string> | undefined;

function loadClaudeSettingsEnv(): Record<string, string> {
	if (claudeSettingsEnv !== undefined) return claudeSettingsEnv;
	claudeSettingsEnv = {};
	try {
		const settingsPath = join(process.env.HOME ?? "/root", ".claude", "settings.json");
		console.error(`[AgentSpawner] Loading Claude settings from: ${settingsPath}`);
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.env && typeof parsed.env === "object") {
			for (const [k, v] of Object.entries(parsed.env)) {
				if (typeof v === "string") claudeSettingsEnv[k] = v;
			}
		}
		console.error(`[AgentSpawner] Loaded ${Object.keys(claudeSettingsEnv).length} env vars from settings.json`);
		console.error(`[AgentSpawner] ANTHROPIC_AUTH_TOKEN present: ${!!claudeSettingsEnv.ANTHROPIC_AUTH_TOKEN}`);
		console.error(`[AgentSpawner] ANTHROPIC_BASE_URL present: ${!!claudeSettingsEnv.ANTHROPIC_BASE_URL}`);
	} catch (e) {
		console.error(`[AgentSpawner] Failed to load settings.json:`, e);
	}
	return claudeSettingsEnv;
}

export function buildSpawnProcessEnv(input: {
	worktree: string;
	route: ModelRoute;
	agentEnv: Record<string, string>;
	extraEnv: Record<string, string>;
}): Record<string, string> {
	// Credential resolution order:
	// 1. DB-stored keys (api_key_primary / api_key_secondary) — highest priority
	// 2. Env var named by api_key_env (from process.env or ~/.claude/settings.json)
	// 3. Env var named by api_key_fallback_env (same resolution)
	// The resolved key is set under cliApiKeyEnv (what the CLI actually reads).
	const settingsEnv = loadClaudeSettingsEnv();
	const routeCredentialEnv: Record<string, string> = {};

	// Resolve the API key value: DB primary > DB secondary > env var > settings.json
	let resolvedKey: string | null = null;
	if (input.route.apiKeyPrimary) {
		resolvedKey = input.route.apiKeyPrimary;
	} else if (input.route.apiKeyEnv) {
		resolvedKey = process.env[input.route.apiKeyEnv] ?? settingsEnv[input.route.apiKeyEnv] ?? null;
	}
	let resolvedFallback: string | null = null;
	if (input.route.apiKeySecondary) {
		resolvedFallback = input.route.apiKeySecondary;
	} else if (input.route.apiKeyFallbackEnv) {
		resolvedFallback = process.env[input.route.apiKeyFallbackEnv] ?? settingsEnv[input.route.apiKeyFallbackEnv] ?? null;
	}

	// Set the key under the env var the CLI reads (cliApiKeyEnv), falling back to apiKeyEnv
	const cliKeyEnv = input.route.cliApiKeyEnv ?? input.route.apiKeyEnv;
	if (cliKeyEnv && resolvedKey) {
		routeCredentialEnv[cliKeyEnv] = resolvedKey;
	} else if (cliKeyEnv && resolvedFallback) {
		routeCredentialEnv[cliKeyEnv] = resolvedFallback;
	}

	// Resolve base URL: route's DB value > process.env > settings.json
	if (input.route.baseUrlEnv) {
		if (input.route.baseUrl) {
			routeCredentialEnv[input.route.baseUrlEnv] = input.route.baseUrl;
		} else if (!process.env[input.route.baseUrlEnv]) {
			const val = settingsEnv[input.route.baseUrlEnv];
			if (val) routeCredentialEnv[input.route.baseUrlEnv] = val;
		}
	}

	const baseEnv: Record<string, string> = {
		// Carry through essential PATH
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? "/var/lib/agenthive",
		// Agent-specific overrides from .env.agent
		DATABASE_URL: input.agentEnv.DATABASE_URL ?? "",
		AGENT_WORKTREE: input.worktree,
		AGENT_PROVIDER: input.route.agentProvider,
		AGENT_ROUTE_PROVIDER: input.route.routeProvider,
		AGENT_API_SPEC: input.route.apiSpec,
		// Spawn control: DB-driven flag tells the agent whether it may spawn subagents
		AGENTHIVE_SPAWN_DELEGATE: String(input.route.spawnDelegate),
		// Git identity isolation
		GIT_CONFIG_GLOBAL: `${GITCONFIG_ROOT}/${input.worktree}.gitconfig`,
		GIT_CONFIG_NOSYSTEM: "1",
		// API keys are selected from DB-backed route metadata, not worktree prefix.
		...routeCredentialEnv,
		...(process.env.GITHUB_TOKEN && {
			GITHUB_TOKEN: process.env.GITHUB_TOKEN,
		}),
	};

	return {
		...baseEnv,
		...input.extraEnv,
	};
}

/**
 * Build argv + env for the Anthropic Claude CLI.
 * Used when api_spec = 'anthropic' (native claude CLI).
 */
type CommandSpec = {
	argv: string[];
	env: Record<string, string>;
	stdin?: string;
};

function buildClaudeArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	const argv = [
		route.cliPath ?? "claude",
		"--print", // non-interactive: print response and exit
		"--model",
		route.modelName,
		req.task,
	];
	const env: Record<string, string> = { ANTHROPIC_MODEL: route.modelName };
	// DB controls base_url; set env var whenever baseUrlEnv is configured.
	if (route.baseUrlEnv) {
		env[route.baseUrlEnv] = route.baseUrl;
	}
	return { argv, env };
}

/**
 * Build argv + env for the Hermes CLI.
 * Used when agent_cli = 'hermes' — the native AgentHive agent framework.
 * Uses `hermes chat -q <prompt> -m <model> --provider <provider> --yolo`.
 * cli_path in model_routes controls the binary location (no hardcoding here).
 */
function buildHermesArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	const argv = [
		route.cliPath ?? "hermes",
		"chat",
		"-q",
		req.task,
		"-m",
		route.modelName,
		"--provider",
		route.routeProvider,
		"--yolo",
		"-Q", // quiet mode: no spinner/activity
	];
	// Migration 039: if spawn_toolsets is configured, restrict the agent's
	// toolsets so it cannot spawn subagents via the built-in delegate_task.
	if (route.spawnToolsets) {
		argv.push("--toolsets", route.spawnToolsets);
	}
	return { argv, env: {} };
}

/**
 * Build argv + env for the OpenAI Codex CLI.
 * Used when agent_provider = 'codex' (openai spec, `codex` terminal tool).
 * https://github.com/openai/codex
 */
function buildCodexArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	const argv = [
		route.cliPath ?? "codex",
		"exec",
		"--dangerously-bypass-approvals-and-sandbox",
		"--model",
		route.modelName,
		req.task,
	];
	const env: Record<string, string> = {};
	// DB controls base_url; set env var whenever baseUrlEnv is configured.
	if (route.baseUrlEnv) {
		env[route.baseUrlEnv] = route.baseUrl;
	}
	return { argv, env };
}

/**
 * Build argv + env for any OpenAI-compatible endpoint.
 * Used when api_spec = 'openai' (Nous, Xiaomi, OpenAI, GitHub Copilot, etc.).
 * Uses the `llm` CLI (https://llm.datasette.io).
 */
function buildOpenAICompatArgs(
	req: SpawnRequest,
	route: ModelRoute,
): CommandSpec {
	const argv = ["llm", "--model", route.modelName, req.task];
	const env: Record<string, string> = {};
	if (route.baseUrlEnv) {
		env[route.baseUrlEnv] = route.baseUrl;
	}
	return { argv, env };
}

/**
 * Build argv + env for Google Gemini CLI.
 * Used when api_spec = 'google'.
 * cli_path in model_routes controls the binary location (no hardcoding here).
 */
function buildGeminiArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	const argv = [route.cliPath ?? "gemini", "--model", route.modelName, "--prompt", req.task];
	return { argv, env: {} };
}

/**
 * Build argv + env for the GitHub Copilot CLI.
 * Used when agent_cli = 'copilot' — auth is read from ~/.copilot/settings.json
 * by the CLI itself; no API key env var is required.
 * cli_path in model_routes controls the binary location (no hardcoding here).
 */
function buildCopilotArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	const argv = [
		route.cliPath ?? "copilot",
		"-p",
		req.task,
		"--yolo",
		"--model",
		route.modelName,
	];
	return { argv, env: {} };
}

/** Dispatch to the correct builder based on route.agentCli (DB is source of truth). */
function buildArgsBySpec(req: SpawnRequest, route: ModelRoute): CommandSpec {
	// agent_cli from DB determines which CLI to use
	switch (route.agentCli) {
		case "codex":
			return buildCodexArgs(req, route);
		case "claude":
			return buildClaudeArgs(req, route);
		case "copilot":
			return buildCopilotArgs(req, route);
		case "gemini":
			return buildGeminiArgs(req, route);
		case "hermes":
			return buildHermesArgs(req, route);
		default:
			// llm or any other openai-compatible CLI
			return buildOpenAICompatArgs(req, route);
	}
}

export function assertResolvedRouteMetadata(
	provider: AgentProvider,
	route: ModelRoute,
): void {
	if (route.agentProvider !== provider) {
		throw new Error(
			`[P235] Route agent_provider "${route.agentProvider}" does not match worktree provider "${provider}" for model "${route.modelName}".`,
		);
	}
	if (!route.routeProvider || !route.apiSpec || !route.baseUrl) {
		throw new Error(
			`[P235] Refusing to run "${provider}" route "${route.modelName}" with incomplete DB route metadata.`,
		);
	}
}

// ─── P245: Host-level spawn policy ────────────────────────────────────────────

export class SpawnPolicyViolation extends Error {
	constructor(
		readonly host: string,
		readonly routeProvider: string,
		readonly modelName: string,
	) {
		super(
			`[P245] Spawn policy violation: host "${host}" is not permitted to run route_provider "${routeProvider}" (model "${modelName}").`,
		);
		this.name = "SpawnPolicyViolation";
	}
}

/**
 * Enforce host-level spawn policy. Called after resolveModelRoute but before
 * the CLI subprocess is launched. Violations are recorded to
 * roadmap.escalation_log with severity=high and the spawn is aborted.
 *
 * Unknown hosts are permitted (legacy fallback) — see fn_check_spawn_policy.
 */
async function assertSpawnAllowed(
	host: string,
	route: ModelRoute,
	proposalId?: number,
	worktree?: string,
): Promise<void> {
	const { rows } = await query<{ allowed: boolean }>(
		`SELECT roadmap.fn_check_spawn_policy($1, $2) AS allowed`,
		[host, route.routeProvider],
	);
	const allowed = rows[0]?.allowed ?? true;
	if (allowed) return;

	// Record the violation before throwing so the signal survives the crash.
	try {
		await query(
			`INSERT INTO roadmap.escalation_log
                (obstacle_type, proposal_id, agent_identity, escalated_to, severity, resolution_note)
             VALUES ('SPAWN_POLICY_VIOLATION', $1, $2, 'orchestrator', 'high', $3)`,
			[
				proposalId !== undefined ? String(proposalId) : null,
				worktree ?? null,
				`host=${host} route_provider=${route.routeProvider} model=${route.modelName}`,
			],
		);
	} catch (err) {
		// Logging failure must not mask the original violation.
		console.error(
			`[P245] Failed to write escalation_log for spawn violation:`,
			err,
		);
	}

	throw new SpawnPolicyViolation(host, route.routeProvider, route.modelName);
}

let modelRoutesMillionPricingPromise: Promise<boolean> | undefined;

async function supportsPerMillionRoutePricing(): Promise<boolean> {
	if (!modelRoutesMillionPricingPromise) {
		modelRoutesMillionPricingPromise = query<{ column_name: string }>(
			`SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'roadmap'
         AND table_name = 'model_routes'
         AND column_name = ANY($1::text[])`,
			[
				[
					"cost_per_million_input",
					"cost_per_million_output",
					"cost_per_million_cache_write",
					"cost_per_million_cache_hit",
				],
			],
		).then(({ rows }) => rows.length > 0);
	}
	return modelRoutesMillionPricingPromise;
}

// ─── Worktree config loader ───────────────────────────────────────────────────

/** Parse .env.agent file — returns key/value pairs. */
async function loadEnvAgent(
	worktreeName: string,
	worktreeRoot: string = WORKTREE_ROOT,
): Promise<Record<string, string>> {
	const path = join(worktreeRoot, worktreeName, ".env.agent");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err: any) {
		if (err?.code === "ENOENT") return {}; // No .env.agent — creds from $HOME
		throw new Error(
			`Cannot read .env.agent for worktree "${worktreeName}" at ${path}`,
		);
	}

	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed.slice(eq + 1).trim();
		// Expand ${VAR} references using already-parsed keys
		env[key] = val.replace(
			/\$\{([^}]+)\}/g,
			(_, k) => env[k] ?? process.env[k] ?? "",
		);
	}
	return env;
}

/**
 * Resolve the first enabled agent provider from model_routes.
 * Used as a dynamic fallback when no worktree-level provider is configured.
 */
export async function resolveActiveRouteProvider(): Promise<AgentProvider | null> {
	const { rows } = await query<{ agent_provider: string }>(
		`SELECT agent_provider
		 FROM roadmap.model_routes
		 WHERE is_enabled = true
		 ORDER BY priority ASC, COALESCE(cost_per_million_input, 0) ASC
		 LIMIT 1`,
	);
	return (rows[0]?.agent_provider ?? null) as AgentProvider | null;
}

/**
 * Detect a worktree's provider from its `.env.agent` (AGENT_PROVIDER key).
 * Falls back to the first enabled route in model_routes rather than hardcoding
 * a specific provider, so provider changes only require a DB update.
 */
export async function detectProvider(worktreeName: string, worktreeRoot: string = WORKTREE_ROOT): Promise<AgentProvider> {
	const envPath = join(worktreeRoot, worktreeName, ".env.agent");
	try {
		const content = await readFile(envPath, "utf8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq < 0) continue;
			const key = trimmed.slice(0, eq).trim();
			if (key !== "AGENT_PROVIDER") continue;
			const value = trimmed.slice(eq + 1).trim().replace(/^[\"']|[\"']$/g, "");
			if (value) return value as AgentProvider;
		}
	} catch (err: any) {
		if (err?.code !== "ENOENT") throw err;
	}
	// No .env.agent — resolve from DB so switching providers requires only a DB change
	const active = await resolveActiveRouteProvider();
	if (active) return active;
	// Last resort: use the env var if set
	const envProvider = process.env.AGENTHIVE_DEFAULT_PROVIDER as AgentProvider | undefined;
	return envProvider ?? "hermes";
}

// ─── P235: Platform-Aware Model Constraints ──────────────────────────────────

/**
 * P235 + M026: Resolve model route for a spawn request.
 *
 * Returns a full ModelRoute (including base_url and api_spec) so the spawner
 * can build the correct CLI args regardless of which worktree is invoking it.
 * This enables global escalation (e.g. openclaw → claude-opus via anthropic route).
 *
 * Resolution order:
 *   1. If hint given: find the best enabled route for (hint, agent_provider)
 *   2. If hint has no enabled route: warn and fall back to provider default
 *   3. If no hint: pick the cheapest enabled route for this agent_provider
 *      (lowest priority number first, i.e. token_plan before api_key)
 */
async function resolveModelRoute(
	provider: AgentProvider,
	hint?: string,
): Promise<ModelRoute> {
	type RouteRow = {
		model_name: string;
		route_provider: string;
		agent_provider: string;
		agent_cli: string;
		cli_path: string | null;
		api_spec: string;
		base_url: string;
		plan_type: string | null;
		cost_per_million_input: number | null;
		cost_per_million_output: number | null;
		api_key_env: string | null;
		api_key_fallback_env: string | null;
		base_url_env: string | null;
		cli_api_key_env: string | null;
		api_key_primary: string | null;
		api_key_secondary: string | null;
		spawn_toolsets: string | null;
		spawn_delegate: boolean | null;
	};

	const perMillionPricing = await supportsPerMillionRoutePricing();

	const fetchRoute = (modelName: string) => {
		if (perMillionPricing) {
		return query<RouteRow>(
			`SELECT model_name, route_provider, agent_provider,
               agent_cli, cli_path, api_spec, base_url, plan_type,
               cost_per_million_input, cost_per_million_output,
               api_key_env, api_key_fallback_env, base_url_env, cli_api_key_env,
               api_key_primary, api_key_secondary, spawn_toolsets, spawn_delegate
        FROM roadmap.model_routes
        WHERE model_name = $1
          AND agent_provider = $2
          AND is_enabled = true
        ORDER BY priority ASC, COALESCE(cost_per_million_input, 0) ASC
        LIMIT 1`,
				[modelName, provider],
			);
		}

		return query<RouteRow>(
			`SELECT model_name, route_provider, agent_provider,
              agent_cli, cli_path, api_spec, base_url, plan_type,
              NULL::numeric AS cost_per_million_input,
              NULL::numeric AS cost_per_million_output,
              api_key_env, api_key_fallback_env, base_url_env, cli_api_key_env,
              api_key_primary, api_key_secondary, spawn_toolsets, spawn_delegate
       FROM roadmap.model_routes
       WHERE model_name = $1
         AND agent_provider = $2
         AND is_enabled = true
        ORDER BY priority ASC
        LIMIT 1`,
			[modelName, provider],
		);
	};

	const toModelRoute = (r: RouteRow): ModelRoute => ({
		modelName: r.model_name,
		routeProvider: r.route_provider,
		agentProvider: r.agent_provider,
		agentCli: r.agent_cli ?? r.agent_provider,
		cliPath: r.cli_path ?? null,
		apiSpec: r.api_spec as ModelRoute["apiSpec"],
		baseUrl: r.base_url,
		planType: r.plan_type,
		costPer1kInput: Number(r.cost_per_million_input ? r.cost_per_million_input / 1000 : 0),
		costPerMillionInput: Number(r.cost_per_million_input ?? 0),
		costPerMillionOutput: Number(r.cost_per_million_output ?? 0),
		apiKeyEnv: r.api_key_env,
		apiKeyFallbackEnv: r.api_key_fallback_env,
		baseUrlEnv: r.base_url_env,
		cliApiKeyEnv: r.cli_api_key_env,
		apiKeyPrimary: r.api_key_primary,
		apiKeySecondary: r.api_key_secondary,
		spawnToolsets: r.spawn_toolsets,
		spawnDelegate: r.spawn_delegate ?? false,
	});

	if (hint) {
		const { rows } = await fetchRoute(hint);
		if (rows.length > 0) {
			const route = toModelRoute(rows[0]);
			assertResolvedRouteMetadata(provider, route);
			return route;
		}

		console.warn(
			`[P235] No enabled route for model "${hint}" with agent_provider "${provider}". ` +
				`Falling back to default.`,
		);
		// Fall through to default resolution
	}

	// Default: use DB is_default flag first, then cheapest enabled as fallback.
	const { rows } = perMillionPricing
		? await query<RouteRow>(
				`SELECT model_name, route_provider, agent_provider,
               agent_cli, cli_path, api_spec, base_url, plan_type,
               cost_per_million_input, cost_per_million_output,
               api_key_env, api_key_fallback_env, base_url_env, cli_api_key_env,
               api_key_primary, api_key_secondary, spawn_toolsets, spawn_delegate
        FROM roadmap.model_routes
        WHERE agent_provider = $1
          AND is_enabled = true
        ORDER BY
          CASE WHEN is_default = true THEN 0 ELSE 1 END,
          priority ASC,
          COALESCE(cost_per_million_input, 0) ASC
        LIMIT 1`,
				[provider],
			)
		: await query<RouteRow>(
				`SELECT model_name, route_provider, agent_provider,
              agent_cli, cli_path, api_spec, base_url, plan_type,
              NULL::numeric AS cost_per_million_input,
              NULL::numeric AS cost_per_million_output,
              api_key_env, api_key_fallback_env, base_url_env, cli_api_key_env,
              api_key_primary, api_key_secondary, spawn_toolsets, spawn_delegate
       FROM roadmap.model_routes
       WHERE agent_provider = $1
         AND is_enabled = true
        ORDER BY
          CASE WHEN is_default = true THEN 0 ELSE 1 END,
          priority ASC
        LIMIT 1`,
				[provider],
			);

	if (rows.length > 0) {
		const route = toModelRoute(rows[0]);
		assertResolvedRouteMetadata(provider, route);
		return route;
	}

	// Host-level fallback (legacy, kept for transition)
	const fallbackModel = await getHostDefaultModel();
	if (fallbackModel) {
		const { rows: defaultRows } = perMillionPricing
			? await query<RouteRow>(
					`SELECT model_name, route_provider, agent_provider,
               agent_cli, cli_path, api_spec, base_url, plan_type,
               cost_per_million_input, cost_per_million_output,
               api_key_env, api_key_fallback_env, base_url_env, cli_api_key_env,
               api_key_primary, api_key_secondary, spawn_toolsets, spawn_delegate
        FROM roadmap.model_routes
        WHERE model_name = $1
          AND agent_provider = $2
          AND is_enabled = true
        ORDER BY priority ASC, COALESCE(cost_per_million_input, 0) ASC
        LIMIT 1`,
					[fallbackModel, provider],
				)
			: await query<RouteRow>(
					`SELECT model_name, route_provider, agent_provider,
              agent_cli, cli_path, api_spec, base_url, plan_type,
              NULL::numeric AS cost_per_million_input,
              NULL::numeric AS cost_per_million_output,
              api_key_env, api_key_fallback_env, base_url_env, cli_api_key_env,
              api_key_primary, api_key_secondary, spawn_toolsets, spawn_delegate
       FROM roadmap.model_routes
       WHERE model_name = $1
         AND agent_provider = $2
         AND is_enabled = true
        ORDER BY priority ASC
        LIMIT 1`,
					[fallbackModel, provider],
				);
		if (defaultRows.length > 0) {
			const route = toModelRoute(defaultRows[0]);
			assertResolvedRouteMetadata(provider, route);
			return route;
		}
	}

	throw new Error(
		`[P235] No enabled route found in DB for agent_provider "${provider}" and no usable host default_model fallback for host "${AGENTHIVE_HOST}".`,
	);
}

let hostDefaultModelPromise: Promise<string | null> | undefined;

async function getHostDefaultModel(): Promise<string | null> {
	if (!hostDefaultModelPromise) {
		hostDefaultModelPromise = query<{ default_model: string | null }>(
			`SELECT default_model
       FROM roadmap.host_model_policy
       WHERE host_name = $1
       LIMIT 1`,
			[AGENTHIVE_HOST],
		).then(({ rows }) => rows[0]?.default_model ?? null);
	}
	return hostDefaultModelPromise;
}

async function buildProposalContextPackage(input: {
	proposalId: number;
	taskType: string;
	agentIdentity: string;
	maxTokens: number;
}): Promise<string> {
	const { rows } = await query<{
		display_id: string | null;
		title: string;
		status: string;
		summary: string | null;
		design: string | null;
	}>(
		`SELECT display_id, title, status, summary, design
     FROM roadmap_proposal.proposal
     WHERE id = $1
     LIMIT 1`,
		[input.proposalId],
	);
	const proposal = rows[0];
	if (!proposal) {
		return [
			"## Proposal Context",
			`- Proposal: #${input.proposalId}`,
			`- Task type: ${input.taskType}`,
			`- Agent: ${input.agentIdentity}`,
			"- Source: proposal not found",
		].join("\n");
	}

	const context = [
		"## Proposal Context",
		`- Proposal: ${proposal.display_id ?? `#${input.proposalId}`}`,
		`- Title: ${proposal.title}`,
		`- Status: ${proposal.status}`,
		`- Task type: ${input.taskType}`,
		`- Agent: ${input.agentIdentity}`,
		proposal.summary ? `\n### Summary\n${proposal.summary}` : "",
		proposal.design ? `\n### Design\n${proposal.design}` : "",
	]
		.filter(Boolean)
		.join("\n");
	const maxChars = Math.max(1000, input.maxTokens * 4);
	return context.length > maxChars
		? `${context.slice(0, maxChars)}\n...`
		: context;
}

// ─── Core spawn logic ─────────────────────────────────────────────────────────

/**
 * Spawn an agent subprocess inside its worktree.
 * Records the run in agent_runs and agent_budget_ledger.
 */
export async function spawnAgent(req: SpawnRequest): Promise<SpawnResult> {
	const {
		worktree,
		task,
		proposalId,
		stage,
		model: modelHint,
		timeoutMs = 300_000,
		worktreeRoot = WORKTREE_ROOT,
		provider: providerOverride,
	} = req;

	// P405: provider comes from model_routes via orchestrator, not hardcoded to worktree
	const provider = providerOverride ?? await detectProvider(worktree, worktreeRoot);
	// P235/M026: resolve full route (model + api_spec + base_url) from model_routes
	const route = await resolveModelRoute(provider, modelHint);
	// P245: enforce host-level spawn policy before launching any CLI subprocess.
	await assertSpawnAllowed(AGENTHIVE_HOST, route, proposalId, worktree);
	const agentEnv = await loadEnvAgent(worktree, worktreeRoot);
	let assembledTask = task;

	if (proposalId !== undefined) {
		const contextPackage = await buildProposalContextPackage({
			proposalId,
			taskType: stage,
			agentIdentity: req.agentLabel ?? worktree,
			maxTokens: 2000,
		});
		const maturityHint = stage === RfcStates.COMPLETE || stage === "DEPLOYED"
			? ""
			: `\n\n## Maturity Advancement\nWhen you complete your task, call the MCP tool \`set_maturity\` (action: "set_maturity") to advance this proposal to maturity "mature". This triggers the implicit gate to transition the proposal to the next workflow state. Use the proposal ID ${proposalId}.`;
		assembledTask = `${contextPackage}\n\n## Task\n${task}${maturityHint}`;
	}

	const spawnReq = { ...req, task: assembledTask };

	// Build argv + env from route metadata (api_spec drives which CLI is used)
	const { argv, env: extraEnv, stdin } = buildArgsBySpec(spawnReq, route);

	// Assemble process environment (agent-scoped, not inheriting secrets from host)
	const processEnv = buildSpawnProcessEnv({
		worktree,
		route,
		agentEnv,
		extraEnv: {
			...extraEnv,
			MCP_URL: process.env.MCP_URL ?? getMcpUrl(),
			// P466: hand the warm-boot briefing id to the child via env so it
			// can call `briefing_load(<id>)` on boot. Real uuid → child can
			// retrieve mission, success_criteria, allowed_tools, MCP quirks,
			// and escalation channels. Absent → child runs in legacy "blind"
			// mode using only the task prompt.
			...(req.briefingId ? { AGENTHIVE_BRIEFING_ID: req.briefingId } : {}),
		},
	});

	// Insert agent_runs row (status = running)
	const { rows } = await query(
		`INSERT INTO agent_runs
       (proposal_id, display_id, agent_identity, stage, model_used, status, activity, started_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, now())
     RETURNING id`,
		[
			proposalId ?? null,
			`wt:${worktree}`,
			req.agentLabel ? `${req.agentLabel}@${worktree}` : worktree,
			stage,
			route.modelName,
			req.activity ?? null,
		],
	);
	const agentRunId = String(rows[0].id);

	const startMs = Date.now();
	const cwd = join(worktreeRoot, worktree);

	const { stdout, stderr, exitCode } = await runProcess(
		argv,
		cwd,
		processEnv,
		timeoutMs,
		stdin,
	);
	const durationMs = Date.now() - startMs;

	// Update agent_runs on completion
	const status = exitCode === 0 ? "completed" : "failed";
	const outputSummary = stdout.slice(-1000);
	const errorDetail = stderr.slice(-4000);
	await query(
		`UPDATE agent_runs
     SET status = $1,
         duration_ms = $2,
         output_summary = $3,
         error_detail = $4,
         completed_at = now()
     WHERE id = $5`,
		[status, durationMs, outputSummary, errorDetail, agentRunId],
	);

	return { agentRunId, worktree, exitCode, stdout, stderr, durationMs };
}

// ─── Process runner ───────────────────────────────────────────────────────────

interface ProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

function runProcess(
	argv: string[],
	cwd: string,
	env: Record<string, string>,
	timeoutMs: number,
	stdin?: string,
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const [cmd, ...args] = argv;
		console.error(`[AgentSpawner] Spawning: ${cmd} ${args.slice(0, 3).join(" ")}...`);
		console.error(`[AgentSpawner] ANTHROPIC_AUTH_TOKEN in env: ${!!env.ANTHROPIC_AUTH_TOKEN}`);
		console.error(`[AgentSpawner] ANTHROPIC_BASE_URL in env: ${env.ANTHROPIC_BASE_URL}`);
		console.error(`[AgentSpawner] ANTHROPIC_MODEL in env: ${env.ANTHROPIC_MODEL}`);
		const child: ChildProcess = spawn(cmd, args, {
			cwd,
			env,
			stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		if (stdin !== undefined) {
			child.stdin?.end(stdin);
		}

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			stderr += "\n[agent-spawner] Killed after timeout";
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code });
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({
				stdout,
				stderr: `${stderr}\n[agent-spawner] spawn error: ${err.message}`,
				exitCode: null,
			});
		});
	});
}

// ─── Escalation ladder helper ─────────────────────────────────────────────────

/**
 * Escalation ladder: basic → standard → advanced → premium → USER.
 *
 * Called when a spawn returns a non-zero exit code or known error patterns.
 * Each escalation step retries with a stronger model.
 * If all models fail, inserts a CRITICAL notification_queue row for the USER.
 */
export async function escalateOrNotify(
	req: SpawnRequest,
	result: SpawnResult,
	proposalId?: number,
): Promise<SpawnResult | null> {
	// P405: use explicit provider if passed, otherwise fall back to worktree detection
	const provider = req.provider ?? await detectProvider(req.worktree, req.worktreeRoot ?? WORKTREE_ROOT);

	// P235/M026: build escalation ladder from model_routes for this agent_provider.
	// Per model: pick best (lowest priority) route. Then sort models cheap → expensive.
	const { rows: ladderRows } = await query<{
		model_name: string;
		cost: number;
	}>(
		`SELECT model_name, min(COALESCE(cost_per_million_input, 0)) AS cost
     FROM roadmap.model_routes
     WHERE agent_provider = $1 AND is_enabled = true
     GROUP BY model_name
     ORDER BY cost ASC`,
		[provider],
	);

	const ladder = ladderRows.map((r) => r.model_name);

	if (ladder.length === 0) {
		// No models in registry for this provider — skip escalation, notify
		await query(
			`INSERT INTO notification_queue (proposal_id, severity, channel, title, body)
       VALUES ($1, 'CRITICAL', 'discord', $2, $3)`,
			[
				proposalId ?? null,
				`Agent task failed — no escalation ladder for provider "${provider}"`,
				`Worktree: ${result.worktree}\nExit: ${result.exitCode}\nStderr: ${result.stderr.slice(0, 400)}`,
			],
		);
		return null;
	}

	// Find current position (req.model is the model used for this run)
	const currentModel = req.model ?? (await getHostDefaultModel()) ?? "";
	const currentIdx = ladder.indexOf(currentModel);
	const nextIdx = currentIdx + 1;

	if (nextIdx < ladder.length) {
		const nextModel = ladder[nextIdx];
		console.log(
			`[escalate] ${provider} ladder: "${currentModel}" → "${nextModel}" (step ${nextIdx}/${ladder.length - 1})`,
		);
		return spawnAgent({ ...req, model: nextModel });
	}

	// All escalations exhausted — notify USER
	await query(
		`INSERT INTO notification_queue (proposal_id, severity, channel, title, body)
     VALUES ($1, 'CRITICAL', 'discord', $2, $3)`,
		[
			proposalId ?? null,
			`Agent task failed after full escalation ladder`,
			`Worktree: ${result.worktree}\nExit: ${result.exitCode}\nStderr: ${result.stderr.slice(0, 400)}`,
		],
	);

	return null;
}
