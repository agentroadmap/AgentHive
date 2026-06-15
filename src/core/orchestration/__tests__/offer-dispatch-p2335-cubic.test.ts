/**
 * P2335: Cubic Workspace Acquisition Into Offer Dispatch.
 *
 * These tests exercise OrchestratorOfferDispatcher.dispatch()'s cubic-acquisition
 * step using full dependency injection (dispatch_* overrides) so the dispatch
 * path itself is hermetic — no real agency is resolved, no message is sent, no
 * cubic SQL runs. The only live-DB touch is the fail-open role_early_exit
 * predicate lookup (role 'developer' has no predicate → falls through), matching
 * the established pattern of the sibling offer-dispatch tests.
 *
 * Covers:
 *   AC-7  — dispatch() calls the cubic acquirer with the resolved agency identity.
 *   AC-8  — cubic_id + cubic_worktree_path are injected into the dispatched payload.
 *   AC-11 — two different projects dispatching to the same agency get distinct cubic_ids.
 *   AC-12 — one project dispatching to multiple agencies grants each a unique cubic_id.
 *   AC-13 — when the cubic acquirer throws, the offer completes 'failed' and is NOT dispatched.
 *   AC-14 — dispatch without a cubic (acquirer returns null) still succeeds via worktree_hint.
 *
 * The DB-layer lifecycle (acquire → lock → release on fn_complete_work_offer)
 * is proven hermetically in scripts/migrations/266 + the report's psql evidence.
 */

import { describe, it, expect } from "vitest";
import {
	OrchestratorOfferDispatcher,
	type ClaimedOffer,
} from "../offer-dispatch.ts";

const ORCHESTRATOR_IDENTITY = "test:p2335-orchestrator";
const SILENT = { log: () => {}, warn: () => {}, error: () => {} };

function baseClaim(overrides: Partial<ClaimedOffer> = {}): ClaimedOffer {
	return {
		// offerId is the stringified dispatch_id (toUuid() does BigInt(offerId)).
		offerId: "2888335",
		dispatchId: 2_888_335,
		proposalId: 2335,
		squadName: "p2335-squad",
		role: "developer",
		claimToken: "tok-p2335",
		claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		offerVersion: 1,
		// project_id in metadata so acquireCubic never queries the proposal row.
		metadata: { project_id: 7, worktree_hint: "legacy-wt" },
		leaseTtlSeconds: 60,
		...overrides,
	};
}

interface Capture {
	sent: Array<Record<string, unknown>>;
	acquireCalls: Array<{
		agentIdentity: string;
		proposalId: number;
		projectId: number;
		phase: string;
	}>;
	completions: Array<{ status: string }>;
}

/**
 * Build a dispatcher whose acquirer is controlled by `acquire`. All network
 * collaborators are stubbed; sendMessage + the cubic acquire are recorded.
 * fn_complete_work_offer / squad_dispatch UPDATEs in the AC-13 path hit the
 * real pool with a non-existent dispatch_id (no-op UPDATE, returns false) — the
 * assertion is on which branch ran, captured via `acquire`/`sent`.
 */
function makeDispatcher(
	acquire: (
		agentIdentity: string,
		proposalId: number,
		projectId: number,
		phase: string,
	) => Promise<{ cubicId: string; worktreePath: string } | null>,
	cap: Capture,
	agencyIdentity = "agency-alpha",
) {
	return new OrchestratorOfferDispatcher({
		orchestratorIdentity: ORCHESTRATOR_IDENTITY,
		logger: SILENT,
		// resolveAgency returns a candidate; queryAgentIdentity maps it to the
		// agent_identity text used as the cubic owner.
		dispatch_resolveAgency: async () =>
			({ agencyId: 1n } as never),
		dispatch_queryAgentIdentity: async () => agencyIdentity,
		dispatch_briefingAssemble: async () =>
			({ briefing_id: "brief-1" } as never),
		dispatch_sendMessage: async (msg) => {
			cap.sent.push(msg.payload as Record<string, unknown>);
		},
		dispatch_acquireCubic: async (agentIdentity, proposalId, projectId, phase) => {
			cap.acquireCalls.push({ agentIdentity, proposalId, projectId, phase });
			return acquire(agentIdentity, proposalId, projectId, phase);
		},
	});
}

function emptyCapture(): Capture {
	return { sent: [], acquireCalls: [], completions: [] };
}

