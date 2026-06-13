/**
 * P1392: Integration tests for persona injection into provider spawners.
 *
 * Tests cover:
 * - Claude CLI: persona passed via --append-system-prompt (not prepended to task)
 * - Codex: persona prepended to task as `<persona>\n\n<task>`
 * - Gemini: persona prepended with `# Role\n\n<persona>\n\n<task>` format
 * - Copilot: persona prepended with `## Persona\n\n<persona>\n\n<task>` format
 * - No persona: builders work as before (no --append-system-prompt, no prepend)
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
	buildArgsBySpec,
	type SpawnRequest,
	type ModelRoute,
} from "../agent-spawner.ts";

const mockRoute: ModelRoute = {
	modelName: "claude-opus",
	routeProvider: "anthropic",
	agentProvider: "claude",
	agentCli: "claude",
	cliPath: null,
	apiSpec: "anthropic",
	baseUrl: "https://api.anthropic.com",
	planType: null,
	costPer1kInput: 0.003,
	costPerMillionInput: 3,
	costPerMillionOutput: 15,
	apiKeyEnv: null,
	apiKeyFallbackEnv: null,
	baseUrlEnv: null,
	cliApiKeyEnv: "ANTHROPIC_API_KEY",
	apiKeyPrimary: null,
	apiKeySecondary: null,
	spawnToolsets: null,
	spawnDelegate: false,
	routeId: BigInt(1),
};

test("Claude: --append-system-prompt when persona provided", () => {
	const req: SpawnRequest = {
		worktree: "test-worktree",
		task: "Review the proposal.",
		stage: "gate-reviewer",
		persona: "You are a skeptic. Challenge assumptions.",
		personaName: "skeptic-alpha",
	};

	const route = { ...mockRoute, agentCli: "claude" };
	const { argv, env } = buildArgsBySpec(req, route);

	// Should have --append-system-prompt followed by persona
	assert(argv.includes("--append-system-prompt"));
	const appendIdx = argv.indexOf("--append-system-prompt");
	assert.equal(argv[appendIdx + 1], "You are a skeptic. Challenge assumptions.");

	// Task should NOT be prepended with persona
	assert.equal(argv[argv.length - 1], "Review the proposal.");

	// Verify no persona prepend in the task
	const taskIdx = argv.indexOf("Review the proposal.");
	assert.equal(argv[taskIdx], "Review the proposal.");
	assert(!argv[taskIdx].includes("You are a skeptic"));
});

test("Claude: no --append-system-prompt when persona absent", () => {
	const req: SpawnRequest = {
		worktree: "test-worktree",
		task: "Review the proposal.",
		stage: "gate-reviewer",
	};

	const route = { ...mockRoute, agentCli: "claude" };
	const { argv } = buildArgsBySpec(req, route);

	// Should NOT have --append-system-prompt
	assert(!argv.includes("--append-system-prompt"));
	// Task should be present
	assert(argv.includes("Review the proposal."));
});

test("Codex: persona prepended to task", () => {
	const personaText = "You are a code architect.";
	const taskText = "Implement the feature.";
	const req: SpawnRequest = {
		worktree: "test-worktree",
		task: taskText,
		stage: "developer",
		persona: personaText,
		personaName: "engineering-software-architect",
	};

	const route = {
		...mockRoute,
		agentCli: "codex",
		modelName: "code-davinci-003",
	};
	const { argv } = buildArgsBySpec(req, route);

	// Find the task argument
	const taskArg = argv[argv.length - 1];
	assert(taskArg.includes(personaText));
	assert(taskArg.includes(taskText));
	assert(taskArg.startsWith(personaText));
	assert(taskArg.includes("\n\n" + taskText));
});

test("Codex: no prepend when persona absent", () => {
	const taskText = "Implement the feature.";
	const req: SpawnRequest = {
		worktree: "test-worktree",
		task: taskText,
		stage: "developer",
	};

	const route = {
		...mockRoute,
		agentCli: "codex",
		modelName: "code-davinci-003",
	};
	const { argv } = buildArgsBySpec(req, route);

	const taskArg = argv[argv.length - 1];
	assert.equal(taskArg, taskText);
});

test("Gemini: persona with # Role header format", () => {
	const personaText = "You are a design expert.";
	const taskText = "Design the UI.";
	const req: SpawnRequest = {
		worktree: "test-worktree",
		task: taskText,
		stage: "designer",
		persona: personaText,
		personaName: "design-ui-designer",
	};

	const route = {
		...mockRoute,
		agentCli: "gemini",
		modelName: "gemini-pro",
	};
	const { argv } = buildArgsBySpec(req, route);

	// Find the --prompt argument
	const promptIdx = argv.indexOf("--prompt");
	const promptArg = argv[promptIdx + 1];

	assert(promptArg.includes("# Role"));
	assert(promptArg.includes(personaText));
	assert(promptArg.includes(taskText));
	assert(promptArg.startsWith("# Role"));
});

test("Copilot: persona with ## Persona header format", () => {
	const personaText = "You are a code quality expert.";
	const taskText = "Improve the code.";
	const req: SpawnRequest = {
		worktree: "test-worktree",
		task: taskText,
		stage: "reviewer",
		persona: personaText,
		personaName: "engineering-code-reviewer",
	};

	const route = {
		...mockRoute,
		agentCli: "copilot",
		modelName: "gpt-4-turbo",
	};
	const { argv } = buildArgsBySpec(req, route);

	// Find the -p argument
	const pIdx = argv.indexOf("-p");
	const promptArg = argv[pIdx + 1];

	assert(promptArg.includes("## Persona"));
	assert(promptArg.includes(personaText));
	assert(promptArg.includes(taskText));
	assert(promptArg.startsWith("## Persona"));
});

test("Claude with empty persona string: treated as absent", () => {
	const req: SpawnRequest = {
		worktree: "test-worktree",
		task: "Review the proposal.",
		stage: "gate-reviewer",
		persona: "", // Empty string
	};

	const route = { ...mockRoute, agentCli: "claude" };
	const { argv } = buildArgsBySpec(req, route);

	// Should NOT have --append-system-prompt for empty string
	assert(!argv.includes("--append-system-prompt"));
	assert(argv.includes("Review the proposal."));
});

test("All providers preserve task when no persona", () => {
	const taskText = "Do the work.";

	const testCases = [
		{ cli: "claude", route: { ...mockRoute, agentCli: "claude" } },
		{ cli: "codex", route: { ...mockRoute, agentCli: "codex" } },
		{ cli: "gemini", route: { ...mockRoute, agentCli: "gemini" } },
		{ cli: "copilot", route: { ...mockRoute, agentCli: "copilot" } },
	];

	for (const { cli, route } of testCases) {
		const req: SpawnRequest = {
			worktree: "test-worktree",
			task: taskText,
			stage: "worker",
		};

		const { argv } = buildArgsBySpec(req, route);
		assert(argv.includes(taskText), `${cli} should preserve task when no persona`);
	}
});
