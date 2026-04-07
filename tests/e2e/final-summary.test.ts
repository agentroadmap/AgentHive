import assert from "node:assert";
import { mkdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { extractStructuredSection } from "../../src/markdown/structured-sections.ts";
import type { Proposal } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Final Summary", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-final-summary");
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Final Summary Test Project");
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR).catch(() => {});
	});

	it("creates proposals with Final Summary and persists section markers", async () => {
		const core = new Core(TEST_DIR);
		const { proposal } = await core.createProposalFromInput({
			title: "Proposal with summary",
			finalSummary: "Completed the core workflow",
		});

		assert.ok(proposal.rawContent?.includes("## Final Summary"));
		assert.ok(
			proposal.rawContent?.includes("<!-- SECTION:FINAL_SUMMARY:BEGIN -->"),
		);
		assert.ok(
			proposal.rawContent?.includes("<!-- SECTION:FINAL_SUMMARY:END -->"),
		);
		expect(
			extractStructuredSection(proposal.rawContent ?? "", "finalSummary"),
		).toBe("Completed the core workflow");
	});

	it("sets, appends, and clears Final Summary via proposal edit operations", async () => {
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

		await core.updateProposalFromInput(
			"proposal-1",
			{ finalSummary: "Initial summary" },
			false,
		);
		let body = await core.getProposalContent("proposal-1");
		expect(extractStructuredSection(body ?? "", "finalSummary")).toBe(
			"Initial summary",
		);

		await core.updateProposalFromInput(
			"proposal-1",
			{ appendFinalSummary: ["Second", "Third"] },
			false,
		);
		body = await core.getProposalContent("proposal-1");
		expect(extractStructuredSection(body ?? "", "finalSummary")).toBe(
			"Initial summary\n\nSecond\n\nThird",
		);

		await core.updateProposalFromInput(
			"proposal-1",
			{ clearFinalSummary: true },
			false,
		);
		body = await core.getProposalContent("proposal-1");
		expect(
			extractStructuredSection(body ?? "", "finalSummary"),
		).toBeUndefined();
		assert.ok(!body?.includes("## Final Summary"));
	});

	it("orders Final Summary after Implementation Notes", async () => {
		const core = new Core(TEST_DIR);
		const proposal: Proposal = {
			id: "proposal-2",
			title: "Ordered proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Desc",
			implementationPlan: "1. Plan",
			implementationNotes: "Notes",
			finalSummary: "Summary",
		};
		await core.createProposal(proposal, false);

		const body = (await core.getProposalContent("proposal-2")) ?? "";
		const notesIndex = body.indexOf("## Implementation Notes");
		const summaryIndex = body.indexOf("## Final Summary");
		assert.ok(summaryIndex > notesIndex);
	});

	it("does not persist empty Final Summary sections", async () => {
		const core = new Core(TEST_DIR);
		const { proposal } = await core.createProposalFromInput({
			title: "Proposal without summary",
		});

		assert.ok(!proposal.rawContent?.includes("## Final Summary"));
	});

	it("ignores Final Summary examples nested inside Description", () => {
		const content = [
			"## Description",
			"",
			"<!-- SECTION:DESCRIPTION:BEGIN -->",
			"Here is an example:",
			"```markdown",
			"## Final Summary",
			"",
			"<!-- SECTION:FINAL_SUMMARY:BEGIN -->",
			"### Example",
			"- Not the real summary",
			"<!-- SECTION:FINAL_SUMMARY:END -->",
			"```",
			"<!-- SECTION:DESCRIPTION:END -->",
			"",
			"## Final Summary",
			"",
			"<!-- SECTION:FINAL_SUMMARY:BEGIN -->",
			"Real summary content",
			"<!-- SECTION:FINAL_SUMMARY:END -->",
			"",
		].join("\n");

		expect(extractStructuredSection(content, "finalSummary")).toBe(
			"Real summary content",
		);
	});
});
