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
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { query } from "../../infra/postgres/pool.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const WORKTREE_ROOT = "/data/code/worktree";
const GITCONFIG_ROOT = "/data/code/AgentHive/.git/worktrees-config";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentProvider = "claude" | "gemini" | "copilot" | "openclaw";

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
	stage?: string;
	/** Preferred model override (provider decides default) */
	model?: string;
	/** Max tokens for this invocation */
	maxTokens?: number;
	/** Wall-clock timeout in milliseconds (default 300 000 = 5 min) */
	timeoutMs?: number;
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
	apiSpec: "anthropic" | "openai" | "google";
	baseUrl: string;
	planType: string | null;
	costPer1kInput: number;
}

/**
 * Build argv + env for the Anthropic Claude CLI.
 * Used when api_spec = 'anthropic' (native claude CLI).
 */
function buildClaudeArgs(
	req: SpawnRequest,
	route: ModelRoute,
): { argv: string[]; env: Record<string, string> } {
	const argv = [
		"claude",
		"--print", // non-interactive: print response and exit
		"--model",
		route.modelName,
		req.task,
	];
	const env: Record<string, string> = { ANTHROPIC_MODEL: route.modelName };
	// Non-default base URL (e.g. Xiaomi anthropic-spec endpoint)
	if (route.baseUrl !== "https://api.anthropic.com") {
		env.ANTHROPIC_BASE_URL = route.baseUrl;
	}
	return { argv, env };
}

/**
 * Build argv + env for any OpenAI-compatible endpoint.
 * Used when api_spec = 'openai' (Nous, Xiaomi, OpenAI, etc.).
 * Uses the `llm` CLI (https://llm.datasette.io).
 */
function buildOpenAICompatArgs(
	req: SpawnRequest,
	route: ModelRoute,
): { argv: string[]; env: Record<string, string> } {
	const argv = ["llm", "--model", route.modelName, req.task];
	const env: Record<string, string> = {
		OPENAI_BASE_URL: route.baseUrl,
	};
	return { argv, env };
}

/**
 * Build argv + env for Google Gemini CLI.
 * Used when api_spec = 'google'.
 */
function buildGeminiArgs(
	req: SpawnRequest,
	route: ModelRoute,
): { argv: string[]; env: Record<string, string> } {
	const argv = ["gemini", "--model", route.modelName, "--prompt", req.task];
	return { argv, env: {} };
}

/** Dispatch to the correct builder based on route.apiSpec. */
function buildArgsBySpec(
	req: SpawnRequest,
	route: ModelRoute,
): { argv: string[]; env: Record<string, string> } {
	switch (route.apiSpec) {
		case "anthropic":
			return buildClaudeArgs(req, route);
		case "google":
			return buildGeminiArgs(req, route);
		case "openai":
			return buildOpenAICompatArgs(req, route);
	}
}

// ─── Worktree config loader ───────────────────────────────────────────────────

