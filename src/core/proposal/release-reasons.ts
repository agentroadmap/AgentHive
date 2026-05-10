/**
 * P934 — Lease release semantics: canonical taxonomy.
 *
 * A lease release is a lifecycle decision, not a cleanup action. Every
 * `proposal_lease.release_reason` value MUST come from this enum so
 * `fn_lease_clear_maturity_on_release` can deterministically map it to
 * the next maturity. No defaults, no fall-through, no silent demotion.
 *
 * The trigger function performs the same mapping in SQL (see migration
 * 128-p934-release-reason-taxonomy.sql); this TS file is the source of
 * truth. Any change here MUST land alongside a migration that updates the
 * SQL CASE in `fn_lease_clear_maturity_on_release` plus the CHECK
 * constraint on `proposal_lease.release_reason`.
 *
 * P934 ACs covered: AC-3 (taxonomy in one source of truth), AC-4
 * (deterministic mapping, no fall-through), AC-13 (length cap — every
 * value here is well under 64 chars).
 */

/** Lifecycle outcome buckets. The releaser declares which bucket they're in. */
export type ReleaseOutcome = "work_complete" | "abandoned" | "incomplete" | "internal";

/** Next maturity each outcome maps to (per P934 design contract). */
export const OUTCOME_TO_MATURITY: Record<ReleaseOutcome, "mature" | "obsolete" | "new"> = {
	work_complete: "mature",
	abandoned: "obsolete",
	incomplete: "new",
	internal: "new",
};

/**
 * Canonical release reasons grouped by outcome.
 * Each value is a stable, short snake_case identifier safe for length-cap
 * CHECK (max observed value 23 chars; cap is 128).
 */
export const RELEASE_REASONS_BY_OUTCOME = {
	/**
	 * The releaser finished the work the lease was for; proposal is gate-ready
	 * for the next stage. Trigger sets maturity='mature'.
	 */
	work_complete: [
		"work_delivered",         // generic completion
		"gate_review_complete",   // gate-agent finished a review pass
		"authored_complete",      // operator/author finished design + ACs
	],

	/**
	 * The releaser explicitly gives up; proposal exits the active corpus.
	 * Trigger sets maturity='obsolete' (and proposal stays out of the queue).
	 */
	abandoned: [
		"wont_pursue",            // operator decision: not going to pursue
		"superseded",             // replaced by a different proposal
		"out_of_scope",           // determined to be out of scope after investigation
	],

	/**
	 * Work isn't done but releaser can't continue. Proposal returns to the
	 * queue. Trigger sets maturity='new'.
	 */
	incomplete: [
		"gate_hold",              // gate verdict: hold for revision
		"gate_reject",            // gate verdict: reject; needs different approach
		"lease_expired",          // TTL expired without explicit release
		"manual_release",         // operator manually released; explicit incomplete
		"released_unfinished",    // releaser is done for now but work isn't
		"reassigned",             // lease reassigned to another agent
		"force_reclaimed",        // admin reclaimed the lease (e.g. stuck agent)
		"operator_cancelled",     // operator cancelled the task mid-flight
		"operator_terminated",    // operator killed the spawned agent
		"gate_dispatch_blocked",  // gate dispatch failed (CLI exited non-zero)
		"gate_spawn_failed",      // spawn-time policy violation or route error
	],

	/**
	 * Set ONLY by `trg_release_leases_on_transition` when a status change
	 * auto-releases the lease. The proposal already moved past the stage; the
	 * trigger keeps maturity='new' for the new stage. No operator intent
	 * involved. Callers MUST NOT pass this value directly.
	 */
	internal: [
		"gate_transitioned",
	],
} as const satisfies Record<ReleaseOutcome, readonly string[]>;

/** Flat list of every allowed reason. */
export const ALLOWED_RELEASE_REASONS: readonly string[] = Object.values(
	RELEASE_REASONS_BY_OUTCOME,
).flat();

/** Reasons callers may pass directly. Excludes `internal` (trigger-only). */
export const CALLER_RELEASE_REASONS: readonly string[] = (
	["work_complete", "abandoned", "incomplete"] as const
).flatMap((b) => RELEASE_REASONS_BY_OUTCOME[b]);

/** Reverse map: reason → outcome. */
const REASON_TO_OUTCOME: Record<string, ReleaseOutcome> = Object.fromEntries(
	(Object.entries(RELEASE_REASONS_BY_OUTCOME) as Array<
		[ReleaseOutcome, readonly string[]]
	>).flatMap(([outcome, reasons]) => reasons.map((r) => [r, outcome] as const)),
);

/** Look up the outcome bucket for a reason. Returns null for unknown. */
export function outcomeOf(reason: string): ReleaseOutcome | null {
	return REASON_TO_OUTCOME[reason] ?? null;
}

/** Look up the next maturity for a reason. Returns null for unknown. */
export function maturityFor(reason: string): "mature" | "obsolete" | "new" | null {
	const o = outcomeOf(reason);
	return o ? OUTCOME_TO_MATURITY[o] : null;
}

/**
 * Validate a caller-supplied reason. Throws with a structured error message
 * when the reason is unknown or is `gate_transitioned` (trigger-only).
 *
 * Use this at every API boundary before passing the reason to releaseLease /
 * the underlying UPDATE. Loud rejection beats silent demotion.
 */
export class InvalidReleaseReasonError extends Error {
	constructor(public readonly received: string | undefined | null) {
		const examples = [
			"work_delivered (work-complete → maturity=mature)",
			"manual_release (incomplete → maturity=new)",
			"wont_pursue (abandoned → maturity=obsolete)",
		];
		super(
			`[P934] Invalid release_reason: ${JSON.stringify(received)}. ` +
				`Required, must be one of the canonical values. Examples: ${examples.join("; ")}. ` +
				`Full list: ${CALLER_RELEASE_REASONS.join(", ")}.`,
		);
		this.name = "InvalidReleaseReasonError";
	}
}

export function assertValidCallerReason(
	reason: string | undefined | null,
): asserts reason is string {
	if (typeof reason !== "string" || reason.length === 0) {
		throw new InvalidReleaseReasonError(reason);
	}
	if (reason === "gate_transitioned") {
		throw new InvalidReleaseReasonError(reason);
	}
	if (!CALLER_RELEASE_REASONS.includes(reason)) {
		throw new InvalidReleaseReasonError(reason);
	}
}
