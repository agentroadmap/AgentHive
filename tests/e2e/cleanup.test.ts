import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Cleanup functionality", () => {
	let core: Core;

	// Sample data
	const sampleProposal: Proposal = {
		id: "proposal-1",
		title: "Test Proposal",
		status: "Complete",
		assignee: [],
		createdDate: "2025-07-21",
		labels: [],
		dependencies: [],
		rawContent: "Test proposal description",
	};

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cleanup");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize roadmap project
		core = new Core(TEST_DIR);
		await core.initializeProject("Cleanup Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("Core functionality", () => {
		it("should create completed directory in roadmap structure", async () => {
			await core.filesystem.ensureRoadmapStructure();
			assert.strictEqual(
				core.filesystem.completedDir,
				join(TEST_DIR, "roadmap", "completed"),
			);
		});

		it("should move Complete proposal to completed folder", async () => {
			// Create a proposal
			await core.createProposal(sampleProposal, false);

			// Verify proposal exists in active proposals
			const activeProposals = await core.filesystem.listProposals();
			assert.strictEqual(activeProposals.length, 1);
			assert.strictEqual(activeProposals[0]?.id, "proposal-1");

			// Move to completed
			const success = await core.completeProposal("proposal-1", false);
			assert.strictEqual(success, true);

			// Verify proposal is no longer in active proposals
			const activeProposalsAfter = await core.filesystem.listProposals();
			assert.strictEqual(activeProposalsAfter.length, 0);

			// Verify proposal is in completed proposals
			const completedProposals = await core.filesystem.listCompletedProposals();
			assert.strictEqual(completedProposals.length, 1);
			assert.strictEqual(completedProposals[0]?.id, "proposal-1");
			assert.strictEqual(completedProposals[0]?.title, "Test Proposal");
		});
	});

	describe("getCompleteProposalsByAge", () => {
		it("should filter Complete proposals by age", async () => {
			// Create old Complete proposal (7 days ago)
			const oldDate = new Date();
			oldDate.setDate(oldDate.getDate() - 7);
			const oldProposal: Proposal = {
				...sampleProposal,
				title: "Old Complete Proposal",
				createdDate: oldDate.toISOString().split("T")[0] as string,
				updatedDate: oldDate.toISOString().split("T")[0] as string,
				rawContent: "Old proposal description",
			};
			await core.createProposal(oldProposal, false);

			// Create recent Complete proposal (1 day ago)
			const recentDate = new Date();
			recentDate.setDate(recentDate.getDate() - 1);
			const recentProposal: Proposal = {
				...sampleProposal,
				id: "proposal-2",
				title: "Recent Complete Proposal",
				createdDate: recentDate.toISOString().split("T")[0] as string,
				updatedDate: recentDate.toISOString().split("T")[0] as string,
				rawContent: "Recent proposal description",
			};
			await core.createProposal(recentProposal, false);

			// Create Active proposal
			const activeProposal: Proposal = {
				...sampleProposal,
				id: "proposal-3",
				title: "Active Proposal",
				status: "Active",
				createdDate: oldDate.toISOString().split("T")[0] as string,
				rawContent: "Active proposal description",
			};
			await core.createProposal(activeProposal, false);

			// Get proposals older than 3 days
			const oldProposals = await core.getCompleteProposalsByAge(3);
			assert.strictEqual(oldProposals.length, 1);
			assert.strictEqual(oldProposals[0]?.id, "proposal-1");

			// Get proposals older than 0 days (should include recent proposal too)
			const allCompleteProposals = await core.getCompleteProposalsByAge(0);
			assert.strictEqual(allCompleteProposals.length, 2);
		});

		it("should handle proposals without dates", async () => {
			const proposal: Proposal = {
				...sampleProposal,
				title: "Proposal Without Date",
				createdDate: "",
				rawContent: "Proposal description",
			};
			await core.createProposal(proposal, false);

			const oldProposals = await core.getCompleteProposalsByAge(1);
			assert.strictEqual(oldProposals.length, 0); // Should not include proposals without valid dates
		});

		it("should use updatedDate over createdDate when available", async () => {
			const oldDate = new Date();
			oldDate.setDate(oldDate.getDate() - 10);
			const recentDate = new Date();
			recentDate.setDate(recentDate.getDate() - 1);

			const proposal: Proposal = {
				id: "proposal-1",
				title: "Proposal with Both Dates",
				status: "Complete",
				assignee: [],
				createdDate: oldDate.toISOString().split("T")[0] as string,
				updatedDate: recentDate.toISOString().split("T")[0] as string,
				labels: [],
				dependencies: [],
				rawContent: "Proposal description",
			};
			await core.createProposal(proposal, false);

			// Should use updatedDate (recent) not createdDate (old)
			const oldProposals = await core.getCompleteProposalsByAge(5);
			assert.strictEqual(oldProposals.length, 0); // updatedDate is recent, so not old enough

			const recentProposals = await core.getCompleteProposalsByAge(0);
			assert.strictEqual(recentProposals.length, 1); // updatedDate makes it recent
		});
	});

	describe("Error handling", () => {
		it("should handle non-existent proposal gracefully", async () => {
			const success = await core.completeProposal("non-existent", false);
			assert.strictEqual(success, false);
		});

		it("should return empty array for listCompletedProposals when no completed proposals exist", async () => {
			const completedProposals = await core.filesystem.listCompletedProposals();
			assert.strictEqual(completedProposals.length, 0);
		});
	});
});
