import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { proposalIdsEqual } from "../../src/utils/proposal-path.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("S129 Operations", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-s129");
		core = new Core(TEST_DIR);
		await core.filesystem.ensureRoadmapStructure();
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		await core.initializeProject("Test Project", true);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {}
	});

	it("should promote a proposal through statuses", async () => {
		const proposal: any = {
			id: "proposal-1",
			title: "Promote Me",
			status: "Potential",
			assignee: [],
			createdDate: "2026-03-29",
			labels: [],
			dependencies: [],
		};
		await core.filesystem.saveProposal(proposal);

		// Use lowercase for operations to match filesystem directly
		const promoted = await core.promoteProposal(
			"proposal-1",
			"test-agent",
			false,
		);
		assert.strictEqual(promoted.status, "Active");

		const promotedAgain = await core.promoteProposal(
			"proposal-1",
			"test-agent",
			false,
		);
		assert.strictEqual(promotedAgain.status, "Accepted");
	});

	it("should demote a proposal through statuses", async () => {
		const proposal: any = {
			id: "proposal-1",
			title: "Demote Me",
			status: "Accepted",
			assignee: [],
			createdDate: "2026-03-29",
			labels: [],
			dependencies: [],
		};
		await core.filesystem.saveProposal(proposal);

		const demoted = await core.demoteProposalProper(
			"proposal-1",
			"test-agent",
			false,
		);
		assert.strictEqual(demoted.status, "Active");
	});

	it("should update proposal priority", async () => {
		const proposal: any = {
			id: "proposal-1",
			title: "Priority Test",
			status: "Potential",
			assignee: [],
			createdDate: "2026-03-29",
			labels: [],
			dependencies: [],
		};
		await core.filesystem.saveProposal(proposal);

		const updated = await core.updatePriority(
			"proposal-1",
			"high",
			"test-agent",
			false,
		);
		assert.strictEqual(updated.priority, "high");
	});

	it("should merge two proposals", async () => {
		const s1: any = {
			id: "proposal-1",
			title: "Source",
			status: "Potential",
			assignee: [],
			createdDate: "2026-03-29",
			labels: [],
			dependencies: [],
			description: "Source Desc",
			implementationNotes: "Source Notes",
		};
		const s2: any = {
			id: "proposal-2",
			title: "Target",
			status: "Potential",
			assignee: [],
			createdDate: "2026-03-29",
			labels: [],
			dependencies: [],
			description: "Target Desc",
		};
		await core.filesystem.saveProposal(s1);
		await core.filesystem.saveProposal(s2);

		const merged = await core.mergeProposals(
			"proposal-1",
			"proposal-2",
			"test-agent",
			false,
		);
		assert.ok(proposalIdsEqual(merged.id, "proposal-2"));
		assert.ok(merged.implementationNotes?.includes("Source Desc"));
		assert.ok(merged.implementationNotes?.includes("Source Notes"));

		const sourceExists = await core.getProposal("proposal-1");
		assert.strictEqual(sourceExists, null);
	});

	it("should move a proposal within status columns", async () => {
		const s1: any = {
			id: "proposal-1",
			title: "Proposal 1",
			status: "Active",
			assignee: [],
			createdDate: "2026-03-29",
			labels: [],
			dependencies: [],
		};
		const s2: any = {
			id: "proposal-2",
			title: "Proposal 2",
			status: "Active",
			assignee: [],
			createdDate: "2026-03-29",
			labels: [],
			dependencies: [],
		};
		await core.filesystem.saveProposal(s1);
		await core.filesystem.saveProposal(s2);

		// Move proposal-1 to be after proposal-2 (index 1)
		const moved = await core.moveProposal(
			"proposal-1",
			"Active",
			1,
			"test-agent",
			false,
		);
		assert.ok(proposalIdsEqual(moved.id, "proposal-1"));

		const activeProposals = await core.queryProposals({ status: "Active" });
		assert.strictEqual(activeProposals.length, 2);
		const ids = activeProposals.map((s) => s.id);
		assert.ok(ids.some((id) => proposalIdsEqual(id, "proposal-1")));
		assert.ok(ids.some((id) => proposalIdsEqual(id, "proposal-2")));
	});
});
