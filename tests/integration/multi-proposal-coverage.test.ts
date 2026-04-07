/**
 * Multi-Proposal Coverage Tests (Fixed)
 *
 * Tests for proposals with no prior test coverage:
 * - proposal-28: Executable Verification Proposalments Contract
 * - proposal-29: Peer Tester Audit Workflow
 * - proposal-33: DAG Connectivity Enforcement & Orphan Detection
 * - proposal-36: Token-Efficient Plain Output
 */

import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("Multi-Proposal Coverage Tests", () => {
	let projectRoot: string;
	let core: Core;

	beforeEach(async () => {
		projectRoot = createUniqueTestDir("test-multi-proposal");
		core = new Core(projectRoot);
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		await safeCleanup(projectRoot);
	});

	// ==========================================
	// proposal-28: Executable Verification Proposalments
	// ==========================================
	describe("proposal-28: Executable Verification Proposalments Contract", () => {
		it("AC #1: Proposals can store verification proposalments separately from ACs", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			await core.updateProposalFromInput(proposal.id, {
				addVerificationProposalments: [
					{ text: "Unit tests pass", role: "builder" },
					{ text: "Integration tests pass", role: "peer-tester" },
				],
			});

			const updated = await core.getProposal(proposal.id);
			assert.ok(
				updated?.verificationProposalments,
				"Proposal should have verification proposalments",
			);
			assert.strictEqual(updated?.verificationProposalments?.length, 2);
		});

		it("AC #2: Verification proposalments can declare expected evidence and role", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			await core.updateProposalFromInput(proposal.id, {
				addVerificationProposalments: [
					{
						text: "All ACs verified",
						role: "peer-tester",
						evidence: "test-results.log",
					},
				],
			});

			const updated = await core.getProposal(proposal.id);
			const vs = updated?.verificationProposalments?.[0];
			assert.ok(vs, "Verification proposalment should exist");
			assert.strictEqual(vs.role, "peer-tester");
			assert.ok(
				vs.evidence?.includes("test-results.log") ||
					vs.evidence === "test-results.log",
			);
		});

		it("AC #3: Verification proposalments translate visionary claims into assertions", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Auth System",
				status: "Potential",
			});

			await core.updateProposalFromInput(proposal.id, {
				addVerificationProposalments: [
					{
						text: "OAuth flow completes within 500ms",
						role: "builder",
						checked: true,
					},
				],
			});

			const updated = await core.getProposal(proposal.id);
			const vs = updated?.verificationProposalments?.[0] as any;
			assert.ok(vs, "Verification proposalment should exist");
			assert.ok(
				vs.text?.includes("500ms") || vs.proposalment?.includes("500ms"),
				"Proposalment should contain specific assertion",
			);
		});

		it("AC #4: Verification proposalments visible in proposal data", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			await core.updateProposalFromInput(proposal.id, {
				addVerificationProposalments: [
					{ text: "Tests pass", role: "builder", evidence: "test.log" },
				],
			});

			const updated = await core.getProposal(proposal.id);
			assert.ok(
				updated?.verificationProposalments,
				"Verification should be visible",
			);
			assert.strictEqual(
				updated?.verificationProposalments?.[0].role,
				"builder",
			);
		});
	});

	// ==========================================
	// proposal-29: Peer Tester Audit Workflow
	// ==========================================
	describe("proposal-29: Peer Tester Audit Workflow", () => {
		it("AC #1: Builder can request peer audit with proof attached", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			await core.updateProposalFromInput(proposal.id, {
				builder: "@builder",
				addProof: ["unit tests passed"],
			});

			const updated = await core.getProposal(proposal.id);
			assert.strictEqual(updated?.builder, "@builder");
			assert.ok(updated?.proof?.length, "Should have proof");
		});

		it("AC #2: Peer tester can record review notes and verdict", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			await core.updateProposalFromInput(proposal.id, {
				builder: "@builder",
				auditor: "@peer-tester",
				auditNotes: "Reviewed all code and tests. Approved.",
				maturity: "audited",
			});

			const updated = await core.getProposal(proposal.id);
			assert.strictEqual(updated?.auditor, "@peer-tester");
			assert.ok(updated?.auditNotes?.includes("Approved"));
			assert.strictEqual(updated?.maturity, "audited");
		});

		it("AC #3: Workflow blocks builder self-certification", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			await assert.rejects(
				() =>
					core.updateProposalFromInput(proposal.id, {
						builder: "@same-person",
						auditor: "@same-person",
						auditNotes: "Self-approved",
						maturity: "audited",
					}),
				/Peer Audit requires distinct agents/i,
			);
		});

		it("AC #4: Builder and peer roles stored distinctly", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
			});

			// Set builder and auditor first
			await core.updateProposalFromInput(proposal.id, {
				builder: "@builder",
				auditor: "@peer",
				auditNotes: "Peer review complete",
			});

			// Add verification proposalments with checked=true
			await core.updateProposalFromInput(proposal.id, {
				addVerificationProposalments: [
					{
						text: "Self-test",
						role: "builder",
						evidence: "builder.log",
						checked: true,
					},
					{
						text: "Peer-test",
						role: "peer-tester",
						evidence: "peer.log",
						checked: true,
					},
				],
			});

			// Now set maturity to audited
			await core.updateProposalFromInput(proposal.id, {
				maturity: "audited",
			});

			const updated = await core.getProposal(proposal.id);
			const builderVerifications = updated?.verificationProposalments?.filter(
				(v: any) => v.role === "builder",
			);
			const peerVerifications = updated?.verificationProposalments?.filter(
				(v: any) => v.role === "peer-tester",
			);
			assert.ok(
				builderVerifications?.length,
				"Should have builder verification",
			);
			assert.ok(peerVerifications?.length, "Should have peer verification");
		});
	});

	// ==========================================
	// proposal-33: DAG Connectivity Enforcement
	// ==========================================
	describe("proposal-33: DAG Connectivity Enforcement & Orphan Detection", () => {
		it("AC #1: Identify orphan proposals (no deps, no descendants)", async () => {
			const { proposal: orphan } = await core.createProposalFromInput({
				title: "Orphan",
				status: "Potential",
			});

			const { proposal: parent } = await core.createProposalFromInput({
				title: "Parent",
				status: "Potential",
			});
			const { proposal: child } = await core.createProposalFromInput({
				title: "Child",
				status: "Potential",
			});
			await core.updateProposalFromInput(child.id, {
				dependencies: [parent.id],
			});

			const proposals = await core.queryProposals({
				includeCrossBranch: false,
			});
			const hasDeps = new Set(
				proposals
					.filter((s) => s.dependencies?.length)
					.flatMap((s) => s.dependencies!),
			);
			const orphans = proposals.filter(
				(s) => !s.dependencies?.length && !hasDeps.has(s.id),
			);
			assert.ok(
				orphans.some((o) => o.id === orphan.id),
				"Should detect orphan",
			);
		});

		it("AC #2: Identify dead ends (complete with no dependents)", async () => {
			const { proposal: deadEnd } = await core.createProposalFromInput({
				title: "Dead End",
				status: "Complete",
			});
			const { proposal: parent } = await core.createProposalFromInput({
				title: "Parent",
				status: "Potential",
			});
			const { proposal: child } = await core.createProposalFromInput({
				title: "Child",
				status: "Potential",
			});
			await core.updateProposalFromInput(child.id, {
				dependencies: [parent.id],
			});

			const proposals = await core.queryProposals({
				includeCrossBranch: false,
			});
			const hasDependents = new Set(
				proposals
					.filter((s) => s.dependencies?.length)
					.flatMap((s) => s.dependencies!),
			);
			const deadEnds = proposals.filter(
				(s) => isComplete(s.status) && !hasDependents.has(s.id),
			);
			assert.ok(
				deadEnds.some((d) => d.id === deadEnd.id),
				"Should detect dead end",
			);
		});

		it("AC #3: Proposal creation without dependencies succeeds", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Initial",
				status: "Potential",
			});
			assert.ok(proposal, "Proposal creation should succeed");
			assert.ok(!proposal.dependencies || proposal.dependencies.length === 0);
		});

		it("AC #4: Proposals with dependencies are properly linked", async () => {
			const { proposal: dep } = await core.createProposalFromInput({
				title: "Dependency",
				status: "Potential",
			});
			const { proposal: dependent } = await core.createProposalFromInput({
				title: "Dependent",
				status: "Potential",
			});

			await core.updateProposalFromInput(dependent.id, {
				dependencies: [dep.id],
			});
			const updated = await core.getProposal(dependent.id);

			assert.ok(
				updated?.dependencies?.includes(dep.id),
				"Dependencies should be stored",
			);
		});
	});

	// ==========================================
	// proposal-36: Token-Efficient Plain Output
	// ==========================================
	describe("proposal-36: Token-Efficient Plain Output", () => {
		it("AC #1: Proposal data available for plain output", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Test Proposal",
				status: "Potential",
				description: "Test description",
			});
			await core.updateProposalFromInput(proposal.id, {
				finalSummary: "Summary",
			});

			const data = await core.getProposal(proposal.id);
			assert.ok(data, "Proposal should be retrievable");
			assert.ok(data?.title, "Should have title");
			assert.ok(data?.status, "Should have status");
		});

		it("AC #3: Proposal list provides compact data", async () => {
			await core.createProposalFromInput({ title: "Test 1", priority: "high" });
			await core.createProposalFromInput({ title: "Test 2", priority: "low" });

			const proposals = await core.queryProposals({
				includeCrossBranch: false,
			});
			for (const s of proposals) {
				assert.ok(s.id, "Should have ID");
				assert.ok(s.status, "Should have status");
				assert.ok(s.title, "Should have title");
			}
		});

		it("AC #6: Full proposal details accessible", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Detailed Proposal",
				status: "Potential",
				description: "Full description",
			});
			await core.updateProposalFromInput(proposal.id, {
				finalSummary: "Summary",
			});

			const full = await core.getProposal(proposal.id);
			assert.ok(full?.description, "Should have description");
			assert.ok(full?.finalSummary, "Should have final summary");
		});
	});
});

function isComplete(status: string): boolean {
	return status.toLowerCase() === "complete";
}
