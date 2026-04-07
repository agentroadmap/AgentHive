import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { formatLocalDateTime } from "../../src/utils/date-time.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("Proposal Claiming", () => {
	let projectRoot: string;
	let core: Core;

	beforeEach(async () => {
		projectRoot = createUniqueTestDir("test-claiming");
		core = new Core(projectRoot);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(projectRoot);
	});

	it("should claim a proposal", async () => {
		const { proposal } = await core.createProposalFromInput({
			title: "Test Proposal",
		});
		const claimed = await core.claimProposal(proposal.id, "@agent-1", {
			durationMinutes: 30,
		});

		assert.strictEqual(claimed.claim?.agent, "@agent-1");
		assert.ok(claimed.claim.expires);
		assert.ok(claimed.claim.created);

		// Verify it's saved to disk
		const reloaded = await core.fs.loadProposal(proposal.id);
		assert.strictEqual(reloaded?.claim?.agent, "@agent-1");
	});

	it("should not allow claiming an already claimed proposal by another agent", async () => {
		const { proposal } = await core.createProposalFromInput({
			title: "Test Proposal",
		});
		await core.claimProposal(proposal.id, "@agent-1", { durationMinutes: 30 });

		try {
			await core.claimProposal(proposal.id, "@agent-2", {
				durationMinutes: 30,
			});
			assert.fail("Should have thrown error");
		} catch (err) {
			assert.ok((err as Error).message.includes("already claimed by @agent-1"));
		}
	});

	it("should allow claiming if force is used", async () => {
		const { proposal } = await core.createProposalFromInput({
			title: "Test Proposal",
		});
		await core.claimProposal(proposal.id, "@agent-1", { durationMinutes: 30 });

		const claimed = await core.claimProposal(proposal.id, "@agent-2", {
			durationMinutes: 30,
			force: true,
		});
		assert.strictEqual(claimed.claim?.agent, "@agent-2");
	});

	it("should allow claiming if previous claim expired", async () => {
		const { proposal } = await core.createProposalFromInput({
			title: "Test Proposal",
		});

		// Manually create an expired claim
		const past = new Date(Date.now() - 3600000); // 1 hour ago
		const claim = {
			agent: "@agent-1",
			created: formatLocalDateTime(new Date(past.getTime() - 3600000)),
			expires: formatLocalDateTime(past),
		};
		await core.updateProposalFromInput(proposal.id, { claim });

		const claimed = await core.claimProposal(proposal.id, "@agent-2", {
			durationMinutes: 30,
		});
		assert.strictEqual(claimed.claim?.agent, "@agent-2");
	});

	it("should release a claim", async () => {
		const { proposal } = await core.createProposalFromInput({
			title: "Test Proposal",
		});
		await core.claimProposal(proposal.id, "@agent-1", { durationMinutes: 30 });

		const released = await core.releaseClaim(proposal.id, "@agent-1");
		assert.strictEqual(released.claim, undefined);

		const reloaded = await core.fs.loadProposal(proposal.id);
		assert.strictEqual(reloaded?.claim, undefined);
	});

	it("should renew a claim", async () => {
		const { proposal } = await core.createProposalFromInput({
			title: "Test Proposal",
		});
		const claimed = await core.claimProposal(proposal.id, "@agent-1", {
			durationMinutes: 30,
		});
		const originalExpires = claimed.claim?.expires;

		// Renew extends from NOW
		const renewed = await core.renewClaim(proposal.id, "@agent-1", {
			durationMinutes: 60,
		});
		assert.strictEqual(renewed.claim?.agent, "@agent-1");
		assert.notStrictEqual(renewed.claim?.expires, originalExpires);
	});

	it("should consider claimed proposals as not ready for pickup", async () => {
		const { proposal } = await core.createProposalFromInput({
			title: "Test Proposal",
			status: "Potential",
		});

		// Initially ready
		const readyProposalsBefore = await core.queryProposals({
			filters: { ready: true },
		});
		assert.ok(readyProposalsBefore.some((s) => s.id === proposal.id));

		// Claim it
		await core.claimProposal(proposal.id, "@agent-1", { durationMinutes: 30 });

		// Now not ready
		const readyProposalsAfter = await core.queryProposals({
			filters: { ready: true },
		});
		assert.ok(!readyProposalsAfter.some((s) => s.id === proposal.id));
	});
});