/** Parse .env.agent file — returns key/value pairs. */
async function loadEnvAgent(
	worktreeName: string,
): Promise<Record<string, string>> {
	const path = join(WORKTREE_ROOT, worktreeName, ".env.agent");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
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

/** Detect provider from worktree name prefix. */
function detectProvider(worktreeName: string): AgentProvider {
	if (worktreeName.startsWith("claude")) return "claude";
	if (worktreeName.startsWith("gemini")) return "gemini";
	if (worktreeName.startsWith("copilot")) return "copilot";
	if (worktreeName.startsWith("openclaw")) return "openclaw";
	throw new Error(`Unknown provider prefix for worktree "${worktreeName}"`);
}

// ─── P235: Platform-Aware Model Constraints ──────────────────────────────────

/** Hard-coded platform defaults used when route lookup fails. */
const PROVIDER_DEFAULTS: Record<AgentProvider, string> = {
	claude: "claude-sonnet-4-6",
	gemini: "gemini-2.0-flash",
	copilot: "gpt-4o",
	openclaw: "xiaomi/mimo-v2-pro",
};

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
		api_spec: string;
		base_url: string;
		plan_type: string | null;
		cost_per_1k_input: number;
	};

	const fetchRoute = (modelName: string) =>
		query<RouteRow>(
			`SELECT model_name, route_provider, agent_provider,
              api_spec, base_url, plan_type, cost_per_1k_input
       FROM roadmap.model_routes
       WHERE model_name = $1 AND agent_provider = $2 AND is_enabled = true
       ORDER BY priority ASC
       LIMIT 1`,
			[modelName, provider],
		);

	const toModelRoute = (r: RouteRow): ModelRoute => ({
		modelName: r.model_name,
		routeProvider: r.route_provider,
		agentProvider: r.agent_provider,
		apiSpec: r.api_spec as ModelRoute["apiSpec"],
		baseUrl: r.base_url,
		planType: r.plan_type,
		costPer1kInput: Number(r.cost_per_1k_input),
	});

	if (hint) {
		const { rows } = await fetchRoute(hint);
		if (rows.length > 0) return toModelRoute(rows[0]);

		console.warn(
			`[P235] No enabled route for model "${hint}" with agent_provider "${provider}". ` +
				`Falling back to default.`,
		);
		// Fall through to default resolution
	}

	// Default: cheapest enabled model for this provider
	const { rows } = await query<RouteRow>(
		`SELECT model_name, route_provider, agent_provider,
            api_spec, base_url, plan_type, cost_per_1k_input
     FROM roadmap.model_routes
     WHERE agent_provider = $1 AND is_enabled = true
     ORDER BY priority ASC, cost_per_1k_input ASC
     LIMIT 1`,
		[provider],
	);

	if (rows.length > 0) return toModelRoute(rows[0]);

	// No DB routes at all — synthesize a hard-coded fallback
	const fallbackModel = PROVIDER_DEFAULTS[provider];
	console.warn(`[P235] No routes in DB for agent_provider "${provider}". Using hard-coded default "${fallbackModel}".`);
	return {
		modelName: fallbackModel,
		routeProvider: provider,
		agentProvider: provider,
		apiSpec: provider === "gemini" ? "google" : provider === "claude" ? "anthropic" : "openai",
		baseUrl:
			provider === "claude"
				? "https://api.anthropic.com"
				: provider === "gemini"
					? "https://generativelanguage.googleapis.com/v1beta"
					: "https://api.openai.com/v1",
		planType: null,
		costPer1kInput: 0,
	};
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
	} = req;

	const provider = detectProvider(worktree);
	// P235/M026: resolve full route (model + api_spec + base_url) from model_routes
	const route = await resolveModelRoute(provider, modelHint);
	const agentEnv = await loadEnvAgent(worktree);
	let assembledTask = task;

	if (proposalId !== undefined) {
		const contextPackage = await buildProposalContextPackage({
			proposalId,
			taskType: stage ?? "unknown",
			agentIdentity: worktree,
			maxTokens: 2000,
		});
		assembledTask = `${contextPackage}\n\n## Task\n${task}`;
	}

	const spawnReq = { ...req, task: assembledTask };

	// Build argv + env from route metadata (api_spec drives which CLI is used)
	const { argv, env: extraEnv } = buildArgsBySpec(spawnReq, route);

	// Assemble process environment (agent-scoped, not inheriting secrets from host)
	const processEnv: Record<string, string> = {
		// Carry through essential PATH
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? "/root",
		// Agent-specific overrides from .env.agent
		DATABASE_URL: agentEnv.DATABASE_URL ?? "",
		AGENT_WORKTREE: worktree,
		AGENT_PROVIDER: provider,
		AGENT_ROUTE_PROVIDER: route.routeProvider,
		AGENT_API_SPEC: route.apiSpec,
		// Git identity isolation
		GIT_CONFIG_GLOBAL: `${GITCONFIG_ROOT}/${worktree}.gitconfig`,
		GIT_CONFIG_NOSYSTEM: "1",
		// API keys: pass through from host environment (agents need them)
		...(process.env.ANTHROPIC_API_KEY && {
			ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		}),
		...(process.env.GEMINI_API_KEY && {
			GEMINI_API_KEY: process.env.GEMINI_API_KEY,
		}),
		...(process.env.OPENAI_API_KEY && {
			OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		}),
		...(process.env.XIAOMI_API_KEY && {
			XIAOMI_API_KEY: process.env.XIAOMI_API_KEY,
		}),
		...(process.env.NOUS_API_KEY && {
			NOUS_API_KEY: process.env.NOUS_API_KEY,
		}),
		// Route-specific env from argv builder (OPENAI_BASE_URL, ANTHROPIC_BASE_URL, etc.)
		...extraEnv,
	};

	// Insert agent_runs row (status = running)
	const { rows } = await query(
		`INSERT INTO agent_runs
       (proposal_id, display_id, agent_identity, stage, model_used, status, started_at)
     VALUES ($1, $2, $3, $4, $5, 'running', now())
     RETURNING id`,
		[proposalId ?? null, `wt:${worktree}`, worktree, stage ?? "unknown", route.modelName],
	);
	const agentRunId = String(rows[0].id);

	const startMs = Date.now();
	const cwd = join(WORKTREE_ROOT, worktree);

	const { stdout, stderr, exitCode } = await runProcess(
		argv,
		cwd,
		processEnv,
		timeoutMs,
	);
	const durationMs = Date.now() - startMs;

	// Update agent_runs on completion
	const status = exitCode === 0 ? "completed" : "failed";
	await query(
		`UPDATE agent_runs
     SET status = $1, duration_ms = $2, output_summary = $3, completed_at = now()
     WHERE id = $4`,
		[status, durationMs, stdout.slice(0, 500), agentRunId],
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
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const [cmd, ...args] = argv;
		const child: ChildProcess = spawn(cmd, args, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

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
	const provider = detectProvider(req.worktree);

	// P235/M026: build escalation ladder from model_routes for this agent_provider.
	// Per model: pick best (lowest priority) route. Then sort models cheap → expensive.
	const { rows: ladderRows } = await query<{ model_name: string; cost: number }>(
		`SELECT model_name, min(cost_per_1k_input) AS cost
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
	const currentModel = req.model ?? PROVIDER_DEFAULTS[provider];
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
