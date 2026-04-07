import assert from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { installClaudeAgent } from "../../src/agent-instructions.ts";
import { CLAUDE_AGENT_CONTENT } from "../../src/constants/index.ts";
import { createUniqueTestDir, expect } from "../support/test-utils.ts";

describe("installClaudeAgent", () => {
	let TEST_PROJECT: string;

	beforeEach(async () => {
		TEST_PROJECT = createUniqueTestDir("test-claude-agent");
		await rm(TEST_PROJECT, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_PROJECT, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_PROJECT, { recursive: true, force: true }).catch(() => {});
	});

	it("creates .claude/agents directory in project root if it doesn't exist", async () => {
		await installClaudeAgent(TEST_PROJECT);

		const agentDir = join(TEST_PROJECT, ".claude", "agents");
		expect(existsSync(agentDir)).toBe(true);
	});

	it("writes the project-manager-roadmap.md file with correct content", async () => {
		await installClaudeAgent(TEST_PROJECT);

		const agentPath = join(
			TEST_PROJECT,
			".claude",
			"agents",
			"project-manager-roadmap.md",
		);
		const content = await await readFile(agentPath, "utf-8");

		assert.strictEqual(content, CLAUDE_AGENT_CONTENT);
		assert.ok(content.includes("name: project-manager-roadmap"));
		assert.ok(
			content.includes(
				"You are an expert project manager specializing in the roadmap.md proposal management system",
			),
		);
	});

	it("overwrites existing agent file", async () => {
		const agentDir = join(TEST_PROJECT, ".claude", "agents");
		await mkdir(agentDir, { recursive: true });

		const agentPath = join(
			TEST_PROJECT,
			".claude",
			"agents",
			"project-manager-roadmap.md",
		);
		await writeFile(agentPath, "Old content");

		await installClaudeAgent(TEST_PROJECT);

		const content = await await readFile(agentPath, "utf-8");
		assert.strictEqual(content, CLAUDE_AGENT_CONTENT);
		assert.ok(!content.includes("Old content"));
	});

	it("works with different project paths", async () => {
		const subProjectPath = join(TEST_PROJECT, "subproject");
		await mkdir(subProjectPath, { recursive: true });

		await installClaudeAgent(subProjectPath);

		const agentPath = join(
			subProjectPath,
			".claude",
			"agents",
			"project-manager-roadmap.md",
		);
		expect(existsSync(agentPath)).toBe(true);
	});
});
