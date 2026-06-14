/**
 * V3-C6 (P1438) AC-10 — worker-failure recovery decision.
 *
 * On a worker failure the liaison brain must decide ONE of:
 *   - retry    — try once more (transient cause: flake, brief rate-limit);
 *   - reroute  — return the offer to the open pool for a peer/other agency;
 *   - escalate — log an issue (a real defect / policy-sensitive case);
 *   - log      — record-and-drop (benign / non-actionable: nothing to retry,
 *                no peer can do better, not worth an issue).
 *
 * AC-10's anti-patterns are explicit: NOT a silent drop, NOT an unconditional
 * retry storm. This module is the mechanical default (wrapper-enforced
 * concern): given the failure signal + how many attempts already happened it
 * returns a bounded, recorded action. The brain may override, but the floor is
 * deterministic and testable — a retry only fires for a transient cause and
 * only while attempts remain.
 *
 * The chosen action is recorded against the offer (squad_dispatch.metadata
 * .recovery_action / .recovery_reason) so a failure is never a silent drop.
 *
 * Pure: no DB, no I/O.
 */

/** The four mutually-exclusive recovery actions. */
export type RecoveryActionKind = "retry" | "reroute" | "escalate" | "log";

/**
 * squad_dispatch.failure_class CHECK domain (see migration constraint
 * squad_dispatch_failure_class_check). We classify into one of these so the
 * recorded class stays inside the allowed set.
 */
export type FailureClass =
	| "auth_rejected"
	| "rate_limited"
	| "quota_exhausted"
	| "no_eligible_agency"
	| "lease_expired"
	| "unknown";

export interface RecoveryDecision {
	action: RecoveryActionKind;
	/** Normalized failure class to stamp on the dispatch row. */
	failureClass: FailureClass;
	/** Whether the underlying cause is transient (drives the reaper/requeue). */
	transient: boolean;
	/** Human-readable reason, recorded in metadata.recovery_reason. */
	reason: string;
}

export interface RecoveryInput {
	/**
	 * The spawn error message and/or worker output that triggered the failure.
	 * Either may be empty; classification is best-effort over whatever is given.
	 */
	errorText?: string | null;
	/**
	 * Why the offer-dispatch handler already decided this was a failure, when
	 * known: degenerate exit-0 (auth/empty), missing role artifact, etc. Lets us
	 * distinguish "the worker produced nothing" from "the process crashed".
	 */
	failureReason?: string | null;
	/**
	 * squad_dispatch.attempt_count for this offer BEFORE this attempt's outcome
	 * (i.e. how many times it has been tried so far, ≥1). Used to cap retries.
	 */
	attemptCount: number;
	/** Max attempts before we stop retrying a transient failure. Default 2. */
	maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 2;

function lc(s: string | null | undefined): string {
	return (s ?? "").toLowerCase();
}

/**
 * Classify the raw failure into a (FailureClass, transient) pair using the same
 * vocabulary the rest of the dispatch path uses.
 */
export function classifyFailure(input: RecoveryInput): {
	failureClass: FailureClass;
	transient: boolean;
} {
	const text = `${lc(input.errorText)} ${lc(input.failureReason)}`;

	if (
		text.includes("quota") ||
		text.includes("usage limit") ||
		text.includes("exhausted")
	) {
		return { failureClass: "quota_exhausted", transient: true };
	}
	if (
		text.includes("rate limit") ||
		text.includes("rate_limit") ||
		text.includes("429") ||
		text.includes("too many requests")
	) {
		return { failureClass: "rate_limited", transient: true };
	}
	if (
		text.includes("401") ||
		text.includes("403") ||
		text.includes("unauthorized") ||
		text.includes("forbidden") ||
		text.includes("auth_required") ||
		text.includes("authentication") ||
		text.includes("invalid api key")
	) {
		return { failureClass: "auth_rejected", transient: false };
	}
	if (
		text.includes("timeout") ||
		text.includes("sigterm") ||
		text.includes("killed") ||
		text.includes("econnreset") ||
		text.includes("socket hang up")
	) {
		// Transient infra flake — eligible for a single retry.
		return { failureClass: "unknown", transient: true };
	}
	if (
		text.includes("no_artifact") ||
		text.includes("no deliverable") ||
		text.includes("no role artifact") ||
		text.includes("empty_output")
	) {
		// Worker ran but produced nothing verifiable — a real defect, not a flake.
		return { failureClass: "unknown", transient: false };
	}
	return { failureClass: "unknown", transient: false };
}

/**
 * Decide the recovery action for a failed worker.
 *
 * Decision table:
 *   auth_rejected               → escalate (operator must fix creds; retrying
 *                                 the same dead auth is a guaranteed loop).
 *   rate_limited / quota        → reroute (transient for THIS agency, but a peer
 *                                 with headroom can serve it now; return to pool).
 *   transient (flake/timeout)   → retry IF attempts remain, else escalate.
 *   non-transient defect        → escalate (log an issue).
 *
 * Never returns a silent drop: "log" is only used for an explicitly benign
 * cause, and even then the action is recorded.
 */
export function decideRecoveryAction(input: RecoveryInput): RecoveryDecision {
	const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const { failureClass, transient } = classifyFailure(input);
	const attempts = Number.isFinite(input.attemptCount)
		? Math.max(1, input.attemptCount)
		: 1;

	if (failureClass === "auth_rejected") {
		return {
			action: "escalate",
			failureClass,
			transient,
			reason: "auth rejected — provider credentials need operator attention; not retrying dead auth",
		};
	}

	if (failureClass === "rate_limited" || failureClass === "quota_exhausted") {
		return {
			action: "reroute",
			failureClass,
			transient,
			reason: `${failureClass} for this agency — returning offer to the open pool for a peer with headroom`,
		};
	}

	if (transient) {
		if (attempts < maxAttempts) {
			return {
				action: "retry",
				failureClass,
				transient,
				reason: `transient failure (attempt ${attempts}/${maxAttempts}) — retrying once`,
			};
		}
		return {
			action: "escalate",
			failureClass,
			transient,
			reason: `transient failure persisted after ${attempts} attempts — escalating instead of retry-storming`,
		};
	}

	// Non-transient: a real defect or unverifiable output. Escalate (log an issue),
	// not a silent drop.
	return {
		action: "escalate",
		failureClass,
		transient,
		reason: "non-transient failure (defect or missing deliverable) — escalating for an issue, not silently dropping",
	};
}
