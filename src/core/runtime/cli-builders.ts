/**
 * AgentHive — CliBuilder Interface & Implementations
 *
 * Each agent CLI (claude, codex, hermes, gemini, copilot) has a builder
 * that produces the correct argv and env for subprocess execution.
 *
 * The CliBuilder is a formalized abstraction over the per-CLI logic
 * that was previously inline in agent-spawner.ts.
 *
 * P228: Cubic Runtime Abstraction
 * P450 V1: defaultModel() wrapped with route-first resolution + fallback audit
 */

import { emitCliBuilderFallback, getRouteForBuilder } from "./cli-builder-route-resolver.ts";

// ─── Types ────────────────────────────────────────────────────────────────

export type CliName = "claude" | "codex" | "hermes" | "gemini" | "copilot";

export interface BuildArgvOptions {
	/** The task/prompt content */
	task: string;
	/** Override the default model for this CLI */
	modelOverride?: string;
	/** MCP server URL for tool access */
	mcpUrl?: string;
	/** Additional CLI-specific flags */
	flags?: Record<string, string | boolean>;
	/** Base URL override for API endpoint */
	baseUrl?: string;
}

export interface BuildEnvOptions {
	/** Home directory to set (for auth file resolution) */
	homeDir: string;
	/** Injected API keys (for key_inject auth mode) */
	apiKeyVault?: Record<string, string>;
	/** Whether to inherit existing env vars (host_inherit mode) */
	inheritEnv?: boolean;
}

export interface CommandSpec {
	/** Full argv array including the executable */
	argv: string[];
	/** Extra environment variables to set */
	env: Record<string, string>;
	/** Optional stdin content */
	stdin?: string;
}

/**
 * CliBuilder interface — each agent CLI implements this.
 * The builder knows:
 *   - Which executable to invoke
 *   - How to format task/model into argv
 *   - What env vars are needed for auth
 *   - Default model when none specified
 */
export interface CliBuilder {
	/** CLI identifier */
	readonly name: CliName;

	/** Build the full command argv for spawning */
	buildArgv(options: BuildArgvOptions): string[];

	/** Build environment variables for auth and runtime */
	buildEnv(options: BuildEnvOptions): Record<string, string>;

	/** Executable name for PATH lookup */
	executableName(): string;

	/** Default model when no override specified */
	defaultModel(): string;

	/**
	 * Build a complete CommandSpec from model route metadata.
	 * This is the primary entry point for agent-spawner integration.
	 */
	buildCommandSpec(
		task: string,
		route: { modelName: string; baseUrl: string; routeProvider: string },
	): CommandSpec;
}

// ─── Claude CLI ───────────────────────────────────────────────────────────

export class ClaudeCliBuilder implements CliBuilder {
	readonly name: CliName = "claude";

	executableName(): string {
		return "claude";
	}

	defaultModel(): string {
		return "claude-sonnet-4-6";
	}

	buildArgv(options: BuildArgvOptions): string[] {
		const argv = ["claude", "--print"];
		if (options.modelOverride) {
			argv.push("--model", options.modelOverride);
		}
		argv.push(options.task);
		return argv;
	}

	buildEnv(options: BuildEnvOptions): Record<string, string> {
		const env: Record<string, string> = {
			HOME: options.homeDir,
		};
		if (options.apiKeyVault?.ANTHROPIC_API_KEY) {
			env.ANTHROPIC_API_KEY = options.apiKeyVault.ANTHROPIC_API_KEY;
		}
		return env;
	}

	buildCommandSpec(
		task: string,
		route: { modelName: string; baseUrl: string; routeProvider: string },
	): CommandSpec {
		const argv = ["claude", "--print", "--model", route.modelName, task];
		const env: Record<string, string> = {
			ANTHROPIC_MODEL: route.modelName,
		};
		// Non-default base URL (e.g. Xiaomi anthropic-spec endpoint)
		if (route.baseUrl !== "https://api.anthropic.com") {
			env.ANTHROPIC_BASE_URL = route.baseUrl;
		}
		return { argv, env };
	}
}

// ─── Codex CLI ────────────────────────────────────────────────────────────

export class CodexCliBuilder implements CliBuilder {
	readonly name: CliName = "codex";

	executableName(): string {
		return "codex";
	}

	defaultModel(): string {
		return "gpt-4-turbo";
	}

	buildArgv(options: BuildArgvOptions): string[] {
		const argv = ["codex", "exec"];
		if (options.flags?.["dangerously-bypass-approvals-and-sandbox"] !== false) {
			argv.push("--dangerously-bypass-approvals-and-sandbox");
		}
		if (options.modelOverride) {
			argv.push("--model", options.modelOverride);
		}
		argv.push(options.task);
		return argv;
	}

	buildEnv(options: BuildEnvOptions): Record<string, string> {
		const env: Record<string, string> = {
			HOME: options.homeDir,
		};
		if (options.apiKeyVault?.OPENAI_API_KEY) {
			env.OPENAI_API_KEY = options.apiKeyVault.OPENAI_API_KEY;
		}
		return env;
	}

	buildCommandSpec(
		task: string,
		route: { modelName: string; baseUrl: string; routeProvider: string },
	): CommandSpec {
		const argv = [
			"codex",
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--model",
			route.modelName,
			task,
		];
		const env: Record<string, string> = {};
		if (route.baseUrl !== "https://api.openai.com/v1") {
			env.OPENAI_BASE_URL = route.baseUrl;
		}
		return { argv, env };
	}
}

// ─── Hermes CLI ───────────────────────────────────────────────────────────