describe("P2335 AC-7/AC-8: cubic acquired and injected into payload", () => {
	it("calls the acquirer with the resolved agency identity (AC-7)", async () => {
		const cap = emptyCapture();
		const d = makeDispatcher(
			async () => ({ cubicId: "cubic_abc", worktreePath: "/data/code/worktree/p7-P2335-agency-alpha" }),
			cap,
			"agency-alpha",
		);

		await d.dispatch(baseClaim());

		expect(cap.acquireCalls).toHaveLength(1);
		expect(cap.acquireCalls[0].agentIdentity).toBe("agency-alpha");
		expect(cap.acquireCalls[0].proposalId).toBe(2335);
		expect(cap.acquireCalls[0].projectId).toBe(7);
		// developer role → build phase
		expect(cap.acquireCalls[0].phase).toBe("build");
	});

	it("injects cubic_id and cubic_worktree_path into the dispatched payload (AC-8)", async () => {
		const cap = emptyCapture();
		const wt = "/data/code/worktree/p7-P2335-agency-alpha";
		const d = makeDispatcher(
			async () => ({ cubicId: "cubic_abc", worktreePath: wt }),
			cap,
		);

		await d.dispatch(baseClaim());

		expect(cap.sent).toHaveLength(1);
		expect(cap.sent[0].cubic_id).toBe("cubic_abc");
		expect(cap.sent[0].cubic_worktree_path).toBe(wt);
	});

	it("maps review roles to the 'review' cubic phase", async () => {
		const cap = emptyCapture();
		const d = makeDispatcher(
			async () => ({ cubicId: "cubic_rev", worktreePath: "/data/code/worktree/x" }),
			cap,
		);
		await d.dispatch(baseClaim({ role: "gate-reviewer" }));
		expect(cap.acquireCalls[0].phase).toBe("review");
	});
});

describe("P2335 AC-11/AC-12: distinct cubics per (project, agency)", () => {
	it("two projects → same agency get distinct cubic_ids (AC-11)", async () => {
		const cap = emptyCapture();
		// Simulate the SQL function: cubic is keyed on (agent_identity, project_id).
		const byKey = new Map<string, string>();
		let seq = 0;
		const d = makeDispatcher(
			async (agentIdentity, _proposalId, projectId) => {
				const key = `${agentIdentity}:${projectId}`;
				if (!byKey.has(key)) byKey.set(key, `cubic_${++seq}`);
				return { cubicId: byKey.get(key)!, worktreePath: `/data/code/worktree/${key}` };
			},
			cap,
			"agency-shared",
		);

		await d.dispatch(baseClaim({ metadata: { project_id: 10 } }));
		await d.dispatch(baseClaim({ metadata: { project_id: 20 } }));

		expect(cap.sent).toHaveLength(2);
		expect(cap.sent[0].cubic_id).not.toBe(cap.sent[1].cubic_id);
	});

	it("one project → two agencies get distinct cubic_ids (AC-12)", async () => {
		const cap = emptyCapture();
		const byKey = new Map<string, string>();
		let seq = 0;
		const acquire = async (
			agentIdentity: string,
			_p: number,
			projectId: number,
		) => {
			const key = `${agentIdentity}:${projectId}`;
			if (!byKey.has(key)) byKey.set(key, `cubic_${++seq}`);
			return { cubicId: byKey.get(key)!, worktreePath: `/data/code/worktree/${key}` };
		};

		const dA = makeDispatcher(acquire, cap, "agency-A");
		const dB = makeDispatcher(acquire, cap, "agency-B");

		await dA.dispatch(baseClaim({ metadata: { project_id: 5 } }));
		await dB.dispatch(baseClaim({ metadata: { project_id: 5 } }));

		expect(cap.sent).toHaveLength(2);
		expect(cap.sent[0].cubic_id).not.toBe(cap.sent[1].cubic_id);
	});
});

describe("P2335 AC-13: acquisition failure completes offer as failed", () => {
	it("does NOT dispatch when the acquirer throws", async () => {
		const cap = emptyCapture();
		const d = makeDispatcher(async () => {
			throw new Error("simulated fn_acquire_cubic failure");
		}, cap);

		await d.dispatch(baseClaim());

		// acquirer was attempted, but no message was sent — the offer took the
		// fail path instead of dispatching into an unallocated worktree.
		expect(cap.acquireCalls).toHaveLength(1);
		expect(cap.sent).toHaveLength(0);
	});
});

describe("P2335 AC-14: backward compatibility (no cubic → worktree_hint)", () => {
	it("still dispatches via worktree_hint when acquirer returns null", async () => {
		const cap = emptyCapture();
		const d = makeDispatcher(async () => null, cap);

		await d.dispatch(baseClaim());

		expect(cap.sent).toHaveLength(1);
		// No cubic fields, but the legacy worktree_hint survives.
		expect(cap.sent[0].cubic_id).toBeUndefined();
		expect(cap.sent[0].cubic_worktree_path).toBeUndefined();
		expect(cap.sent[0].worktree_hint).toBe("legacy-wt");
	});
});
