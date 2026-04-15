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

import { randomUUID, createHash } from "node:crypto";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { query } from "../../infra/postgres/pool.ts";
import { buildProposalContextPackage } from "./context-builder.ts";
import {
	createDriftMonitor,
	estimateTokenCount,
} from "./token-efficiency.ts";

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

/**
 * Build the argv + env for an Anthropic Claude CLI invocation.
 * Assumes `claude` is on PATH inside the spawn environment.
 */
function buildClaudeArgs(
	req: SpawnRequest,
	model: string,
): { argv: string[]; env: Record<string, string> } {
	const mcpConfigPath = join(WORKTREE_ROOT, req.worktree, ".mcp.json");
	const argv = [
		"claude",
		"--print", // non-interactive: print response and exit
		"--mcp-config", mcpConfigPath,
		"--allowedTools", "mcp__agenthive__*,mcp__roadmap__*,Read,Write,Edit,Bash,Glob,Grep",
		"--model",
		model,
		req.task,
	];
	return { argv, env: { ANTHROPIC_MODEL: model } };
}

/**
 * Build the argv for a Hermes CLI invocation (Nous subscription).
 * Fallback runtime when claude/codex aren't authenticated.
 */
function buildHermesArgs(
	req: SpawnRequest,
	model: string,
): { argv: string[]; env: Record<string, string> } {
	const argv = [
		"hermes",
		"chat",
		"-q", req.task,
		"-Q",
		"--provider", "nous",
		"--yolo",
	];
	if (model && model !== "xiaomi/mimo-v2-pro") {
		argv.push("-m", model);
	}
	return { argv, env: {} };
}

/**
 * Build args for an OpenAI-compatible CLI (covers OpenRouter, Ollama, MiniMax, OpenClaw).
 * Uses the `llm` CLI tool (https://llm.datasette.io) which supports --model and --system.
 * Falls back to `openai` CLI if `llm` is unavailable.
 */
function buildOpenAICompatArgs(
	req: SpawnRequest,
	model: string,
	baseUrl?: string,
): { argv: string[]; env: Record<string, string> } {
	const argv = ["llm", "--model", model, req.task];
	const env: Record<string, string> = {};
	if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
	return { argv, env };
}

/**
 * Build args for Google Gemini CLI.
 * Assumes `gemini` CLI is on PATH.
 */
