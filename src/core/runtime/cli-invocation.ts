/**
 * Shared CLI Invocation Registry — P920
 *
 * Provides a unified interface for agency runtimes to resolve and invoke LLM
 * CLI handlers. Replaces duplicate resolveLiaisonHandler switches across
 * start-agency.ts (start-copilot-agency.ts retired by P930).
 *
 * Brand labels and argv builders are sourced from:
 *  - brand: defaultBrandFor(provider) in cli-argv-builders.ts (SOLE authority)
 *  - bin: roadmap.model_routes.cli_path or env fallback (CLAUDE_BIN, CODEX_BIN, COPILOT_BIN)
 *  - buildArgs: argv builder from cli-argv-builders.ts per-provider
 */
import { query } from "../../infra/postgres/pool.ts";
import type { ModelRoute } from "../../core/orchestration/agent-spawner.ts";
import {
	defaultBrandFor,
	buildClaudeArgs,
	buildCodexArgs,
	buildCopilotArgs,
	buildHermesArgs,
	buildGeminiArgs,
	buildOpenAICompatArgs,
	buildAntigravityArgs,
	buildMimoArgs,
} from "./cli-argv-builders.ts";
import { spawn } from "node:child_process";

export interface CliInvocationHandler {
	provider: string;
	bin: string;
	buildArgs: (prompt: string) => string[];
	brand: string;
}

export interface CliInvocationOptions {
	/** Timeout in milliseconds. Default 30000 (30s). */
	timeoutMs?: number;
}

/**
 * Shared registry for CLI handler resolution across all agency runtimes.
 */
export class CliInvocationRegistry {
	private localHandlers: Map<string, CliInvocationHandler> = new Map();

	/**
	 * Register a handler for tests or local override.
	 */
	registerLocal(handler: CliInvocationHandler): void {
		this.localHandlers.set(handler.provider, handler);
	}

	/**
	 * Resolve a CLI handler by provider.
	 * Checks local overrides first, then loads from DB + env fallback.
	 */
	async resolve(provider: string): Promise<CliInvocationHandler | null> {
		// Check local overrides (for tests)
		if (this.localHandlers.has(provider)) {
			return this.localHandlers.get(provider)!;
		}

		// Load from DB
		const { rows } = await query(
			`SELECT agent_provider, cli_path, model_name FROM roadmap.model_routes
			  WHERE agent_provider = $1
			  ORDER BY is_enabled DESC, priority DESC
			  LIMIT 1`,
			[provider],
		);

		if (!rows[0]) {
			// Provider not in DB; return null
			return null;
		}

		const route = rows[0] as { agent_provider: string; cli_path?: string; model_name?: string };
		const bin =
			route.cli_path ||
			this.envFallback(provider) ||
			this.defaultBinFor(provider);

		const brand = defaultBrandFor(provider);
		const buildArgs = this.buildArgsForProvider(provider, route.model_name);

		if (!buildArgs) {
			return null;
		}

		return {
			provider,
			bin,
			buildArgs,
			brand,
		};
	}

	/**
	 * Get all enabled providers from roadmap.model_routes.
	 */
	async allEnabledProviders(): Promise<string[]> {
		const { rows } = await query(
			`SELECT DISTINCT agent_provider FROM roadmap.model_routes
			  WHERE agent_provider IS NOT NULL
			  ORDER BY agent_provider`,
			[],
		);
		return rows.map((r: { agent_provider: string }) => r.agent_provider);
	}

	private envFallback(provider: string): string | null {
		switch (provider) {
			case "claude":
				return process.env.CLAUDE_BIN || null;
			case "codex":
				return process.env.CODEX_BIN || null;
			case "copilot":
				return process.env.COPILOT_BIN || null;
			case "hermes":
				return process.env.HERMES_BIN || null;
			case "gemini":
				return process.env.GEMINI_BIN || null;
			case "xiaomi":
				return process.env.MIMO_BIN || null;
			default:
				return null;
		}
	}

	private defaultBinFor(provider: string): string {
		// Last resort: use provider name as bin (e.g. "claude", "codex")
		return provider;
	}

	private buildArgsForProvider(
		provider: string,
		modelName?: string,
	): ((prompt: string) => string[]) | null {
		switch (provider) {
			case "claude":
				return buildClaudeArgs;
			case "codex":
				return buildCodexArgs;
			case "copilot":
				return buildCopilotArgs;
			case "hermes":
				return buildHermesArgs;
			case "gemini":
				return buildGeminiArgs;
			case "antigravity":
				return (prompt: string) => {
					const model = modelName || "Gemini 3.5 Flash (Medium)";
					const addDir = process.cwd();
					return buildAntigravityArgs(prompt, model, addDir);
				};
			case "xiaomi":
				return buildMimoArgs;
			default:
				return buildOpenAICompatArgs;
		}
	}
}

export const globalCliInvocationRegistry = new CliInvocationRegistry();

/**
 * Invoke a CLI handler with timeout and error handling.
 *
 * @param handler The CLI handler
 * @param prompt The prompt to send
 * @param opts Invocation options (timeout, etc.)
 * @returns The CLI output
 * @throws Error if timeout or non-zero exit code
 */
export async function invokeCliHandler(
	handler: CliInvocationHandler,
	prompt: string,
	opts: CliInvocationOptions = {},
): Promise<string> {
	const timeoutMs = opts.timeoutMs ?? 30000;
	const args = handler.buildArgs(prompt);

	return new Promise((resolve, reject) => {
		const child = spawn(handler.bin, args, {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let out = "";
		let err = "";
		let timedOut = false;

		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);

		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			err += d.toString();
		});

		child.on("close", (code) => {
			clearTimeout(timeout);

			if (timedOut) {
				const detail = [err.trim(), out.trim()]
					.filter(Boolean)
					.join("\n")
					.slice(0, 300);
				const suffix = detail ? `: ${detail}` : "";
				return reject(
					new Error(`${handler.bin} timed out after ${timeoutMs}ms${suffix}`),
				);
			}

			if (code === 0) {
				return resolve(out.trim());
			}

			reject(
				new Error(
					`${handler.bin} exited ${code}: ${err.slice(0, 300)}`,
				),
			);
		});

		child.on("error", (e) => {
			clearTimeout(timeout);
			reject(e);
		});
	});
}
