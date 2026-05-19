/**
 * P934 — Tests for the canonical release-reason taxonomy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	ALLOWED_RELEASE_REASONS,
	CALLER_RELEASE_REASONS,
	InvalidReleaseReasonError,
	OUTCOME_TO_MATURITY,
	RELEASE_REASONS_BY_OUTCOME,
	assertValidCallerReason,
	maturityFor,
	outcomeOf,
} from "./release-reasons.ts";

test("OUTCOME_TO_MATURITY: P934 contract — work=mature, abandoned=obsolete, incomplete=new, internal=new", () => {
	assert.equal(OUTCOME_TO_MATURITY.work_complete, "mature");
	assert.equal(OUTCOME_TO_MATURITY.abandoned, "obsolete");
	assert.equal(OUTCOME_TO_MATURITY.incomplete, "new");
	assert.equal(OUTCOME_TO_MATURITY.internal, "new");
});

test("ALLOWED_RELEASE_REASONS: every value is short, snake_case, ≤ 64 chars (AC-13 length cap)", () => {
	for (const r of ALLOWED_RELEASE_REASONS) {
		assert.ok(r.length <= 64, `reason "${r}" exceeds 64 chars`);
		assert.match(r, /^[a-z][a-z0-9_]*$/, `reason "${r}" is not snake_case`);
	}
});

test("ALLOWED_RELEASE_REASONS: no duplicates across outcome buckets", () => {
	const seen = new Set<string>();
	for (const r of ALLOWED_RELEASE_REASONS) {
		assert.ok(!seen.has(r), `duplicate reason "${r}" across outcome buckets`);
		seen.add(r);
	}
});

test("CALLER_RELEASE_REASONS: excludes internal trigger-only values", () => {
	for (const internal of RELEASE_REASONS_BY_OUTCOME.internal) {
		assert.ok(
			!CALLER_RELEASE_REASONS.includes(internal),
			`caller reason list must not include trigger-only value "${internal}"`,
		);
	}
});

test("outcomeOf + maturityFor: work_delivered → work_complete → mature", () => {
	assert.equal(outcomeOf("work_delivered"), "work_complete");
	assert.equal(maturityFor("work_delivered"), "mature");
	assert.equal(maturityFor("authored_complete"), "mature");
	assert.equal(maturityFor("gate_review_complete"), "mature");
});

test("outcomeOf + maturityFor: wont_pursue → abandoned → obsolete", () => {
	assert.equal(outcomeOf("wont_pursue"), "abandoned");
	assert.equal(maturityFor("wont_pursue"), "obsolete");
	assert.equal(maturityFor("superseded"), "obsolete");
	assert.equal(maturityFor("out_of_scope"), "obsolete");
});

test("outcomeOf + maturityFor: manual_release → incomplete → new", () => {
	assert.equal(outcomeOf("manual_release"), "incomplete");
	assert.equal(maturityFor("manual_release"), "new");
	assert.equal(maturityFor("lease_expired"), "new");
	assert.equal(maturityFor("gate_hold"), "new");
	assert.equal(maturityFor("force_reclaimed"), "new");
	assert.equal(maturityFor("gate_spawn_failed"), "new");
	assert.equal(maturityFor("gate_dispatch_blocked"), "new");
});

test("outcomeOf + maturityFor: gate_transitioned → internal → new (trigger-only)", () => {
	assert.equal(outcomeOf("gate_transitioned"), "internal");
	assert.equal(maturityFor("gate_transitioned"), "new");
});

test("outcomeOf + maturityFor: unknown reason returns null", () => {
	assert.equal(outcomeOf("released"), null); // legacy default rejected
	assert.equal(outcomeOf("completed"), null); // legacy default rejected
	assert.equal(outcomeOf("force-reclaimed"), null); // hyphen variant rejected
	assert.equal(maturityFor("nonsense"), null);
});

test("assertValidCallerReason: accepts canonical caller reasons", () => {
	assert.doesNotThrow(() => assertValidCallerReason("work_delivered"));
	assert.doesNotThrow(() => assertValidCallerReason("manual_release"));
	assert.doesNotThrow(() => assertValidCallerReason("wont_pursue"));
});

test("assertValidCallerReason: rejects undefined / null / empty", () => {
	assert.throws(
		() => assertValidCallerReason(undefined),
		InvalidReleaseReasonError,
	);
	assert.throws(() => assertValidCallerReason(null), InvalidReleaseReasonError);
	assert.throws(() => assertValidCallerReason(""), InvalidReleaseReasonError);
});

test("assertValidCallerReason: rejects gate_transitioned (trigger-only)", () => {
	assert.throws(
		() => assertValidCallerReason("gate_transitioned"),
		InvalidReleaseReasonError,
	);
});

test("assertValidCallerReason: rejects legacy / unknown reasons", () => {
	assert.throws(
		() => assertValidCallerReason("released"),
		InvalidReleaseReasonError,
	);
	assert.throws(
		() => assertValidCallerReason("completed"),
		InvalidReleaseReasonError,
	);
	assert.throws(
		() => assertValidCallerReason("force-reclaimed"), // hyphen variant
		InvalidReleaseReasonError,
	);
});

test("InvalidReleaseReasonError: error message lists examples + full enum", () => {
	try {
		assertValidCallerReason("nonsense");
		assert.fail("expected throw");
	} catch (e) {
		assert.ok(e instanceof InvalidReleaseReasonError);
		assert.match(e.message, /work_delivered/);
		assert.match(e.message, /manual_release/);
		assert.match(e.message, /wont_pursue/);
		assert.match(e.message, /Full list:/);
	}
});
