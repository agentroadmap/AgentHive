import assert from "node:assert";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	_loadAgentGuideline,
	AGENT_GUIDELINES,
	addAgentInstructions,
	CLAUDE_GUIDELINES,
	COPILOT_GUIDELINES,
	ensureMcpGuidelines,
	GEMINI_GUIDELINES,
	README_GUIDELINES,
} from "../../src/index.ts";
import {
	createUniqueTestDir,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("addAgentInstructions", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-agent-instructions");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("creates guideline files when none exist", async () => {
		await addAgentInstructions(TEST_DIR);
		const agents = await await readFile(join(TEST_DIR, "AGENTS.md"), "utf-8");
		const claude = await await readFile(join(TEST_DIR, "CLAUDE.md"), "utf-8");
		const gemini = await await readFile(join(TEST_DIR, "GEMINI.md"), "utf-8");
		const copilot = await await readFile(
			join(TEST_DIR, ".github/copilot-instructions.md"),
			"utf-8",
		);

		// Check that files contain the markers and content
		assert.ok(agents.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(agents.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(agents.includes(await _loadAgentGuideline(AGENT_GUIDELINES)));

		assert.ok(claude.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(claude.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(claude.includes(await _loadAgentGuideline(CLAUDE_GUIDELINES)));

		assert.ok(gemini.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(gemini.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(gemini.includes(await _loadAgentGuideline(GEMINI_GUIDELINES)));

		assert.ok(copilot.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(copilot.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(copilot.includes(await _loadAgentGuideline(COPILOT_GUIDELINES)));
	});

	it("appends guideline files when they already exist", async () => {
		await writeFile(join(TEST_DIR, "AGENTS.md"), "Existing\n");
		await addAgentInstructions(TEST_DIR);
		const agents = await await readFile(join(TEST_DIR, "AGENTS.md"), "utf-8");
		expect(agents.startsWith("Existing\n")).toBe(true);
		assert.ok(agents.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(agents.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(agents.includes(await _loadAgentGuideline(AGENT_GUIDELINES)));
	});

	it("creates only selected files", async () => {
		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md", "README.md"]);

		const agentsExists = await stat(join(TEST_DIR, "AGENTS.md"))
			.then(() => true)
			.catch(() => false);
		const claudeExists = await stat(join(TEST_DIR, "CLAUDE.md"))
			.then(() => true)
			.catch(() => false);
		const geminiExists = await stat(join(TEST_DIR, "GEMINI.md"))
			.then(() => true)
			.catch(() => false);
		const copilotExists = await stat(
			join(TEST_DIR, ".github/copilot-instructions.md"),
		)
			.then(() => true)
			.catch(() => false);
		const readme = await readFile(join(TEST_DIR, "README.md"), "utf-8");

		assert.strictEqual(agentsExists, true);
		assert.strictEqual(claudeExists, false);
		assert.strictEqual(geminiExists, false);
		assert.strictEqual(copilotExists, false);
		assert.ok(readme.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(readme.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(readme.includes(await _loadAgentGuideline(README_GUIDELINES)));
	});

	it("loads guideline content from file paths", async () => {
		const pathGuideline = join(
			process.cwd(),
			"src/apps/guidelines/agent-guidelines.md",
		);
		const content = await _loadAgentGuideline(pathGuideline);
		assert.ok(
			content.includes(
				"# Instructions for the usage of agentRoadmap.md CLI Tool",
			),
		);
	});

	it("does not duplicate content when run multiple times (idempotent)", async () => {
		// First run
		await addAgentInstructions(TEST_DIR);
		const firstRun = await readFile(join(TEST_DIR, "CLAUDE.md"), "utf-8");

		// Second run - should not duplicate content
		await addAgentInstructions(TEST_DIR);
		const secondRun = await readFile(join(TEST_DIR, "CLAUDE.md"), "utf-8");

		assert.strictEqual(firstRun, secondRun);
	});

	it("preserves existing content and adds Roadmap.md content only once", async () => {
		const existingContent =
			"# My Existing Claude Instructions\n\nThis is my custom content.\n";
		await writeFile(join(TEST_DIR, "CLAUDE.md"), existingContent);

		// First run
		await addAgentInstructions(TEST_DIR, undefined, ["CLAUDE.md"]);
		const firstRun = await readFile(join(TEST_DIR, "CLAUDE.md"), "utf-8");

		// Second run - should not duplicate Roadmap.md content
		await addAgentInstructions(TEST_DIR, undefined, ["CLAUDE.md"]);
		const secondRun = await readFile(join(TEST_DIR, "CLAUDE.md"), "utf-8");

		assert.strictEqual(firstRun, secondRun);
		assert.ok(firstRun.includes(existingContent));
		assert.ok(firstRun.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(firstRun.includes("<!-- ROADMAP.MD GUIDELINES END -->"));

		// Count occurrences of the marker to ensure it's only there once
		const startMarkerCount = (
			firstRun.match(/<!-- ROADMAP\.MD GUIDELINES START -->/g) || []
		).length;
		const endMarkerCount = (
			firstRun.match(/<!-- ROADMAP\.MD GUIDELINES END -->/g) || []
		).length;
		assert.strictEqual(startMarkerCount, 1);
		assert.strictEqual(endMarkerCount, 1);
	});

	it("handles different file types with appropriate markers", async () => {
		const existingContent = "existing content\n";

		// Test AGENTS.md (markdown with HTML comments)
		await writeFile(join(TEST_DIR, "AGENTS.md"), existingContent);
		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const agentsContent = await await readFile(
			join(TEST_DIR, "AGENTS.md"),
			"utf-8",
		);
		assert.ok(agentsContent.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(agentsContent.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
	});

	it("replaces CLI guidelines with MCP nudge when switching modes", async () => {
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const cliBlock = [
			"Preface content",
			"<!-- ROADMAP.MD GUIDELINES START -->",
			"CLI instructions here",
			"<!-- ROADMAP.MD GUIDELINES END -->",
			"Footer line",
			"",
		].join("\n");
		await writeFile(agentsPath, cliBlock);

		await ensureMcpGuidelines(TEST_DIR, "AGENTS.md");
		const updated = await await readFile(agentsPath, "utf-8");

		assert.ok(!updated.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(!updated.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(updated.includes("<!-- ROADMAP.MD MCP GUIDELINES START -->"));
		assert.ok(updated.includes("<!-- ROADMAP.MD MCP GUIDELINES END -->"));
		assert.ok(updated.includes("Preface content"));
		assert.ok(updated.includes("Footer line"));
	});

	it("replaces MCP nudge with CLI guidelines when switching modes", async () => {
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const mcpBlock = [
			"Header",
			"<!-- ROADMAP.MD MCP GUIDELINES START -->",
			"MCP reminder here",
			"<!-- ROADMAP.MD MCP GUIDELINES END -->",
			"",
		].join("\n");
		await writeFile(agentsPath, mcpBlock);

		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const updated = await await readFile(agentsPath, "utf-8");

		assert.ok(updated.includes("<!-- ROADMAP.MD GUIDELINES START -->"));
		assert.ok(updated.includes("<!-- ROADMAP.MD GUIDELINES END -->"));
		assert.ok(!updated.includes("<!-- ROADMAP.MD MCP GUIDELINES START -->"));
		assert.ok(!updated.includes("<!-- ROADMAP.MD MCP GUIDELINES END -->"));
		assert.ok(updated.includes("Header"));
	});
});
