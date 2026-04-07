/**
 * proposal-3: Ready Work Discovery Tests
 *
 * AC #1: CLI/MCP can list proposals ready for pickup (dependency + claim status)
 * AC #2: Ready-proposal evaluation is consistent across surfaces
 * AC #3: Tests cover blocked chains, complete deps, and no-ready-work edge cases
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("proposal-3: Ready Work Discovery", () => {
	let projectRoot: string;
	let core: Core;

	beforeEach(async () => {
		projectRoot = createUniqueTestDir("test-ready-work");
		core = new Core(projectRoot);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(projectRoot);
	});

	describe("AC #1: Ready proposals based on dependency and claim status", () => {
		it("should find ready proposals with all deps complete", async () => {
			const { proposal: dep } = await core.createProposalFromInput({
				title: "Dependency",
				status: "Complete",
			});
			const { proposal: ready } = await core.createProposalFromInput({
				title: "Ready Proposal",
				status: "Potential",
				dependencies: [dep.id],
			});

			const proposals = await core.queryProposals({ filters: { ready: true } });
			assert.ok(
				proposals.some((s) => s.id === ready.id),
				"Should find ready proposal",
			);
		});

		it("should exclude proposals with uncomplete dependencies", async () => {
			const { proposal: dep } = await core.createProposalFromInput({
				title: "Uncomplete Dep",
				status: "Potential",
			});
			const { proposal: blocked } = await core.createProposalFromInput({
				title: "Blocked Proposal",
				status: "Potential",
				dependencies: [dep.id],
			});

			const proposals = await core.queryProposals({ filters: { ready: true } });
			assert.ok(
				!proposals.some((s) => s.id === blocked.id),
				"Should NOT find blocked proposal",
			);
		});

		it("should exclude claimed proposals from ready pool", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Claimed Proposal",
				status: "Potential",
			});
			await core.claimProposal(proposal.id, "@agent-1", {
				durationMinutes: 30,
			});

			const proposals = await core.queryProposals({ filters: { ready: true } });
			assert.ok(
				!proposals.some((s) => s.id === proposal.id),
				"Should NOT find claimed proposal",
			);
		});
	});

	describe("AC #3: Edge cases", () => {
		it("should handle blocked dependency chains", async () => {
			// A -> B -> C (C is blocked because A is not complete)
			const { proposal: a } = await core.createProposalFromInput({
				title: "A",
				status: "Potential",
			});
			const { proposal: b } = await core.createProposalFromInput({
				title: "B",
				status: "Potential",
				dependencies: [a.id],
			});
			const { proposal: c } = await core.createProposalFromInput({
				title: "C",
				status: "Potential",
				dependencies: [b.id],
			});

			const ready = await core.queryProposals({ filters: { ready: true } });
			assert.ok(!ready.some((s) => s.id === c.id), "C should be blocked");
			assert.ok(!ready.some((s) => s.id === b.id), "B should be blocked");
		});

		it("should unblock proposal when dependency is complete", async () => {
			const { proposal: dep } = await core.createProposalFromInput({
				title: "Dep",
				status: "Potential",
			});
			const { proposal: child } = await core.createProposalFromInput({
				title: "Child",
				status: "Potential",
				dependencies: [dep.id],
			});

			// Initially blocked
			let ready = await core.queryProposals({ filters: { ready: true } });
			assert.ok(
				!ready.some((s) => s.id === child.id),
				"Should be blocked initially",
			);

			// Reach the dependency (need builder + auditor for audited maturity)
			await core.updateProposalFromInput(dep.id, {
				builder: "@builder",
				auditor: "@auditor",
				auditNotes: "Done",
				status: "Complete",
				maturity: "audited",
				addProof: ["test"],
				finalSummary: "Done",
			});

			// Now should be ready
			ready = await core.queryProposals({ filters: { ready: true } });
			assert.ok(
				ready.some((s) => s.id === child.id),
				"Should be ready after dep complete",
			);
		});

		it("should handle no ready work scenario", async () => {
			// All proposals blocked or complete
			const { proposal: s1 } = await core.createProposalFromInput({
				title: "Only1",
				status: "Potential",
			});

			// Query ready proposals - should find at least s1 if it has no deps
			const _ready = await core.queryProposals({ filters: { ready: true } });

			// Mark s1 as claimed to block it
			await core.claimProposal(s1.id, "@agent", { durationMinutes: 30 });

			const readyAfterClaim = await core.queryProposals({
				filters: { ready: true },
			});
			// s1 should not be ready because it's claimed
			assert.ok(
				!readyAfterClaim.some((s) => s.id === s1.id),
				"Claimed proposal should not be ready",
			);
		});
	});
});
