import assert from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { extractStructuredSection } from "../../src/markdown/structured-sections.ts";
import type { Proposal } from "../../src/types/index.ts";
import { editProposalPlatformAware } from "../support/test-helpers.ts";
import {
	buildCliCommand,
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Implementation Notes CLI", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-notes");
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Implementation Notes Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("proposal create with implementation notes", () => {
		it("should handle all proposal creation scenarios with implementation notes", async () => {
			// Test 1: create proposal with implementation notes using --notes
			const result1 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 1", "--notes", "Initial implementation completed"])}`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result1.exitCode, 0);

			const core = new Core(TEST_DIR);
			let proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("<!-- SECTION:NOTES:BEGIN -->"));
			expect(
				extractStructuredSection(
					proposal?.rawContent || "",
					"implementationNotes",
				),
			).toContain("Initial implementation completed");

			// Test 2: create proposal with multi-line implementation notes
			const result2 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 2", "--notes", "Step 1: Analysis completed\nStep 2: Implementation active"])}`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result2.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-2");
			assert.notStrictEqual(proposal, null);
			const notes2 =
				extractStructuredSection(
					proposal?.rawContent || "",
					"implementationNotes",
				) || "";
			assert.ok(notes2.includes("Step 1: Analysis completed"));
			assert.ok(notes2.includes("Step 2: Implementation active"));

			// Test 3: create proposal with both plan and notes (notes should come after plan)
			const result3 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 3", "--plan", "1. Design\n2. Build\n3. Test", "--notes", "Following the plan step by step"])}`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result3.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-3");
			assert.notStrictEqual(proposal, null);
			expect(
				extractStructuredSection(
					proposal?.rawContent || "",
					"implementationPlan",
				),
			).toContain("1. Design");
			expect(
				extractStructuredSection(
					proposal?.rawContent || "",
					"implementationNotes",
				),
			).toContain("Following the plan step by step");

			// Check that Implementation Notes comes after Implementation Plan
			const desc = proposal?.rawContent || "";
			const planIndex = desc.indexOf("## Implementation Plan");
			const notesIndex = desc.indexOf("## Implementation Notes");
			assert.ok(notesIndex > planIndex);

			// Test 4: create proposal with multiple options including notes
			const result4 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 4", "-d", "Complex proposal description", "--ac", "Must work correctly,Must be tested", "--notes", "Using TDD approach"])}`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result4.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-4");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("Complex proposal description"));
			expect(
				extractStructuredSection(
					proposal?.rawContent || "",
					"implementationNotes",
				),
			).toContain("Using TDD approach");

			// Test 5: create proposal without notes should not add the section
			const result5 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 5"])}`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result5.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-5");
			assert.notStrictEqual(proposal, null);
			// Should not add Implementation Notes section for empty notes
			assert.ok(!proposal?.rawContent?.includes("## Implementation Notes"));
		});
	});

	describe("proposal edit with implementation notes", () => {
		it("should handle all implementation notes scenarios", async () => {
			const core = new Core(TEST_DIR);

			// Test 1: add implementation notes to existing proposal
			const proposal1: Proposal = {
				id: "proposal-1",
				title: "Test Proposal 1",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-03",
				labels: [],
				dependencies: [],
				description: "Test description",
			};
			await core.createProposal(proposal1, false);

			let result = await editProposalPlatformAware(
				{
					proposalId: "1",
					notes: "Fixed the bug by updating the validation logic",
				},
				TEST_DIR,
			);
			if (result.exitCode !== 0)
				console.error("COMMAND FAILED stderr:", result.stderr);
			assert.strictEqual(result.exitCode, 0);

			let updatedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(updatedProposal, null);
			assert.ok(
				updatedProposal?.rawContent?.includes("## Implementation Notes"),
			);
			assert.ok(
				updatedProposal?.rawContent?.includes(
					"Fixed the bug by updating the validation logic",
				),
			);

			// Test 2: overwrite existing implementation notes
			const proposal2: Proposal = {
				id: "proposal-2",
				title: "Test Proposal 2",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-03",
				labels: [],
				dependencies: [],
				description: "Test description",
				implementationNotes: "Initial implementation completed",
			};
			await core.createProposal(proposal2, false);

			result = await editProposalPlatformAware(
				{
					proposalId: "2",
					notes: "Added error handling",
				},
				TEST_DIR,
			);
			if (result.exitCode !== 0)
				console.error("COMMAND FAILED stderr:", result.stderr);
			assert.strictEqual(result.exitCode, 0);

			updatedProposal = await core.filesystem.loadProposal("proposal-2");
			assert.notStrictEqual(updatedProposal, null);
			const notesSection = updatedProposal?.rawContent?.match(
				/## Implementation Notes\s*\n([\s\S]*?)(?=\n## |$)/i,
			);
			assert.ok(
				!notesSection?.[1]?.includes("Initial implementation completed"),
			);
			assert.ok(notesSection?.[1]?.includes("Added error handling"));

			// Test 3: work together with status update when marking as Complete
			const proposal3: Proposal = {
				id: "proposal-3",
				title: "Feature Implementation",
				status: "Active",
				assignee: ["@dev"],
				createdDate: "2025-07-03",
				labels: ["feature"],
				dependencies: [],
				description: "Implement new feature",
				acceptanceCriteriaItems: [
					{ index: 1, text: "Feature works", checked: false },
					{ index: 2, text: "Tests pass", checked: false },
				],
			};
			await core.createProposal(proposal3, false);

			result = await editProposalPlatformAware(
				{
					proposalId: "3",
					status: "Complete",
					maturity: "audited",
					builder: "@builder",
					auditor: "@auditor",
					finalSummary: "Implementation complete",
					addProof: ["Unit tests passed"],
					notes:
						"Implemented using the factory pattern\nAdded unit tests\nUpdated documentation",
				},
				TEST_DIR,
			);
			if (result.exitCode !== 0)
				console.error("COMMAND FAILED stderr:", result.stderr);
			assert.strictEqual(result.exitCode, 0);

			updatedProposal = await core.filesystem.loadProposal("proposal-3");
			assert.notStrictEqual(updatedProposal, null);
			assert.strictEqual(updatedProposal?.status, "Complete");
			assert.ok(
				updatedProposal?.rawContent?.includes("## Implementation Notes"),
			);
			assert.ok(
				updatedProposal?.rawContent?.includes(
					"Implemented using the factory pattern",
				),
			);
			assert.ok(updatedProposal?.rawContent?.includes("Added unit tests"));
			assert.ok(updatedProposal?.rawContent?.includes("Updated documentation"));

			// Test 4: handle multi-line notes with proper formatting
			const proposal4: Proposal = {
				id: "proposal-4",
				title: "Complex Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-03",
				labels: [],
				dependencies: [],
				description: "Complex proposal description",
			};
			await core.createProposal(proposal4, false);

			const multiLineNotes = `Completed the following:
- Refactored the main module
- Added error boundaries
- Improved performance by 30%

Technical decisions:
- Used memoization for expensive calculations
- Implemented lazy loading`;

			result = await editProposalPlatformAware(
				{
					proposalId: "4",
					notes: multiLineNotes,
				},
				TEST_DIR,
			);
			if (result.exitCode !== 0)
				console.error("COMMAND FAILED stderr:", result.stderr);
			assert.strictEqual(result.exitCode, 0);

			updatedProposal = await core.filesystem.loadProposal("proposal-4");
			assert.notStrictEqual(updatedProposal, null);
			assert.ok(
				updatedProposal?.rawContent?.includes("Refactored the main module"),
			);
			assert.ok(updatedProposal?.rawContent?.includes("Technical decisions:"));
			assert.ok(
				updatedProposal?.rawContent?.includes("Implemented lazy loading"),
			);

			// Test 5: position implementation notes after implementation plan if present
			const proposal5: Proposal = {
				id: "proposal-5",
				title: "Planned Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-03",
				labels: [],
				dependencies: [],
				rawContent:
					"Proposal with plan\n\n## Acceptance Criteria\n\n- [ ] Works\n\n## Implementation Plan\n\n1. Design\n2. Build\n3. Test",
			};
			await core.createProposal(proposal5, false);

			result = await editProposalPlatformAware(
				{
					proposalId: "5",
					notes: "Followed the plan successfully",
				},
				TEST_DIR,
			);
			if (result.exitCode !== 0)
				console.error("COMMAND FAILED stderr:", result.stderr);
			assert.strictEqual(result.exitCode, 0);

			updatedProposal = await core.filesystem.loadProposal("proposal-5");
			assert.notStrictEqual(updatedProposal, null);
			const desc = updatedProposal?.rawContent || "";

			// Check that Implementation Notes comes after Implementation Plan
			const planIndex = desc.indexOf("## Implementation Plan");
			const notesIndex = desc.indexOf("## Implementation Notes");
			assert.ok(planIndex > 0);
			assert.ok(notesIndex > planIndex);

			// Test 6: handle empty notes gracefully
			const proposal6: Proposal = {
				id: "proposal-6",
				title: "Test Proposal 6",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-03",
				labels: [],
				dependencies: [],
				description: "Test description",
			};
			await core.createProposal(proposal6, false);

			result = await editProposalPlatformAware(
				{
					proposalId: "6",
					notes: "",
				},
				TEST_DIR,
			);
			if (result.exitCode !== 0)
				console.error("COMMAND FAILED stderr:", result.stderr);
			assert.strictEqual(result.exitCode, 0);

			updatedProposal = await core.filesystem.loadProposal("proposal-6");
			assert.notStrictEqual(updatedProposal, null);
			// Should not add Implementation Notes section for empty notes
			assert.ok(
				!updatedProposal?.rawContent?.includes("## Implementation Notes"),
			);
		});

		it("preserves nested H2 headings when migrating legacy implementation notes", async () => {
			const core = new Core(TEST_DIR);
			const proposal: Proposal = {
				id: "proposal-7",
				title: "Legacy Notes",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-03",
				labels: [],
				dependencies: [],
				rawContent:
					"Initial description\n\n## Implementation Notes\n\nSummary of work\n\n## Follow-up\n\nCapture additional findings",
			};
			await core.createProposal(proposal, false);

			const appendResult = execSync(
				`node --experimental-strip-types ${CLI_PATH} proposal edit 7 --append-notes "Added verification details"`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(appendResult.exitCode, 0);

			const updated = await core.filesystem.loadProposal("proposal-7");
			assert.notStrictEqual(updated, null);
			const body = updated?.rawContent || "";
			assert.ok(body.includes("<!-- SECTION:NOTES:BEGIN -->"));
			const notesContent =
				extractStructuredSection(body, "implementationNotes") || "";
			assert.ok(notesContent.includes("## Follow-up"));
			assert.ok(notesContent.includes("Summary of work"));
			assert.ok(notesContent.includes("Added verification details"));
		});
	});
});
