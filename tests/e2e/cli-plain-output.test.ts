import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
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
let SUBSTATES: Array<{ id: string; title: string }> = [];

describe("CLI plain output for AI agents", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-plain-output");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo first using shell API (same pattern as other tests)
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize roadmap project using Core (same pattern as other tests)
		const core = new Core(TEST_DIR);
		await core.initializeProject("Plain Output Test Project");

		// Create a test proposal
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Test proposal for plain output",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Test description",
			},
			false,
		);

		const { proposal: subproposal1 } = await core.createProposalFromInput(
			{
				title: "Child proposal A",
				parentProposalId: "proposal-1",
			},
			false,
		);

		const { proposal: subproposal2 } = await core.createProposalFromInput(
			{
				title: "Child proposal B",
				parentProposalId: "proposal-1",
			},
			false,
		);

		// Preserve order for assertions
		SUBSTATES = [subproposal1, subproposal2];

		// Create a second proposal without subproposals
		await core.createProposal(
			{
				id: "proposal-2",
				title: "Standalone proposal for plain output",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-19",
				labels: [],
				dependencies: [],
				description: "Standalone description",
			},
			false,
		);

		// Create a test draft with proper draft-X id format
		await core.createDraft(
			{
				id: "draft-1",
				title: "Test draft for plain output",
				status: "Draft",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Test draft description",
			},
			false,
		);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should output plain text with proposal view --plain", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal view 1 --plain`,
			{ cwd: TEST_DIR },
		);

		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(result.exitCode, 0);
		// Should contain the file path as first line
		expect(result.stdout.toString()).toContain("File: ");
		expect(result.stdout.toString()).toContain(
			"proposal-1 - Test-proposal-for-plain-output.md",
		);
		// Should contain the formatted proposal output
		expect(result.stdout.toString()).toContain(
			"Proposal PROPOSAL-1 - Test proposal for plain output",
		);
		expect(result.stdout.toString()).toContain("Status: ○ Potential");
		expect(result.stdout.toString()).toContain("Created: 2025-06-18");
		expect(result.stdout.toString()).toContain("Subproposals (2):");
		const [subproposal1, subproposal2] = SUBSTATES;
		if (subproposal1 && subproposal2) {
			const output = result.stdout.toString();
			assert.ok(
				output.includes(`- ${subproposal1.id} - ${subproposal1.title}`),
			);
			assert.ok(
				output.includes(`- ${subproposal2.id} - ${subproposal2.title}`),
			);
			expect(output.indexOf(subproposal1.id)).toBeLessThan(
				output.indexOf(subproposal2.id),
			);
		}
		expect(result.stdout.toString()).toContain("Description:");
		expect(result.stdout.toString()).toContain("Test description");
		expect(result.stdout.toString()).toContain("Acceptance Criteria:");
		expect(result.stdout.toString()).toContain("Verification Proposalments:");
		// Should not contain TUI escape codes
		expect(result.stdout.toString()).not.toContain("[?1049h");
		expect(result.stdout.toString()).not.toContain("\x1b");
	});

	it("should output plain text with proposal <id> --plain shortcut", async () => {
		// Verify proposal exists before running CLI command
		const core = new Core(TEST_DIR);
		const proposal = await core.filesystem.loadProposal("proposal-1");
		assert.notStrictEqual(proposal, null);
		assert.strictEqual(proposal?.id, "proposal-1");

		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal 1 --plain`,
			{ cwd: TEST_DIR },
		);

		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(result.exitCode, 0);
		// Should contain the file path as first line
		expect(result.stdout.toString()).toContain("File: ");
		expect(result.stdout.toString()).toContain(
			"proposal-1 - Test-proposal-for-plain-output.md",
		);
		// Should contain the formatted proposal output
		expect(result.stdout.toString()).toContain(
			"Proposal PROPOSAL-1 - Test proposal for plain output",
		);
		expect(result.stdout.toString()).toContain("Status: ○ Potential");
		expect(result.stdout.toString()).toContain("Created: 2025-06-18");
		expect(result.stdout.toString()).toContain("Description:");
		expect(result.stdout.toString()).toContain("Test description");
		// Should not contain TUI escape codes
		expect(result.stdout.toString()).not.toContain("[?1049h");
		expect(result.stdout.toString()).not.toContain("\x1b");
	});

	it("should not include a subproposal list when none exist", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal view 2 --plain`,
			{ cwd: TEST_DIR },
		);

		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(result.exitCode, 0);
		expect(result.stdout.toString()).toContain(
			"Proposal PROPOSAL-2 - Standalone proposal for plain output",
		);
		expect(result.stdout.toString()).not.toContain("Subproposals (");
		expect(result.stdout.toString()).not.toContain("Subproposals:");
	});

	it("should output plain text with draft view --plain", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} draft view 1 --plain`,
			{ cwd: TEST_DIR },
		);

		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(result.exitCode, 0);
		// Should contain the file path as first line
		expect(result.stdout.toString()).toContain("File: ");
		expect(result.stdout.toString()).toContain(
			"draft-1 - Test-draft-for-plain-output.md",
		);
		// Should contain the formatted draft output
		expect(result.stdout.toString()).toContain(
			"Proposal draft-1 - Test draft for plain output",
		);
		expect(result.stdout.toString()).toContain("Status: ○ Draft");
		expect(result.stdout.toString()).toContain("Created: 2025-06-18");
		expect(result.stdout.toString()).toContain("Description:");
		// Should not contain TUI escape codes
		expect(result.stdout.toString()).not.toContain("[?1049h");
		expect(result.stdout.toString()).not.toContain("\x1b");
	});

	it("should output plain text with draft <id> --plain shortcut", async () => {
		// Verify draft exists before running CLI command
		const core = new Core(TEST_DIR);
		const draft = await core.filesystem.loadDraft("draft-1");
		assert.notStrictEqual(draft, null);
		assert.strictEqual(draft?.id, "draft-1");

		const result = execSync(
			`node --experimental-strip-types ${cliPath} draft 1 --plain`,
			{ cwd: TEST_DIR },
		);

		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(result.exitCode, 0);
		// Should contain the file path as first line
		expect(result.stdout.toString()).toContain("File: ");
		expect(result.stdout.toString()).toContain(
			"draft-1 - Test-draft-for-plain-output.md",
		);
		// Should contain the formatted draft output
		expect(result.stdout.toString()).toContain(
			"Proposal draft-1 - Test draft for plain output",
		);
		expect(result.stdout.toString()).toContain("Status: ○ Draft");
		expect(result.stdout.toString()).toContain("Created: 2025-06-18");
		expect(result.stdout.toString()).toContain("Description:");
		// Should not contain TUI escape codes
		expect(result.stdout.toString()).not.toContain("[?1049h");
		expect(result.stdout.toString()).not.toContain("\x1b");
	});

	it("omits complete-proposal plan text and checked criteria from plain output", async () => {
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-3",
				title: "Complete proposal for plain output",
				status: "Complete",
				assignee: [],
				createdDate: "2025-06-20",
				labels: ["release", "ai"],
				dependencies: [],
				rawContent: `## Description

Complete description

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Already done
- [ ] #2 Still visible
<!-- AC:END -->

## Verification Proposalments
<!-- VERIFY:BEGIN -->
- [x] #1 Command exits 0
<!-- VERIFY:END -->

## Implementation Plan
<!-- SECTION:PLAN:BEGIN -->
1. Hidden complete plan
<!-- SECTION:PLAN:END -->

## Final Summary
<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Complete summary
<!-- SECTION:FINAL_SUMMARY:END -->
`,
			},
			false,
		);

		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal view 3 --plain`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const out = result.stdout.toString();
		expect(out).toContain(
			"Proposal PROPOSAL-3 - Complete proposal for plain output",
		);
		expect(out).toContain("Description:");
		expect(out).toContain("Complete description");
		expect(out).toContain("Acceptance Criteria:");
		expect(out).toContain("Still visible");
		expect(out).not.toContain("Already done");
		expect(out).not.toContain("Implementation Plan:");
		expect(out).toContain("Final Summary:");
		expect(out).toContain("Complete summary");
		expect(out).not.toContain("<!-- AC:BEGIN -->");
		expect(out).not.toContain("<!-- SECTION:PLAN:BEGIN -->");
	});

	// Proposal list already has --plain support and works correctly
});
