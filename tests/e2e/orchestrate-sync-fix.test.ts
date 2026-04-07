import assert from "node:assert";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runOrchestrateCommand } from "../../src/commands/orchestrate.ts";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

describe("Orchestrate Sync Fix", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = createUniqueTestDir("test-orchestrate-sync");
		await mkdir(repoDir, { recursive: true });
		// Initialize git repo
		execSync("git init", { cwd: repoDir });
		execSync("git config user.email test@example.com", { cwd: repoDir });
		execSync("git config user.name 'Test User'", { cwd: repoDir });
		// Create initial commit
		await writeFile(join(repoDir, "README.md"), "# Test Project");
		execSync("git add README.md", { cwd: repoDir });
		execSync("git commit -m 'Initial commit'", { cwd: repoDir });

		// Create roadmap structure
		await mkdir(join(repoDir, "roadmap", "proposals"), { recursive: true });
		await writeFile(
			join(repoDir, "roadmap", "config.yml"),
			"project_name: 'Test Project'",
		);
		execSync("git add roadmap/", { cwd: repoDir });
		execSync("git commit -m 'Add roadmap'", { cwd: repoDir });
	});

	afterEach(async () => {
		await safeCleanup(repoDir);
	});

	it("should symlink the entire roadmap directory and apply skip-worktree", async () => {
		const core = new Core(repoDir);

		// Run orchestrate command for 1 agent
		// We mock clack by passing the number directly
		await runOrchestrateCommand(core, "1");

		const agentDir = join(repoDir, "worktrees", "agent-1");
		const agentRoadmapDir = join(agentDir, "roadmap");

		// 1. Check if it's a symlink
		const linkStat = await lstat(agentRoadmapDir);
		assert.strictEqual(
			linkStat.isSymbolicLink(),
			true,
			"roadmap/ should be a symbolic link",
		);

		// 2. Check if git status is clean regarding roadmap files
		// (skip-worktree should prevent them from appearing as deleted)
		const status = execSync("git status --porcelain", {
			cwd: agentDir,
		}).stdout.toString();
		assert.ok(
			!status.includes(" D roadmap/"),
			"Roadmap files should not appear as deleted",
		);

		// 3. Check CLAUDE.md content for terminology
		const claudeContent = await readFile(join(agentDir, "CLAUDE.md"), "utf-8");
		assert.ok(
			claudeContent.includes('"Active"'),
			"Should use 'Active' terminology",
		);
		assert.ok(
			claudeContent.includes("roadmap/proposals/"),
			"Should use 'roadmap/proposals/' path",
		);
	});
});
