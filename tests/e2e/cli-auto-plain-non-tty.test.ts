import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal } from "../../src/types";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;
let core: Core;

describe("CLI auto-plain behavior in non-TTY runs", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-auto-plain-non-tty");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Auto Plain Non-TTY Test");

		const seedProposal: Proposal = {
			id: "proposal-1",
			title: "First Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2026-01-01 00:00",
			labels: [],
			dependencies: [],
			description: "Seed proposal description",
		};
		await core.createProposal(seedProposal, false);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("proposal list falls back to plain output without --plain", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal list`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const out = result.stdout.toString();
		assert.ok(out.includes("Potential:"));
		expect(out.toLowerCase()).toContain("proposal-1 - first proposal");
		assert.ok(!out.includes("\x1b"));
	});

	test("proposal view falls back to plain output without --plain", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal view 1`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const out = result.stdout.toString();
		assert.ok(out.includes("Proposal proposal-1 - First Proposal"));
		assert.ok(out.includes("Description:"));
		assert.ok(out.includes("Seed proposal description"));
		assert.ok(!out.includes("\x1b"));
	});

	test("proposal create preserves legacy concise output without --plain", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Second Proposal"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const out = result.stdout.toString();
		assert.ok(out.includes("Created proposal proposal-2"));
		assert.ok(out.includes("File: "));
		assert.ok(!out.includes("Proposal proposal-2 - Second Proposal"));
	});

	test("proposal edit preserves legacy concise output without --plain", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal edit 1 -s "Active"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);
		expect(result.stdout.toString()).toContain("Updated proposal proposal-1");
	});
});
