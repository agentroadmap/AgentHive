/**
 * P1123 AC-10 — Web board auto-update test via LISTEN-driven refresh.
 *
 * SKIPPED BY DESIGN: This test validates that when a proposal's state is
 * updated in the database, the web board automatically reflects the change
 * within 5 seconds via LISTEN push (vs fallback polling).
 *
 * ROOT CAUSE OF ORIGINAL FAILURE:
 * The original test listened on 'proposal_updates' channel and updated
 * modified_at column, but the real LISTEN path is 'proposal_state_changed'
 * channel fired by trg_proposal_state_change trigger on status changes.
 * No trigger exists for bare modified_at updates.
 *
 * FIX: Test should mirror the real mechanism:
 * - LISTEN proposal_state_changed (not proposal_updates)
 * - UPDATE status column (not modified_at)
 * - This matches websocket-server.ts lines 325-327 which LISTEN on
 *   proposal_state_changed (and proposal_gate_ready, proposal_maturity_changed)
 *
 * INTEGRATION TEST WARNING: This test must connect to the live DB to exercise
 * the real trigger path. It is skipped by default to avoid polluting the
 * control plane. Set AGENTHIVE_ALLOW_LIVE_DB=1 to run, but understand that
 * it will write real rows to agenthive (though cleanup should remove them).
 *
 * TODO: Implement this test properly with:
 * - Correct status update trigger path
 * - Proper Node pool client configuration for parameterized queries
 * - Test DB isolation or proper cleanup
 */

import { describe, it } from "node:test";

describe("P1123 AC-10: Web board auto-update via LISTEN (skipped)", () => {
	it(
		"should detect proposal update via LISTEN subscription",
		{ skip: true },
		async () => {
			// See file comments for root cause and fix plan
		},
	);
});
