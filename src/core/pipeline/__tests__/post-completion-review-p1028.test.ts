/**
 * P1028 — Post-Completion Review unit tests.
 *
 * Pure logic, no DB: all side-effects are injected fakes. Covers AC-4 (scan +
 * storm cap), AC-5 (idempotency key + version + 3-attempt throttle), AC-6
 * (confirmed→validated, low-confidence reschedule), AC-7 (follow_on child).
 *
 * Run: node --import jiti/register --test src/core/pipeline/__tests__/post-completion-review-p1028.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	applyPostReviewVerdict,
	computePostReviewIdempotencyKey,
	POST_REVIEW_MAX_ATTEMPTS,
	POST_REVIEW_ROLE,
	POST_REVIEW_STORM_CAP,
	runPostReviewScanTick,
	selectDuePostReviewProposals,
	type ApplyVerdictDeps,
	type PostReviewCandidate,
	type PostReviewQueryFn,
} from "../post-completion-review.ts";

const silentLogger = { log() {}, warn() {} };

function makeCandidate(over: Partial<PostReviewCandidate> = {}): PostReviewCandidate {
	return {
		id: over.id ?? 100,
		display_id: over.display_id ?? "P100",
		review_scheduled_at: over.review_scheduled_at ?? "2026-06-15T00:00:00.000Z",
		review_version: over.review_version ?? 1,
	};
}

describe("P1028 idempotency key (AC-5)", () => {
	it("is deterministic for identical inputs", () => {
		const a = computePostReviewIdempotencyKey({ proposalId: 7, reviewScheduledAt: "t", reviewVersion: 1 });
		const b = computePostReviewIdempotencyKey({ proposalId: 7, reviewScheduledAt: "t", reviewVersion: 1 });
		assert.equal(a, b);
	});

	it("differs when review_version changes (reschedule yields distinct offer)", () => {
		const v1 = computePostReviewIdempotencyKey({ proposalId: 7, reviewScheduledAt: "t", reviewVersion: 1 });
		const v2 = computePostReviewIdempotencyKey({ proposalId: 7, reviewScheduledAt: "t", reviewVersion: 2 });
		assert.notEqual(v1, v2);
	});

	it("differs when review_scheduled_at changes", () => {
		const t1 = computePostReviewIdempotencyKey({ proposalId: 7, reviewScheduledAt: "t1", reviewVersion: 1 });
		const t2 = computePostReviewIdempotencyKey({ proposalId: 7, reviewScheduledAt: "t2", reviewVersion: 1 });
		assert.notEqual(t1, t2);
	});
});

describe("P1028 selectDue + scan tick (AC-4)", () => {
	it("queries with status COMPLETE/enable/verdict-null filters and respects storm cap param", async () => {
		let capturedSql = "";
		let capturedParams: unknown[] = [];
		const q: PostReviewQueryFn = async (sql, params) => {
			capturedSql = sql;
			capturedParams = params ?? [];
			return { rows: [] };
		};
		await selectDuePostReviewProposals(q);
		assert.match(capturedSql, /status = 'COMPLETE'/);
		assert.match(capturedSql, /enable_post_review = true/);
		assert.match(capturedSql, /review_verdict IS NULL/);
		assert.match(capturedSql, /review_scheduled_at <= now\(\)/);
		assert.equal(capturedParams[0], POST_REVIEW_STORM_CAP);
		assert.equal(capturedParams[1], POST_REVIEW_MAX_ATTEMPTS);
	});

	it("posts one offer per due proposal with the version-bearing idempotency key", async () => {
		const due = [makeCandidate({ id: 1, display_id: "P1", review_version: 3 }), makeCandidate({ id: 2, display_id: "P2" })];
		const q: PostReviewQueryFn = async () => ({ rows: due });
		const posted: Array<{ cand: PostReviewCandidate; key: string }> = [];
		const res = await runPostReviewScanTick(q, async (cand, key) => { posted.push({ cand, key }); }, silentLogger);
		assert.equal(res.scanned, 2);
		assert.equal(res.posted, 2);
		assert.equal(res.failed, 0);
		// key for P1 must reflect review_version=3
		const expectedKey = computePostReviewIdempotencyKey({ proposalId: 1, reviewScheduledAt: due[0].review_scheduled_at, reviewVersion: 3 });
		assert.equal(posted[0].key, expectedKey);
	});

	it("a single failing post does not abort the batch", async () => {
		const due = [makeCandidate({ id: 1 }), makeCandidate({ id: 2 })];
		const q: PostReviewQueryFn = async () => ({ rows: due });
		let n = 0;
		const res = await runPostReviewScanTick(q, async () => {
			n += 1;
			if (n === 1) throw new Error("boom");
		}, silentLogger);
		assert.equal(res.posted, 1);
		assert.equal(res.failed, 1);
	});

	it("storm cap is 10", () => {
		assert.equal(POST_REVIEW_STORM_CAP, 10);
	});

	it("offer role is post-completion-review", () => {
		assert.equal(POST_REVIEW_ROLE, "post-completion-review");
	});
});

// ── Verdict harness: records UPDATEs + injected side-effects ──────────────────
function makeVerdictDeps(over: { attempts?: number } = {}) {
	const updates: Array<{ sql: string; params: unknown[] }> = [];
	const validated: Array<{ id: number; reason: string }> = [];
	const children: Array<{ parentId: number; title: string; scope: string }> = [];
	let attempts = over.attempts ?? 0;
	const q: PostReviewQueryFn = async (sql, params) => {
		updates.push({ sql, params: params ?? [] });
		if (/SELECT review_attempts/.test(sql)) {
			return { rows: [{ review_attempts: attempts }] as never[] };
		}
		return { rows: [] };
	};
	const deps: ApplyVerdictDeps = {
		queryFn: q,
		actor: "test-reviewer",
		logger: silentLogger,
		markValidated: async (id, _a, reason) => { validated.push({ id, reason }); },
		createFollowOnChild: async (input) => { children.push(input); return 999; },
	};
	return { deps, updates, validated, children, setAttempts: (a: number) => { attempts = a; } };
}

describe("P1028 verdict: confirmed (AC-6)", () => {
	it("confidence >= 0.7 → validated + review_verdict=confirmed", async () => {
		const h = makeVerdictDeps();
		const res = await applyPostReviewVerdict(5, "P5", { verdict: "confirmed", confidence: 0.9, gaps: [] }, h.deps);
		assert.equal(res.action, "validated");
		assert.equal(h.validated.length, 1);
		assert.equal(h.validated[0].id, 5);
		assert.ok(h.updates.some((u) => /review_verdict = 'confirmed'/.test(u.sql)));
	});

	it("confidence < 0.7 → reschedules instead of validating", async () => {
		const h = makeVerdictDeps({ attempts: 0 });
		const res = await applyPostReviewVerdict(5, "P5", { verdict: "confirmed", confidence: 0.5, gaps: [] }, h.deps);
		assert.equal(res.action, "rescheduled");
		assert.equal(h.validated.length, 0);
	});

	it("rejects malformed payload", async () => {
		const h = makeVerdictDeps();
		const res = await applyPostReviewVerdict(5, "P5", { verdict: "bogus" }, h.deps);
		assert.equal(res.action, "rejected");
	});
});

describe("P1028 verdict: needs_iteration throttle (AC-5)", () => {
	it("reschedules with version bump on early attempts", async () => {
		const h = makeVerdictDeps({ attempts: 0 });
		const res = await applyPostReviewVerdict(5, "P5", { verdict: "needs_iteration", confidence: 0.4, gaps: ["x"] }, h.deps);
		assert.equal(res.action, "rescheduled");
		assert.ok(h.updates.some((u) => /review_version = review_version \+ 1/.test(u.sql)));
		assert.ok(h.updates.some((u) => /review_scheduled_at = now\(\) \+/.test(u.sql)));
	});

	it("escalates to operator at the final attempt (no further reschedule)", async () => {
		// attempts already 2 → nextAttempt 3 >= MAX(3) → escalate
		const h = makeVerdictDeps({ attempts: POST_REVIEW_MAX_ATTEMPTS - 1 });
		const res = await applyPostReviewVerdict(5, "P5", { verdict: "needs_iteration", confidence: 0.4, gaps: ["x"] }, h.deps);
		assert.equal(res.action, "escalated");
		// records the verdict + bumped attempts, but does NOT clear review_verdict back to NULL
		assert.ok(h.updates.some((u) => /review_verdict = 'needs_iteration'/.test(u.sql)));
		assert.ok(!h.updates.some((u) => /review_verdict = NULL/.test(u.sql)));
	});
});

describe("P1028 verdict: follow_on (AC-7)", () => {
	it("creates a child proposal and validates the parent", async () => {
		const h = makeVerdictDeps();
		const res = await applyPostReviewVerdict(5, "P5", {
			verdict: "follow_on",
			confidence: 0.8,
			gaps: ["scaling"],
			follow_on_title: "Scale the thing",
			follow_on_scope: "Handle 10x load",
		}, h.deps);
		assert.equal(res.action, "follow_on");
		assert.equal(res.childProposalId, 999);
		assert.equal(h.children.length, 1);
		assert.equal(h.children[0].parentId, 5);
		assert.equal(h.children[0].title, "Scale the thing");
		assert.equal(h.validated.length, 1, "parent should be validated");
		assert.ok(h.updates.some((u) => /review_verdict = 'follow_on'/.test(u.sql)));
	});

	it("synthesizes title/scope from gaps when not provided", async () => {
		const h = makeVerdictDeps();
		const res = await applyPostReviewVerdict(5, "P5", {
			verdict: "follow_on", confidence: 0.8, gaps: ["regression in X"],
		}, h.deps);
		assert.equal(res.action, "follow_on");
		assert.match(h.children[0].title, /Follow-on for P5/);
		assert.match(h.children[0].scope, /regression in X/);
	});
});