export class HermesCliBuilder implements CliBuilder {
	readonly name: CliName = "hermes";

	executableName(): string {
		return "hermes";
	}

	defaultModel(): string {
		return "xiaomi/mimo-v2-omni";
	}

	buildArgv(options: BuildArgvOptions): string[] {
		const argv = ["hermes", "chat", "-q", options.task];
		if (options.modelOverride) {
			argv.push("-m", options.modelOverride);
		}
		if (options.flags?.provider) {
			argv.push("--provider", String(options.flags.provider));
		}
		argv.push("--yolo", "-Q");
		return argv;
	}

	buildEnv(options: BuildEnvOptions): Record<string, string> {
		const env: Record<string, string> = {
			HOME: options.homeDir,
		};
		if (options.apiKeyVault?.NOUS_API_KEY) {
			env.NOUS_API_KEY = options.apiKeyVault.NOUS_API_KEY;
			env.OPENAI_API_KEY = options.apiKeyVault.NOUS_API_KEY;
		}
		if (options.apiKeyVault?.XIAOMI_API_KEY) {
			env.XIAOMI_API_KEY = options.apiKeyVault.XIAOMI_API_KEY;
			env.OPENAI_API_KEY = options.apiKeyVault.XIAOMI_API_KEY;
		}
		return env;
	}

	buildCommandSpec(
		task: string,
		route: { modelName: string; baseUrl: string; routeProvider: string },
	): CommandSpec {
		const argv = [
			"hermes",
			"chat",
			"-q",
			task,
			"-m",
			route.modelName,
			"--provider",
			route.routeProvider,
			"--yolo",
			"-Q",
		];
		return { argv, env: {} };
	}
}

// ─── Gemini CLI ───────────────────────────────────────────────────────────

export class GeminiCliBuilder implements CliBuilder {
	readonly name: CliName = "gemini";

	executableName(): string {
		return "gemini";
	}

	defaultModel(): string {
		return "gemini-pro";
	}

	buildArgv(options: BuildArgvOptions): string[] {
		const argv = ["gemini"];
		if (options.modelOverride) {
			argv.push("--model", options.modelOverride);
		}
		argv.push("--prompt", options.task);
		return argv;
	}

	buildEnv(options: BuildEnvOptions): Record<string, string> {
		const env: Record<string, string> = {
			HOME: options.homeDir,
		};
		if (options.apiKeyVault?.GEMINI_API_KEY) {
			env.GEMINI_API_KEY = options.apiKeyVault.GEMINI_API_KEY;
		}
		return env;
	}

	buildCommandSpec(
		task: string,
		route: { modelName: string; baseUrl: string; routeProvider: string },
	): CommandSpec {
		const argv = ["gemini", "--model", route.modelName, "--prompt", task];
		return { argv, env: {} };
	}
}

// ─── Copilot CLI ──────────────────────────────────────────────────────────

export class CopilotCliBuilder implements CliBuilder {
	readonly name: CliName = "copilot";

	executableName(): string {
		return "gh";
	}

	defaultModel(): string {
		return "gpt-4";
	}

	buildArgv(options: BuildArgvOptions): string[] {
		const argv = ["gh", "copilot", "suggest"];
		if (options.modelOverride) {
			argv.push("--model", options.modelOverride);
		}
		argv.push(options.task);
		return argv;
	}

	buildEnv(options: BuildEnvOptions): Record<string, string> {
		const env: Record<string, string> = {
			HOME: options.homeDir,
		};
		if (options.apiKeyVault?.GITHUB_TOKEN) {
			env.GITHUB_TOKEN = options.apiKeyVault.GITHUB_TOKEN;
		}
		return env;
	}

	buildCommandSpec(
		task: string,
		route: { modelName: string; baseUrl: string; routeProvider: string },
	): CommandSpec {
		const argv = ["gh", "copilot", "suggest", "--model", route.modelName, task];
		const env: Record<string, string> = {};
		return { argv, env };
	}
}

// ─── Registry ─────────────────────────────────────────────────────────────

const BUILDERS: Record<string, CliBuilder> = {
	claude: new ClaudeCliBuilder(),
	codex: new CodexCliBuilder(),
	hermes: new HermesCliBuilder(),
	gemini: new GeminiCliBuilder(),
	copilot: new CopilotCliBuilder(),
};

/**
 * Get a CliBuilder by name. Falls back to Hermes if unknown.
 */
export function getCliBuilder(cliName: string): CliBuilder {
	return BUILDERS[cliName] ?? BUILDERS.hermes;
}

/**
 * Check if a CLI name is known.
 */
export function isKnownCli(cliName: string): cliName is CliName {
	return cliName in BUILDERS;
}

/**
 * List all registered CLI names.
 */
export function listCliNames(): CliName[] {
	return Object.keys(BUILDERS) as CliName[];
}

/**
 * P450 V1: Resolve model for a builder with route-first logic.
 *
 * Attempt to fetch an active route from DB for the given builder.
 * If found, return the route's model. If not found, emit fallback audit
 * and return the builder's hardcoded defaultModel().
 *
 * This async wrapper ensures spawners can route through DB before falling
 * back to legacy hardcoded defaults.
 */
export async function resolveBuilderModel(cliName: string): Promise<string> {
	const builder = getCliBuilder(cliName);
	const route = await getRouteForBuilder(cliName);

	if (route.found) {
		return route.modelName;
	}

	// No route found; emit audit and use hardcoded default
	const defaultModel = builder.defaultModel();
	await emitCliBuilderFallback(cliName, defaultModel);
	return defaultModel;
}
