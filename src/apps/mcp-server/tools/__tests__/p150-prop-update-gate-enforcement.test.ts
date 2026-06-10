/**
 * P150 Tests: prop_update gate enforcement
 *
 * Tests that prop_update cannot bypass gate decisions when transitioning between
 * workflow stages (DRAFT → REVIEW, etc). Requires gate decision to be recorded
 * atomically with any status transition.
 *
 * Uses proposal IDs in 999200+ range to avoid collisions.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../../../../infra/postgres/pool.ts";
import { PgProposalHandlers } from "../proposals/pg-handlers.ts";

describe("P150: prop_update gate enforcement — negative test", () => {
	const testProposalIds = {
		// Test 1: prop_update rejects status on DRAFT→REVIEW (999201)
		rejectStatusTransitionId: 999201,
		// Test 2: prop_update allows non-gate-transition status on DEVELOP (999202)
		allowNonGateTransitionId: 999202,
		// Test 3: verify gate_decision_log is NOT created by prop_update (999203)
		verifyNoDecisionLogId: 999203,
	};

	const george = "george";

	let handlers: PgProposalHandlers;

	beforeAll(async () => {
		const mockServer = {} as unknown;
		handlers = new PgProposalHandlers(mockServer as any, "/data/code/AgentHive");

		// Clean up any leftover test data
		const testIds = Object.values(testProposalIds);
		await query(
			`DELETE FROM roadmap_proposal.gate_decision_log
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal_lease
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal_event
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap.workflows
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal
			  WHERE id = ANY($1)`,
			[testIds],
		);

		// Seed agent registry for test identities
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[george, "llm", "developer"],
		);
	});

	afterAll(async () => {
		// Clean up all test proposals and their related data
		const testIds = Object.values(testProposalIds);
		await query(
			`DELETE FROM roadmap_proposal.gate_decision_log
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal_lease
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal_event
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap.workflows
			  WHERE proposal_id = ANY($1)`,
			[testIds],
		);
		await query(
			`DELETE FROM roadmap_proposal.proposal
			  WHERE id = ANY($1)`,
			[testIds],
		);
	});

	// ─── Helper: Create test proposal ───────────────────────────────────

	async function createTestProposal(
		id: number,
		status = "DRAFT",
		maturity = "new",
	): Promise<number> {
		const { rows } = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
			   (id, display_id, type, status, maturity, title, audit, created_at, modified_at)
			 OVERRIDING SYSTEM VALUE
			 VALUES ($1, $2, 'feature', $3, $4, $5, '[]'::jsonb, now(), now())
			 ON CONFLICT (id) DO NOTHING
			 RETURNING id`,
			[id, `P${id}`, status, maturity, `Test Proposal ${id}`],
		);
		return rows[0]?.id ?? id;
	}

	async function createActiveLease(
		proposalId: number,
		agent: string,
		expiresAt?: Date,
	): Promise<void> {
		const expires = expiresAt ?? new Date(Date.now() + 120 * 60 * 1000);
		await query(
			`DELETE FROM roadmap_proposal.proposal_lease
			 WHERE proposal_id = $1 AND agent_identity = $2`,
			[proposalId, agent],
		);
		await query(
			`INSERT INTO roadmap_proposal.proposal_lease
			   (proposal_id, agent_identity, claimed_at, expires_at)
			 VALUES ($1, $2, now(), $3)`,
			[proposalId, agent, expires],
		);
	}

	// ─── Test 1: prop_update rejects gate transitions ───────────────────

	describe("AC-5: prop_update rejects status on gate transitions", () => {
		it("prop_update with status DRAFT→REVIEW fails with clear error message", async () => {
			const pid = testProposalIds.rejectStatusTransitionId;
			await createTestProposal(pid, "DRAFT", "mature");
			await createActiveLease(pid, george);

			const result = await handlers.updateProposal({
				id: String(pid),
				status: "REVIEW",
				author: george,
			});

			expect(result.content[0].type).toBe("text");
			const text = result.content[0].text;

			// Should fail with a clear error about gate transitions
			expect(text).toMatch(/[Gg]ate|[Dd]ecision|[Rr]equire/);
			expect(text).not.toContain("Updated proposal");
			expect(text).not.toContain("Transitioned");
		});

		it("prop_update error message explicitly rejects status changes with guidance", async () => {
			const pid = testProposalIds.rejectStatusTransitionId;
			const result = await handlers.updateProposal({
				id: String(pid),
				status: "REVIEW",
				author: george,
			});

			const text = result.content[0].text;
			// After P150 fix, should guide users to use proper workflow
			expect(text).toMatch(/[Pp]rop_update|status|[Gg]ate/);
		});

		it("no gate_decision_log entry is created by failed prop_update", async () => {
			const pid = testProposalIds.rejectStatusTransitionId;
			const { rows } = await query<{ id: number }>(
				`SELECT id FROM roadmap_proposal.gate_decision_log
				  WHERE proposal_id = $1`,
				[pid],
			);
			expect(rows.length).toBe(0);
		});

		it("proposal status remains DRAFT after failed prop_update", async () => {
			const pid = testProposalIds.rejectStatusTransitionId;
			const { rows } = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].status).toBe("DRAFT");
		});
	});

	// ─── Test 2: prop_update allows non-gate field updates ───────────────

	describe("AC-5: prop_update still allows non-status field updates", () => {
		it("prop_update can update title, summary, design on DRAFT proposal", async () => {
			const pid = testProposalIds.verifyNoDecisionLogId;
			await createTestProposal(pid, "DRAFT", "new");

			const result = await handlers.updateProposal({
				id: String(pid),
				title: "Updated Title",
				summary: "Updated summary",
				design: "Updated design",
				author: george,
			});

			expect(result.content[0].text).toContain("Updated proposal");

			// Verify the updates took effect
			const { rows } = await query<{
				title: string;
				summary: string;
				design: string;
			}>(
				`SELECT title, summary, design FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].title).toBe("Updated Title");
			expect(rows[0].summary).toBe("Updated summary");
			expect(rows[0].design).toBe("Updated design");
		});

		it("prop_update with status on non-gate transitions is still rejected (closed by P150 AC-4 design)", async () => {
			const pid = testProposalIds.allowNonGateTransitionId;
			// Create in REVIEW state (a non-gate source for the RFC workflow)
			await createTestProposal(pid, "REVIEW", "mature");
			await createActiveLease(pid, george);

			// Even though REVIEW→DEVELOP is a gate transition, prop_update should reject
			// ANY status field for consistency (P150 AC-4: "require every DRAFT to REVIEW path")
			const result = await handlers.updateProposal({
				id: String(pid),
				status: "DEVELOP",
				author: george,
			});

			const text = result.content[0].text;
			expect(text).toMatch(/[Gg]ate|[Dd]ecision|[Rr]equire/);
		});
	});
});
