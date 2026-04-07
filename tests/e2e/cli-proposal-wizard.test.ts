import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("CLI proposal wizard integration compatibility", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-proposal-wizard");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("CLI Wizard Compatibility");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors in tests
		}
	});

	it("preserves non-interactive missing title error for proposal create", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create`,
			{ cwd: TEST_DIR },
		);
		assert.notStrictEqual(result.exitCode, 0);
		expect(result.stderr.toString()).toContain(
			"error: missing required argument 'title'",
		);
	});

	it("preserves non-interactive missing proposalId error for proposal edit", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal edit`,
			{ cwd: TEST_DIR },
		);
		assert.notStrictEqual(result.exitCode, 0);
		expect(result.stderr.toString()).toContain(
			"error: missing required argument 'proposalId'",
		);
	});

	it("keeps legacy non-interactive edit behavior when proposalId is provided", async () => {
		execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Edit target" --desc "Before edit"`,
			{ cwd: TEST_DIR },
		);
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal edit 1`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);
		expect(result.stdout.toString()).toContain("Updated proposal");
	});
});
