import assert from "node:assert";
import { mkdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("Pickup Atomicity", () => {
	let repoDir: string;

	beforeEach(async () => {
		repoDir = createUniqueTestDir("test-pickup-atomicity");
		await mkdir(repoDir, { recursive: true });
		const core = new Core(repoDir);
		await core.initializeProject("Pickup Test");

		// Create a few ready proposals
		await core.createProposalFromInput({
			title: "High Priority",
			priority: "high",
		});
		await core.createProposalFromInput({
			title: "Medium Priority",
			priority: "medium",
		});
		await core.createProposalFromInput({
			title: "Low Priority",
			priority: "low",
		});
	});

	afterEach(async () => {
		await safeCleanup(repoDir);
	});

	it("should pick the highest priority proposal", async () => {
		const core = new Core(repoDir);
		const result = await core.pickupProposal({ agent: "agent-1" });

		assert.ok(result, "Should pick up a proposal");
		assert.strictEqual(
			result.proposal.priority,
			"high",
			"Should pick the high priority proposal",
		);
		assert.strictEqual(
			result.proposal.claim?.agent,
			"agent-1",
			"Should be claimed by agent-1",
		);
	});

	it("should not pick up already claimed proposals", async () => {
		const core = new Core(repoDir);
		// Pick up all 3 proposals
		await core.pickupProposal({ agent: "agent-1" });
		await core.pickupProposal({ agent: "agent-2" });
		await core.pickupProposal({ agent: "agent-3" });

		const result = await core.pickupProposal({ agent: "agent-4" });
		assert.strictEqual(
			result,
			null,
			"Should not find any more ready proposals",
		);
	});

	it("should explain the choice in dry-run mode without claiming", async () => {
		const core = new Core(repoDir);
		const result = await core.pickupProposal({
			agent: "agent-1",
			dryRun: true,
		});

		assert.ok(result, "Should pick up a proposal in dry-run");
		assert.ok(
			result.explanation.includes("high"),
			"Explanation should mention high priority",
		);

		const refreshed = await core.getProposal(result.proposal.id);
		assert.ok(!refreshed?.claim, "Proposal should NOT be claimed in dry-run");
	});

	it("should handle concurrent pickup attempts using file locking", async () => {
		const core = new Core(repoDir);

		// Simulate two agents trying to pick up at the same time
		// Since we're in the same process, we can't easily test cross-process locking
		// but we can at least ensure the sequential calls work and don't double-claim.
		const promise1 = core.pickupProposal({ agent: "agent-1" });
		const promise2 = core.pickupProposal({ agent: "agent-2" });

		const [res1, res2] = await Promise.all([promise1, promise2]);

		assert.ok(
			res1 && res2,
			"Both should succeed in picking up different proposals",
		);
		assert.notStrictEqual(
			res1.proposal.id,
			res2.proposal.id,
			"Should have picked up different proposals",
		);

		const proposal1 = await core.getProposal(res1.proposal.id);
		const proposal2 = await core.getProposal(res2.proposal.id);

		assert.strictEqual(proposal1?.claim?.agent, "agent-1");
		assert.strictEqual(proposal2?.claim?.agent, "agent-2");
	});
});
