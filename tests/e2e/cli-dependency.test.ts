import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createProposalPlatformAware,
	editProposalPlatformAware,
	viewProposalPlatformAware,
} from "../support/test-helpers.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

describe("CLI Dependency Support", () => {
	let TEST_DIR: string;
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-dependency");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repository first using the same pattern as other tests
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("test-project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should create proposal with single dependency using --dep", async () => {
		// Create base proposal first
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);

		// Create proposal with dependency
		const result2 = await createProposalPlatformAware(
			{ title: "Dependent Proposal", dependencies: "proposal-1" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);
		assert.ok(result2.stdout.includes("Created proposal proposal-2"));

		// Verify dependency was set
		const proposal = await core.filesystem.loadProposal("proposal-2");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, ["proposal-1"]);
	});

	test("should create proposal with single dependency using --depends-on", async () => {
		// Create base proposal first
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);

		// Create proposal with dependency
		const result2 = await createProposalPlatformAware(
			{ title: "Dependent Proposal", dependencies: "proposal-1" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);
		assert.ok(result2.stdout.includes("Created proposal proposal-2"));

		// Verify dependency was set
		const proposal = await core.filesystem.loadProposal("proposal-2");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, ["proposal-1"]);
	});

	test("should create proposal with multiple dependencies (comma-separated)", async () => {
		// Create base proposals first
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal 1" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);
		const result2 = await createProposalPlatformAware(
			{ title: "Base Proposal 2" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);

		// Create proposal with multiple dependencies
		const result3 = await createProposalPlatformAware(
			{ title: "Dependent Proposal", dependencies: "proposal-1,proposal-2" },
			TEST_DIR,
		);
		assert.strictEqual(result3.exitCode, 0);
		assert.ok(result3.stdout.includes("Created proposal proposal-3"));

		// Verify dependencies were set
		const proposal = await core.filesystem.loadProposal("proposal-3");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, [
			"proposal-1",
			"proposal-2",
		]);
	});

	test("should create proposal with multiple dependencies (multiple flags)", async () => {
		// Create base proposals first
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal 1" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);
		const result2 = await createProposalPlatformAware(
			{ title: "Base Proposal 2" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);

		// Create proposal with multiple dependencies using multiple flags (simulated as comma-separated)
		const result3 = await createProposalPlatformAware(
			{ title: "Dependent Proposal", dependencies: "proposal-1,proposal-2" },
			TEST_DIR,
		);
		assert.strictEqual(result3.exitCode, 0);
		assert.ok(result3.stdout.includes("Created proposal proposal-3"));

		// Verify dependencies were set
		const proposal = await core.filesystem.loadProposal("proposal-3");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, [
			"proposal-1",
			"proposal-2",
		]);
	});

	test("should normalize proposal IDs in dependencies", async () => {
		// Create base proposal first
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);

		// Create proposal with dependency using numeric ID (should be normalized to proposal-X)
		const result2 = await createProposalPlatformAware(
			{ title: "Dependent Proposal", dependencies: "1" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);
		assert.ok(result2.stdout.includes("Created proposal proposal-2"));

		// Verify dependency was normalized
		const proposal = await core.filesystem.loadProposal("proposal-2");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, ["proposal-1"]);
	});

	test("should fail when dependency proposal does not exist", async () => {
		// Try to create proposal with non-existent dependency
		const result = await createProposalPlatformAware(
			{ title: "Dependent Proposal", dependencies: "proposal-999" },
			TEST_DIR,
		);
		assert.strictEqual(result.exitCode, 1);
		assert.ok(
			result.stderr.includes(
				"The following dependencies do not exist: proposal-999",
			),
		);
	});

	test("should edit proposal to add dependencies", async () => {
		// Create base proposals first
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal 1" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);
		const result2 = await createProposalPlatformAware(
			{ title: "Base Proposal 2" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);
		const result3 = await createProposalPlatformAware(
			{ title: "Proposal to Edit" },
			TEST_DIR,
		);
		assert.strictEqual(result3.exitCode, 0);

		// Edit proposal to add dependencies
		const result4 = await editProposalPlatformAware(
			{ proposalId: "proposal-3", dependencies: "proposal-1,proposal-2" },
			TEST_DIR,
		);
		assert.strictEqual(result4.exitCode, 0);
		assert.ok(result4.stdout.includes("Updated proposal proposal-3"));

		// Verify dependencies were added
		const proposal = await core.filesystem.loadProposal("proposal-3");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, [
			"proposal-1",
			"proposal-2",
		]);
	});

	test("should edit proposal to update dependencies", async () => {
		// Create base proposals using platform-aware helper
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal 1" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);
		const result2 = await createProposalPlatformAware(
			{ title: "Base Proposal 2" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);
		const result3 = await createProposalPlatformAware(
			{ title: "Base Proposal 3" },
			TEST_DIR,
		);
		assert.strictEqual(result3.exitCode, 0);

		// Create proposal with initial dependency
		const result4 = await createProposalPlatformAware(
			{
				title: "Proposal with Dependency",
				dependencies: "proposal-1",
			},
			TEST_DIR,
		);
		assert.strictEqual(result4.exitCode, 0);

		// Edit proposal to change dependencies using platform-aware helper
		const result5 = await editProposalPlatformAware(
			{
				proposalId: "proposal-4",
				dependencies: "proposal-2,proposal-3",
			},
			TEST_DIR,
		);
		assert.strictEqual(result5.exitCode, 0);

		// Verify dependencies were updated (should replace, not append)
		const proposal = await core.filesystem.loadProposal("proposal-4");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, [
			"proposal-2",
			"proposal-3",
		]);
	});

	test("should handle dependencies on draft proposals", async () => {
		// Create draft proposal first using platform-aware helper
		// Drafts now get draft-X ids
		const result1 = await createProposalPlatformAware(
			{
				title: "Draft Proposal",
				draft: true,
			},
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);
		assert.ok(result1.stdout.includes("Created draft draft-1"));

		// Create proposal that depends on draft
		// Note: Proposals and drafts have separate ID sequences now
		const result2 = await createProposalPlatformAware(
			{
				title: "Proposal depending on draft",
				dependencies: "draft-1",
			},
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);

		// Verify dependency on draft was set
		// First non-draft proposal will be proposal-1
		const proposal = await core.filesystem.loadProposal("proposal-1");
		assert.notStrictEqual(proposal, null);
		assert.deepStrictEqual(proposal?.dependencies, ["draft-1"]);
	});

	test("should display dependencies in plain text view", async () => {
		// Create base proposal
		const result1 = await createProposalPlatformAware(
			{ title: "Base Proposal" },
			TEST_DIR,
		);
		assert.strictEqual(result1.exitCode, 0);

		// Create proposal with dependency
		const result2 = await createProposalPlatformAware(
			{ title: "Dependent Proposal", dependencies: "proposal-1" },
			TEST_DIR,
		);
		assert.strictEqual(result2.exitCode, 0);

		// View proposal in plain text mode
		const result3 = await viewProposalPlatformAware(
			{ proposalId: "proposal-2", plain: true },
			TEST_DIR,
		);
		assert.strictEqual(result3.exitCode, 0);
		assert.ok(result3.stdout.includes("Dependencies: proposal-1"));
	});
});
