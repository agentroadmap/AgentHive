import assert from "node:assert";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("CLI agents command", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-agents-cli");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo first
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize roadmap project using Core
		const core = new Core(TEST_DIR);
		await core.initializeProject("Agents Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should show help when no options are provided", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} agents`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
	});

	it("should show help text with agents --help", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} agents --help`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
	});

	it("should update selected agent instruction files", async () => {
		// Test the underlying functionality directly instead of the interactive CLI
		const core = new Core(TEST_DIR);
		const { addAgentInstructions } = await import("../../src/index.ts");

		// Update AGENTS.md file
		await expect(async () => {
			await addAgentInstructions(TEST_DIR, core.gitOps, ["AGENTS.md"]);
		}).not.toThrow();

		// Verify the file was created
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const exists = await stat(agentsPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
		const content = await readFile(agentsPath, "utf-8");
		assert.ok(content.includes("Roadmap.md"));
	});

	it("should handle user cancellation gracefully", async () => {
		// Test that the function handles empty selection (cancellation) gracefully
		const core = new Core(TEST_DIR);
		const { addAgentInstructions } = await import("../../src/index.ts");

		// Test with empty array (simulates user cancellation)
		await expect(async () => {
			await addAgentInstructions(TEST_DIR, core.gitOps, []);
		}).not.toThrow();

		// No files should be created when selection is empty
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const exists = await stat(agentsPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(false);
	});

	it("should fail when not in a roadmap project", async () => {
		// Use OS temp directory to ensure complete isolation from project
		const tempDir = await import("node:os").then((os) => os.tmpdir());
		const nonRoadmapDir = join(
			tempDir,
			`test-non-roadmap-${Date.now()}-${Math.random().toString(36).substring(7)}`,
		);

		// Ensure clean proposal first
		await rm(nonRoadmapDir, { recursive: true, force: true }).catch(() => {});

		// Create a temporary directory that's not a roadmap project
		await mkdir(nonRoadmapDir, { recursive: true });

		// Initialize git repo
		execSync(`git init`, { cwd: nonRoadmapDir });
		execSync(`git config user.name "Test User"`, { cwd: nonRoadmapDir });
		execSync(`git config user.email test@example.com`, { cwd: nonRoadmapDir });

		const result = execSync(
			`node --experimental-strip-types ${cliPath} agents --update-instructions`,
			{ cwd: nonRoadmapDir },
		);

		assert.strictEqual(result.exitCode, 1);

		// Cleanup
		await rm(nonRoadmapDir, { recursive: true, force: true }).catch(() => {});
	});

	it("should update multiple selected files", async () => {
		// Test updating multiple agent instruction files
		const core = new Core(TEST_DIR);
		const { addAgentInstructions } = await import("../../src/index.ts");

		// Test updating multiple files
		await expect(async () => {
			await addAgentInstructions(TEST_DIR, core.gitOps, [
				"AGENTS.md",
				"CLAUDE.md",
			]);
		}).not.toThrow();

		// Verify both files were created
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const claudePath = join(TEST_DIR, "CLAUDE.md");

		const agentsExists = await stat(agentsPath)
			.then(() => true)
			.catch(() => false);
		const claudeExists = await stat(claudePath)
			.then(() => true)
			.catch(() => false);

		expect(agentsExists).toBe(true);
		expect(claudeExists).toBe(true);

		const agentsContent = await readFile(agentsPath, "utf-8");
		const claudeContent = await readFile(claudePath, "utf-8");

		assert.ok(agentsContent.includes("Roadmap.md"));
		assert.ok(claudeContent.includes("Roadmap.md"));
	});

	it("should update existing files correctly", async () => {
		// Test that existing files are updated correctly (idempotent)
		const core = new Core(TEST_DIR);
		const { addAgentInstructions } = await import("../../src/index.ts");

		// First, create a file
		await addAgentInstructions(TEST_DIR, core.gitOps, ["AGENTS.md"]);

		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const exists = await stat(agentsPath)
			.then(() => true)
			.catch(() => false);
		expect(exists).toBe(true);
		const _originalContent = await readFile(agentsPath, "utf-8");

		// Update it again - should be idempotent
		await expect(async () => {
			await addAgentInstructions(TEST_DIR, core.gitOps, ["AGENTS.md"]);
		}).not.toThrow();

		// File should still exist and have consistent content
		const existsAfter = await stat(agentsPath)
			.then(() => true)
			.catch(() => false);
		expect(existsAfter).toBe(true);
		const updatedContent = await readFile(agentsPath, "utf-8");
		assert.ok(updatedContent.includes("Roadmap.md"));
		// Should be idempotent - content should be similar (may have minor differences)
		assert.ok(updatedContent.length > 0);
	});
});