function buildGeminiArgs(
	req: SpawnRequest,
	model: string,
): { argv: string[]; env: Record<string, string> } {
	const argv = ["gemini", "--model", model, "--prompt", req.task];
	return { argv, env: {} };
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

/** Pick default model based on provider and optional hint. */
function resolveModel(provider: AgentProvider, hint?: string): string {
	if (hint) return hint;
	switch (provider) {
		case "claude":
			return "claude-sonnet-4-6";
		case "gemini":
			return "gemini-2.0-flash";
		case "copilot":
			return "gpt-4o";
		case "openclaw":
			return "openclaw-v1";
	}
}

/**
 * Check if a CLI provider is authenticated and available.
 * Falls back to "hermes" (always available via Nous subscription).
 */
async function resolveAvailableProvider(preferred: AgentProvider): Promise<string> {
	try {
		switch (preferred) {
			case "claude": {
				const out = execSync("claude auth status 2>&1", { timeout: 5000, encoding: "utf8" });
				if (out.includes('"loggedIn": true')) return "claude";
				break;
			}
			case "gemini":
			case "copilot":
			case "openclaw":
				// Check if the CLI exists on PATH
				try {
					execSync(`which ${preferred} 2>/dev/null`, { timeout: 3000 });
					return preferred;
				} catch { /* not available */ }
				break;
		}
	} catch { /* auth check failed */ }

	// Fallback to hermes — always available (Nous subscription)
	return "hermes";
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
	const model = resolveModel(provider, modelHint);
	const agentEnv = await loadEnvAgent(worktree);
	const runId = randomUUID();

	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
     VALUES ($1, 'llm', 'active')
     ON CONFLICT (agent_identity) DO UPDATE SET status = 'active'`,
		[worktree],
	);

	// Build context package first so the enriched task is used when assembling argv.
	let assembledTask = task;
	let contextPackage = "";

	if (proposalId !== undefined) {
		contextPackage = await buildProposalContextPackage({
			proposalId,
			taskType: stage ?? "unknown",
			agentIdentity: worktree,
			maxTokens: 2000,
		});
		assembledTask = `${contextPackage}\n\n## Task\n${task}`;
	}

	// Build provider-specific argv and additional env.
	// Fall back to hermes if the preferred CLI isn't authenticated.
	let argv: string[];
	let extraEnv: Record<string, string>;
	const spawnReq = () => ({ ...req, task: assembledTask });

	const effectiveProvider = await resolveAvailableProvider(provider);
	switch (effectiveProvider) {
		case "claude":
			({ argv, env: extraEnv } = buildClaudeArgs(spawnReq(), model));
			break;
		case "gemini":
			({ argv, env: extraEnv } = buildGeminiArgs(spawnReq(), model));
			break;
		case "copilot":
		case "openclaw":
			({ argv, env: extraEnv } = buildOpenAICompatArgs(spawnReq(), model));
			break;
		default:
			// hermes fallback — always available (Nous subscription)
			({ argv, env: extraEnv } = buildHermesArgs(spawnReq(), model));
			break;
	}

	// Assemble process environment — host auth inheritance.
	// Each CLI reads auth from its own config in HOME. The agent does NOT manage credentials.
	const processEnv: Record<string, string> = {
		PATH: "/home/andy/.local/bin:" + (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"),
		HOME: process.env.HOME ?? "/home/andy",
		// Agent-specific overrides from .env.agent
		DATABASE_URL: agentEnv.DATABASE_URL ?? "",
		AGENT_WORKTREE: worktree,
		AGENT_PROVIDER: provider,
		// Git identity isolation
		GIT_CONFIG_GLOBAL: `${GITCONFIG_ROOT}/${worktree}.gitconfig`,
		GIT_CONFIG_NOSYSTEM: "1",
		// Provider-specific overrides from argv builder
		...extraEnv,
	};

	const estimatedInputTokens = estimateTokenCount(assembledTask);
	const inputHash = createHash("sha256")
		.update(assembledTask)
		.digest("hex");

	const { rows: modelRows } = await query<{ model_name: string }>(
		`SELECT model_name FROM model_metadata WHERE model_name = $1 LIMIT 1`,
		[model],
	);
	const modelNameForLogs = modelRows[0]?.model_name ?? null;

	await query(
		`INSERT INTO run_log
       (run_id, agent_identity, proposal_id, model_name, pipeline_stage, input_summary, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'running')
     ON CONFLICT (run_id) DO UPDATE
     SET agent_identity = EXCLUDED.agent_identity,
         proposal_id = EXCLUDED.proposal_id,
         model_name = EXCLUDED.model_name,
         pipeline_stage = EXCLUDED.pipeline_stage,
         input_summary = EXCLUDED.input_summary,
         status = 'running'`,
		[
			runId,
			worktree,
			proposalId ?? null,
			modelNameForLogs,
			stage ?? "unknown",
			task.slice(0, 500),
		],
	);

	if (modelNameForLogs) {
		await query(
			`INSERT INTO context_window_log
         (agent_identity, proposal_id, model_name, input_tokens, output_tokens, context_limit, was_truncated, truncation_note, run_id)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)`,
			[
				worktree,
				proposalId ?? null,
				modelNameForLogs,
				estimatedInputTokens,
				2000,
				estimatedInputTokens > 2000,
				estimatedInputTokens > 2000
					? "Context trimmed to target budget by token-efficiency builder"
					: null,
				runId,
			],
		);
	}

	// Insert agent_runs row (status = running)
	const { rows } = await query(
		`INSERT INTO agent_runs
       (proposal_id, display_id, agent_identity, stage, model_used, status, started_at, tokens_in, input_hash)
     VALUES ($1, $2, $3, $4, $5, 'running', now(), $6, $7)
     RETURNING id`,
		[
			proposalId ?? null,
			`wt:${worktree}`,
			worktree,
			stage ?? "unknown",
			model,
			estimatedInputTokens,
			inputHash,
		],
	);
	const agentRunId = String(rows[0].id);

	const startMs = Date.now();
	const cwd = join(WORKTREE_ROOT, worktree);

	const { stdout, stderr, exitCode } = await runProcess(
		argv,
		cwd,
		processEnv,
		timeoutMs,
		createDriftMonitor(task, {}),
	);
	const durationMs = Date.now() - startMs;

	// Update agent_runs on completion
	const driftKilled = stderr.includes("critical drift");
	const status = driftKilled
		? "cancelled"
		: exitCode === 0
			? "completed"
			: "failed";
	await query(
		`UPDATE agent_runs
     SET status = $1, duration_ms = $2, output_summary = $3, completed_at = now(),
         tokens_out = $4, cost_usd = $5
     WHERE id = $6`,
		[
			status,
			durationMs,
			stdout.slice(0, 500),
			estimateTokenCount(stdout),
			0,
			agentRunId,
		],
	);
	await query(
		`UPDATE run_log
       SET status = $1, finished_at = now()
     WHERE run_id = $2`,
		[
			status === "completed" ? "success" : status === "cancelled" ? "cancelled" : "error",
			runId,
		],
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
	driftMonitor?: ReturnType<typeof createDriftMonitor>,
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
		let lastActivityMs = Date.now();

		// Rolling liveness: reset on any output. Kill if silent for 2 minutes.
		const SILENCE_KILL_MS = 120_000; // no output for 2 min = dead
		const ABSOLUTE_MAX_MS = timeoutMs; // hard cap from config

		const livenessCheck = setInterval(() => {
			const silentMs = Date.now() - lastActivityMs;
			if (silentMs > SILENCE_KILL_MS) {
				child.kill("SIGTERM");
				stderr += `\n[agent-spawner] Killed — no output for ${Math.round(silentMs / 1000)}s`;
				clearInterval(livenessCheck);
			}
		}, 15_000); // check every 15s

		// Absolute safety timeout
		const absoluteTimer = setTimeout(() => {
			child.kill("SIGTERM");
			stderr += "\n[agent-spawner] Killed after absolute timeout";
			clearInterval(livenessCheck);
		}, ABSOLUTE_MAX_MS);

		child.stdout?.on("data", (d: Buffer) => {
			const chunk = d.toString();
			stdout += chunk;
			lastActivityMs = Date.now(); // agent is alive
			const drift = driftMonitor?.record(chunk);
			if (drift?.level === "critical") {
				child.kill("SIGTERM");
				stderr += `\n[agent-spawner] Killed for critical drift (${drift.score.toFixed(2)})`;
			}
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
			lastActivityMs = Date.now(); // agent is alive
		});

		child.on("close", (code) => {
			clearInterval(livenessCheck);
			clearTimeout(absoluteTimer);
			resolve({ stdout, stderr, exitCode: code });
		});

		child.on("error", (err) => {
			clearInterval(livenessCheck);
			clearTimeout(absoluteTimer);
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
	const LADDER: Array<{ provider: AgentProvider; model: string }> = [
		{ provider: "claude", model: "claude-haiku-4-5" },
		{ provider: "claude", model: "claude-sonnet-4-6" },
		{ provider: "claude", model: "claude-opus-4-6" },
	];

	// Find current position in ladder
	const currentModel = result.stdout.match(/model=(\S+)/)?.[1] ?? "";
	const currentIdx = LADDER.findIndex((l) => l.model === currentModel);
	const nextIdx = currentIdx + 1;

	if (nextIdx < LADDER.length) {
		const next = LADDER[nextIdx];
		return spawnAgent({ ...req, model: next.model });
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
