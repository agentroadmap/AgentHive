import assert from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { extractStructuredSection } from "../../src/markdown/structured-sections.ts";
import type { Proposal } from "../../src/types/index.ts";
import {
	buildCliCommand,
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Final Summary CLI", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-final-summary-cli");
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Final Summary CLI Test Project");
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR).catch(() => {});
	});

	it("supports --final-summary on proposal create", async () => {
		const result = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Proposal A", "--final-summary", "PR-ready summary"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const core = new Core(TEST_DIR);
		const proposal = await core.filesystem.loadProposal("proposal-1");
		assert.notStrictEqual(proposal, null);
		assert.ok(proposal?.rawContent?.includes("## Final Summary"));
		expect(
			extractStructuredSection(proposal?.rawContent ?? "", "finalSummary"),
		).toBe("PR-ready summary");
	});

	it("supports set/append/clear flags on proposal edit", async () => {
		const core = new Core(TEST_DIR);
		const base: Proposal = {
			id: "proposal-1",
			title: "Editable proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Initial description",
		};
		await core.createProposal(base, false);

		let res = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--final-summary", "Initial summary"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		let body = await core.getProposalContent("proposal-1");
		expect(extractStructuredSection(body ?? "", "finalSummary")).toBe(
			"Initial summary",
		);

		res = execSync(
			`node --experimental-strip-types ${buildCliCommand([
				CLI_PATH,
				"proposal",
				"edit",
				"1",
				"--append-final-summary",
				"Second",
				"--append-final-summary",
				"Third",
			])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		body = await core.getProposalContent("proposal-1");
		expect(extractStructuredSection(body ?? "", "finalSummary")).toBe(
			"Initial summary\n\nSecond\n\nThird",
		);

		res = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--clear-final-summary"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		body = await core.getProposalContent("proposal-1");
		expect(
			extractStructuredSection(body ?? "", "finalSummary"),
		).toBeUndefined();
		assert.ok(!body?.includes("## Final Summary"));
	});

	it("renders Final Summary in plain output after Implementation Notes when present", async () => {
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Plain output proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-03",
				labels: [],
				dependencies: [],
				description: "Desc",
				implementationNotes: "Notes",
				finalSummary: "Summary",
			},
			false,
		);

		const result = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "view", "1", "--plain"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const output = result.stdout.toString();
		assert.ok(output.includes("Implementation Notes:"));
		assert.ok(output.includes("Final Summary:"));
		expect(output.indexOf("Final Summary:")).toBeGreaterThan(
			output.indexOf("Implementation Notes:"),
		);
	});
});
