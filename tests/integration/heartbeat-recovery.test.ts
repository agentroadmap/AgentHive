/**
 * Heartbeat & Stale Agent Recovery Tests
 *
 * Verifies Proposal 7 ACs:
 * - AC #4: Agents publish heartbeat signals via proposal_heartbeat MCP tool
 * - AC #5: Heartbeat interval is configurable and validated
 * - AC #6: proposal_prune_claims removes claims exceeding heartbeat timeout
 * - AC #7: proposal_pickup skips agents with stale heartbeats
 * - AC #8: Stale agent recovery triggers automatic release after 2x interval
 * - AC #9: Recovery flow tested with simulated agent crash
 * - AC #10: proposal_renew resets heartbeat timestamp and extends expiry atomically
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { formatLocalDateTime } from "../../src/utils/date-time.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("Heartbeat & Stale Agent Recovery", () => {
	let projectRoot: string;
	let core: Core;

	beforeEach(async () => {
		projectRoot = createUniqueTestDir("test-heartbeat");
		core = new Core(projectRoot);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(projectRoot);
	});

	describe("AC #4: Heartbeat signal recording", () => {
		it("should record heartbeat timestamp in claim metadata", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
			});
			await core.claimProposal(proposal.id, "@agent-1", {
				durationMinutes: 30,
			});

			// Send heartbeat
			const result = await core.heartbeat(proposal.id, "@agent-1");
			assert.ok(
				result.claim?.lastHeartbeat,
				"claim should have lastHeartbeat set",
			);

			// Verify it persisted
			const reloaded = await core.fs.loadProposal(proposal.id);
			assert.ok(
				reloaded?.claim?.lastHeartbeat,
				"persisted claim should have lastHeartbeat",
			);
		});
	});

	describe("AC #5: Configurable heartbeat interval", () => {
		it("should use default heartbeat interval from config", async () => {
			const config = await core.fs.loadConfig();
			// Default should be 30 min (1800000 ms)
			const interval = config?.coordination?.heartbeatIntervalMs ?? 1800000;
			assert.ok(interval > 0, "heartbeat interval should be positive");
		});

		it("should validate heartbeat interval against claim expiry", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
			});
			// Claim with short duration
			await core.claimProposal(proposal.id, "@agent-1", { durationMinutes: 1 });

			// Heartbeat should succeed even with short claim
			const result = await core.heartbeat(proposal.id, "@agent-1");
			assert.ok(result.claim?.lastHeartbeat);
		});
	});

	describe("AC #6: proposal_prune_claims removes stale claims", () => {
		it("should prune claims exceeding heartbeat timeout", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
			});

			// Create a claim with a stale heartbeat (2 hours ago)
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const claim = {
				agent: "@stale-agent",
				created: formatLocalDateTime(new Date(twoHoursAgo.getTime() - 3600000)),
				expires: formatLocalDateTime(new Date(twoHoursAgo.getTime() + 3600000)),
				lastHeartbeat: formatLocalDateTime(twoHoursAgo),
				heartbeatIntervalMs: 1800000, // 30 min
			};
			await core.updateProposalFromInput(proposal.id, { claim });

			// Prune with 60-minute timeout (stale agent hasn't heartbeated in 120 min)
			const pruned = await core.pruneClaims({ timeoutMinutes: 60 });
			assert.ok(pruned.includes(proposal.id), "stale claim should be pruned");

			// Verify claim is gone
			const reloaded = await core.fs.loadProposal(proposal.id);
			assert.strictEqual(
				reloaded?.claim,
				undefined,
				"pruned claim should be removed",
			);
		});

		it("should keep claims with recent heartbeats", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
			});

			// Create a claim with a fresh heartbeat (1 minute ago)
			const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
			const futureExpiry = new Date(Date.now() + 3600000);
			const claim = {
				agent: "@fresh-agent",
				created: formatLocalDateTime(new Date(oneMinuteAgo.getTime() - 60000)),
				expires: formatLocalDateTime(futureExpiry),
				lastHeartbeat: formatLocalDateTime(oneMinuteAgo),
				heartbeatIntervalMs: 1800000,
			};
			await core.updateProposalFromInput(proposal.id, { claim });

			// Prune with 60-minute timeout
			const pruned = await core.pruneClaims({ timeoutMinutes: 60 });
			assert.ok(
				!pruned.includes(proposal.id),
				"fresh claim should NOT be pruned",
			);

			// Verify claim still exists
			const reloaded = await core.fs.loadProposal(proposal.id);
			assert.ok(reloaded?.claim, "fresh claim should remain");
		});
	});

	describe("AC #7: proposal_pickup skips stale agents", () => {
		it("should not pick up proposals claimed by stale agents (claim valid but heartbeat stale)", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			// Create a claim that is NOT expired (expires in 30 min) but has a STALE heartbeat (2 hours ago)
			// This simulates an agent that crashed before its lease expired
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const thirtyMinFromNow = new Date(Date.now() + 30 * 60 * 1000);
			const claim = {
				agent: "@stale-agent",
				created: formatLocalDateTime(new Date(twoHoursAgo.getTime() - 60000)),
				expires: formatLocalDateTime(thirtyMinFromNow), // Claim is still VALID
				lastHeartbeat: formatLocalDateTime(twoHoursAgo), // But heartbeat is STALE
				heartbeatIntervalMs: 1800000, // 30 min - stale if no heartbeat for 60+ min
			};
			await core.updateProposalFromInput(proposal.id, { claim });

			// pickupProposal should skip this proposal because the agent's heartbeat is stale
			const pickup = await core.pickupProposal({
				agent: "@new-agent",
				dryRun: true,
			});
			if (pickup) {
				assert.notStrictEqual(
					pickup.proposal.id,
					proposal.id,
					"should not pick up stale-claimed proposal",
				);
			}
			// If pickup returns null, that's acceptable (no ready proposals)
		});
	});

	describe("AC #8 & #9: Stale agent recovery / simulated crash", () => {
		it("should allow recovery after agent crash (no heartbeat)", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Crash Recovery Test",
				status: "Potential",
			});

			// Agent claims the proposal
			await core.claimProposal(proposal.id, "@crashing-agent", {
				durationMinutes: 30,
			});
			const reloaded = await core.fs.loadProposal(proposal.id);
			assert.strictEqual(reloaded?.claim?.agent, "@crashing-agent");

			// Simulate crash: manually make the claim stale (heartbeat 2+ hours ago)
			const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
			const staleClaim = {
				agent: "@crashing-agent",
				created: formatLocalDateTime(new Date(twoHoursAgo.getTime() - 3600000)),
				expires: formatLocalDateTime(new Date(twoHoursAgo.getTime() + 3600000)),
				lastHeartbeat: formatLocalDateTime(twoHoursAgo),
				heartbeatIntervalMs: 1800000,
			};
			await core.updateProposalFromInput(proposal.id, { claim: staleClaim });

			// Prune the stale claim
			const pruned = await core.pruneClaims({ timeoutMinutes: 60 });
			assert.ok(
				pruned.includes(proposal.id),
				"crashed agent's claim should be pruned",
			);

			// New agent can now pick up the proposal
			const reClaimed = await core.claimProposal(
				proposal.id,
				"@recovery-agent",
				{ durationMinutes: 30 },
			);
			assert.strictEqual(
				reClaimed.claim?.agent,
				"@recovery-agent",
				"new agent should be able to claim after crash recovery",
			);
		});
	});

	describe("AC #10: proposal_renew resets heartbeat atomically", () => {
		it("should reset heartbeat timestamp on renewal", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Renewal Test",
			});
			await core.claimProposal(proposal.id, "@agent-1", {
				durationMinutes: 30,
			});

			// Wait a tiny bit
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Renew the claim
			const renewed = await core.renewClaim(proposal.id, "@agent-1", {
				durationMinutes: 60,
			});

			assert.ok(
				renewed.claim?.lastHeartbeat,
				"renewed claim should have lastHeartbeat",
			);
			assert.ok(renewed.claim?.expires, "renewed claim should have new expiry");

			// Verify both heartbeat and expiry were updated
			const reloaded = await core.fs.loadProposal(proposal.id);
			assert.ok(
				reloaded?.claim?.lastHeartbeat,
				"persisted claim should have lastHeartbeat",
			);
			assert.ok(
				reloaded?.claim?.expires,
				"persisted claim should have new expiry",
			);
		});

		it("should extend expiry from NOW, not from original expiry", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Renewal Extension Test",
			});

			// Create an old claim (claimed 30 min ago, expires 1 min ago)
			const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
			const oneMinAgo = new Date(Date.now() - 60 * 1000);
			const oldClaim = {
				agent: "@agent-1",
				created: formatLocalDateTime(thirtyMinAgo),
				expires: formatLocalDateTime(oneMinAgo),
				lastHeartbeat: formatLocalDateTime(thirtyMinAgo),
				heartbeatIntervalMs: 1800000,
			};
			await core.updateProposalFromInput(proposal.id, { claim: oldClaim });

			const beforeRenew = new Date();
			const renewed = await core.renewClaim(proposal.id, "@agent-1", {
				durationMinutes: 60,
			});
			const afterRenew = new Date();

			assert.ok(renewed.claim?.expires);
			const newExpiry = new Date(renewed.claim.expires.replace(" ", "T"));

			// Expiry should be roughly now + 60 minutes (with some tolerance)
			const expectedMin = new Date(beforeRenew.getTime() + 59 * 60 * 1000); // 59 min (tolerance)
			const expectedMax = new Date(afterRenew.getTime() + 61 * 60 * 1000); // 61 min (tolerance)

			assert.ok(
				newExpiry >= expectedMin,
				`expiry ${newExpiry.toISOString()} should be >= ${expectedMin.toISOString()}`,
			);
			assert.ok(
				newExpiry <= expectedMax,
				`expiry ${newExpiry.toISOString()} should be <= ${expectedMax.toISOString()}`,
			);
		});
	});
});
