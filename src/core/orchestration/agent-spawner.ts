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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import {
	getLatestQuotaSnapshot,
	validateModelForDispatch,
} from "../../apps/mcp-server/tools/spending/pg-handlers.ts";
import {
	buildContextPackage,
	type PackageType,
} from "../../infra/agency/context_builder.ts";
import { query } from "../../infra/postgres/pool.ts";
import * as config from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import {
	getDaemonUrl,
	getMcpUrl,
	getMcpUrlAsync,
} from "../../shared/runtime/endpoints.ts";
import { getProjectRoot, getWorktreeRoot } from "../../shared/runtime/paths.ts";
import {
	buildBaseName,
	computeAbbr,
	isLiaisonHint,
} from "../identity/agent-registry/agent-name.ts";
import { resolveInstanceId } from "../identity/agent-registry/registry.ts";
import { ObservabilityWriter } from "../observability/observability-writer.ts";
import {
	HotfixStates,
	isTerminal,
	RfcStates,
} from "../workflow/state-names.ts";
import { checkAgencyCapacity } from "./capacity-filter.ts";
import {
	getMcpInitDiagnosisReport,
	getMcpInitDiagnostics,
	type McpInitTiming,
	wrapMcpInitTimeout,
} from "./mcp-init-wrapper.ts";
import {
	isModelInCooldown,
	setCliFamilyCooldown,
	setModelCooldown,
	setProviderCooldown,
} from "./provider-cooldown.ts";
import { isWithinCapacity } from "./resolvers/capacity-guard.ts";
import {
	agencyPolicyFilterSql,
	authDownFilterSql,
	budgetFilterSql,
	buildEliminationDiagnosticSql,
	cooldownFilterSql,
	hostPolicyFilterSql,
	projectPolicyFilterSql,
	rolePolicyFilterSql,
} from "./resolvers/route-policy-filters.ts";
import type {
	EliminatedRoute,
	ResolveRouteOpts,
} from "./resolvers/route-resolver.types.ts";
import { provisionScratch, reapScratch, SCRATCH_ROOT } from "./scratch.ts";
import { sanitizeExtraEnv } from "./spawn-env-sanitizer.ts";
import { applySpawnStagger } from "./spawn-stagger.ts";
import { assertNotRepoRoot } from "./worktree-guard.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKTREE_ROOT = getWorktreeRoot();
const GITCONFIG_ROOT = join(getProjectRoot(), ".git", "worktrees-config");

// ─── Live child registry (shutdown plumbing) ─────────────────────────────────
//
// `runProcess` spawns long-lived `claude --print` (and similar) children that
// can run for many minutes. systemd units configure TimeoutStopSec, and the
// orchestrator's `shutdown()` path used to wait on the in-flight promise set
// — but those promises only resolve when the children themselves
// exit. If the children never receive a signal they keep running until
// systemd escalates to SIGKILL on the parent.
//
// We track every live child here so the service-level shutdown handler can
// signal them all in one shot. Exported helpers:
//   - liveChildCount()           : count of still-running spawns
//   - terminateLiveChildren(opt) : SIGTERM all, optionally SIGKILL after grace
//
// The set is keyed by `ChildProcess` so callers don't need to know about PIDs;
// stale entries are removed on `close`/`error`.
const liveChildren: Set<ChildProcess> = new Set();

/**
 * Register a spawned child in the live-child registry and automatically
 * deregister it when it emits `close` or `error`.
 *
 * Exported so tests can inject mock ChildProcess-like objects and verify
 * shutdown-plumbing behavior without spawning real processes.
 *
 * @internal — callers outside agent-spawner should only need this for tests.
 */
export function trackLiveChild(child: ChildProcess): void {
	liveChildren.add(child);
	const deregister = () => liveChildren.delete(child);
	child.once("close", deregister);
	child.once("error", deregister);
}

export function liveChildCount(): number {
	return liveChildren.size;
}

export interface TerminateOptions {
	/** Milliseconds to wait between SIGTERM and SIGKILL. Default 8000. */
	graceMs?: number;
	/** Optional logger; defaults to console.error so journalctl picks it up. */
	log?: (msg: string) => void;
}

export async function terminateLiveChildren(
	opts: TerminateOptions = {},
): Promise<{ signalled: number; killed: number }> {
	const log = opts.log ?? ((m: string) => console.error(m));
	const graceMs = Math.max(0, opts.graceMs ?? 8000);
	const snapshot = Array.from(liveChildren);
	if (snapshot.length === 0) return { signalled: 0, killed: 0 };

	log(
		`[AgentSpawner] terminating ${snapshot.length} live child(ren) with SIGTERM`,
	);
	let signalled = 0;
	for (const child of snapshot) {
		try {
			if (child.exitCode === null) {
				child.kill("SIGTERM");
				signalled++;
			}
		} catch (err) {
			log(
				`[AgentSpawner] SIGTERM failed for pid ${child.pid}: ${(err as Error).message}`,
			);
		}
	}

	if (graceMs === 0) return { signalled, killed: 0 };

	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline && liveChildren.size > 0) {
		await new Promise((r) => setTimeout(r, 250));
	}

	let killed = 0;
	for (const child of Array.from(liveChildren)) {
		try {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				killed++;
			}
		} catch (err) {
			log(
				`[AgentSpawner] SIGKILL failed for pid ${child.pid}: ${(err as Error).message}`,
			);
		}
	}
	if (killed > 0) {
		log(`[AgentSpawner] SIGKILL'd ${killed} child(ren) that ignored SIGTERM`);
	}
	return { signalled, killed };
}

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
	/**
	 * P852: Capability hints used to derive the structured agent identity
	 * (`{rt}-{host}-{exp}-{n}`). The first non-empty entry maps to the `exp`
	 * segment; "liaison" routes the agent into the singleton 0..9 slot range.
	 * If absent, the spawner falls back to [stage] for the hint list.
	 */
	capabilities?: string[];
	/** Descriptive activity label (e.g. "researching", "enhancing", "reviewing") */
	activity?: string;
	/**
	 * P466: warm-boot briefing id assembled by the parent (orchestrator) before
	 * dispatch. Set as AGENTHIVE_BRIEFING_ID env in the spawned child so the
	 * child can call `briefing_load(<id>)` on boot. Without this the child
	 * runs in legacy "blind" mode (only the task prompt for context).
	 */
	briefingId?: string | null;
	/** P760: Project id used to enforce per-project dispatch capacity limits. */
	projectId?: number;
	/** P771 Layer 3: agency identity for per-agency route policy filter. */
	agencyIdentity?: string | null;
	/** P771 Layer 4: agent_role_profile row id for role-based route constraints. */
	roleProfileId?: number | null;
	/** P226: Tier preference derived from task difficulty — passed to resolveModelRoute Layer 7. */
	requiredTier?: string | null;
	/** P604: trace context — propagated from parent orchestrator span */
	traceId?: string;
	/** P604: parent span ID for child span linking */
	parentSpanId?: string | null;
	/** P1068 AC-3: required role slug (e.g., 'engineering/code-reviewer') for role-identity binding */
	requiredRole?: string | null;
	/** P1392: resolved persona body for system-prompt injection (provider-aware) */
	persona?: string | null;
	/** P1392: persona name/source for telemetry */
	personaName?: string | null;
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
	/** DB primary key of the resolved model_routes row (P604: routing observability) */
	routeId?: bigint | null;
}

// Lazy-loaded Claude settings.json env vars (read once, cached)
let claudeSettingsEnv: Record<string, string> | undefined;

function loadClaudeSettingsEnv(): Record<string, string> {
	if (claudeSettingsEnv !== undefined) return claudeSettingsEnv;
	claudeSettingsEnv = {};
	try {
		const settingsPath = join(
			process.env.HOME ?? "/root",
			".claude",
			"settings.json",
		);
		console.error(
			`[AgentSpawner] Loading Claude settings from: ${settingsPath}`,
		);
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed?.env && typeof parsed.env === "object") {
			for (const [k, v] of Object.entries(parsed.env)) {
				if (typeof v === "string") claudeSettingsEnv[k] = v;
			}
		}
		console.error(
			`[AgentSpawner] Loaded ${Object.keys(claudeSettingsEnv).length} env vars from settings.json`,
		);
		console.error(
			`[AgentSpawner] ANTHROPIC_AUTH_TOKEN present: ${!!claudeSettingsEnv.ANTHROPIC_AUTH_TOKEN}`,
		);
		console.error(
			`[AgentSpawner] ANTHROPIC_BASE_URL present: ${!!claudeSettingsEnv.ANTHROPIC_BASE_URL}`,
		);
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
	traceId?: string;
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
		resolvedKey =
			process.env[input.route.apiKeyEnv] ??
			settingsEnv[input.route.apiKeyEnv] ??
			null;
	}
	let resolvedFallback: string | null = null;
	if (input.route.apiKeySecondary) {
		resolvedFallback = input.route.apiKeySecondary;
	} else if (input.route.apiKeyFallbackEnv) {
		resolvedFallback =
			process.env[input.route.apiKeyFallbackEnv] ??
			settingsEnv[input.route.apiKeyFallbackEnv] ??
			null;
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
		HOME: input.agentEnv.HOME ?? process.env.HOME ?? "/var/lib/agenthive",
		...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
		// Agent-specific DB credentials — agent env first, then process env
		DATABASE_URL: input.agentEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? "",
		AGENT_WORKTREE: input.worktree,
		AGENT_PROVIDER: input.route.agentProvider,
		AGENT_ROUTE_PROVIDER: input.route.routeProvider,
		AGENT_API_SPEC: input.route.apiSpec,
		// Spawn control: DB-driven flag tells the agent whether it may spawn subagents
		AGENTHIVE_SPAWN_DELEGATE: String(input.route.spawnDelegate),
		// P604: propagate trace context into child process
		...(input.traceId && { AGENTHIVE_TRACE_ID: input.traceId }),
		// Git identity isolation
		GIT_CONFIG_GLOBAL: `${GITCONFIG_ROOT}/${input.worktree}.gitconfig`,
		GIT_CONFIG_NOSYSTEM: "1",
		// API keys are selected from DB-backed route metadata, not worktree prefix.
		...routeCredentialEnv,
	};

	return {
		...baseEnv,
		...sanitizeExtraEnv(input.extraEnv),
	};
}

