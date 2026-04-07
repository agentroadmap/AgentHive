import assert from "node:assert";
import { lstat, mkdir, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Orchestrate command symlink", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");
	const nodeArgs = "--experimental-strip-types";

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-orchestrate-symlink");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize roadmap project
		const core = new Core(TEST_DIR);
		await core.initializeProject("Orchestrate Test Project");

		// Commit roadmap so it's included in worktrees
		execSync(`git add roadmap`, { cwd: TEST_DIR });
		execSync(`git commit -m "chore: initialize roadmap"`, { cwd: TEST_DIR });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	it("should create worktrees with roadmap as a symlink to the root roadmap", async () => {
		// Run orchestrate command to create 1 agent
		const cmd = `node ${nodeArgs} ${cliPath} orchestrate --agents 1`;
		// Use -y or similar if it was interactive, but we passed --agents so it should be non-interactive for count
		// However, clack might still try to be interactive.
		// Looking at src/commands/orchestrate.ts, if numAgentsStr is provided, it skips the prompt.

		const result = execSync(cmd, { cwd: TEST_DIR });
		assert.strictEqual(result.exitCode, 0);

		const agentRoadmapDir = join(TEST_DIR, "worktrees", "agent-1", "roadmap");
		const stats = await lstat(agentRoadmapDir);

		assert.ok(
			stats.isSymbolicLink(),
			"roadmap directory in worktree should be a symlink",
		);

		const linkTarget = await readlink(agentRoadmapDir);
		// The link target should be relative: ../../roadmap
		assert.strictEqual(
			linkTarget,
			"../../roadmap",
			"symlink should point to the root roadmap directory via relative path",
		);
	});

	it("should move SQLite cache into the roadmap directory", async () => {
		// Run any command that initializes the ContentStore/SQLite
		const cmd = `node ${nodeArgs} ${cliPath} proposal list --plain`;
		const result = execSync(cmd, { cwd: TEST_DIR });
		assert.strictEqual(result.exitCode, 0);

		const sqlitePath = join(TEST_DIR, "roadmap", ".cache", "index.db");
		const stats = await lstat(sqlitePath);
		assert.ok(
			stats.isFile(),
			"SQLite cache should be created inside the roadmap directory",
		);

		// Also check that the old location (root .cache) does NOT contain the DB if it was a fresh project
		const oldSqlitePath = join(TEST_DIR, ".cache", "index.db");
		try {
			await lstat(oldSqlitePath);
			assert.fail(
				"SQLite cache should NOT be in the project root .cache directory",
			);
		} catch (e: any) {
			assert.strictEqual(
				e.code,
				"ENOENT",
				"Old SQLite cache location should not exist",
			);
		}
	});
});
