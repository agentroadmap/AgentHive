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

const CLI_PATH = join(process.cwd(), "src", "cli.ts");
let TEST_DIR: string;

describe("Implementation Notes - append", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-notes-append");
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Append Notes Test Project");
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR).catch(() => {});
	});

	it("appends to existing Implementation Notes with single blank line", async () => {
		const core = new Core(TEST_DIR);
		const proposal: Proposal = {
			id: "proposal-1",
			title: "Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Test description",
			implementationNotes: "First block",
		};
		await core.createProposal(proposal, false);

		const result = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--append-notes", "Second block"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const updatedBody = await core.getProposalContent("proposal-1");
		expect(
			extractStructuredSection(updatedBody ?? "", "implementationNotes"),
		).toBe("First block\n\nSecond block");
	});

	it("creates Implementation Notes at correct position when missing (after plan, else AC, else Description)", async () => {
		const core = new Core(TEST_DIR);
		const t: Proposal = {
			id: "proposal-1",
			title: "Planned",
			status: "Potential",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Desc here",
			acceptanceCriteriaItems: [{ index: 1, text: "A", checked: false }],
			implementationPlan: "1. Do A\n2. Do B",
		};
		await core.createProposal(t, false);

		const res = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--append-notes", "Followed plan"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		const body = (await core.getProposalContent("proposal-1")) ?? "";
		const planIdx = body.indexOf("## Implementation Plan");
		const notesContent =
			extractStructuredSection(body, "implementationNotes") || "";
		assert.ok(planIdx > 0);
		assert.ok(notesContent.includes("Followed plan"));
	});

	it("supports multiple --append-notes flags in order", async () => {
		const core = new Core(TEST_DIR);
		const proposal: Proposal = {
			id: "proposal-1",
			title: "Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-07-03",
			labels: [],
			dependencies: [],
			description: "Some description",
		};
		await core.createProposal(proposal, false);

		const res = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--append-notes", "First", "--append-notes", "Second"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		const updatedBody = await core.getProposalContent("proposal-1");
		expect(
			extractStructuredSection(updatedBody ?? "", "implementationNotes"),
		).toBe("First\n\nSecond");
	});

	it("edit --append-notes works and allows combining with --notes", async () => {
		const resOk = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "T", "--plan", "1. A\n2. B"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(resOk.exitCode, 0);

		const res1 = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--append-notes", "Alpha", "--append-notes", "Beta"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res1.exitCode, 0);

		const core = new Core(TEST_DIR);
		let proposalBody = await core.getProposalContent("proposal-1");
		expect(
			extractStructuredSection(proposalBody ?? "", "implementationNotes"),
		).toBe("Alpha\n\nBeta");

		// Combining --notes (replace) with --append-notes (append) should work
		const combined = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--notes", "Y", "--append-notes", "X"])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(combined.exitCode, 0);

		proposalBody = await core.getProposalContent("proposal-1");
		expect(
			extractStructuredSection(proposalBody ?? "", "implementationNotes"),
		).toBe("Y\n\nX");
	});
});
