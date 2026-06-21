/**
 * CLI Argument Builders for Liaison Invocation — P920
 *
 * SOLE AUTHORITY for brand literals (capitalized names like "Claude", "Codex").
 * Each provider has a simple prompt→args builder used by liaison agents.
 * These are NOT the same as the buildArgsBySpec builders in agent-spawner.ts,
 * which include model routing, auth setup, and full task context.
 * These builders are minimal: just prompt + provider-specific CLI flags.
 */

/**
 * Get the brand/persona name for a provider.
 * This is the ONLY place in the codebase where brand literals appear.
 * All other files (cli-invocation.ts, liaison-agent.ts, start-agency.ts, etc.)
 * must call this function instead of hardcoding names.
 */
export function defaultBrandFor(provider: string): string {
	switch (provider) {
		case "claude":
			return "Claude";
		case "codex":
			return "Codex";
		case "copilot":
			return "GitHub Copilot";
		case "hermes":
			return "Hermes";
		case "gemini":
			return "Gemini";
		case "antigravity":
			return "Antigravity";
		case "xiaomi":
			return "Mimo";
		default:
			return provider;
	}
}

/**
 * Build argv for Claude liaison invocation.
 * Simple: just --print <prompt>
 */
export function buildClaudeArgs(prompt: string): string[] {
	return ["--print", prompt];
}

/**
 * Build argv for Codex liaison invocation.
 * Codex requires exec with bypass flags.
 */
export function buildCodexArgs(prompt: string): string[] {
	return [
		"exec",
		"--dangerously-bypass-approvals-and-sandbox",
		prompt,
	];
}

/**
 * Build argv for Copilot liaison invocation.
 * Copilot uses -p for prompt + --yolo for approval bypass.
 */
export function buildCopilotArgs(prompt: string): string[] {
	return ["-p", prompt, "--yolo"];
}

/**
 * Build argv for Hermes liaison invocation.
 * Hermes has its own CLI interface; minimal prompt passing.
 */
export function buildHermesArgs(prompt: string): string[] {
	// Hermes pattern (placeholder; verify with actual Hermes CLI)
	return ["--input", prompt];
}

/**
 * Build argv for Gemini liaison invocation.
 * --prompt flag verified correct for headless (non-interactive) invocation (2026-05-14).
 */
export function buildGeminiArgs(prompt: string): string[] {
	return ["--prompt", prompt];
}

/**
 * Build argv for Mimo (xiaomi) liaison invocation.
 * `mimo run <prompt>` is the one-shot headless pattern.
 */
export function buildMimoArgs(prompt: string): string[] {
	return ["run", prompt];
}

/**
 * Build argv for OpenAI-compatible CLI (fallback).
 * Generic pattern for unknown or LLM-compatible providers.
 */
export function buildOpenAICompatArgs(prompt: string): string[] {
	return [prompt];
}

/**
 * Build argv for Antigravity liaison invocation — P2408.
 * Minimal prompt + model + dangerously-skip-permissions + add-dir.
 */
export function buildAntigravityArgs(
	prompt: string,
	model: string,
	addDir: string,
): string[] {
	return [
		"-p",
		prompt,
		"--model",
		model,
		"--dangerously-skip-permissions",
		"--add-dir",
		addDir,
	];
}