function assertCliAuthAvailable(
	route: ModelRoute,
	env: Record<string, string>,
): void {
	if (route.agentCli !== "codex") return;
	if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return;

	const codexHome = env.CODEX_HOME ?? join(env.HOME, ".codex");
	const authPath = join(codexHome, "auth.json");
	if (existsSync(authPath)) return;

	throw new Error(
		[
			`[AgentSpawner] Codex auth missing for route ${route.agentProvider}/${route.modelName}`,
			`no OPENAI_API_KEY/CODEX_API_KEY resolved and no auth.json found under ${codexHome}`,
			"run codex login for the service user, or set OPENAI_API_KEY/CODEX_API_KEY/CODEX_HOME in the orchestrator environment",
		].join("; "),
	);
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
		"--dangerously-skip-permissions", // spawned agents need Write/Bash to do real work
		"--model",
		route.modelName,
	];

	// P1392: Claude supports --append-system-prompt for persona injection.
	// If persona is provided, use it as a system prompt flag instead of prepending to task.
	if (req.persona) {
		argv.push("--append-system-prompt", req.persona);
	}

	// Append the task (which should NOT contain the persona if we used --append-system-prompt)
	argv.push(req.task);

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
 *
 * P1392: For providers without --append-system-prompt support, persona is prepended to task.
 */
function buildCodexArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	// P1392: Prepend persona to task for codex (no --append-system-prompt support)
	const taskWithPersona = req.persona
		? `${req.persona}\n\n${req.task}`
		: req.task;

	const argv = [
		route.cliPath ?? "codex",
		"exec",
		"--dangerously-bypass-approvals-and-sandbox",
		"--model",
		route.modelName,
		taskWithPersona,
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
 *
 * --skip-trust: required for headless invocation when the worktree directory
 * isn't on Gemini's trusted-folders list. The agent-spawner constructs a
 * whitelist-only child env so GEMINI_CLI_TRUST_WORKSPACE doesn't propagate
 * from the parent agency process; the CLI flag is the load-bearing equivalent.
 *
 * P1392: For Gemini, persona is prepended to the prompt (via # Role header format).
 */
function buildGeminiArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	// P1392: Prepend persona with # Role header format for gemini
	const taskWithPersona = req.persona
		? `# Role\n\n${req.persona}\n\n${req.task}`
		: req.task;

	const argv = [
		route.cliPath ?? "gemini",
		"--skip-trust",
		"--model",
		route.modelName,
		"--prompt",
		taskWithPersona,
	];
	return { argv, env: {} };
}

/**
 * Build argv + env for the GitHub Copilot CLI.
 * Used when agent_cli = 'copilot' — auth is read from ~/.copilot/settings.json
 * by the CLI itself; no API key env var is required.
 * cli_path in model_routes controls the binary location (no hardcoding here).
 *
 * P1392: For Copilot, persona is prepended to the prompt (via ## Persona header format).
 */
function buildCopilotArgs(req: SpawnRequest, route: ModelRoute): CommandSpec {
	// P1392: Prepend persona with ## Persona header format for copilot
	const taskWithPersona = req.persona
		? `## Persona\n\n${req.persona}\n\n${req.task}`
		: req.task;

	const argv = [
		route.cliPath ?? "copilot",
		"-p",
		taskWithPersona,
		"--yolo",
		"--model",
		route.modelName,
	];
	return { argv, env: {} };
}

function buildAntigravityArgs(
	req: SpawnRequest,
	route: ModelRoute,
): CommandSpec {
	const argv = [
		route.cliPath ?? "agy",
		"-p",
		req.task,
		"--model",
		route.modelName,
		"--dangerously-skip-permissions",
		"--add-dir",
		req.worktree,
	];
	return { argv, env: {} };
}

/** Dispatch to the correct builder based on route.agentCli (DB is source of truth). */
export function buildArgsBySpec(
	req: SpawnRequest,
	route: ModelRoute,
): CommandSpec {
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
		case "agy":
			return buildAntigravityArgs(req, route);
		case "openclaw":
			// P1029: OpenClaw is a WS daemon, not a subprocess — it has no argv.
			// spawnAgent intercepts this agent_cli before runProcess and drives the
			// WebSocket session instead. The empty spec is a sentinel so this
			// route never falls through to buildOpenAICompatArgs.
			return { argv: [], env: {} };
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
	if (!route.agentCli) {
		throw new Error(
			`[P235] Refusing to run "${provider}" route "${route.modelName}" with missing agent_cli.`,
		);
	}
	const knownClis = [
		"claude",
		"codex",
		"hermes",
		"gemini",
		"copilot",
		"agy",
		"openclaw", // P1029: WS-daemon provider, executed via WebSocketAdapter
	];
	if (!knownClis.includes(route.agentCli)) {
		throw new Error(
			`[P235] Refusing to run "${provider}" route "${route.modelName}" with unknown agent_cli "${route.agentCli}".`,
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
 * P743: thrown when detectProvider() exhausts all configured sources
 * (.env.agent, AGENTHIVE_DEFAULT_PROVIDER, roadmap.model_routes) without
 * finding a usable provider. Loud failure preferred over a hardcoded
 * source literal that may route to an unconfigured provider.
 */
export class NoProviderConfigured extends Error {
	constructor(readonly worktreeName: string) {
		super(
			`[P743] No provider configured for worktree "${worktreeName}". ` +
				`Set AGENT_PROVIDER in .env.agent, AGENTHIVE_DEFAULT_PROVIDER in ` +
				`environment, or seed at least one enabled route in roadmap.model_routes.`,
		);
		this.name = "NoProviderConfigured";
	}
}

/**
 * P742: thrown when host_model_policy excludes every available route at
 * the picker layer. Distinct from SpawnPolicyViolation, which fires
 * post-resolution when an already-picked route is rejected. NoPolicyAllowedRoute
 * means the picker never found a candidate — fail-closed at resolution time.
 *
 * P773: all_throttled=true when routes exist and pass all policy layers (1-5)
 * but are all under active cooldown (Layer 6). Caller can distinguish this
 * from a permanent policy block and may retry after cooldown elapses.
 */
export class NoPolicyAllowedRoute extends Error {
	readonly all_throttled: boolean;
	constructor(
		readonly host: string,
		readonly provider: string,
		readonly hint: string | null,
		opts: { all_throttled?: boolean } = {},
	) {
		const throttledNote = opts.all_throttled
			? " All routes are in cooldown — retry after throttle window elapses."
			: " Check roadmap.host_model_policy.";
		super(
			`[P742] No host_model_policy-allowed route for host="${host}" provider="${provider}" hint=${hint ? `"${hint}"` : "null"}.${throttledNote}`,
		);
		this.name = "NoPolicyAllowedRoute";
		this.all_throttled = opts.all_throttled ?? false;
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
 *
 * P928: Refactored to use selectActiveRouteRow as the canonical route eligibility
 * check, but note: this function does NOT filter by agent_provider (it picks the
 * first enabled route across all providers). This differs from selectActiveRouteRow
 * which requires a provider parameter. The fallback path here queries directly to
 * find any enabled route without a provider constraint.
 */
export async function resolveActiveRouteProvider(): Promise<AgentProvider | null> {
	// P245 host policy: filter out routes whose route_provider is forbidden
	// (or not on the allowlist) for the current host. Without this, the
	// picker can return the global priority-1 route only to have the spawner
	// reject it at launch time — every gate dispatch dies in 'blocked'
	// status, the proposal stays mature, fn_notify_gate_ready re-fires, and
	// the Discord state-feed gets spammed with the same gate-ready event.
	const { rows } = await query<{ agent_provider: string }>(
		`SELECT mr.agent_provider
		   FROM roadmap.model_routes mr
		   LEFT JOIN roadmap.host_model_policy hp
		     ON hp.host_name = $1::text
		  WHERE mr.is_enabled = true
		    AND (
		      hp.host_name IS NULL  -- no policy row → allow any (legacy)
		      OR (
		        (
		          coalesce(array_length(hp.allowed_providers, 1), 0) = 0
		          OR mr.route_provider = ANY(hp.allowed_providers)
		        )
		        AND NOT (mr.route_provider = ANY(hp.forbidden_providers))
		      )
		    )
		  ORDER BY mr.priority ASC, COALESCE(mr.cost_per_million_input, 0) ASC
		  LIMIT 1`,
		[AGENTHIVE_HOST],
	);
	return (rows[0]?.agent_provider ?? null) as AgentProvider | null;
}

/**
 * Detect a worktree's provider from provider_registry → agent_registry.preferred_provider.
 * Falls through to AGENT_PROVIDER env var, then the first enabled model_routes row.
 * .env.agent is no longer read here (AC5).
 */
export async function detectProvider(
	worktreeName: string,
	_worktreeRoot: string = WORKTREE_ROOT,
): Promise<AgentProvider> {
	// AC5: query preferred_provider for the active agency matching this worktree identity
	try {
		const { rows } = await query<{ preferred_provider: string | null }>(
			`SELECT ar.preferred_provider
			 FROM roadmap_workforce.agent_registry ar
			 WHERE ar.agent_identity = $1
			   AND EXISTS (
			     SELECT 1 FROM roadmap_workforce.provider_registry pr
			     WHERE pr.agency_id = ar.id AND pr.status = 'active'
			   )
			 LIMIT 1`,
			[worktreeName],
		);
		const fromRegistry = rows[0]?.preferred_provider;
		if (fromRegistry) return fromRegistry as AgentProvider;
	} catch {
		// Table may not yet exist on a fresh DB — fall through gracefully
	}
	// Env var set by operator (avoids hard-coded provider in config files)
	const envProvider = process.env.AGENT_PROVIDER as AgentProvider | undefined;
	if (envProvider) return envProvider;
	// DB fallback: first enabled route so switching providers requires only a DB update
	const active = await resolveActiveRouteProvider();
	if (active) return active;
	// Last resort: use the env var if set.
	// P743: removed the silent `?? "hermes"` fallback. Provider identity must
	// originate from .env.agent, AGENTHIVE_DEFAULT_PROVIDER, or roadmap.model_routes
	// — never a hardcoded source literal. Loud failure is preferred over routing
	// to a provider the operator may not have configured.
	const defaultProvider = process.env.AGENTHIVE_DEFAULT_PROVIDER as
		| AgentProvider
		| undefined;
	if (defaultProvider) return defaultProvider;
	throw new NoProviderConfigured(worktreeName);
}

// ─── P235: Platform-Aware Model Constraints ──────────────────────────────────

/**
 * P772: Fire-and-forget audit INSERT. Classifies every non-winning enabled route
 * by the first policy layer that eliminated it, then writes one row to
 * roadmap.route_decision_log. Errors are swallowed — this must never block dispatch.
 */
async function logRouteDecision({
	provider,
	chosenRouteId,
	proposalId,
	role,
	agencyIdentity,
	projectId,
	roleProfileId,
}: {
	provider: string;
	chosenRouteId: number;
	proposalId: number | null;
	role: string | null;
	agencyIdentity: string | null;
	projectId: number | null;
	roleProfileId: number | null;
}): Promise<void> {
	// Params: $1=provider, $2=winner id, $3=host, $4=projectId, $5=agencyIdentity, $6=roleProfileId
	const { rows } = await query<{
		id: number;
		route_provider: string;
		first_failing_layer: string;
	}>(buildEliminationDiagnosticSql(1, 2, 3, 4, 5, 6, "mr"), [
		provider,
		chosenRouteId,
		AGENTHIVE_HOST,
		projectId,
		agencyIdentity,
		roleProfileId,
	]);

	const eliminatedRoutes = rows
		.filter((r) => r.first_failing_layer !== "passed")
		.map((r) => ({
			route_id: r.id,
			route_provider: r.route_provider,
			reason: r.first_failing_layer,
		}));

	await query(
		`INSERT INTO roadmap.route_decision_log
		   (proposal_id, role, agency_identity, chosen_route_id, eliminated_routes)
		 VALUES ($1, $2, $3, $4, $5)`,
		[
			proposalId,
			role,
			agencyIdentity,
			chosenRouteId,
			JSON.stringify(eliminatedRoutes),
		],
	);
}

/**
 * P235 + M026 + P771: Resolve model route for a spawn request.
 *
 * Returns a full ModelRoute (including base_url and api_spec) so the spawner
 * can build the correct CLI args regardless of which worktree is invoking it.
 * This enables global escalation (e.g. openclaw → claude-opus via anthropic route).
 *
 * P771/P773: applies a 6-layer AND filter chain before selecting the route:
 *   Layer 1 — host_model_policy (existing P742 filter)
 *   Layer 2 — project_route_policy (allowlist/denylist per project)
 *   Layer 3 — agency_route_policy (allowlist/denylist per agency identity)
 *   Layer 4 — agent_role_profile route constraints (role-based)
 *   Layer 5 — route_token_budget (depleted hourly budgets excluded)
 *   Layer 6 — cooldown_until (throttled routes excluded until cooldown elapses)
 *
 * Resolution order:
 *   1. If hint given: find the best enabled route for (hint, agent_provider) passing all layers
 *   2. If hint has no passing route: warn and fall back to provider default
 *   3. If no hint: pick cheapest enabled route passing all 5 layers
 */
async function resolveModelRoute(
	opts: ResolveRouteOpts,
): Promise<ModelRoute & { eliminatedRoutes: EliminatedRoute[] }> {
	const {
		provider,
		projectId = null,
		agencyIdentity = null,
		roleProfileId = null,
		modelHint: hint,
		proposalId = null,
		role = null,
		requiredTier = null,
	} = opts;
	type RouteRow = {
		id: number;
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

	let tierFilter = "";
	let tierParamValue: string | null = requiredTier;

	if (role && (role.includes("frontier-review") || role.includes("audit"))) {
		tierParamValue = "frontier";
	}

	if (tierParamValue) {
		tierFilter = ` AND mr.tier = '${tierParamValue}'`;
	}

	// P1068 AC-5: Layer 7 — enforce agency preferred_provider as hard constraint
	// If agency has preferred_provider set, only routes matching that provider are allowed
	let preferredProviderFilter = "";
	if (agencyIdentity) {
		try {
			const { rows: agencyRows } = await query<{
				preferred_provider: string | null;
			}>(
				`SELECT preferred_provider FROM roadmap_workforce.agent_registry
				 WHERE agent_identity = $1 AND status = 'active'`,
				[agencyIdentity],
			);
			const preferredProvider = agencyRows[0]?.preferred_provider;
			if (preferredProvider) {
				preferredProviderFilter = ` AND mr.route_provider = '${preferredProvider}'`;
				console.log(
					`[AgentSpawner AC-5] Layer 7 applied: agency '${agencyIdentity}' enforced provider='${preferredProvider}'`,
				);
			}
		} catch (err) {
			console.warn(
				`[AgentSpawner AC-5] failed to resolve preferred_provider for '${agencyIdentity}':`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	// P771/P773/P1435: shared params for all route queries: $3=host, $4=projectId, $5=agencyIdentity, $6=roleProfileId
	const policyParams = [
		AGENTHIVE_HOST,
		projectId,
		agencyIdentity,
		roleProfileId,
	] as const;
	const policyFilters = `
          AND ${hostPolicyFilterSql(3, "mr")}
          AND ${projectPolicyFilterSql(4, "mr")}
          AND ${agencyPolicyFilterSql(5, "mr")}
          AND ${rolePolicyFilterSql(6, "mr")}
          AND ${budgetFilterSql(4, "mr")}
          AND ${cooldownFilterSql("mr", 5)}
          AND ${authDownFilterSql("mr")}${tierFilter}${preferredProviderFilter}`;

	const fetchRoute = (modelName: string) => {
		// P742+P771: $3=host, $4=projectId, $5=agencyIdentity, $6=roleProfileId
		// Layers 1-5 applied in WHERE; routes failing any layer are never returned.
		if (perMillionPricing) {
			return query<RouteRow>(
				`SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
               mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
               mr.cost_per_million_input, mr.cost_per_million_output,
               mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
               mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
        FROM roadmap.model_routes mr
        WHERE mr.model_name = $1
          AND mr.agent_provider = $2
          AND mr.is_enabled = true${policyFilters}
        ORDER BY mr.priority ASC, COALESCE(mr.cost_per_million_input, 0) ASC
        LIMIT 1`,
				[modelName, provider, ...policyParams],
			);
		}

		return query<RouteRow>(
			`SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
              mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
              NULL::numeric AS cost_per_million_input,
              NULL::numeric AS cost_per_million_output,
              mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
              mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
       FROM roadmap.model_routes mr
       WHERE mr.model_name = $1
         AND mr.agent_provider = $2
         AND mr.is_enabled = true${policyFilters}
        ORDER BY mr.priority ASC
        LIMIT 1`,
			[modelName, provider, ...policyParams],
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
		costPer1kInput: Number(
			r.cost_per_million_input ? r.cost_per_million_input / 1000 : 0,
		),
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
		routeId: r.id ? BigInt(r.id) : null,
	});

	if (hint) {
		const { rows } = await fetchRoute(hint);
		if (rows.length > 0) {
			const route = toModelRoute(rows[0]);
			assertResolvedRouteMetadata(provider, route);
			void logRouteDecision({
				provider,
				chosenRouteId: rows[0].id,
				proposalId,
				role,
				agencyIdentity,
				projectId,
				roleProfileId,
			}).catch((err) => {
				console.warn(
					"[P772] route_decision_log write failed (non-blocking):",
					err instanceof Error ? err.message : String(err),
				);
			});
			return { ...route, eliminatedRoutes: [] };
		}

		console.warn(
			`[P235] No enabled route for model "${hint}" with agent_provider "${provider}". ` +
				`Falling back to default.`,
		);
		// Fall through to default resolution
	}

	// P771/P773: filter string for queries with params (provider=$1, host=$2, projectId=$3, agency=$4, role=$5)
	const defaultPolicyFilters = `
          AND ${hostPolicyFilterSql(2, "mr")}
          AND ${projectPolicyFilterSql(3, "mr")}
          AND ${agencyPolicyFilterSql(4, "mr")}
          AND ${rolePolicyFilterSql(5, "mr")}
          AND ${budgetFilterSql(3, "mr")}
          AND ${cooldownFilterSql("mr", 4)}${tierFilter}${preferredProviderFilter}`;
	// P771: policy params without a leading modelName param (for default-selection queries)
	const defaultPolicyParams = [
		AGENTHIVE_HOST,
		projectId,
		agencyIdentity,
		roleProfileId,
	] as const;

	// Default: use DB is_default flag first, then cheapest enabled as fallback.
	// P742+P771: all 5 policy layers applied so a policy-excluded default is never returned.
	const { rows } = perMillionPricing
		? await query<RouteRow>(
				`SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
               mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
               mr.cost_per_million_input, mr.cost_per_million_output,
               mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
               mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
        FROM roadmap.model_routes mr
        WHERE mr.agent_provider = $1
          AND mr.is_enabled = true${defaultPolicyFilters}
        ORDER BY
          CASE WHEN mr.is_default = true THEN 0 ELSE 1 END,
          mr.priority ASC,
          COALESCE(mr.cost_per_million_input, 0) ASC
        LIMIT 1`,
				[provider, ...defaultPolicyParams],
			)
		: await query<RouteRow>(
				`SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
              mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
              NULL::numeric AS cost_per_million_input,
              NULL::numeric AS cost_per_million_output,
              mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
              mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
       FROM roadmap.model_routes mr
       WHERE mr.agent_provider = $1
         AND mr.is_enabled = true${defaultPolicyFilters}
        ORDER BY
          CASE WHEN mr.is_default = true THEN 0 ELSE 1 END,
          mr.priority ASC
        LIMIT 1`,
				[provider, ...defaultPolicyParams],
			);

	if (rows.length > 0) {
		const route = toModelRoute(rows[0]);
		assertResolvedRouteMetadata(provider, route);
		void logRouteDecision({
			provider,
			chosenRouteId: rows[0].id,
			proposalId,
			role,
			agencyIdentity,
			projectId,
			roleProfileId,
		}).catch((err) => {
			console.warn(
				"[P772] route_decision_log write failed (non-blocking):",
				err instanceof Error ? err.message : String(err),
			);
		});
		return { ...route, eliminatedRoutes: [] };
	}

	// Host-level fallback (legacy, kept for transition).
	// P742+P771: all 5 policy layers applied.
	const fallbackModel = await getHostDefaultModel();
	if (fallbackModel) {
		const { rows: defaultRows } = perMillionPricing
			? await query<RouteRow>(
					`SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
               mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
               mr.cost_per_million_input, mr.cost_per_million_output,
               mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
               mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
        FROM roadmap.model_routes mr
        WHERE mr.model_name = $1
          AND mr.agent_provider = $2
          AND mr.is_enabled = true${policyFilters}
        ORDER BY mr.priority ASC, COALESCE(mr.cost_per_million_input, 0) ASC
        LIMIT 1`,
					[fallbackModel, provider, ...policyParams],
				)
			: await query<RouteRow>(
					`SELECT mr.id, mr.model_name, mr.route_provider, mr.agent_provider,
              mr.agent_cli, mr.cli_path, mr.api_spec, mr.base_url, mr.plan_type,
              NULL::numeric AS cost_per_million_input,
              NULL::numeric AS cost_per_million_output,
              mr.api_key_env, mr.api_key_fallback_env, mr.base_url_env, mr.cli_api_key_env,
              mr.api_key_primary, mr.api_key_secondary, mr.spawn_toolsets, mr.spawn_delegate
       FROM roadmap.model_routes mr
       WHERE mr.model_name = $1
         AND mr.agent_provider = $2
         AND mr.is_enabled = true${policyFilters}
        ORDER BY mr.priority ASC
        LIMIT 1`,
					[fallbackModel, provider, ...policyParams],
				);
		if (defaultRows.length > 0) {
			const route = toModelRoute(defaultRows[0]);
			assertResolvedRouteMetadata(provider, route);
			void logRouteDecision({
				provider,
				chosenRouteId: defaultRows[0].id,
				proposalId,
				role,
				agencyIdentity,
				projectId,
				roleProfileId,
			}).catch((err) => {
				console.warn(
					"[P772] route_decision_log write failed (non-blocking):",
					err instanceof Error ? err.message : String(err),
				);
			});
			return { ...route, eliminatedRoutes: [] };
		}
	}

	// P742/P773: distinguish "no route at all", "policy excluded everything", and "all throttled".
	const { rows: anyRowsForProvider } = await query<{ count: number }>(
		`SELECT COUNT(*)::int AS count
		   FROM roadmap.model_routes
		  WHERE agent_provider = $1 AND is_enabled = true`,
		[provider],
	);
	if ((anyRowsForProvider[0]?.count ?? 0) > 0) {
		// P773: check if routes exist that pass layers 1-5 but are blocked only by cooldown.
		const { rows: throttledRows } = await query<{ count: number }>(
			`SELECT COUNT(*)::int AS count
			   FROM roadmap.model_routes mr
			  WHERE mr.agent_provider = $1
			    AND mr.is_enabled = true
			    AND ${hostPolicyFilterSql(2, "mr")}
			    AND ${projectPolicyFilterSql(3, "mr")}
			    AND ${agencyPolicyFilterSql(4, "mr")}
			    AND ${rolePolicyFilterSql(5, "mr")}
			    AND ${budgetFilterSql(3, "mr")}
			    AND mr.cooldown_until IS NOT NULL
			    AND mr.cooldown_until > NOW()`,
			[provider, ...defaultPolicyParams],
		);
		const allThrottled = (throttledRows[0]?.count ?? 0) > 0;
		if (allThrottled) {
			console.warn(
				`[P773] All eligible routes for provider "${provider}" are in cooldown. ` +
					`They will become eligible again after cooldown_until elapses.`,
			);
		}
		throw new NoPolicyAllowedRoute(AGENTHIVE_HOST, provider, hint ?? null, {
			all_throttled: allThrottled,
		});
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

// Map task stage strings to context package types for P230 caching.
const STAGE_TO_PACKAGE_TYPE: Record<string, PackageType> = {
	REVIEW: "gate_review",
	DEVELOP: "code_gen",
	DRAFT: "research",
	MERGE: "review",
	TEST: "test_writing",
};

async function buildProposalContextPackage(input: {
	proposalId: number;
	taskType: string;
	agentIdentity: string;
	maxTokens: number;
}): Promise<string> {
	const packageType: PackageType =
		STAGE_TO_PACKAGE_TYPE[input.taskType.toUpperCase()] ?? "research";

	try {
		const pkg = await buildContextPackage({
			proposal_id: BigInt(input.proposalId),
			package_type: packageType,
			agent_identity: input.agentIdentity,
		});
		const maxChars = Math.max(1000, input.maxTokens * 4);
		const text =
			pkg.context_text.length > maxChars
				? `${pkg.context_text.slice(0, maxChars)}\n...`
				: pkg.context_text;
		return text;
	} catch {
		// Fallback to lightweight inline assembly if context_builder fails.
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
}

/**
 * P738 (HF-B): assemble the spawn task with a closing hint that explicitly
 * forbids worker-side set_maturity calls. Gate evaluators advance maturity
 * server-side after parsing stdout verdicts; non-gate workers emit
 * spawn_summary_emit and let the orchestrator's reconciler decide.
 *
 * Pure function — exported for unit testing. The previous inline emitter
 * appended a "Maturity Advancement: call set_maturity → mature on completion"
 * block which became the loop accelerator (dev finishes, maturity flips,
 * fn_notify_gate_ready re-fires, dispatcher re-claims, repeat).
 */
export function renderClosingHint(input: {
	contextPackage: string;
	task: string;
	stage: string;
	proposalId: number | string;
	workflowName?: string;
	roleDefinitionMd?: string | null;
}): string {
	// P1068 AC-3: prepend role definition if provided
	// Role spec becomes the first context layer (identity + discipline)
	let prompt = input.contextPackage;
	if (input.roleDefinitionMd) {
		prompt = `${input.roleDefinitionMd}\n\n---\n\n${prompt}`;
	}

	// Terminal check using canonical state names from state-names.ts.
	// If workflowName is provided, use isTerminal() from the registry.
	// Otherwise, fall back to checking common terminal stage names.
	let terminal = false;
	if (input.workflowName) {
		try {
			terminal = isTerminal(input.workflowName, input.stage);
		} catch {
			// Registry not loaded or workflow unknown; fall back to hardcoded check
			terminal = input.stage === "COMPLETE" || input.stage === "DEPLOYED";
		}
	} else {
		// No workflow name provided; use fallback check
		terminal = input.stage === "COMPLETE" || input.stage === "DEPLOYED";
	}
	const hint = terminal
		? ""
		: `\n\n## Completion\nWhen you finish, emit \`mcp_agent action="spawn_summary_emit"\` with outcome=success|partial|failure|timeout|escalated and a one-paragraph summary. DO NOT call \`set_maturity\` — only the gate-evaluator advances maturity, after parsing your stdout verdict (gate roles) or after the orchestrator's reconciler reads your spawn_summary (non-gate roles). Proposal id: ${input.proposalId}.`;
	return `${prompt}\n\n## Task\n${input.task}${hint}`;
}

// ─── Core spawn logic ─────────────────────────────────────────────────────────

/**
 * P1359: Wrapper around spawnAgent that handles provider quota cooldown and retry.
 *
 * On rate_limited outcome with quotaErrorModel/Provider detected:
 * 1. Write model-level cooldown via setModelCooldown (GREATEST merge semantics)
 * 2. Re-resolve route via resolveModelRoute (Layer 6 filter excludes cooled routes)
 * 3. Retry with next-priority same-provider route
 * 4. Cap retries at SPAWN_PROVIDER_MAX_ATTEMPTS flag (default 3)
 * 5. If all enabled routes exhausted, set provider-level cooldown
 * 6. Return 'provider_exhausted' outcome when max attempts reached
 */
export async function spawnWithRetry(req: SpawnRequest): Promise<SpawnResult> {
	let maxAttempts = 3;
	try {
		maxAttempts =
			(await config.getOptional(FlagKeys.SPAWN_PROVIDER_MAX_ATTEMPTS)) ?? 3;
	} catch {
		// Standalone liaison processes may not initialize the global runtime
		// config resolver; keep the documented retry default instead of
		// blocking dispatch before the first spawn.
	}
	let attemptCount = 0;
	let lastResult: SpawnResult | null = null;
	const provider =
		req.provider || (await detectProvider(req.worktree, req.worktreeRoot));

	while (attemptCount < maxAttempts) {
		attemptCount++;
		lastResult = await spawnAgent(req);

		// If successful (exitCode === 0), return immediately
		if (lastResult.exitCode === 0) {
			return lastResult;
		}

		// Classify the exit to detect quota errors
		const exitClass = classifyExit(
			lastResult.stdout,
			lastResult.stderr,
			lastResult.exitCode,
		);

		// If not a rate-limit error, return immediately
		if (exitClass.outcome !== "rate_limited") {
			return lastResult;
		}

		// If rate-limit but no provider quota signal detected, return now (generic rate-limit)
		if (!exitClass.quotaErrorProvider) {
			return lastResult;
		}

		// P1359: We have a model-specific quota error — set cooldown and retry.
		// D3 remediation: honor the parsed exitClass.resetAt (from classifyExit's
		// per-provider detector); previous fixed 2/30 minute fallback ignored
		// gemini's "reset after 15h56m11s", anthropic's retry-after seconds, etc.
		const modelName = req.model || exitClass.quotaErrorModel || "unknown";
		const FALLBACK_COOLDOWN_MINUTES = 60; // 1h per P1359 design when no parsed TTL
		const MIN_COOLDOWN_MINUTES = 1; // floor (clock-skew safety)
		const MAX_COOLDOWN_MINUTES = 24 * 60; // 24h ceiling
		let cooldownMinutes: number;
		if (exitClass.resetAt instanceof Date) {
			const deltaMs = exitClass.resetAt.getTime() - Date.now();
			if (deltaMs > 0) {
				cooldownMinutes = Math.min(
					MAX_COOLDOWN_MINUTES,
					Math.max(MIN_COOLDOWN_MINUTES, Math.ceil(deltaMs / 60_000)),
				);
			} else {
				cooldownMinutes = FALLBACK_COOLDOWN_MINUTES;
			}
		} else {
			cooldownMinutes = FALLBACK_COOLDOWN_MINUTES;
		}
		const cooldownReason =
			lastResult.stderr?.slice(0, 500) ||
			lastResult.stdout?.slice(0, 500) ||
			"quota_exhausted";

		// P1682 AC-4 & AC-9: Decision fork — hold vs cooldown based on reset duration
		// Read thresholds from env (AC-6); defaults chosen for rapid re-probe vs over-wait
		const HOLD_WINDOW_MAX_SEC = Number(
			process.env.AGENTHIVE_HOLD_WINDOW_MAX_SEC ?? 1800,
		); // default 30min
		const CLAUDE_CLI_DEFAULT_COOLDOWN_SEC = Number(
			process.env.AGENTHIVE_CLAUDE_CLI_DEFAULT_COOLDOWN_SEC ?? 3600,
		); // default 1h
		const LONG_LIMIT_COOLDOWN_SEC = Number(
			process.env.AGENTHIVE_LONG_LIMIT_COOLDOWN_SEC ?? 86400,
		); // default 24h

		// Measure the time until reset
		const deltaMs =
			(exitClass.resetAt?.getTime() ??
				Date.now() + CLAUDE_CLI_DEFAULT_COOLDOWN_SEC * 1000) - Date.now();
		const deltaSec = Math.ceil(deltaMs / 1000);

		// AC-9: If reset is unparseable or beyond HOLD_WINDOW, use provider-level cooldown
		if (deltaSec > HOLD_WINDOW_MAX_SEC || !exitClass.resetAt) {
			// Long reset or unparseable: set provider-level cooldown (not hold)
			const longCooldownMinutes = Math.min(
				MAX_COOLDOWN_MINUTES,
				Math.ceil(LONG_LIMIT_COOLDOWN_SEC / 60),
			);
			try {
				if (exitClass.quotaErrorProvider === "claude") {
					await setCliFamilyCooldown(
						"claude",
						longCooldownMinutes,
						`${cooldownReason} [long_reset_exceeded_hold_window]`,
					);
				} else {
					await setModelCooldown(
						provider,
						modelName,
						longCooldownMinutes,
						`${cooldownReason} [long_reset_exceeded_hold_window]`,
					);
				}
			} catch (err) {
				console.error(
					`[P1682] Failed to set long-reset cooldown for ${provider}/${modelName}:`,
					err,
				);
			}
			// Return failure; do NOT call recordProviderHardLimit or fn_return_work_offer
			return lastResult;
		}

		// AC-4 & AC-5: Short reset (<= HOLD_WINDOW) — place in hold state if we have a reset time
		if (exitClass.quotaErrorProvider === "claude" && exitClass.resetAt) {
			try {
				// For claude CLI: also set route cooldown so new spawns don't immediately fail again
				await setCliFamilyCooldown("claude", cooldownMinutes, cooldownReason);
			} catch (err) {
				console.error(`[P1682] Failed to set model cooldown for claude:`, err);
			}
			// Note: recordProviderHardLimit() is called in offer-dispatch-handler.ts
			// after the spawn is claimed (not here). We just set the route cooldown.
		} else {
			try {
				await setModelCooldown(
					provider,
					modelName,
					cooldownMinutes,
					cooldownReason,
				);
			} catch (err) {
				console.error(
					`[P1359] Failed to set model cooldown for ${provider}/${modelName}:`,
					err,
				);
			}
		}

		// Re-resolve route applying Layer 6 cooldown filter
		let nextRoute;
		try {
			const resolveResult = await resolveModelRoute({
				provider,
				projectId: req.projectId ?? null,
				agencyIdentity: req.agencyIdentity ?? null,
				roleProfileId: req.roleProfileId ?? null,
				modelHint: req.model,
				proposalId: req.proposalId ?? null,
				role: req.stage,
			});
			nextRoute = resolveResult;
		} catch (err) {
			console.error(`[P1359] Re-resolve failed for ${provider}:`, err);
			// Check if all enabled routes for this provider are now cooled
			try {
				const countResult = await query<{ enabled_count: number }>(
					`SELECT COUNT(*) as enabled_count FROM roadmap.model_routes
					 WHERE route_provider = $1 AND is_enabled = true
					   AND (cooldown_until IS NULL OR cooldown_until <= NOW())`,
					[provider],
				);
				const nonCooledCount = countResult.rows[0]?.enabled_count ?? 0;
				if (nonCooledCount === 0) {
					// All routes cooled — escalate to provider level
					await setProviderCooldown(provider, "rate_limit", cooldownReason);
				}
			} catch (err2) {
				console.error(`[P1359] Failed to escalate to provider cooldown:`, err2);
			}
			return lastResult;
		}

		// Update request with new route for next attempt
		req = {
			...req,
			provider: nextRoute.routeProvider,
			model: nextRoute.modelName,
		};

		// If we've exhausted max attempts, check for provider escalation
		if (attemptCount >= maxAttempts) {
			try {
				const countResult = await query<{ enabled_count: number }>(
					`SELECT COUNT(*) as enabled_count FROM roadmap.model_routes
					 WHERE route_provider = $1 AND is_enabled = true
					   AND (cooldown_until IS NULL OR cooldown_until <= NOW())`,
					[provider],
				);
				const nonCooledCount = countResult.rows[0]?.enabled_count ?? 0;
				if (nonCooledCount === 0) {
					// All routes cooled — escalate to provider level
					await setProviderCooldown(provider, "rate_limit", cooldownReason);
				}
			} catch (err) {
				console.error(
					`[P1359] Failed to escalate to provider cooldown at max attempts:`,
					err,
				);
			}
			// Return the last failure; orchestrator will handle provider_exhausted state
			return lastResult;
		}

		// Continue to next iteration (retry with new route)
	}

	// Should not reach here, but return last result as fallback
	return (
		lastResult || {
			agentRunId: "unknown",
			worktree: req.worktree,
			exitCode: 1,
			stdout: "",
			stderr: "Spawn loop exhausted without valid result",
			durationMs: 0,
		}
	);
}

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
		timeoutMs = Number(process.env.AGENTHIVE_SPAWN_TIMEOUT_MS ?? 1_200_000),
		worktreeRoot = WORKTREE_ROOT,
		provider: providerOverride,
	} = req;

	// P760: enforce per-project dispatch capacity before any costly work.
	if (req.projectId !== undefined) {
		const withinCap = await isWithinCapacity(req.projectId);
		if (!withinCap) {
			throw new Error(
				`[P760] Project ${req.projectId} is at max concurrent dispatch capacity`,
			);
		}
	}

	// P1730 AC-4: apply spawn-start stagger to mitigate MCP-init thundering herd.
	// Spreads concurrent spawns across a configurable window (default ~1.5s per spawn)
	// plus random jitter (default ~500ms) to break synchronized init hangs.
	await applySpawnStagger();

	// P1004: pre-spawn quota check — defer if provider quota is critically low.
	// Reads the latest agent_usage_snapshot for the target provider. Missing
	// snapshot = no data yet, so we allow the spawn (fail open rather than block
	// all agents until the first report arrives).
	const QUOTA_HEADROOM_PCT = parseFloat(
		process.env.QUOTA_HEADROOM_PCT ?? "0.20",
	);
	if (req.provider) {
		try {
			const quotaSnap = await getLatestQuotaSnapshot(req.provider);
			if (
				quotaSnap?.quota_remaining !== null &&
				quotaSnap?.quota_remaining !== undefined &&
				quotaSnap.quota_limit !== null &&
				quotaSnap.quota_limit !== undefined &&
				quotaSnap.quota_limit > 0
			) {
				const pct = quotaSnap.quota_remaining / quotaSnap.quota_limit;
				if (pct < QUOTA_HEADROOM_PCT) {
					throw new Error(
						`[P1004] Spawn deferred: ${req.provider} quota at ${Math.round(pct * 100)}% ` +
							`(${quotaSnap.quota_remaining}/${quotaSnap.quota_limit} remaining, ` +
							`headroom threshold ${Math.round(QUOTA_HEADROOM_PCT * 100)}%). ` +
							`Resets at ${quotaSnap.quota_reset_at?.toISOString() ?? "unknown"}.`,
					);
				}
			}
		} catch (err) {
			// Only re-throw P1004 quota errors; silently swallow DB errors so a
			// missing snapshot table (pre-migration) never blocks spawning.
			if (err instanceof Error && err.message.startsWith("[P1004]")) throw err;
		}
	}

	// P405: provider comes from model_routes via orchestrator, not hardcoded to worktree
	const provider =
		providerOverride ?? (await detectProvider(worktree, worktreeRoot));
	// P235/M026/P771/P772/P226: resolve full route applying all policy layers; logs decision
	const { eliminatedRoutes: _eliminatedRoutes, ...route } =
		await resolveModelRoute({
			provider,
			projectId: req.projectId ?? null,
			agencyIdentity: req.agencyIdentity ?? null,
			roleProfileId: req.roleProfileId ?? null,
			modelHint,
			proposalId: req.proposalId ?? null,
			role: req.stage,
			requiredTier: req.requiredTier ?? null,
		});
	// P797: validate that the resolved model has at least one enabled route before spawning
	const routeCheck = await validateModelForDispatch(
		route.modelName,
		req.proposalId,
	);
	if (!routeCheck.valid) {
		throw new Error(
			`[P797] Cannot spawn agent: ${routeCheck.error} — model="${routeCheck.model ?? route.modelName}"`,
		);
	}
	// P245: enforce host-level spawn policy before launching any CLI subprocess.
	await assertSpawnAllowed(AGENTHIVE_HOST, route, proposalId, worktree);

	// P1365-AC4/AC8: Check agency capacity for the resolved provider/model
	// Reject hard-throttled agencies; soft-throttled ones proceed but with audit log
	if (req.agencyIdentity) {
		const { isHardThrottled } = await checkAgencyCapacity(
			req.agencyIdentity,
			route.agentProvider,
			route.modelName,
			req.projectId,
		);
		if (isHardThrottled) {
			throw new Error(
				`[P1365] Cannot spawn agent: agency "${req.agencyIdentity}" is hard-throttled for ${route.agentProvider}/${route.modelName}. Requests are being rate-limited; retrying in ~${route.modelName} reset window.`,
			);
		}
	}

	const agentEnv = await loadEnvAgent(worktree, worktreeRoot);
	let assembledTask = task;

	// P852: derive structured agent identity (`{rt}-{host}-{exp}-{n}`) when the
	// caller did not pre-claim a label. The slot allocation hits agent_registry,
	// so we do it once here and reuse the value for context, agent_runs, and
	// the child env. Falls back to the worktree name if anything is missing.
	const routeAbbr = computeAbbr(
		route.agentProvider,
		route.modelName,
		route.routeProvider,
	);
	const identityHints: ReadonlyArray<string | undefined> =
		req.capabilities && req.capabilities.length > 0
			? req.capabilities
			: [stage];
	let effectiveLabel = req.agentLabel;
	if (!effectiveLabel) {
		const base = buildBaseName(routeAbbr, AGENTHIVE_HOST, identityHints);
		effectiveLabel = await resolveInstanceId(
			base,
			isLiaisonHint(identityHints),
		);
	}
	const agentIdentity = effectiveLabel ?? worktree;

	if (proposalId !== undefined) {
		const contextPackage = await buildProposalContextPackage({
			proposalId,
			taskType: stage,
			agentIdentity,
			maxTokens: 2000,
		});
		// Fetch workflow name for terminal state check
		let workflowName: string | undefined;
		try {
			const { rows } = await query<{ workflow_name: string | null }>(
				`SELECT workflow_name FROM roadmap_proposal.proposal WHERE id = $1`,
				[proposalId],
			);
			workflowName = rows[0]?.workflow_name ?? undefined;
		} catch {
			// Silently ignore query errors; renderClosingHint has fallback checks
		}

		// P1068 AC-3: Load role definition if requiredRole is specified
		let roleDefinitionMd: string | null = null;
		if (req.requiredRole) {
			try {
				const { rows } = await query<{ content_md: string }>(
					`SELECT content_md FROM roadmap_proposal.role_definition WHERE role_slug = $1`,
					[req.requiredRole],
				);
				roleDefinitionMd = rows[0]?.content_md ?? null;
				if (!roleDefinitionMd) {
					console.warn(
						`[AgentSpawner] AC-3: role '${req.requiredRole}' not found in role_definition table`,
					);
				}
			} catch (err) {
				console.warn(
					`[AgentSpawner] AC-3: failed to load role definition for '${req.requiredRole}':`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		assembledTask = renderClosingHint({
			contextPackage,
			task,
			stage,
			proposalId,
			workflowName,
			roleDefinitionMd,
		});
	}

	const spawnReq = { ...req, task: assembledTask };

	// Build argv + env from route metadata (api_spec drives which CLI is used)
	const { argv, env: extraEnv, stdin } = buildArgsBySpec(spawnReq, route);

	// P604: trace context — inherit from request or start a new root trace
	const traceId = req.traceId ?? randomUUID();
	const obsWriter = new ObservabilityWriter("operator:agent-spawner");

	const { spanId } = await obsWriter.startSpan({
		traceId,
		operation: "agent.spawn",
		parentSpanId: req.parentSpanId ?? null,
		attributes: {
			worktree,
			agent_provider: provider,
			stage,
			...(proposalId !== undefined && { proposal_id: proposalId }),
		},
	});

	// Assemble process environment (agent-scoped, not inheriting secrets from host)
	const processEnv = buildSpawnProcessEnv({
		worktree,
		route,
		agentEnv,
		traceId,
		extraEnv: {
			...extraEnv,
			MCP_URL: process.env.MCP_URL ?? (await getMcpUrlAsync()),
			// P466: hand the warm-boot briefing id to the child via env so it
			// can call `briefing_load(<id>)` on boot. Real uuid → child can
			// retrieve mission, success_criteria, allowed_tools, MCP quirks,
			// and escalation channels. Absent → child runs in legacy "blind"
			// mode using only the task prompt.
			...(req.briefingId ? { AGENTHIVE_BRIEFING_ID: req.briefingId } : {}),
			// P852: hand the structured identity and route abbr to the child so it
			// can register itself under the same label that's already in agent_runs.
			AGENTHIVE_AGENT_IDENTITY: agentIdentity,
			AGENTHIVE_ROUTE_ABBR: routeAbbr,
		},
	});

	// P1967 AC-3: Check OAuth token expiry if present in processEnv (best-effort)
	if (processEnv.CLAUDE_CODE_OAUTH_TOKEN && route.agentProvider === "claude") {
		try {
			const provisionedAtKey = (FlagKeys as Record<string, unknown>)[
				"CLAUDE_OAUTH_TOKEN_PROVISIONED_AT_MS"
			];
			if (provisionedAtKey) {
				const provisionedAt = (await config.getOptional(
					provisionedAtKey as never,
				)) as number | undefined;
				if (provisionedAt) {
					const { checkOAuthTokenExpiry } = await import(
						"../../core/runtime/oauth-token-monitor.ts"
					);
					checkOAuthTokenExpiry(provisionedAt, 30, {
						warn: (msg: string) => console.warn(`[AgentSpawner] ${msg}`),
					});
				}
			}
		} catch {
			// non-fatal: token expiry check is advisory only
		}
	}

	try {
		assertCliAuthAvailable(route, processEnv);
	} catch (err) {
		await obsWriter.closeSpan({
			spanId,
			status: "error",
			errorMessage: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}

	// V3-C4 (P1436): provider truth at spawn. The claiming agency's DECLARED
	// provider (agent_registry.preferred_provider) must match the RESOLVED route
	// provider (route.agentProvider) — same vocabulary (claude/codex/copilot/
	// gemini/hermes), so a direct string compare. Phase-1 enforcement is
	// warn+record (legacy divergence like cooper/george exists): we log the
	// mismatch and stamp agent_runs so the v_provider_mismatch audit can prove
	// the live divergence rate. Fail-closed (throw before launch) flips on once
	// that rate hits zero — documented on P1436. No agencyIdentity (legacy/direct
	// spawn) → nothing to assert; recorded as NULL claimed_provider.
	let claimedProvider: string | null = null;
	let agentCliDeclared: string | null = null;
	let providerMismatch = false;
	if (req.agencyIdentity) {
		try {
			const { rows: agRows } = await query<{
				preferred_provider: string | null;
				agent_cli: string | null;
			}>(
				`SELECT preferred_provider, agent_cli
				   FROM roadmap_workforce.agent_registry
				  WHERE agent_identity = $1 LIMIT 1`,
				[req.agencyIdentity],
			);
			claimedProvider = agRows[0]?.preferred_provider ?? null;
			agentCliDeclared = agRows[0]?.agent_cli ?? null;
			if (claimedProvider && claimedProvider !== route.agentProvider) {
				providerMismatch = true;
				console.warn(
					`[AgentSpawner][P1436] provider mismatch: agency '${req.agencyIdentity}' ` +
						`declares provider='${claimedProvider}' but resolved route is ` +
						`'${route.agentProvider}' (model=${route.modelName}, route_id=${route.routeId ?? "?"}). ` +
						`Recording mismatch (phase-1 warn+record; not fail-closed).`,
				);
			}
		} catch (lookupErr) {
			console.warn(
				`[AgentSpawner][P1436] provider-truth lookup failed for agency '${req.agencyIdentity}' (non-fatal):`,
				lookupErr instanceof Error ? lookupErr.message : lookupErr,
			);
		}
	}

	// Insert agent_runs row (status = running)
	// P852: agent_runs.agent_identity is the structured label without the
	// worktree suffix, so it joins cleanly to agent_registry rows.
	// P1436: also record provider-truth columns for spend/routing audit.
	const { rows } = await query(
		`INSERT INTO roadmap_workforce.agent_runs
       (proposal_id, display_id, agent_identity, stage, model_used, status, activity, started_at,
        claimed_provider, resolved_provider, agent_cli, route_id, agency_identity, provider_mismatch)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, now(),
        $7, $8, $9, $10, $11, $12)
     RETURNING id`,
		[
			proposalId ?? null,
			`wt:${worktree}`,
			agentIdentity,
			stage,
			route.modelName,
			req.activity ?? null,
			claimedProvider,
			route.agentProvider,
			agentCliDeclared,
			route.routeId ?? null,
			req.agencyIdentity ?? null,
			providerMismatch,
		],
	);
	const agentRunId = String(rows[0].id);

	// P404: provision scratch directory for this agent run
	let scratchUuid: string | null = null;
	const worktreePath = join(worktreeRoot, worktree);
	try {
		const scratch = await provisionScratch(
			randomUUID(),
			agentRunId,
			agentIdentity,
		);
		scratchUuid = scratch.scratchUuid;
		processEnv.AGENT_SCRATCH_DIR = scratch.scratchPath;
		// AC-1: stamp scratch_path on the cubic that owns this worktree (non-fatal)
		query(
			`UPDATE roadmap.cubics SET scratch_path = $1 WHERE worktree_path = $2 AND status = 'active'`,
			[scratch.scratchPath, worktreePath],
		).catch(() => {});
	} catch {
		// non-fatal — agent runs without scratch if provisioning fails
	}

	const startMs = Date.now();
	const cwd = worktreePath;

	// P1445 AC-1: refuse to spawn a worker in the shared repo root. Every
	// dispatch-spawned agent MUST run in its own git worktree; spawning in the
	// shared checkout is the root cause of the cross-agent file-swap / wrong-
	// branch-merge incidents. This is the mechanical enforcement of CONVENTIONS
	// §7a — a single guard call the spawn path cannot bypass.
	assertNotRepoRoot(cwd, getProjectRoot());

	// P1029: OpenClaw routes execute over a WebSocket session instead of a
	// subprocess. Only the "obtain stdout/stderr/exitCode" step differs — every
	// downstream concern (token ledger, classifyExit, agent_runs, observability
	// span) is shared, so existing CLI providers keep a byte-identical path. The
	// scratch reap stays in finally() exactly as before (runs on success OR throw).
	let stdout: string;
	let stderr: string;
	let exitCode: number | null;
	try {
		if (route.agentCli === "openclaw") {
			const { runOpenClawSession } = await import(
				"../../infra/agency/agent-adapter.ts"
			);
			const gatewayUrl =
				route.baseUrl ||
				(route.baseUrlEnv ? processEnv[route.baseUrlEnv] : undefined) ||
				processEnv.OPENCLAW_GATEWAY_URL ||
				process.env.OPENCLAW_GATEWAY_URL ||
				"";
			if (!gatewayUrl) {
				({ stdout, stderr, exitCode } = {
					stdout: "",
					stderr:
						"[agent-adapter] no OpenClaw gateway URL (route.base_url / base_url_env / OPENCLAW_GATEWAY_URL all empty)",
					exitCode: null,
				});
			} else {
				({ stdout, stderr, exitCode } = await runOpenClawSession({
					gatewayUrl,
					sessionId: agentRunId,
					task: spawnReq.task,
					model: route.modelName,
					env: processEnv,
					timeoutMs,
				}));
			}
		} else {
			({ stdout, stderr, exitCode } = await runProcess(
				argv,
				cwd,
				processEnv,
				timeoutMs,
				stdin,
				{ agentRunId, worktree },
			));
		}
	} finally {
		// Best-effort immediate reap; the 15-min cron sweep covers SIGKILL/crash cases.
		reapScratch(scratchUuid).catch((err: unknown) => {
			console.error(
				`[AgentSpawner] immediate reap failed for ${scratchUuid}: ${err instanceof Error ? err.message : err}`,
			);
		});
	}
	const durationMs = Date.now() - startMs;

	// P1392 AC-5: Append persona name to output_summary for telemetry
	let outputSummary = stdout.slice(-1000);
	if (req.personaName) {
		outputSummary = `persona=${req.personaName} ${outputSummary}`;
	}
	const errorDetail = stderr.slice(-4000);

	// TODO P1365-AC2: Extract rate-limit headers from response and record signal
	// After spawn completes, if the Anthropic SDK or other instrumentation surfaces
	// response headers, call parseRateLimitHeaders() and pass signal to in-memory
	// CapacityTracker via recordSignal(). Headers not yet exposed by SDK (Phase 2).
	// This placeholder will be wired up when claude-code API proxy is available.

	// P721: classify non-zero exits — rate-limit hits must not count toward
	// P689's circuit breaker and must throttle the route for future dispatches.
	const exitClass = classifyExit(stdout, stderr, exitCode);
	const status =
		exitClass.outcome === "rate_limited" ? "rate_limited" : exitClass.outcome;

	await query(
		`UPDATE roadmap_workforce.agent_runs
     SET status = $1,
         duration_ms = $2,
         output_summary = $3,
         error_detail = $4,
         completed_at = now()
     WHERE id = $5`,
		[status, durationMs, outputSummary, errorDetail, agentRunId],
	);

	// P1289 AC-5: budget ledger writer is deferred to P1018 (CLI token capture
	// substrate). A placeholder INSERT here would require values for the NOT NULL
	// columns budget_remaining_usd + cumulative_cost_usd that have no meaning
	// without real per-run token data, and would degrade the ledger to a row
	// counter with no telemetry value. P1018 owns the wire-up.

	// P604: close span + write child observability records
	await obsWriter.closeSpan({
		spanId,
		status: exitCode === 0 ? "ok" : "error",
		errorMessage: exitCode !== 0 ? errorDetail.slice(0, 500) : null,
	});
	await obsWriter.writeAgentExecutionSpan({
		spanId,
		agencyId: worktree,
		agentId: BigInt(agentRunId),
		proposalId: proposalId ?? null,
		modelName: route.modelName,
		routeId: route.routeId ?? null,
	});
	if (route.routeId) {
		const selectionReason = modelHint
			? route.modelName === modelHint
				? "hint_match"
				: "hint_fallback"
			: "default_route";
		await obsWriter.writeModelRoutingOutcome({
			traceId,
			selectedRouteId: route.routeId,
			candidateRoutes: [
				{
					routeId: String(route.routeId),
					modelName: route.modelName,
					selectionReason,
				},
			],
			selectionReason,
		});
	}

	if (exitClass.outcome === "rate_limited") {
		const throttledUntil =
			exitClass.resetAt ?? new Date(Date.now() + 60 * 60 * 1000);
		await query(
			`INSERT INTO roadmap.host_model_route_throttle
			   (provider, model, throttled_until, reason)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT (provider, model) DO UPDATE
			   SET throttled_until = EXCLUDED.throttled_until,
			       reason = EXCLUDED.reason`,
			[
				route.routeProvider,
				route.modelName,
				throttledUntil.toISOString(),
				outputSummary.slice(0, 500),
			],
		);
		// Emit one notification per throttle event (not per proposal)
		await query(
			`INSERT INTO roadmap.notification_queue
			   (proposal_id, severity, kind, title, body, metadata)
			 VALUES ($1, 'WARNING', 'route_throttled', $2, $3, $4::jsonb)
			 ON CONFLICT DO NOTHING`,
			[
				proposalId ?? null,
				`Route throttled: ${route.routeProvider}/${route.modelName}`,
				`Usage cap hit — route throttled until ${throttledUntil.toISOString()}. Affected run: ${agentRunId}.`,
				JSON.stringify({
					provider: route.routeProvider,
					model: route.modelName,
					throttled_until: throttledUntil.toISOString(),
					agent_run_id: agentRunId,
				}),
			],
		).catch(() => {
			/* non-fatal */
		});
	}

	if (scratchUuid) {
		await reapScratch(scratchUuid).catch(() => {
			/* non-fatal — orphan scanner covers this at next boot */
		});
	}
	return { agentRunId, worktree, exitCode, stdout, stderr, durationMs };
}

// ─── P721: Rate-limit exit classifier ────────────────────────────────────────

const RATE_LIMIT_PATTERNS: RegExp[] = [
	/you'?ve hit your limit\s*·?\s*resets/i,
	/rate.?limit/i,
	/quota.{0,40}exceeded/i,
	/429\s+too many requests/i,
	/usage.{0,20}cap/i,
];

// P1682: claude-CLI subscription usage-limit fallback cooldown (minutes) when the
// CLI emits no parseable reset time. Env-configurable, no config service (env.conf
// pattern, like AGENTHIVE_SPAWN_TIMEOUT_MS). Default 30m = a short re-probe cadence
// that self-corrects via GREATEST merge rather than over-waiting a possibly-shorter
// window; an exact parsed reset (epoch/clock) always overrides this.
const CLAUDE_LIMIT_FALLBACK_MIN = Number(
	process.env.AGENTHIVE_CLAUDE_LIMIT_FALLBACK_MIN ?? 30,
);

interface ExitClassification {
	outcome: "completed" | "failed" | "rate_limited" | "provider_exhausted";
	resetAt?: Date | null;
	quotaErrorProvider?: string;
	quotaErrorModel?: string;
}

function parseResetTime(text: string): Date | null {
	// e.g. "resets 11pm (America/Toronto)" or "resets at 2026-04-29T03:00Z"
	const match = text.match(
		/resets(?:\s+at)?\s+([^\n(]{1,40})(?:\s*\([^)]+\))?/i,
	);
	if (!match) return null;
	const raw = match[1].trim();
	const attempt = new Date(raw);
	if (!isNaN(attempt.getTime())) return attempt;
	// Fallback: +1h
	return new Date(Date.now() + 60 * 60 * 1000);
}

/**
 * P1359: Detect provider-specific quota signals with TTL parsing.
 * Returns (provider, model, resetAt) on match, null otherwise.
 */
export function detectProviderQuotaSignal(
	stdout: string,
	stderr: string,
): { provider: string; model: string; resetAt: Date } | null {
	const hay = `${stdout}\n${stderr}`;

	// Gemini: "TerminalQuotaError" or "exhausted capacity"
	// TTL: "reset after Xh Ym Zs" (e.g., "reset after 1h 23m 45s")
	if (/TerminalQuotaError|exhausted\s+capacity/i.test(hay)) {
		let resetAt = new Date(Date.now() + 60 * 60 * 1000); // default 1h
		const match = hay.match(/reset\s+after\s+(\d+)h\s+(\d+)m\s+(\d+)s/i);
		if (match) {
			const h = parseInt(match[1], 10);
			const m = parseInt(match[2], 10);
			const s = parseInt(match[3], 10);
			resetAt = new Date(Date.now() + (h * 3600 + m * 60 + s) * 1000);
		}
		return { provider: "gemini", model: "unknown", resetAt };
	}

	// Codex CLI (ChatGPT-backed gpt-5.5): "You've hit your usage limit" + "try again at H:MM AM/PM"
	// Distinct from the OpenAI API rate_limit_exceeded format below.
	// TTL: parse "try again at H:MM AM/PM" as local time; fallback 1h.
	if (
		/you'?ve\s+hit\s+your\s+usage\s+limit|chatgpt\.com\/codex\/settings\/usage/i.test(
			hay,
		)
	) {
		let resetAt = new Date(Date.now() + 60 * 60 * 1000);
		const m = hay.match(/try\s+again\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)/i);
		if (m) {
			const h12 = parseInt(m[1], 10);
			const mins = parseInt(m[2], 10);
			const h24 =
				(h12 === 12 ? 0 : h12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
			const candidate = new Date();
			candidate.setHours(h24, mins, 0, 0);
			if (candidate.getTime() < Date.now())
				candidate.setDate(candidate.getDate() + 1);
			resetAt = candidate;
		}
		return { provider: "codex", model: "gpt-5.5", resetAt };
	}

	// OpenAI: "rate_limit_exceeded" or 429 + "quota"
	// TTL: "Retry-After: X" header or "X-RateLimit-Reset" timestamp
	if (
		/rate_limit_exceeded|429.*quota/i.test(hay) ||
		(/429/.test(hay) && /quota/i.test(hay))
	) {
		let resetAt = new Date(Date.now() + 60 * 60 * 1000); // default 1h
		// Try to extract Retry-After (seconds) or X-RateLimit-Reset (Unix timestamp)
		const retryMatch = hay.match(/Retry-After[:\s]+(\d+)/i);
		if (retryMatch) {
			const seconds = parseInt(retryMatch[1], 10);
			resetAt = new Date(Date.now() + seconds * 1000);
		}
		const resetMatch = hay.match(/X-RateLimit-Reset[:\s]+(\d+)/i);
		if (resetMatch) {
			const timestamp = parseInt(resetMatch[1], 10);
			resetAt = new Date(timestamp * 1000);
		}
		return { provider: "openai", model: "unknown", resetAt };
	}

	// Anthropic: "rate_limit_error" or "usage_limit"
	// TTL: "retry-after" header (seconds) or fallback 1h
	if (/rate_limit_error|usage_limit/i.test(hay)) {
		let resetAt = new Date(Date.now() + 60 * 60 * 1000); // default 1h
		const match = hay.match(/retry-after[:\s]+(\d+)/i);
		if (match) {
			const seconds = parseInt(match[1], 10);
			resetAt = new Date(Date.now() + seconds * 1000);
		}
		return { provider: "anthropic", model: "unknown", resetAt };
	}

	// Copilot: "weekly rate limit"
	// TTL: often contains explicit reset datetime; fallback 7 days
	if (/weekly\s+rate\s+limit/i.test(hay)) {
		let resetAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // default 7 days
		const match = hay.match(
			/(?:reset|resets)\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^)\n]*)/i,
		);
		if (match) {
			const dt = new Date(match[1]);
			if (!isNaN(dt.getTime())) {
				resetAt = dt;
			}
		}
		return { provider: "copilot", model: "unknown", resetAt };
	}

	// P1682: Claude CLI (Claude Code --print, OAuth/subscription) usage limit.
	// The CLI prints human text "usage limit reached" (SPACE) — distinct from the
	// Anthropic API "usage_limit" (UNDERSCORE) handled above, which is why the live
	// claude limit fell through to outcome:"failed" with no cooldown. Formats seen:
	//   "Claude AI usage limit reached|<unix-epoch>"  → exact reset
	//   "... usage limit reached ... resets 3pm (TZ)" → clock reset
	//   "5-hour limit reached"                         → window size only → fallback
	// Returned provider="claude" so spawnWithRetry cools the whole `claude` CLI route
	// family (account-wide limit), not a single (provider,model) pair.
	if (/usage\s+limit\s+reached|\d+\s*-\s*hour\s+limit\s+reached/i.test(hay)) {
		let resetAt = new Date(Date.now() + CLAUDE_LIMIT_FALLBACK_MIN * 60 * 1000);
		const epochMatch = hay.match(/usage\s+limit\s+reached\s*\|\s*(\d{10,13})/i);
		if (epochMatch) {
			const num = parseInt(epochMatch[1], 10);
			const ms = epochMatch[1].length >= 13 ? num : num * 1000;
			const dt = new Date(ms);
			if (!isNaN(dt.getTime()) && dt.getTime() > Date.now()) resetAt = dt;
		} else {
			const clock = parseResetTime(hay);
			if (clock && clock.getTime() > Date.now()) resetAt = clock;
		}
		return { provider: "claude", model: "cli", resetAt };
	}

	return null;
}

export function classifyExit(
	stdout: string,
	stderr: string,
	exitCode: number | null,
): ExitClassification {
	if (exitCode === 0) return { outcome: "completed" };
	const hay = `${stdout}\n${stderr}`;

	// Check for provider-specific quota signals first (P1359)
	const quotaSignal = detectProviderQuotaSignal(stdout, stderr);
	if (quotaSignal) {
		return {
			outcome: "rate_limited",
			resetAt: quotaSignal.resetAt,
			quotaErrorProvider: quotaSignal.provider,
			quotaErrorModel: quotaSignal.model,
		};
	}

	// Fall back to generic rate-limit patterns
	for (const pat of RATE_LIMIT_PATTERNS) {
		if (pat.test(hay)) {
			return { outcome: "rate_limited", resetAt: parseResetTime(hay) };
		}
	}
	return { outcome: "failed" };
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
	opts?: { agentRunId?: string; worktree?: string },
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const [cmd, ...args] = argv;
		console.error(
			`[AgentSpawner] Spawning: ${cmd} ${args.slice(0, 3).join(" ")}...`,
		);
		console.error(
			`[AgentSpawner] ANTHROPIC_AUTH_TOKEN in env: ${!!env.ANTHROPIC_AUTH_TOKEN}`,
		);
		console.error(
			`[AgentSpawner] ANTHROPIC_BASE_URL in env: ${env.ANTHROPIC_BASE_URL}`,
		);
		console.error(
			`[AgentSpawner] ANTHROPIC_MODEL in env: ${env.ANTHROPIC_MODEL}`,
		);
		const child: ChildProcess = spawn(cmd, args, {
			cwd,
			env,
			stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		trackLiveChild(child);

		let stdout = "";
		let stderr = "";

		// P1730 AC-1: instrument MCP init with separate timeout
		// Must be set up BEFORE attaching stdout/stderr listeners so we can
		// disarm the timeout on first stdout (model responding = MCP init done).
		let cleanupMcpTimeout: (() => void) | null = null;
		if (opts?.agentRunId && opts?.worktree && env.MCP_URL) {
			const mcpConnectTimeout = Number(
				process.env.AGENTHIVE_MCP_CONNECT_TIMEOUT_MS ?? "90000",
			);
			console.error(
				`[AgentSpawner] P1730: MCP connect timeout enabled: ${mcpConnectTimeout}ms`,
			);
			cleanupMcpTimeout = wrapMcpInitTimeout(
				child,
				opts.agentRunId,
				opts.worktree,
				mcpConnectTimeout,
			);
		}

		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
			// First stdout means the model is responding — MCP init must have succeeded.
			// Disarm the MCP init timeout so a slow-but-working spawn isn't killed early.
			if (cleanupMcpTimeout) {
				cleanupMcpTimeout();
				cleanupMcpTimeout = null;
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
			// Any stderr means Claude has started and MCP init is done (or in progress).
			// Disarm MCP init timeout so long-running tasks aren't killed before first stdout.
			if (cleanupMcpTimeout) {
				cleanupMcpTimeout();
				cleanupMcpTimeout = null;
			}
		});

		if (stdin !== undefined) {
			child.stdin?.end(stdin);
		}

		// SIGTERM at deadline; SIGKILL escalation 10s later if the child ignores it.
		// Without the escalation, claude --print mid-API-call traps SIGTERM and
		// blows past the declared budget by 10–15 minutes.
		// `exited` tracks REAL termination. child.killed only means "a signal was
		// sent" (it is true immediately after the SIGTERM below), so it must NOT
		// gate the SIGKILL escalation — claude --print traps SIGTERM mid-API-call
		// and would otherwise run to its ~2h hard limit, wedging the dispatch slot
		// indefinitely. Guarding the escalation on `exited` is what makes a
		// livelocked spawn reliably free its slot at timeoutMs + 10s.
		let exited = false;
		let killTimer: NodeJS.Timeout | null = null;
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			stderr += "\n[agent-spawner] SIGTERM after timeout";
			killTimer = setTimeout(() => {
				if (!exited) {
					try {
						child.kill("SIGKILL");
						stderr += "\n[agent-spawner] SIGKILL after grace";
					} catch {
						/* already exited */
					}
				}
			}, 10_000);
		}, timeoutMs);

		const cleanup = () => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (cleanupMcpTimeout) cleanupMcpTimeout();
			// liveChildren removal is handled by the once("close"/"error") listeners
			// registered by trackLiveChild(); no manual delete needed here.
		};

		child.on("close", (code) => {
			exited = true;
			cleanup();
			resolve({ stdout, stderr, exitCode: code });
		});

		child.on("error", (err) => {
			exited = true;
			cleanup();
			const diagnostics = [
				`cmd_exists=${existsSync(cmd)}`,
				`cwd=${cwd}`,
				`cwd_exists=${existsSync(cwd)}`,
				`home=${env.HOME ?? ""}`,
				`codex_home=${env.CODEX_HOME ?? ""}`,
				`path=${env.PATH ?? ""}`,
			].join(" ");
			resolve({
				stdout,
				stderr: `${stderr}\n[agent-spawner] spawn error: ${err.message}\n[agent-spawner] spawn diagnostics: ${diagnostics}`,
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
	const provider =
		req.provider ??
		(await detectProvider(req.worktree, req.worktreeRoot ?? WORKTREE_ROOT));

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
		// No models in registry for this provider — skip escalation, notify.
		// P674: emit kind+payload; transport resolved by notification_route.
		await query(
			`INSERT INTO notification_queue (proposal_id, severity, kind, title, body, metadata)
       VALUES ($1, 'CRITICAL', 'spawn_no_ladder', $2, $3, $4::jsonb)`,
			[
				proposalId ?? null,
				`Agent task failed — no escalation ladder for provider "${provider}"`,
				`Worktree: ${result.worktree}\nExit: ${result.exitCode}\nStderr: ${result.stderr.slice(0, 400)}`,
				JSON.stringify({
					provider,
					worktree: result.worktree,
					exit_code: result.exitCode,
					stderr_tail: result.stderr.slice(-400),
				}),
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

	// All escalations exhausted — notify USER.
	// P674: emit kind+payload; transport resolved by notification_route.
	await query(
		`INSERT INTO notification_queue (proposal_id, severity, kind, title, body, metadata)
     VALUES ($1, 'CRITICAL', 'spawn_ladder_exhausted', $2, $3, $4::jsonb)`,
		[
			proposalId ?? null,
			`Agent task failed after full escalation ladder`,
			`Worktree: ${result.worktree}\nExit: ${result.exitCode}\nStderr: ${result.stderr.slice(0, 400)}`,
			JSON.stringify({
				provider,
				worktree: result.worktree,
				exit_code: result.exitCode,
				ladder,
				stderr_tail: result.stderr.slice(-400),
			}),
		],
	);

	return null;
}

export function softSortProviderHealthCandidates<
	T extends { route_provider: string },
>(
	rows: T[],
	healthFn: (provider: string) => { status: string; checkedAt: number } | null,
): T[] {
	function rank(row: T): number {
		const h = healthFn(row.route_provider);
		if (!h) return 1;
		if (h.status === "ok") return 0;
		return 2;
	}
	return [...rows].sort((a, b) => rank(a) - rank(b));
}

// ─── P1730: MCP Init Diagnostics (AC-1) ────────────────────────────────────────

/**
 * Export MCP init diagnostics for AC-1 diagnosis reporting.
 * Used by operators to understand whether MCP init contention is the bottleneck.
 */
export function getMcpInitDiagnosticsReport(): string {
	return getMcpInitDiagnosisReport();
}

export function getMcpInitPerformanceSnapshot() {
	return getMcpInitDiagnostics();
}

export type { McpInitTiming } from "./mcp-init-wrapper.ts";
