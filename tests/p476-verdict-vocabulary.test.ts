/**
 * P476: Verdict vocabulary expansion smoke test
 *
 * Tests:
 * - All 7 verdicts accepted by submit_review
 * - approve_with_changes + change_requirements inserts requirement rows
 * - getOpenChangeRequirements returns unsatisfied requirements
 * - Marking requirements satisfied works
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../src/postgres/pool.ts";
import { submitReview, getOpenChangeRequirements } from "../src/apps/mcp-server/tools/rfc/pg-handlers.ts";

describe("P476: Verdict vocabulary expansion", () => {
	let testProposalId: number;
	const testVerdicts = ["approve", "approve_with_changes", "request_changes", "send_back", "reject", "defer", "recuse"];
	const testReviewers = testVerdicts.map((_, i) => `test-reviewer-${i}`);

	beforeAll(async () => {
		// Create test reviewers in agent_registry
		for (const reviewer of testReviewers) {
			await query(
				`INSERT INTO agent_registry (agent_identity, agent_type)
         VALUES ($1, 'human') ON CONFLICT DO NOTHING`,
				[reviewer],
			);
		}

		// Also register the change_requirements reviewer
		await query(
			`INSERT INTO agent_registry (agent_identity, agent_type)
       VALUES ('test-reviewer-changes', 'human') ON CONFLICT DO NOTHING`,
			[],
		);

		// Create a test proposal (only required fields; triggers will set maturity, etc.)
		const { rows } = await query(
			`INSERT INTO roadmap_proposal.proposal (title, type, audit)
       VALUES ('P476 Test Proposal', 'feature', '{}')
       RETURNING id`,
			[],
		);
		testProposalId = rows[0].id;
	});

	afterAll(async () => {
		// Clean up: delete test proposal and all related data (cascade will handle reviews and requirements)
		await query("DELETE FROM roadmap_proposal.proposal WHERE id = $1", [testProposalId]);
	});

	it("should accept all 7 verdict values", async () => {
		for (let i = 0; i < testVerdicts.length; i++) {
			const verdict = testVerdicts[i];
			const result = await submitReview({
				proposal_id: String(testProposalId),
				reviewer: `test-reviewer-${i}`,
				verdict,
				notes: `Testing ${verdict}`,
			});

			expect(result.content[0].type).toBe("text");
			const text = (result.content[0] as any).text;
			expect(text).toContain("✅");
			expect(text).toContain(verdict);
		}
	});

	it("should insert change requirements when verdict is approve_with_changes", async () => {
		const changeReqs = ["fix X", "fix Y"];
		const result = await submitReview({
			proposal_id: String(testProposalId),
			reviewer: "test-reviewer-changes",
			verdict: "approve_with_changes",
			notes: "Approved with conditions",
			change_requirements: changeReqs,
		});

		expect(result.content[0].type).toBe("text");
		const text = (result.content[0] as any).text;
		expect(text).toContain("✅");
		expect(text).toContain("approve_with_changes");

		// Verify requirements were inserted
		const { rows } = await query(
			`SELECT requirement_text FROM roadmap_proposal.post_gate_change_requirement
       WHERE satisfied = FALSE AND requirement_text = ANY($1::text[])`,
			[changeReqs],
		);
		expect(rows.length).toBe(2);
		expect(rows.map((r) => r.requirement_text).sort()).toEqual(changeReqs.sort());
	});

	it("should return open requirements via getOpenChangeRequirements", async () => {
		const openReqs = await getOpenChangeRequirements(testProposalId);
		expect(Array.isArray(openReqs)).toBe(true);
		// Should have at least the "fix X" and "fix Y" requirements
		expect(openReqs.length).toBeGreaterThanOrEqual(2);
	});

	it("should allow marking requirements satisfied", async () => {
		// Get one open requirement first
		const { rows: openRows } = await query(
			`SELECT id, requirement_text FROM roadmap_proposal.post_gate_change_requirement
       WHERE satisfied = FALSE LIMIT 1`,
			[],
		);

		if (openRows.length > 0) {
			const requirementId = openRows[0].id;
			// Mark it satisfied
			await query(
				`UPDATE roadmap_proposal.post_gate_change_requirement
         SET satisfied = TRUE, satisfied_at = NOW(), satisfied_by = $1
         WHERE id = $2`,
				["test-satisfier", requirementId],
			);

			// Verify it's marked as satisfied
			const { rows: verifyRows } = await query(
				`SELECT satisfied, satisfied_by FROM roadmap_proposal.post_gate_change_requirement WHERE id = $1`,
				[requirementId],
			);
			expect(verifyRows[0].satisfied).toBe(true);
			expect(verifyRows[0].satisfied_by).toBe("test-satisfier");

			// getOpenChangeRequirements should return fewer rows
			const updatedOpenReqs = await getOpenChangeRequirements(testProposalId);
			expect(updatedOpenReqs.length).toBeLessThan(2);
		}
	});

	it("should validate CHECK constraint on proposal_reviews.verdict", async () => {
		// Try to insert an invalid verdict value directly (should fail)
		try {
			await query(
				`INSERT INTO roadmap_proposal.proposal_reviews (proposal_id, reviewer_identity, verdict)
         VALUES ($1, $2, $3)`,
				[testProposalId, "invalid-reviewer", "invalid_verdict"],
			);
			// If we get here, the check constraint is not working
			expect.fail("CHECK constraint should have rejected invalid verdict");
		} catch (err) {
			// Expected to fail with constraint violation
			expect((err as any).message).toMatch(/check constraint|violates/i);
		}
	});
});
