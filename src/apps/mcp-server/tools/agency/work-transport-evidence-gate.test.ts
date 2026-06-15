/**
 * P1438 AC-12/13 (option B): evidence gate on the MCP completion path
 * (handleAgencySubmitResult). A 'completed' submit that lacks the role artifact
 * must be DOWNGRADED to failed — never a false 'delivered'. Reuses
 * verifyDeliverables as the single source of truth.
 *
 * The pool `query` and the verifier are mocked so the gate logic is tested
 * without a live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
const verifyMock = vi.fn();

vi.mock("../../../../infra/postgres/pool.js", () => ({
	query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock("../../../../core/orchestration/deliverable-verifier.js", () => ({
	verifyDeliverables: (...args: unknown[]) => verifyMock(...args),
}));

import * as workTransport from "./work-transport-handlers.ts";

function wireQuery() {
	queryMock.mockImplementation(async (sql: string) => {
		if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
		// the dispatch close UPDATE returns the offer's identity/role
		if (/UPDATE roadmap_workforce\.squad_dispatch[\s\S]*RETURNING proposal_id/.test(sql)) {
			return {
				rows: [
					{
						proposal_id: 4242,
						dispatch_role: "gate-reviewer",
						agent_identity: "claude-bot-gary.a",
						agency_identity: "claude-bot-gary.a",
						squad_name: "P4242",
						required_capabilities: ["review"],
					},
				],
			};
		}
		if (/INSERT INTO roadmap_workforce\.agent_runs/.test(sql)) return { rows: [{ id: 777 }] };
		// the downgrade UPDATE (carries evidence_rejected)
		if (/evidence_rejected/.test(sql)) return { rows: [] };
		return { rows: [] };
	});
}

describe("P1438 AC-12/13: MCP completion evidence gate", () => {
	beforeEach(() => {
		delete process.env.MCP_AGENCY_AUTH;
		queryMock.mockReset();
		verifyMock.mockReset();
		wireQuery();
	});

	it("downgrades a 'completed' submit to failed when the role artifact is missing", async () => {
		verifyMock.mockResolvedValue({ verified: false, failureReason: "No proposal_reviews row" });

		const out = await workTransport.handleAgencySubmitResult({
			dispatch_id: 1n as unknown as bigint,
			claim_token: "tok-1",
			status: "completed",
			duration_ms: 1234,
			output_summary: "I reviewed the proposal.",
		});

		expect(out.delivered).toBe(false);
		expect(out.evidence_rejected).toMatch(/proposal_reviews/i);
		// the gate must have issued the downgrade UPDATE
		const downgraded = queryMock.mock.calls.some((c) => /evidence_rejected/.test(String(c[0])));
		expect(downgraded).toBe(true);
		expect(verifyMock).toHaveBeenCalledOnce();
	});

	it("downgrades a 'completed' submit with an empty summary without even calling the verifier", async () => {
		const out = await workTransport.handleAgencySubmitResult({
			dispatch_id: 2n as unknown as bigint,
			claim_token: "tok-2",
			status: "completed",
			duration_ms: 10,
			output_summary: "   ",
		});

		expect(out.delivered).toBe(false);
		expect(out.evidence_rejected).toMatch(/empty/i);
		expect(verifyMock).not.toHaveBeenCalled();
	});

	it("keeps 'delivered' when the role artifact is verified", async () => {
		verifyMock.mockResolvedValue({ verified: true, artifactType: "proposal_reviews", artifactId: 99 });

		const out = await workTransport.handleAgencySubmitResult({
			dispatch_id: 3n as unknown as bigint,
			claim_token: "tok-3",
			status: "completed",
			duration_ms: 500,
			output_summary: "Review complete; verdict recorded.",
		});

		expect(out.delivered).toBe(true);
		expect(out.evidence_rejected).toBeUndefined();
		const downgraded = queryMock.mock.calls.some((c) => /evidence_rejected/.test(String(c[0])));
		expect(downgraded).toBe(false);
	});
});
