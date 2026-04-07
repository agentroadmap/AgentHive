import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;

describe("CLI proposal list --compact", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-proposal-list-compact");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Compact Proposal List Test");

		await core.createProposal(
			{
				id: "proposal-1",
				title: "Low Priority Potential",
				status: "Potential",
				priority: "low",
				assignee: [],
				createdDate: "2026-01-01 00:00",
				labels: [],
				dependencies: [],
				description: "Proposal one",
			},
			false,
		);
		await core.createProposal(
			{
				id: "proposal-2",
				title: "High Priority Complete",
				status: "Complete",
				priority: "high",
				assignee: [],
				createdDate: "2026-01-02 00:00",
				labels: [],
				dependencies: [],
				description: "Proposal two",
			},
			false,
		);
		await core.createProposal(
			{
				id: "proposal-3",
				title: "Unprioritized Active",
				status: "Active",
				assignee: [],
				createdDate: "2026-01-03 00:00",
				labels: [],
				dependencies: [],
				description: "Proposal three",
			},
			false,
		);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {}
	});

	it("prints one compact line per proposal", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal list --compact`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const lines = result.stdout
			.toString()
			.trim()
			.split(/\r?\n/)
			.filter(Boolean);

		assert.strictEqual(lines.length, 3);
		assert.ok(
			lines.includes("proposal-1 | Potential | low | Low Priority Potential"),
		);
		assert.ok(
			lines.includes("proposal-2 | Complete | high | High Priority Complete"),
		);
		assert.ok(lines.includes("proposal-3 | Active | - | Unprioritized Active"));
		assert.ok(
			lines[0]?.startsWith(
				"proposal-2 | Complete | high | High Priority Complete",
			),
		);
		assert.ok(!result.stdout.toString().includes("Potential:"));
		assert.ok(!result.stdout.toString().includes("Complete:"));
	});

	it("preserves existing filters in compact mode", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal list --compact --status Complete`,
			{
				cwd: TEST_DIR,
			},
		);
		assert.strictEqual(result.exitCode, 0);
		assert.strictEqual(
			result.stdout.toString().trim(),
			"proposal-2 | Complete | high | High Priority Complete",
		);
	});
});
