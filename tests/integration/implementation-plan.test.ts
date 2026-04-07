import assert from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createProposalPlatformAware,
	editProposalPlatformAware,
} from "../support/test-helpers.ts";
import {
	buildCliCommand,
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Implementation Plan CLI", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-plan");
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Implementation Plan Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("proposal create with implementation plan", () => {
		it("should handle all proposal creation scenarios with implementation plans", async () => {
			// Test 1: create proposal with implementation plan using --plan
			const result1 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 1", "--plan", "Step 1: Analyze\nStep 2: Implement"])}`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result1.exitCode, 0);

			const core = new Core(TEST_DIR);
			let proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Implementation Plan"));
			assert.ok(proposal?.rawContent?.includes("Step 1: Analyze"));
			assert.ok(proposal?.rawContent?.includes("Step 2: Implement"));

			// Test 2: create proposal with both description and implementation plan
			const result2 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 2", "-d", "Proposal description", "--plan", "1. First step\n2. Second step"])}`,
				{ cwd: TEST_DIR },
			);
			assert.strictEqual(result2.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-2");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Description"));
			assert.ok(proposal?.rawContent?.includes("Proposal description"));
			assert.ok(proposal?.rawContent?.includes("## Implementation Plan"));
			assert.ok(proposal?.rawContent?.includes("1. First step"));
			assert.ok(proposal?.rawContent?.includes("2. Second step"));

			// Test 3: create proposal with acceptance criteria and implementation plan
			const result = await createProposalPlatformAware(
				{
					title: "Test Proposal 3",
					ac: "Must work correctly, Must be tested",
					plan: "Phase 1: Setup\nPhase 2: Testing",
				},
				TEST_DIR,
			);

			if (result.exitCode !== 0) {
				console.error("CLI Error:", result.stderr || result.stdout);
				console.error("Exit code:", result.exitCode);
			}
			assert.strictEqual(result.exitCode, 0);

			proposal = await core.filesystem.loadProposal(
				result.proposalId || "proposal-3",
			);
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Acceptance Criteria"));
			assert.ok(
				proposal?.rawContent?.includes(
					"- [ ] #1 Must work correctly, Must be tested",
				),
			);
			assert.ok(proposal?.rawContent?.includes("## Implementation Plan"));
			assert.ok(proposal?.rawContent?.includes("Phase 1: Setup"));
			assert.ok(proposal?.rawContent?.includes("Phase 2: Testing"));
		});
	});

	describe("proposal edit with implementation plan", () => {
		beforeEach(async () => {
			const core = new Core(TEST_DIR);
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Existing Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-19",
					labels: [],
					dependencies: [],
					rawContent: "## Description\n\nExisting proposal description",
				},
				false,
			);
		});

		it("should handle all proposal editing scenarios with implementation plans", async () => {
			// Test 1: add implementation plan to existing proposal
			const result1 = await editProposalPlatformAware(
				{ proposalId: "1", plan: "New plan:\n- Step A\n- Step B" },
				TEST_DIR,
			);
			assert.strictEqual(result1.exitCode, 0);

			const core = new Core(TEST_DIR);
			let proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Description"));
			assert.ok(
				proposal?.rawContent?.includes("Existing proposal description"),
			);
			assert.ok(proposal?.rawContent?.includes("## Implementation Plan"));
			assert.ok(proposal?.rawContent?.includes("New plan:"));
			assert.ok(proposal?.rawContent?.includes("- Step A"));
			assert.ok(proposal?.rawContent?.includes("- Step B"));

			// Test 2: replace existing implementation plan
			// First add an old plan via structured field (serializer will compose)
			await core.updateProposalFromInput(
				"proposal-1",
				{ implementationPlan: "Old plan:\n1. Old step 1\n2. Old step 2" },
				false,
			);

			// Now update with new plan
			const result2 = await editProposalPlatformAware(
				{
					proposalId: "1",
					plan: "Updated plan:\n1. New step 1\n2. New step 2",
				},
				TEST_DIR,
			);
			assert.strictEqual(result2.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.ok(proposal?.rawContent?.includes("## Implementation Plan"));
			assert.ok(proposal?.rawContent?.includes("Updated plan:"));
			assert.ok(proposal?.rawContent?.includes("1. New step 1"));
			assert.ok(proposal?.rawContent?.includes("2. New step 2"));
			assert.ok(!proposal?.rawContent?.includes("Old plan:"));
			assert.ok(!proposal?.rawContent?.includes("Old step 1"));

			// Test 3: update both title and implementation plan
			const result = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "1", "--title", "Updated Title", "--plan", "Implementation:\n- Do this\n- Then that"])}`,
				{ cwd: TEST_DIR },
			);

			if (result.exitCode !== 0) {
				console.error(
					"CLI Error:",
					result.stderr.toString() || result.stdout.toString(),
				);
				console.error("Exit code:", result.exitCode);
			}
			assert.strictEqual(result.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);
			assert.strictEqual(proposal?.title, "Updated Title");
			assert.ok(proposal?.rawContent?.includes("## Implementation Plan"));
			assert.ok(proposal?.rawContent?.includes("Implementation:"));
			assert.ok(proposal?.rawContent?.includes("- Do this"));
			assert.ok(proposal?.rawContent?.includes("- Then that"));
		});
	});

	describe("implementation plan positioning", () => {
		it("should handle implementation plan positioning and edge cases", async () => {
			// Test 1: place implementation plan after acceptance criteria when both exist
			const result1 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal", "-d", "Description text", "--ac", "Criterion 1", "--plan", "Plan text"])}`,
				{ cwd: TEST_DIR },
			);

			if (result1.exitCode !== 0) {
				console.error(
					"CLI Error:",
					result1.stderr.toString() || result1.stdout.toString(),
				);
				console.error("Exit code:", result1.exitCode);
			}
			assert.strictEqual(result1.exitCode, 0);

			const core = new Core(TEST_DIR);
			let proposal = await core.filesystem.loadProposal("proposal-1");
			assert.notStrictEqual(proposal, null);

			const description = proposal?.rawContent || "";
			const descIndex = description.indexOf("## Description");
			const acIndex = description.indexOf("## Acceptance Criteria");
			const planIndex = description.indexOf("## Implementation Plan");

			// Verify order: Description -> Acceptance Criteria -> Implementation Plan
			assert.ok(descIndex < acIndex);
			assert.ok(acIndex < planIndex);

			// Test 2: create proposal without plan (should not add the section)
			const result2 = execSync(
				`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "create", "Test Proposal 2"])}`,
				{ cwd: TEST_DIR },
			);

			if (result2.exitCode !== 0) {
				console.error(
					"CLI Error:",
					result2.stderr.toString() || result2.stdout.toString(),
				);
				console.error("Exit code:", result2.exitCode);
			}
			assert.strictEqual(result2.exitCode, 0);

			proposal = await core.filesystem.loadProposal("proposal-2");
			assert.notStrictEqual(proposal, null);
			// Should NOT add the section when no plan is provided
			assert.ok(!proposal?.rawContent?.includes("## Implementation Plan"));
		});
	});
});
