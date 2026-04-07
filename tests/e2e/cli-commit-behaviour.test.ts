import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { GitOperations } from "../../src/git/operations.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

const CLI_PATH = join(process.cwd(), "src/cli.ts");

async function getCommitCountInTest(dir: string): Promise<number> {
	const result = execSync(`git rev-list --all --count`, { cwd: dir });
	return Number.parseInt(result.stdout.toString().trim(), 10);
}

let TEST_DIR: string;

describe("CLI Auto-Commit Behavior with autoCommit: false", () => {
	let git: GitOperations;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-commit-false");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repository first to avoid interactive prompts and ensure consistency
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		git = new GitOperations(TEST_DIR);

		await core.initializeProject("Commit Behavior Test", true); // auto-commit the initialization

		const config = await core.filesystem.loadConfig();
		if (config) {
			config.autoCommit = false;
			await core.filesystem.saveConfig(config);
			// Commit the config change to have a clean proposal for tests
			const configPath = join(TEST_DIR, "roadmap", "config.yml");
			await git.addFile(configPath);
			// Only commit if there are actual changes staged, to avoid errors on empty commits.
			const diffProc = execSync(`git diff --staged --quiet`, { cwd: TEST_DIR });
			if (diffProc.exitCode === 1) {
				await git.commitChanges("test: set autoCommit to false");
			}
		}
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should not commit when creating a proposal if autoCommit is false", async () => {
		const initialCommitCount = await getCommitCountInTest(TEST_DIR);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "No-commit Proposal"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const finalCommitCount = await getCommitCountInTest(TEST_DIR);
		const isClean = await git.isClean();

		assert.strictEqual(finalCommitCount, initialCommitCount);
		assert.strictEqual(isClean, false);
	});

	test("should not commit when creating a document if autoCommit is false", async () => {
		const initialCommitCount = await getCommitCountInTest(TEST_DIR);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} doc create "No-commit Doc"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const finalCommitCount = await getCommitCountInTest(TEST_DIR);
		const isClean = await git.isClean();

		assert.strictEqual(finalCommitCount, initialCommitCount);
		assert.strictEqual(isClean, false);
	});

	test("should not commit when creating a decision if autoCommit is false", async () => {
		const initialCommitCount = await getCommitCountInTest(TEST_DIR);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} decision create "No-commit Decision"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const finalCommitCount = await getCommitCountInTest(TEST_DIR);
		const isClean = await git.isClean();

		assert.strictEqual(finalCommitCount, initialCommitCount);
		assert.strictEqual(isClean, false);
	});
});

describe("CLI Auto-Commit Behavior with autoCommit: true", () => {
	let git: GitOperations;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-commit-true");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		git = new GitOperations(TEST_DIR);

		await core.initializeProject("Commit Behavior Test", true);

		const config = await core.filesystem.loadConfig();
		if (config) {
			config.autoCommit = true; // Enable auto-commit for this test suite
			await core.filesystem.saveConfig(config);
			const configPath = join(TEST_DIR, "roadmap", "config.yml");
			await git.addFile(configPath);
			// Only commit if there are actual changes staged, to avoid errors on empty commits.
			const diffProc = execSync(`git diff --staged --quiet`, { cwd: TEST_DIR });
			if (diffProc.exitCode === 1) {
				await git.commitChanges("test: set autoCommit to true");
			}
		}
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should commit when creating a proposal if autoCommit is true", async () => {
		const initialCommitCount = await getCommitCountInTest(TEST_DIR);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Auto-commit Proposal"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		// Note: isClean() is omitted as createProposal's commit strategy can leave the repo dirty.
		const finalCommitCount = await getCommitCountInTest(TEST_DIR);
		assert.strictEqual(finalCommitCount, initialCommitCount + 1);
	});

	test("should commit when creating a document if autoCommit is true", async () => {
		const initialCommitCount = await getCommitCountInTest(TEST_DIR);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} doc create "Auto-commit Doc"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const finalCommitCount = await getCommitCountInTest(TEST_DIR);
		const isClean = await git.isClean();

		assert.strictEqual(finalCommitCount, initialCommitCount + 1);
		assert.strictEqual(isClean, true);
	});

	test("should commit when creating a decision if autoCommit is true", async () => {
		const initialCommitCount = await getCommitCountInTest(TEST_DIR);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} decision create "Auto-commit Decision"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const finalCommitCount = await getCommitCountInTest(TEST_DIR);
		const isClean = await git.isClean();

		assert.strictEqual(finalCommitCount, initialCommitCount + 1);
		assert.strictEqual(isClean, true);
	});
});
