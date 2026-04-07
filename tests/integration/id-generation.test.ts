import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { serializeProposal } from "../../src/markdown/serializer.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

const TEST_DIR = join(tmpdir(), "roadmap-id-gen-test");

describe("Proposal ID Generation with Archives", () => {
	let core: Core;
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(TEST_DIR);
		core = new Core(testDir);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("should reuse IDs from archived proposals (soft delete behavior)", async () => {
		// Create proposals 1-5
		await core.createProposalFromInput({ title: "Proposal 1" }, false);
		await core.createProposalFromInput({ title: "Proposal 2" }, false);
		await core.createProposalFromInput({ title: "Proposal 3" }, false);
		await core.createProposalFromInput({ title: "Proposal 4" }, false);
		await core.createProposalFromInput({ title: "Proposal 5" }, false);

		// Archive all proposals
		await core.archiveProposal("proposal-1", false);
		await core.archiveProposal("proposal-2", false);
		await core.archiveProposal("proposal-3", false);
		await core.archiveProposal("proposal-4", false);
		await core.archiveProposal("proposal-5", false);

		// Verify proposals directory has no active proposals
		const activeProposals = await core.fs.listProposals();
		assert.strictEqual(activeProposals.length, 0);

		// Create new proposal - should be proposal-1 (archived IDs can be reused)
		const result = await core.createProposalFromInput(
			{ title: "Proposal After Archive" },
			false,
		);
		assert.strictEqual(result.proposal.id, "proposal-1");

		// Verify the proposal was created with correct ID
		const newProposal = await core.getProposal("proposal-1");
		assert.notStrictEqual(newProposal, null);
		assert.strictEqual(newProposal?.title, "Proposal After Archive");
	});

	it("should consider completed proposals but not archived proposals for ID generation", async () => {
		// Create proposals 1-3
		await core.createProposalFromInput(
			{ title: "Proposal 1", status: "Potential" },
			false,
		);
		await core.createProposalFromInput(
			{ title: "Proposal 2", status: "Potential" },
			false,
		);
		await core.createProposalFromInput(
			{ title: "Proposal 3", status: "Potential" },
			false,
		);

		// Archive proposal-1 (its ID can be reused)
		await core.archiveProposal("proposal-1", false);

		// Complete proposal-2 (moves to completed directory, ID cannot be reused)
		await core.completeProposal("proposal-2", false);

		// Keep proposal-3 active
		const activeProposals = await core.fs.listProposals();
		assert.strictEqual(activeProposals.length, 1);
		assert.strictEqual(activeProposals[0]?.id, "proposal-3");

		// Create new proposal - should be proposal-4 (max of active 3 + completed 2 is 3, so next is 4)
		// Note: archived proposal-1 is NOT considered, so its ID could be reused if 2 and 3 weren't taken
		const result = await core.createProposalFromInput(
			{ title: "Proposal 4" },
			false,
		);
		assert.strictEqual(result.proposal.id, "proposal-4");

		// Verify archived proposal still exists
		const archivedProposals = await core.fs.listArchivedProposals();
		expect(archivedProposals.some((t) => t.id === "proposal-1")).toBe(true);

		// Verify completed proposal still exists
		const completedProposals = await core.fs.listCompletedProposals();
		expect(completedProposals.some((t) => t.id === "proposal-2")).toBe(true);
	});

	it("should handle subproposals correctly with archived parents", async () => {
		// Create parent proposal-1
		await core.createProposalFromInput({ title: "Parent Proposal" }, false);

		// Create subproposals
		const subproposal1 = await core.createProposalFromInput(
			{ title: "Subproposal 1", parentProposalId: "proposal-1" },
			false,
		);
		const subproposal2 = await core.createProposalFromInput(
			{ title: "Subproposal 2", parentProposalId: "proposal-1" },
			false,
		);

		assert.strictEqual(subproposal1.proposal.id, "proposal-1.1");
		assert.strictEqual(subproposal2.proposal.id, "proposal-1.2");

		// Archive parent and all subproposals
		await core.archiveProposal("proposal-1", false);
		await core.archiveProposal("proposal-1.1", false);
		await core.archiveProposal("proposal-1.2", false);

		// Create new parent proposal - should be proposal-1 (reusing archived parent ID)
		const newParent = await core.createProposalFromInput(
			{ title: "New Parent" },
			false,
		);
		assert.strictEqual(newParent.proposal.id, "proposal-1");

		// Create subproposal of new parent (proposal-1) - should be proposal-1.1 (reusing archived subproposal ID)
		const newSubproposal = await core.createProposalFromInput(
			{ title: "New Subproposal", parentProposalId: "proposal-1" },
			false,
		);
		assert.strictEqual(newSubproposal.proposal.id, "proposal-1.1");
	});

	it("should work with zero-padded IDs and reuse archived IDs", async () => {
		// Update config to use zero-padded IDs
		const config = await core.fs.loadConfig();
		if (config) {
			config.zeroPaddedIds = 3;
			await core.fs.saveConfig(config);
		}

		// Create and archive proposals with padding
		await core.createProposalFromInput({ title: "Proposal 1" }, false);
		const proposal1 = await core.getProposal("proposal-001");
		assert.strictEqual(proposal1?.id, "proposal-001");

		await core.archiveProposal("proposal-001", false);

		// Create new proposal - should reuse archived ID (proposal-001)
		const result = await core.createProposalFromInput(
			{ title: "Proposal 2" },
			false,
		);
		assert.strictEqual(result.proposal.id, "proposal-001");
	});

	it("should detect existing subproposals with different casing (legacy data)", async () => {
		// Create parent proposal via Core (will be uppercase proposal-1)
		await core.createProposalFromInput({ title: "Parent Proposal" }, false);

		// Simulate legacy lowercase subproposal by directly writing to filesystem
		// This represents a file created before the uppercase ID change
		const proposalsDir = core.fs.proposalsDir;
		const legacySubproposal: Proposal = {
			id: "proposal-1.1", // Lowercase - legacy format
			title: "Legacy Subproposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			parentProposalId: "proposal-1",
		};
		const content = serializeProposal(legacySubproposal);
		await writeFile(
			join(proposalsDir, "proposal-1.1 - Legacy Subproposal.md"),
			content,
		);

		// Create new subproposal via Core - should detect the legacy subproposal and get proposal-1.2
		// BUG: Currently returns proposal-1.1 due to case-sensitive startsWith() check
		const newSubproposal = await core.createProposalFromInput(
			{ title: "New Subproposal", parentProposalId: "proposal-1" },
			false,
		);
		assert.strictEqual(newSubproposal.proposal.id, "proposal-1.2");
	});
});
