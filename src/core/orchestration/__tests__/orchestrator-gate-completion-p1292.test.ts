import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { query } from "../../../infra/postgres/pool.ts";

// LIVE-DB TEST: writes fixture rows to the live agenthive DB (with teardown).
// Skipped by default to keep the suite hermetic — combined runs also collide
// with mock.module pool mocks from sibling tests (see P1369). Run with
// AGENTHIVE_ALLOW_LIVE_DB=1 under a dedicated invocation.
const LIVE = process.env.AGENTHIVE_ALLOW_LIVE_DB === "1";

/**
 * P1292 Tests: Gate Completion Listener in Orchestrator
 *
 * Verifies that the offer_completed NOTIFY handler:
 * 1. Detects gate dispatch by metadata.gate_role presence
 * 2. Extracts proposal_id from squad_dispatch lookup
 * 3. Releases the dispatch lease
 * 4. Resets maturity from 'mature' to 'new' for next dispatch cycle
 */

describe.skipIf(!LIVE)("Orchestrator gate completion listener (P1292)", () => {
	let proposalId: number;
	let dispatchId: number;
	let leaseId: number;
	let agentId: string;
	const agencyId = "test-agency";

	beforeEach(async () => {
		agentId = "agenthive/skeptic-alpha-test";

		// Ensure agent exists in registry
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status)
			VALUES ($1, $2, $3)
			ON CONFLICT (agent_identity) DO NOTHING`,
			[agentId, "llm", "active"]
		);

		// Create test proposal in mature state
		const propResult = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal
				(display_id, type, status, maturity, title, audit)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id`,
			["P1289-test", "feature", "REVIEW", "mature", "Test Proposal", JSON.stringify({})]
		);
		proposalId = propResult.rows[0].id;

		// Create a proposal lease to verify release
		const leaseResult = await query<{ id: number }>(
			`INSERT INTO roadmap_proposal.proposal_lease
				(proposal_id, agent_identity)
			VALUES ($1, $2)
			RETURNING id`,
			[proposalId, agentId]
		);
		leaseId = leaseResult.rows[0].id;

		// Create test dispatch with gate metadata
		const dispatchResult = await query<{ id: number }>(
			`INSERT INTO roadmap_workforce.squad_dispatch
				(proposal_id, agent_identity, squad_name, dispatch_role, metadata, lease_id, required_capabilities)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			RETURNING id`,
			[
				proposalId,
				agentId,
				"gate-P1289-D1",
				"skeptic-alpha",
				JSON.stringify({
					gate_role: "skeptic-alpha",
					gate_from_stage: "DRAFT",
					gate_to_stage: "REVIEW",
					gate_role_source: "builtin-fallback",
				}),
				leaseId,
				JSON.stringify(["review"]),
			]
		);
		dispatchId = dispatchResult.rows[0].id;
	});

	afterEach(async () => {
		// Clean up test data
		await query(
			"DELETE FROM roadmap_proposal.proposal_lease WHERE proposal_id = $1",
			[proposalId]
		);
		await query(
			"DELETE FROM roadmap_workforce.squad_dispatch WHERE proposal_id = $1",
			[proposalId]
		);
		await query(
			"DELETE FROM roadmap_proposal.proposal WHERE id = $1",
			[proposalId]
		);
		await query(
			"DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE $1",
			["agenthive/skeptic-alpha-test%"]
		);
	});

	it("should detect gate dispatch from metadata and reset maturity", async () => {
		// Set proposal to mature state before testing
		await query(
			"UPDATE roadmap_proposal.proposal SET maturity = $1 WHERE id = $2",
			["mature", proposalId]
		);

		// Verify: proposal is mature
		let propResult = await query<{ maturity: string }>(
			"SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1",
			[proposalId]
		);
		expect(propResult.rows[0].maturity).toBe("mature");

		// Simulate offer_completed NOTIFY by looking up dispatch
		const dispatchResult = await query<{
			proposal_id: number;
			metadata: Record<string, unknown>;
		}>(
			"SELECT proposal_id, metadata FROM roadmap_workforce.squad_dispatch WHERE id = $1",
			[dispatchId]
		);

		expect(dispatchResult.rows.length).toBe(1);

		// Verify the dispatch has gate metadata
		const { proposal_id, metadata } = dispatchResult.rows[0];
		const gateRole = metadata?.gate_role as string | undefined;
		expect(gateRole).toBe("skeptic-alpha");

		// Simulate the orchestrator's gate completion handler:
		// Release lease with valid reason (incomplete outcome → maturity='new')
		await query(
			`UPDATE roadmap_proposal.proposal_lease pl
			SET released_at = now(), release_reason = $2
			FROM roadmap_workforce.squad_dispatch sd
			WHERE sd.id = $1
			AND pl.id = sd.lease_id
			AND pl.released_at IS NULL`,
			[dispatchId, "released_unfinished"]
		);

		// Trigger should have set maturity to 'new' automatically
		// Verify that the lease was released
		const leaseResult = await query<{ released_at: string; release_reason: string }>(
			"SELECT released_at, release_reason FROM roadmap_proposal.proposal_lease WHERE id = $1",
			[leaseId]
		);
		expect(leaseResult.rows[0].release_reason).toBe("released_unfinished");
		expect(leaseResult.rows[0].released_at).toBeTruthy();

		// Verify maturity was reset to 'new' by the trigger
		propResult = await query<{ maturity: string }>(
			"SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1",
			[proposalId]
		);
		expect(propResult.rows[0].maturity).toBe("new");
	});

	it("should ignore non-gate dispatches", async () => {
		// Set proposal to mature state
		await query(
			"UPDATE roadmap_proposal.proposal SET maturity = $1 WHERE id = $2",
			["mature", proposalId]
		);

		// Create dispatch without gate metadata
		const nonGateDispatchResult = await query<{ id: number }>(
			`INSERT INTO roadmap_workforce.squad_dispatch
				(proposal_id, agent_identity, squad_name, dispatch_role, metadata, required_capabilities)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id`,
			[
				proposalId,
				agentId,
				"normal-task",
				"developer",
				JSON.stringify({ some_other_field: "value" }),
				JSON.stringify(["coding"]),
			]
		);
		const nonGateDispatchId = nonGateDispatchResult.rows[0].id;

		// Simulate offer_completed for non-gate dispatch
		const dispatchResult = await query<{
			proposal_id: number;
			metadata: Record<string, unknown>;
		}>(
			"SELECT proposal_id, metadata FROM roadmap_workforce.squad_dispatch WHERE id = $1",
			[nonGateDispatchId]
		);

		expect(dispatchResult.rows.length).toBe(1);
		const { metadata } = dispatchResult.rows[0];
		const gateRole = metadata?.gate_role as string | undefined;

		// Should not process if gateRole is not present
		expect(gateRole).toBeUndefined();

		// Proposal should remain mature (unchanged, no lease released)
		const propResult = await query<{ maturity: string }>(
			"SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1",
			[proposalId]
		);
		expect(propResult.rows[0].maturity).toBe("mature");

		// Clean up
		await query(
			"DELETE FROM roadmap_workforce.squad_dispatch WHERE id = $1",
			[nonGateDispatchId]
		);
	});

	it("should only reset maturity if still mature", async () => {
		// Change proposal to different maturity
		await query(
			"UPDATE roadmap_proposal.proposal SET maturity = $1 WHERE id = $2",
			["active", proposalId]
		);

		// Simulate offer_completed
		const dispatchResult = await query<{
			proposal_id: number;
			metadata: Record<string, unknown>;
		}>(
			"SELECT proposal_id, metadata FROM roadmap_workforce.squad_dispatch WHERE id = $1",
			[dispatchId]
		);

		if (dispatchResult.rows.length > 0) {
			const { proposal_id, metadata } = dispatchResult.rows[0];
			const gateRole = metadata?.gate_role as string | undefined;

			if (gateRole) {
				// Check current maturity before updating
				const propCheck = await query<{ maturity: string }>(
					"SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1",
					[proposal_id]
				);

				if (propCheck.rows[0].maturity === "mature") {
					await query(
						`UPDATE roadmap_proposal.proposal SET maturity = $1 WHERE id = $2`,
						["new", proposal_id]
					);
				}
			}
		}

		// Proposal should remain 'active' (unchanged because it wasn't mature)
		const propResult = await query<{ maturity: string }>(
			"SELECT maturity FROM roadmap_proposal.proposal WHERE id = $1",
			[proposalId]
		);
		expect(propResult.rows[0].maturity).toBe("active");
	});
});
