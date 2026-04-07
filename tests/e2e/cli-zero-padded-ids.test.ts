import assert from "node:assert";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

const CLI_PATH = join(process.cwd(), "src/cli.ts");

let TEST_DIR: string;

describe("CLI Zero Padded IDs Feature", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-zero-padded-ids");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git and roadmap project
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Padding Test", false); // No auto-commit for init

		// Enable zero padding in the config
		const config = await core.filesystem.loadConfig();
		if (config) {
			config.zeroPaddedIds = 3;
			config.autoCommit = false; // Disable auto-commit for easier testing
			await core.filesystem.saveConfig(config);
		}
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should create a proposal with a zero-padded ID", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Padded Proposal"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const proposalsDir = join(TEST_DIR, "roadmap", "proposals");
		const files = await readdir(proposalsDir);
		assert.strictEqual(files.length, 1);
		expect(files[0]).toStartWith("proposal-001");
	});

	test("should create a document with a zero-padded ID", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} doc create "Padded Doc"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const docsDir = join(TEST_DIR, "docs");
		const files = await readdir(docsDir);
		assert.strictEqual(files.length, 1);
		expect(files[0]).toStartWith("doc-001");
	});

	test("should create a decision with a zero-padded ID", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} decision create "Padded Decision"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const decisionsDir = join(TEST_DIR, "roadmap", "decisions");
		const files = await readdir(decisionsDir);
		assert.strictEqual(files.length, 1);
		expect(files[0]).toStartWith("decision-001");
	});

	test("should correctly increment a padded proposal ID", async () => {
		execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "First Padded Proposal"`,
			{ cwd: TEST_DIR },
		);
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Second Padded Proposal"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const proposalsDir = join(TEST_DIR, "roadmap", "proposals");
		const files = await readdir(proposalsDir);
		assert.strictEqual(files.length, 2);
		expect(files.some((file) => file.startsWith("proposal-002"))).toBe(true);
	});

	test("should create a sub-proposal with a zero-padded ID", async () => {
		// Create parent proposal first
		execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Parent Proposal"`,
			{ cwd: TEST_DIR },
		);

		// Create sub-proposal
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Padded Sub-proposal" -p proposal-001`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const proposalsDir = join(TEST_DIR, "roadmap", "proposals");
		const files = await readdir(proposalsDir);
		assert.strictEqual(files.length, 2);
		expect(files.some((file) => file.startsWith("proposal-001.01"))).toBe(true);
	});
});
