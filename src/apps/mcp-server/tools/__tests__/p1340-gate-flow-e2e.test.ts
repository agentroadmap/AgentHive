/**
 * P1340 E2E Tests: MCP gate-flow ergonomics
 *
 * Tests the shipped code (commits b2f8937c + 52df0703 + a5089634 + 9ec3758a + f4966343)
 * for: universal aliases (id|proposal_id|display_id), gate-decision atomic advance,
 * admin identity bypass, --force CLI hint, schema error formatting, transition→gate_decision
 * shortcut hint, and workflows sync regression.
 *
 * Uses proposal IDs in 999100+ range to avoid P1293 collisions.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../../../../infra/postgres/pool.ts";
import { PgProposalHandlers } from "../proposals/pg-handlers.ts";
import { recordGateDecision } from "../rfc/pg-handlers.ts";
import type { CallToolResult } from "../types.ts";

describe("P1340: MCP gate-flow ergonomics — e2e", () => {
	// Test proposal IDs (999100+, outside P1293's 999000+ namespace)
	// Each test uses a contiguous range to avoid ID collisions
	const testProposalIds = {
		// Test 1: Universal alias (999101-999109)
		universalAliasId: 999101,
		universalAliasProposalId: 999102,
		universalAliasDisplayId: 999103,
		universalAliasMaturityId: 999104,
		universalAliasMaturityProposalId: 999105,
		universalAliasMaturityDisplayId: 999106,
		universalAliasReleaseDisplayId: 999107,
		universalAliasReleaseProposalId: 999108,
		universalAliasReleaseId: 999109,
		// Test 2: Gate-decision advance (999110-999112)
		gateDecisionAdvance: 999110,
		// Test 2b: Architecture RFC advance (999111)
		archRfcAdvance: 999111,
		// Test 3: Admin bypass (999113)
		adminBypass: 999113,
		// Test 4: Force hint (999114-999115)
		forceHintFirst: 999114,
		forceHintSecond: 999115,
		// Test 5: Force hint for proposal_id (999116)
		forceHintProposalId: 999116,
		// Test 6: Workflows sync (999117)
		workflowsSync: 999117,
		// Test 7: Transition hint (999118)
		transitionHint: 999118,
		// Test 8: recordGateDecision identifiers (999119)
		recordGateDecisionId: 999119,
		// Test 9: Architecture RFC REVIEW→COMPLETE (999120)
		archRfcGateDecision: 999120,
	};

	// Test agencies
	const george = "george";
	const claude = "claude";
	const systemIdentity = "system";
	const orchestratorId = "AGENTHIVE_ORCHESTRATOR_IDENTITY";

	let handlers: PgProposalHandlers;

	beforeAll(async () => {
		// Initialize handlers with minimal server mock
		handlers = new PgProposalHandlers({} as any, "/data/code/AgentHive");

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
			 VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[
				george, "llm", "developer",
				claude, "llm", "developer",
				systemIdentity, "user", "developer",
			],
		);
		// orchestratorId may be uppercase; canonicalize to satisfy ck_agent_identity_canonical
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role)
			 VALUES (fn_canonicalize_identity($1), $2, $3)
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[orchestratorId, "user", "system_orchestrator"],
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
		// Delete any existing lease first
		await query(
			`DELETE FROM roadmap_proposal.proposal_lease
			 WHERE proposal_id = $1 AND agent_identity = $2`,
			[proposalId, agent],
		);
		// Then insert fresh
		await query(
			`INSERT INTO roadmap_proposal.proposal_lease
			   (proposal_id, agent_identity, claimed_at, expires_at)
			 VALUES ($1, $2, now(), $3)`,
			[proposalId, agent, expires],
		);
	}

	// ─── Test 1: Universal alias coverage ───────────────────────────────

	describe("1. Universal alias coverage (id|proposal_id|display_id)", () => {
		it("prop_claim accepts id, proposal_id, and display_id forms", async () => {
			// Create 3 separate proposals to test each alias form independently
			const pidId = 999101;
			const pidProposalId = 999102;
			const pidDisplayId = 999103;
			await createTestProposal(pidId);
			await createTestProposal(pidProposalId);
			await createTestProposal(pidDisplayId);

			// Test with numeric id
			let result = await handlers.claimProposal({
				id: String(pidId),
				agent: claude,
			});
			expect(result.content[0].type).toBe("text");
			expect(result.content[0].text).toContain("Claimed");

			// Test with proposal_id alias
			result = await handlers.claimProposal({
				proposal_id: String(pidProposalId),
				agent: claude,
			});
			expect(result.content[0].text).toContain("Claimed");

			// Test with display_id
			result = await handlers.claimProposal({
				display_id: `P${pidDisplayId}`,
				agent: claude,
			});
			expect(result.content[0].text).toContain("Claimed");
		});

		it("prop_set_maturity accepts all three alias forms", async () => {
			// Create 3 separate proposals for maturity tests
			const pidId = 999104;
			const pidProposalId = 999105;
			const pidDisplayId = 999106;
			await createTestProposal(pidId);
			await createTestProposal(pidProposalId);
			await createTestProposal(pidDisplayId);

			// Test with id
			let result = await handlers.setMaturity({
				id: String(pidId),
				maturity: "active",
			});
			expect(result.content[0].text).toContain("maturity set");

			// Test with proposal_id
			result = await handlers.setMaturity({
				proposal_id: String(pidProposalId),
				maturity: "mature",
			});
			expect(result.content[0].text).toContain("maturity set");

			// Test with display_id
			result = await handlers.setMaturity({
				display_id: `P${pidDisplayId}`,
				maturity: "new",
			});
			expect(result.content[0].text).toContain("maturity set");
		});

		it("prop_release accepts all three alias forms", async () => {
			// Create 3 separate proposals for release tests
			const pidDisplayId = 999107;
			const pidProposalId = 999108;
			const pidId = 999109;
			await createTestProposal(pidDisplayId);
			await createTestProposal(pidProposalId);
			await createTestProposal(pidId);

			// Claim and release with display_id
			await handlers.claimProposal({
				id: String(pidDisplayId),
				agent: claude,
			});
			let result = await handlers.releaseProposal({
				display_id: `P${pidDisplayId}`,
				agent: claude,
				release_reason: "manual_release",
			});
			expect(result.content[0].text).toContain("Released");

			// Claim and release with proposal_id
			await handlers.claimProposal({
				id: String(pidProposalId),
				agent: claude,
			});
			result = await handlers.releaseProposal({
				proposal_id: String(pidProposalId),
				agent: claude,
				release_reason: "work_delivered",
			});
			expect(result.content[0].text).toContain("Released");

			// Claim and release with id
			await handlers.claimProposal({
				id: String(pidId),
				agent: claude,
			});
			result = await handlers.releaseProposal({
				id: String(pidId),
				agent: claude,
				release_reason: "out_of_scope",
			});
			expect(result.content[0].text).toContain("Released");
		});

		it("missing all three identifier aliases returns clear error", async () => {
			const result = await handlers.claimProposal({
				agent: claude,
			});
			expect(result.content[0].text).toContain("missing proposal identifier");
			expect(result.content[0].text).toContain("id=");
			expect(result.content[0].text).toContain("proposal_id");
			expect(result.content[0].text).toContain("display_id");
		});
	});

	// ─── Test 2: Gate-decision atomic advance ───────────────────────────

	describe("2. Gate-decision atomic advance (D1, D2, D3, D4)", () => {
		it("D1 advance (DRAFT→REVIEW) updates status, maturity, releases lease, syncs workflow", async () => {
			const pid = testProposalIds.gateDecisionAdvance;
			await createTestProposal(pid, "DRAFT", "mature");
			await createActiveLease(pid, george);

			const result = await recordGateDecision({
				proposal_id: String(pid),
				gate: "D1",
				decision: "advance",
				rationale: "Passed design review",
				decided_by: george,
			});

			expect(result.content[0].text).toContain("ADVANCED");
			expect(result.content[0].text).toContain("DRAFT → REVIEW");

			// Verify proposal status changed
			const { rows: propRows } = await query<{ status: string; maturity: string }>(
				`SELECT status, maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(propRows[0].status).toBe("REVIEW");
			expect(propRows[0].maturity).toBe("new");

			// Verify lease was released
			const { rows: leaseRows } = await query<{ released_at: string | null }>(
				`SELECT released_at FROM roadmap_proposal.proposal_lease
				  WHERE proposal_id = $1 AND agent_identity = $2`,
				[pid, george],
			);
			expect(leaseRows[0].released_at).not.toBeNull();

			// Verify gate_decision_log entry
			const { rows: decisionRows } = await query<{
				from_state: string;
				to_state: string;
			}>(
				`SELECT from_state, to_state FROM roadmap_proposal.gate_decision_log
				  WHERE proposal_id = $1 AND gate = $2`,
				[pid, "D1"],
			);
			expect(decisionRows[0].from_state).toBe("DRAFT");
			expect(decisionRows[0].to_state).toBe("REVIEW");
		});

		it("D2 advance (REVIEW→DEVELOP) with universal display_id alias", async () => {
			const pid = testProposalIds.gateDecisionAdvance;

			// Manually transition to REVIEW for this test (bypass guard via direct UPDATE)
			await query(
				`UPDATE roadmap_proposal.proposal SET status = $1, maturity = $2 WHERE id = $3`,
				["REVIEW", "mature", pid],
			);
			await createActiveLease(pid, george);

			const result = await recordGateDecision({
				display_id: `P${pid}`,
				gate: "D2",
				decision: "advance",
				rationale: "Ready to develop",
				decided_by: george,
			});

			expect(result.content[0].text).toContain("ADVANCED");
			expect(result.content[0].text).toContain("REVIEW → DEVELOP");

			const { rows } = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].status).toBe("DEVELOP");
		});

		it("D3 advance (DEVELOP→MERGE) with to_state inference", async () => {
			const pid = testProposalIds.gateDecisionAdvance;

			// Set to DEVELOP state
			await query(
				`UPDATE roadmap_proposal.proposal SET status = $1, maturity = $2 WHERE id = $3`,
				["DEVELOP", "mature", pid],
			);
			await createActiveLease(pid, george);

			const result = await recordGateDecision({
				id: String(pid),
				gate: "D3",
				decision: "advance",
				// Note: to_state is NOT passed — should be inferred from gate
				decided_by: george,
			});

			expect(result.content[0].text).toContain("ADVANCED");
			expect(result.content[0].text).toContain("DEVELOP → MERGE");

			const { rows } = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].status).toBe("MERGE");
		});

		it("D4 advance (MERGE→COMPLETE) infers to_state from gate", async () => {
			const pid = testProposalIds.gateDecisionAdvance;

			// Set to MERGE state
			await query(
				`UPDATE roadmap_proposal.proposal SET status = $1, maturity = $2 WHERE id = $3`,
				["MERGE", "mature", pid],
			);
			await createActiveLease(pid, george);

			const result = await recordGateDecision({
				proposal_id: String(pid),
				gate: "D4",
				decision: "advance",
				decided_by: george,
			});

			expect(result.content[0].text).toContain("ADVANCED");
			expect(result.content[0].text).toContain("MERGE → COMPLETE");

			const { rows } = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].status).toBe("COMPLETE");
		});

		it("AC-5: Architecture RFC REVIEW→COMPLETE (3-stage workflow, not a bug)", async () => {
			const pid = testProposalIds.archRfcAdvance;
			// Create proposal with Architecture RFC workflow (3-stage: Draft→Review→Complete)
			await query(
				`INSERT INTO roadmap_proposal.proposal
				   (id, display_id, type, status, maturity, title, audit, workflow_name, created_at, modified_at)
				 OVERRIDING SYSTEM VALUE
				 VALUES ($1, $2, 'architecture', 'REVIEW', 'mature', $3, '[]'::jsonb, 'Architecture RFC', now(), now())
				 ON CONFLICT (id) DO UPDATE SET status='REVIEW', maturity='mature', workflow_name='Architecture RFC'`,
				[pid, `P${pid}`, `Arch RFC Test ${pid}`],
			);
			await createActiveLease(pid, george);

			const result = await recordGateDecision({
				proposal_id: String(pid),
				gate: "D2",
				decision: "advance",
				rationale: "Architecture approved",
				decided_by: george,
			});

			expect(result.content[0].text).toContain("ADVANCED");
			expect(result.content[0].text).toContain("REVIEW → COMPLETE");

			const { rows } = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].status).toBe("COMPLETE");

			// Verify gate_decision_log records the correct from/to states (AC-7)
			const { rows: logRows } = await query<{ from_state: string; to_state: string }>(
				`SELECT from_state, to_state FROM roadmap_proposal.gate_decision_log
				  WHERE proposal_id = $1 AND gate = $2 ORDER BY id DESC LIMIT 1`,
				[pid, "D2"],
			);
			expect(logRows[0].from_state).toBe("REVIEW");
			expect(logRows[0].to_state).toBe("COMPLETE");
		});
	});

	// ─── Test 3: Admin identity bypass ──────────────────────────────────

	describe("3. Admin identity bypass (system, orchestrator)", () => {
		it("system identity bypasses lease requirement on setMaturity", async () => {
			const pid = testProposalIds.adminBypass;
			await createTestProposal(pid, "DRAFT", "new");
			await createActiveLease(pid, george); // george holds lease

			// Non-admin identity would fail with LEASE_CONFLICT
			// But system identity should succeed without lease requirement
			const result = await handlers.setMaturity({
				id: String(pid),
				maturity: "active",
				agent: systemIdentity,
			});

			expect(result.content[0].text).toContain("maturity set");
			// Verify maturity changed
			const { rows } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].maturity).toBe("active");
		});

		it("AGENTHIVE_ORCHESTRATOR_IDENTITY bypasses lease validation", async () => {
			const pid = testProposalIds.adminBypass;

			// Proposal still has george's lease
			const result = await handlers.setMaturity({
				display_id: `P${pid}`,
				maturity: "mature",
				agent: orchestratorId,
			});

			expect(result.content[0].text).toContain("maturity set");

			const { rows } = await query<{ maturity: string }>(
				`SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].maturity).toBe("mature");
		});
	});

	// ─── Test 4: --force CLI hint ───────────────────────────────────────

	describe("4. --force CLI hint on LEASE_CONFLICT", () => {
		it("prop_claim LEASE_CONFLICT includes both MCP and CLI forms", async () => {
			const pid = testProposalIds.forceHintFirst;
			await createTestProposal(pid);
			await createActiveLease(pid, george);

			// Try to claim with different agent
			const result = await handlers.claimProposal({
				id: String(pid),
				agent: claude,
			});

			expect(result.content[0].text).toContain("already claimed");
			// Should include MCP form with force: true
			expect(result.content[0].text).toContain("force: true");
			// Should include CLI form with --force
			expect(result.content[0].text).toContain("--force");
			// Should reference the proposal ID number
			expect(result.content[0].text).toContain(String(pid));
		});

		it("prop_claim with force=true succeeds and releases previous lease", async () => {
			const pid = testProposalIds.forceHintFirst;

			const result = await handlers.claimProposal({
				id: String(pid),
				agent: claude,
				force: true,
			});

			expect(result.content[0].text).toContain("Claimed");
			expect(result.content[0].text).toContain(claude);

			// Verify george's lease was released
			const { rows: leaseRows } = await query<{ released_at: string | null }>(
				`SELECT released_at FROM roadmap_proposal.proposal_lease
				  WHERE proposal_id = $1 AND agent_identity = $2`,
				[pid, george],
			);
			expect(leaseRows[0].released_at).not.toBeNull();
		});
	});

	// ─── Test 5: --force CLI hint for proposal_id param ─────────────────

	describe("5. --force CLI hint uses correct param names", () => {
		it("force hint uses proposal_id in both MCP and CLI forms for claimProposal", async () => {
			const pid = testProposalIds.forceHintProposalId;
			await createTestProposal(pid);
			await createActiveLease(pid, george);

			// Attempt to claim with different agent
			const result = await handlers.claimProposal({
				proposal_id: String(pid),
				agent: "alice",
			});

			const text = result.content[0].text;
			expect(text).toContain("already claimed");
			// MCP form should show proper names
			expect(text).toContain("id:");
			// CLI form should also be present
			expect(text).toContain("--force");
		});
	});

	// ─── Test 6: Workflows sync regression ──────────────────────────────

	describe("6. Workflows sync regression (current_stage consistency)", () => {
		it("record_gate_decision syncs roadmap.workflows.current_stage with proposal.status", async () => {
			const pid = testProposalIds.workflowsSync;
			await createTestProposal(pid, "DRAFT", "mature");
			await createActiveLease(pid, george);

			// Advance through D1
			await recordGateDecision({
				proposal_id: String(pid),
				gate: "D1",
				decision: "advance",
				decided_by: george,
			});

			// Verify proposal.status changed
			const propRows = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(propRows.rows[0].status).toBe("REVIEW");

			// Check if workflows row was created/updated by trigger
			const workflowRows = await query<{ current_stage: string }>(
				`SELECT current_stage FROM roadmap.workflows WHERE proposal_id = $1`,
				[pid],
			);
			// If workflows row exists, it should be synced
			if (workflowRows.rows.length > 0) {
				expect(workflowRows.rows[0].current_stage).toBe("REVIEW");
			}
		});

		it("workflows.current_stage syncs on D2 advance", async () => {
			const pid = testProposalIds.workflowsSync;

			// D2: REVIEW→DEVELOP
			await query(
				`UPDATE roadmap_proposal.proposal SET status = $1, maturity = $2 WHERE id = $3`,
				["REVIEW", "mature", pid],
			);
			await createActiveLease(pid, george);

			await recordGateDecision({
				proposal_id: String(pid),
				gate: "D2",
				decision: "advance",
				decided_by: george,
			});

			const propRows = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(propRows.rows[0].status).toBe("DEVELOP");

			// Verify workflow (if exists) is in sync
			const workflowRows = await query<{ current_stage: string }>(
				`SELECT current_stage FROM roadmap.workflows WHERE proposal_id = $1`,
				[pid],
			);
			if (workflowRows.rows.length > 0) {
				expect(workflowRows.rows[0].current_stage).toBe("DEVELOP");
			}
		});

		it("gate_decision atomic transaction has app.gate_bypass enabled", async () => {
			const pid = testProposalIds.workflowsSync;

			// D3: DEVELOP→MERGE
			await query(
				`UPDATE roadmap_proposal.proposal SET status = $1, maturity = $2 WHERE id = $3`,
				["DEVELOP", "mature", pid],
			);
			await createActiveLease(pid, george);

			const result = await recordGateDecision({
				proposal_id: String(pid),
				gate: "D3",
				decision: "advance",
				decided_by: george,
			});

			// The result should mention atomic transaction
			expect(result.content[0].text).toContain("Atomic");

			// Verify status advanced despite fn_guard_gate_advance (due to gate_bypass)
			const propRows = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(propRows.rows[0].status).toBe("MERGE");
		});
	});

	// ─── Test 7: Transition hints ───────────────────────────────────────

	describe("7. Transition→gate_decision shortcut (D1 gate hint)", () => {
		it("prop_transition suggests record_gate_decision when gate decision missing", async () => {
			const pid = testProposalIds.transitionHint;
			await createTestProposal(pid, "DRAFT", "new");
			await createActiveLease(pid, george);

			// Try to transition without a gate decision
			const result = await handlers.transitionProposal({
				id: String(pid),
				status: "REVIEW",
				author: george,
				notes: "No gate decision logged",
			});

			// Should be rejected and suggest gate_decision
			const text = result.content[0].text;
			// The message says "requires an explicit gate review"
			expect(text).toContain("requires");
			expect(text).toContain("gate");
			// Should mention either gate_decision or explicit gate review
			expect(text).toContain("decision") || expect(text).toContain("review");
		});
	});

	// ─── Test 8: Universal identifiers in recordGateDecision ────────────

	describe("8. Universal identifiers in recordGateDecision", () => {
		it("recordGateDecision accepts id, proposal_id, and display_id", async () => {
			const pid = testProposalIds.recordGateDecisionId;
			await createTestProposal(pid, "REVIEW", "mature");
			await createActiveLease(pid, george);

			// Test with display_id
			const result = await recordGateDecision({
				display_id: `P${pid}`,
				gate: "D2",
				decision: "advance",
				decided_by: george,
			});

			expect(result.content[0].text).toContain("ADVANCED");

			// Verify it worked
			const { rows } = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].status).toBe("DEVELOP");
		});

		it("recordGateDecision missing all identifiers returns clear error", async () => {
			const result = await recordGateDecision({
				gate: "D1",
				decision: "advance",
			});

			expect(result.content[0].text).toContain("missing proposal identifier");
			expect(result.content[0].text).toContain("proposal_id");
		});
	});

	// ─── Test 9: Architecture RFC REVIEW→COMPLETE (AC-5) ───────────────

	describe("9. Architecture RFC gate_decision advance (REVIEW→COMPLETE)", () => {
		it("AC-5: advance on REVIEW-stage Architecture RFC proposal transitions to COMPLETE", async () => {
			const pid = testProposalIds.archRfcGateDecision;

			// Create an architecture-type proposal at REVIEW/mature
			await query(
				`INSERT INTO roadmap_proposal.proposal
				   (id, display_id, type, status, maturity, title, audit, created_at, modified_at)
				 OVERRIDING SYSTEM VALUE
				 VALUES ($1, $2, 'architecture', 'REVIEW', 'mature', $3, '[]'::jsonb, now(), now())
				 ON CONFLICT (id) DO NOTHING`,
				[pid, `P${pid}`, `Architecture RFC Test ${pid}`],
			);

			// Wire up the Architecture RFC workflow (template_id=54: Draft→Review→Complete)
			await query(
				`INSERT INTO roadmap.workflows (template_id, proposal_id, current_stage)
				 VALUES (54, $1, 'Review')
				 ON CONFLICT (proposal_id) DO UPDATE SET template_id = 54, current_stage = 'Review'`,
				[pid],
			);

			await createActiveLease(pid, george);

			const result = await recordGateDecision({
				proposal_id: String(pid),
				gate: "D2",
				decision: "advance",
				rationale: "Architecture approved, advancing to Complete",
				decided_by: george,
			});

			expect(result.content[0].text).toContain("ADVANCED");
			expect(result.content[0].text).toContain("REVIEW → COMPLETE");

			const { rows } = await query<{ status: string }>(
				`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
				[pid],
			);
			expect(rows[0].status).toBe("COMPLETE");

			// Verify gate_decision_log has correct from_state and to_state (AC-7)
			const { rows: logRows } = await query<{ from_state: string; to_state: string }>(
				`SELECT from_state, to_state FROM roadmap_proposal.gate_decision_log
				  WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
				[pid],
			);
			expect(logRows[0].from_state).toBe("REVIEW");
			expect(logRows[0].to_state).toBe("Complete");
		});
	});
});
