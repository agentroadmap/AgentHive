import assert from "node:assert";
import { mkdir } from "node:fs/promises";
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

describe("CLI search command", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-search");
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Search Command Project");

		await core.createProposal(
			{
				id: "proposal-1",
				title: "Central search integration",
				status: "Potential",
				assignee: ["@codex"],
				createdDate: "2025-09-18",
				labels: ["search"],
				dependencies: [],
				rawContent: "Implements central search module",
				description: "Implements central search module",
			},
			false,
		);

		await core.createProposal(
			{
				id: "proposal-2",
				title: "High priority follow-up",
				status: "Active",
				assignee: ["@codex"],
				createdDate: "2025-09-18",
				labels: ["search"],
				dependencies: [],
				rawContent: "Follow-up work",
				description: "Follow-up work",
				priority: "high",
			},
			false,
		);

		await core.filesystem.saveDocument({
			id: "doc-1",
			title: "Search Architecture Notes",
			type: "guide",
			createdDate: "2025-09-18",
			rawContent: "# Search Architecture Notes\nCentral search design",
		});

		await core.filesystem.saveDecision({
			id: "decision-1",
			title: "Adopt centralized search",
			date: "2025-09-18",
			status: "accepted",
			context: "Discussed search consolidation",
			decision: "Adopt shared Fuse index",
			consequences: "Unified search paths",
			rawContent:
				"## Context\nDiscussed search consolidation\n\n## Decision\nAdopt shared Fuse index",
		});
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("returns matching proposals, documents, and decisions in plain output", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} search central --plain`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
		const stdout = result.stdout.toString();
		assert.ok(stdout.includes("Proposals:"));
		assert.ok(stdout.includes("proposal-1 - Central search integration"));
		assert.ok(stdout.includes("Documents:"));
		assert.ok(stdout.includes("doc-1 - Search Architecture Notes"));
		assert.ok(stdout.includes("Decisions:"));
		assert.ok(stdout.includes("decision-1 - Adopt centralized search"));
	});

	it("honors status and priority filters for proposal results", async () => {
		const statusResult = execSync(
			`node --experimental-strip-types ${cliPath} search follow-up --type proposal --status "Active" --plain`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(statusResult.exitCode, 0);
		const statusStdout = statusResult.stdout.toString();
		assert.ok(statusStdout.includes("proposal-2 - High priority follow-up"));
		assert.ok(
			!statusStdout.includes("proposal-1 - Central search integration"),
		);

		const priorityResult = execSync(
			`node --experimental-strip-types ${cliPath} search follow-up --type proposal --priority high --plain`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(priorityResult.exitCode, 0);
		const priorityStdout = priorityResult.stdout.toString();
		assert.ok(priorityStdout.includes("proposal-2 - High priority follow-up"));
	});

	it("applies result limit", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} search search --plain --limit 1`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);
		const stdout = result.stdout.toString();
		const proposalMatches = stdout.match(/proposal-\d+ -/g) || [];
		expect(proposalMatches.length).toBeLessThanOrEqual(1);
	});
});
