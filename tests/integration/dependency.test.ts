import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal } from "../../src/types/index.ts";
import { execSync } from "../support/test-utils.ts";

describe("Proposal Dependencies", () => {
	let tempDir: string;
	let core: Core;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "roadmap-dependency-test-"));

		// Initialize git repository first using the same pattern as other tests
		execSync(`git init -b main`, { cwd: tempDir });
		execSync(`git config user.name "Test User"`, { cwd: tempDir });
		execSync(`git config user.email test@example.com`, { cwd: tempDir });

		core = new Core(tempDir);
		await core.initializeProject("test-project");
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (error) {
			console.warn(`Failed to clean up temp directory: ${error}`);
		}
	});

	test("should create proposal with dependencies", async () => {
		// Create base proposals first
		const proposal1: Proposal = {
			id: "proposal-1",
			title: "Base Proposal 1",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Base proposal",
		};

		const proposal2: Proposal = {
			id: "proposal-2",
			title: "Base Proposal 2",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Another base proposal",
		};

		await core.createProposal(proposal1, false);
		await core.createProposal(proposal2, false);

		// Create proposal with dependencies
		const dependentProposal: Proposal = {
			id: "proposal-3",
			title: "Dependent Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: ["proposal-1", "proposal-2"],
			description: "Proposal that depends on others",
		};

		await core.createProposal(dependentProposal, false);

		// Verify the proposal was created with dependencies
		const savedProposal = await core.filesystem.loadProposal("proposal-3");
		assert.notStrictEqual(savedProposal, null);
		assert.deepStrictEqual(savedProposal?.dependencies, [
			"proposal-1",
			"proposal-2",
		]);
	});

	test("should update proposal dependencies", async () => {
		// Create base proposals
		const proposal1: Proposal = {
			id: "proposal-1",
			title: "Base Proposal 1",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Base proposal",
		};

		const proposal2: Proposal = {
			id: "proposal-2",
			title: "Base Proposal 2",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Another base proposal",
		};

		const proposal3: Proposal = {
			id: "proposal-3",
			title: "Proposal without dependencies",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Proposal without dependencies initially",
		};

		await core.createProposal(proposal1, false);
		await core.createProposal(proposal2, false);
		await core.createProposal(proposal3, false);

		// Update proposal to add dependencies
		await core.updateProposalFromInput(
			proposal3.id,
			{ dependencies: ["proposal-1", "proposal-2"] },
			false,
		);

		// Verify the dependencies were updated
		const savedProposal = await core.filesystem.loadProposal("proposal-3");
		assert.notStrictEqual(savedProposal, null);
		assert.deepStrictEqual(savedProposal?.dependencies, [
			"proposal-1",
			"proposal-2",
		]);
	});

	test("should handle proposals with dependencies in drafts", async () => {
		// Create a draft proposal
		const draftProposal: Proposal = {
			id: "proposal-1",
			title: "Draft Proposal",
			status: "Draft",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Draft proposal",
		};

		await core.createDraft(draftProposal, false);

		// Create proposal that depends on draft
		const proposal2: Proposal = {
			id: "proposal-2",
			title: "Proposal depending on draft",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: ["proposal-1"], // Depends on draft proposal
			description: "Proposal depending on draft",
		};

		await core.createProposal(proposal2, false);

		// Verify the proposal was created with dependency on draft
		const savedProposal = await core.filesystem.loadProposal("proposal-2");
		assert.notStrictEqual(savedProposal, null);
		assert.deepStrictEqual(savedProposal?.dependencies, ["proposal-1"]);
	});

	test("should serialize and deserialize dependencies correctly", async () => {
		const proposal: Proposal = {
			id: "proposal-1",
			title: "Proposal with multiple dependencies",
			status: "Active",
			assignee: ["@developer"],
			createdDate: "2024-01-01",
			labels: ["feature", "backend"],
			dependencies: ["proposal-2", "proposal-3", "proposal-4"],
			description: "Proposal with various metadata and dependencies",
		};

		// Create dependency proposals first
		for (let i = 2; i <= 4; i++) {
			const depProposal: Proposal = {
				id: `proposal-${i}`,
				title: `Dependency Proposal ${i}`,
				status: "Potential",
				assignee: [],
				createdDate: "2024-01-01",
				labels: [],
				dependencies: [],
				description: `Dependency proposal ${i}`,
			};
			await core.createProposal(depProposal, false);
		}

		await core.createProposal(proposal, false);

		// Load the proposal back and verify all fields
		const loadedProposal = await core.filesystem.loadProposal("proposal-1");
		assert.notStrictEqual(loadedProposal, null);
		assert.strictEqual(loadedProposal?.id, "proposal-1");
		assert.strictEqual(
			loadedProposal?.title,
			"Proposal with multiple dependencies",
		);
		assert.strictEqual(loadedProposal?.status, "Active");
		assert.deepStrictEqual(loadedProposal?.assignee, ["@developer"]);
		assert.deepStrictEqual(loadedProposal?.labels, ["feature", "backend"]);
		assert.deepStrictEqual(loadedProposal?.dependencies, [
			"proposal-2",
			"proposal-3",
			"proposal-4",
		]);
	});

	test("should handle empty dependencies array", async () => {
		const proposal: Proposal = {
			id: "proposal-1",
			title: "Proposal without dependencies",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Proposal without dependencies",
		};

		await core.createProposal(proposal, false);

		const loadedProposal = await core.filesystem.loadProposal("proposal-1");
		assert.notStrictEqual(loadedProposal, null);
		assert.deepStrictEqual(loadedProposal?.dependencies, []);
	});

	test("should sanitize archived proposal dependencies on active proposals only", async () => {
		const archivedTarget: Proposal = {
			id: "proposal-1",
			title: "Archive target",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Proposal that will be archived",
		};

		const activeDependent: Proposal = {
			id: "proposal-2",
			title: "Active dependent proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: ["proposal-1", "proposal-1"],
			description: "Depends on archive target",
		};

		const completedDependent: Proposal = {
			id: "proposal-3",
			title: "Completed dependent proposal",
			status: "Complete",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: ["proposal-1"],
			description: "Completed proposal should stay unchanged",
		};

		const childProposal: Proposal = {
			id: "proposal-4",
			title: "Child proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: ["proposal-1"],
			parentProposalId: "proposal-1",
			description:
				"Parent relationship is out of scope for archive sanitization",
		};

		await core.createProposal(archivedTarget, false);
		await core.createProposal(activeDependent, false);
		await core.createProposal(completedDependent, false);
		await core.createProposal(childProposal, false);
		await core.completeProposal("proposal-3", false);

		const archived = await core.archiveProposal("proposal-1", false);
		assert.strictEqual(archived, true);

		const updatedActive = await core.filesystem.loadProposal("proposal-2");
		const updatedChild = await core.filesystem.loadProposal("proposal-4");
		const completedProposals = await core.filesystem.listCompletedProposals();
		const completed = completedProposals.find(
			(proposal) => proposal.id === "proposal-3",
		);

		assert.deepStrictEqual(updatedActive?.dependencies, []);
		assert.deepStrictEqual(updatedChild?.dependencies, []);
		assert.strictEqual(updatedChild?.parentProposalId, "proposal-1");
		assert.deepStrictEqual(completed?.dependencies, ["proposal-1"]);
	});

	test("should sanitize archive links when archiving by numeric id with custom proposal prefix", async () => {
		const config = await core.filesystem.loadConfig();
		assert.notStrictEqual(config, null);
		if (!config) {
			return;
		}
		config.prefixes = { proposal: "back" };
		await core.filesystem.saveConfig(config);

		const { proposal: archiveTarget } = await core.createProposalFromInput({
			title: "Custom prefix target",
		});
		const { proposal: dependentProposal } = await core.createProposalFromInput({
			title: "Custom prefix dependent",
			dependencies: [archiveTarget.id],
		});

		const archived = await core.archiveProposal("1", false);
		assert.strictEqual(archived, true);

		const updatedDependent = await core.filesystem.loadProposal(
			dependentProposal.id,
		);
		assert.deepStrictEqual(updatedDependent?.dependencies, []);
	});

	test("should not sanitize draft dependencies when archiving", async () => {
		const archiveTarget: Proposal = {
			id: "proposal-1",
			title: "Archive target",
			status: "Potential",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: [],
			description: "Proposal that will be archived",
		};

		const draftProposal: Proposal = {
			id: "draft-1",
			title: "Draft dependent proposal",
			status: "Draft",
			assignee: [],
			createdDate: "2024-01-01",
			labels: [],
			dependencies: ["proposal-1"],
			description: "Draft should not be sanitized by archive cleanup",
		};

		await core.createProposal(archiveTarget, false);
		await core.createDraft(draftProposal, false);
		await core.archiveProposal("proposal-1", false);

		const draft = await core.filesystem.loadDraft("draft-1");
		assert.deepStrictEqual(draft?.dependencies, ["proposal-1"]);
	});
});
