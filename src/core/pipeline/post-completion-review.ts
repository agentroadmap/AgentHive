/**
 * P1028 — Post-Completion Review Sessions
 *
 * Closes the feedback loop from delivery back into the proposal corpus. When a
 * proposal reaches COMPLETE, migration 283's trigger stamps review_scheduled_at
 * = now() + review_delay_hours. Once that time arrives, the orchestrator's
 * 15-minute maintenance tick (runPostReviewScanTick) posts a work offer with
 * role='post-completion-review'. A skeptic/validator agent re-evaluates the
 * delivered work against its original ACs in the live environment and returns a
 * structured verdict. applyPostReviewVerdict() persists the outcome:
 *
 *   - 'confirmed'        → maturity='validated', review_verdict='confirmed'
 *   - 'needs_iteration'  → review_verdict='needs_iteration', bump review_version,
 *                          reschedule +24h. Capped at 3 attempts (72h dwell);
 *                          the 3rd failure escalates to operator instead.
 *   - 'follow_on'        → spawn a child DRAFT proposal (parent=this, child_of,
 *                          enable_post_review=false), then set parent
 *                          maturity='validated'.
 *
 * Boundary vs P242: P242 owns the DEVELOP→REVIEW re-evaluation; this module owns
 * the COMPLETE→validated post-validation. Distinct columns, distinct offer role,
 * no collision (see P1028 design § Boundary).
 *
 * All DB access goes through an injected QueryFn so the logic is unit-testable
 * without a live Postgres.
 */

import { createHash } from "node:crypto";

/** Minimal query interface — matches both the pooled poolQuery and a fake. */
export type PostReviewQueryFn = <T = Record<string, unknown>>(
	sql: string,
	params?: unknown[],
) => Promise<{ rows: T[] }>;

export interface PostReviewLogger {
	log: (msg: string) => void;
	warn: (msg: string) => void;
}

/** Role used for the deferred review work offer (AC-4). */
export const POST_REVIEW_ROLE = "post-completion-review";

/** Max review offers posted per scan tick (AC-4). */
export const POST_REVIEW_STORM_CAP = 10;

/**
 * Max needs_iteration reschedules before escalating to the operator (AC-5).
 * After this many attempts (72h dwell at +24h each) we stop rescheduling.
 */
export const POST_REVIEW_MAX_ATTEMPTS = 3;

/** Hours to defer a needs_iteration re-review (AC-5). */
export const POST_REVIEW_RESCHEDULE_HOURS = 24;

export type PostReviewVerdict = "confirmed" | "needs_iteration" | "follow_on";

/** Structured verdict returned by the review agent (AC-6). */
export interface ReviewVerdictPayload {
	verdict: PostReviewVerdict;
	confidence: number;
	gaps: string[];
	follow_on_title?: string;
	follow_on_scope?: string;
}

export interface PostReviewCandidate {
	id: number;
	display_id: string;
	review_scheduled_at: string;
	review_version: number;
}

/**
 * AC-5: deterministic idempotency key for a post-review offer. Includes
 * review_scheduled_at AND review_version so that a needs_iteration reschedule
 * (which bumps version AND pushes review_scheduled_at forward) produces a
 * DISTINCT key — preventing the ON CONFLICT(idempotency_key) path from
 * deduping a legitimately-new review against a prior attempt.
 */
export function computePostReviewIdempotencyKey(parts: {
	proposalId: number;
	reviewScheduledAt: string;
	reviewVersion: number;
}): string {
	const raw = [
		"post-completion-review",
		parts.proposalId,
		parts.reviewScheduledAt,
		parts.reviewVersion,
	].join(":");
	return createHash("sha256").update(raw).digest("hex");
}

/**
 * AC-4: select COMPLETE proposals whose review window has opened and that have
 * no verdict yet, capped at STORM_CAP. enable_post_review filters out the
 * hotfix/issue exemption (AC-2/AC-11) and any operator opt-out.
 */
export async function selectDuePostReviewProposals(
	queryFn: PostReviewQueryFn,
	stormCap: number = POST_REVIEW_STORM_CAP,
): Promise<PostReviewCandidate[]> {
	const { rows } = await queryFn<PostReviewCandidate>(
		`SELECT id,
		        display_id,
		        review_scheduled_at,
		        review_version
		   FROM roadmap_proposal.proposal
		  WHERE status = 'COMPLETE'
		    AND enable_post_review = true
		    AND review_scheduled_at IS NOT NULL
		    AND review_scheduled_at <= now()
		    AND review_verdict IS NULL
		    AND review_attempts < $2
		  ORDER BY review_scheduled_at ASC
		  LIMIT $1`,
		[stormCap, POST_REVIEW_MAX_ATTEMPTS],
	);
	return rows;
}

/** Caller-supplied offer poster — wraps postWorkOffer() so this module stays
 *  decoupled from the offer pipeline's heavy imports and is trivially fakeable. */
export type PostReviewOfferPoster = (
	candidate: PostReviewCandidate,
	idempotencyKey: string,
) => Promise<void>;

export interface PostReviewScanResult {
	scanned: number;
	posted: number;
	failed: number;
}

/**
 * AC-4: the 15-minute maintenance tick body. Selects due proposals and posts a
 * review offer for each, capped at STORM_CAP. Resilient: a single failed post
 * does not abort the batch.
 */
export async function runPostReviewScanTick(
	queryFn: PostReviewQueryFn,
	postOffer: PostReviewOfferPoster,
	logger: PostReviewLogger = console,
	tag = "PostReview",
): Promise<PostReviewScanResult> {
	const result: PostReviewScanResult = { scanned: 0, posted: 0, failed: 0 };
	let due: PostReviewCandidate[];
	try {
		due = await selectDuePostReviewProposals(queryFn);
	} catch (err) {
		logger.warn(
			`[${tag}] scan tick: select failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return result;
	}
	result.scanned = due.length;
	for (const cand of due) {
		const key = computePostReviewIdempotencyKey({
			proposalId: cand.id,
			reviewScheduledAt: cand.review_scheduled_at,
			reviewVersion: cand.review_version,
		});
		try {
			await postOffer(cand, key);
			result.posted += 1;
		} catch (err) {
			result.failed += 1;
			logger.warn(
				`[${tag}] post offer failed for ${cand.display_id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (result.posted > 0 || result.failed > 0) {
		logger.log(
			`[${tag}] scan tick: ${result.scanned} due, ${result.posted} offers posted, ${result.failed} failed`,
		);
	}
	return result;
}

export interface ApplyVerdictDeps {
	queryFn: PostReviewQueryFn;
	/** Promotes a COMPLETE proposal to maturity='validated' through the same
	 *  guarded path the MCP handler uses (records audit + attribution). */
	markValidated: (proposalId: number, actor: string, reason: string) => Promise<void>;
	/** Creates a child DRAFT proposal (AC-7). Returns the new proposal id. */
	createFollowOnChild: (input: {
		parentId: number;
		title: string;
		scope: string;
	}) => Promise<number>;
	/** Identity recorded for the verdict-driven writes. */
	actor: string;
	logger?: PostReviewLogger;
}

export interface ApplyVerdictResult {
	action: "validated" | "rescheduled" | "escalated" | "follow_on" | "rejected";
	childProposalId?: number;
	detail: string;
}

/** Confidence floor for a 'confirmed' verdict to count (AC-6). */
export const POST_REVIEW_CONFIRM_CONFIDENCE = 0.7;

function isValidVerdict(p: unknown): p is ReviewVerdictPayload {
	if (!p || typeof p !== "object") return false;
	const v = p as Record<string, unknown>;
	if (v.verdict !== "confirmed" && v.verdict !== "needs_iteration" && v.verdict !== "follow_on") {
		return false;
	}
	if (typeof v.confidence !== "number" || v.confidence < 0 || v.confidence > 1) return false;
	if (!Array.isArray(v.gaps)) return false;
	return true;
}

/**
 * AC-6/AC-7: apply a review agent's structured verdict to a COMPLETE proposal.
 * Pure decision logic + a small number of injected side-effects, so unit tests
 * can assert each branch without a DB.
 */
export async function applyPostReviewVerdict(
	proposalId: number,
	displayId: string,
	payload: unknown,
	deps: ApplyVerdictDeps,
): Promise<ApplyVerdictResult> {
	const logger = deps.logger ?? console;
	if (!isValidVerdict(payload)) {
		return {
			action: "rejected",
			detail: `malformed verdict payload for ${displayId}: ${JSON.stringify(payload)}`,
		};
	}
	const v = payload;

	// ── confirmed ──────────────────────────────────────────────────────────
	if (v.verdict === "confirmed") {
		if (v.confidence < POST_REVIEW_CONFIRM_CONFIDENCE) {
			// Low-confidence "confirmed" is treated as needs_iteration (AC-5/AC-6
			// drawback mitigation: don't validate on weak evidence).
			return reschedule(proposalId, displayId, deps, logger,
				`confirmed but confidence ${v.confidence} < ${POST_REVIEW_CONFIRM_CONFIDENCE}`);
		}
		await deps.queryFn(
			`UPDATE roadmap_proposal.proposal SET review_verdict = 'confirmed', modified_at = now() WHERE id = $1`,
			[proposalId],
		);
		await deps.markValidated(proposalId, deps.actor, `post-review confirmed (confidence ${v.confidence})`);
		return { action: "validated", detail: `${displayId} confirmed → validated` };
	}

	// ── needs_iteration ───────────────────────────────────────────────────
	if (v.verdict === "needs_iteration") {
		return reschedule(proposalId, displayId, deps, logger,
			`needs_iteration: ${v.gaps.join("; ") || "(no gaps listed)"}`);
	}

	// ── follow_on ─────────────────────────────────────────────────────────
	const title = v.follow_on_title?.trim() || `Follow-on for ${displayId}`;
	const scope = v.follow_on_scope?.trim() || `Address post-completion gaps: ${v.gaps.join("; ")}`;
	const childId = await deps.createFollowOnChild({ parentId: proposalId, title, scope });
	await deps.queryFn(
		`UPDATE roadmap_proposal.proposal SET review_verdict = 'follow_on', modified_at = now() WHERE id = $1`,
		[proposalId],
	);
	await deps.markValidated(proposalId, deps.actor, `post-review follow_on → child proposal id=${childId}`);
	logger.log(`[PostReview] ${displayId} follow_on → child id=${childId}, parent validated`);
	return {
		action: "follow_on",
		childProposalId: childId,
		detail: `${displayId} follow_on → child id=${childId}; parent validated`,
	};
}

/**
 * needs_iteration reschedule with the 3-attempt throttle (AC-5). Bumps
 * review_version (new idempotency key), pushes review_scheduled_at +24h, and
 * increments review_attempts. On the final allowed attempt, escalates to the
 * operator instead of rescheduling (leaves review_verdict='needs_iteration' so
 * the scan's review_attempts<MAX filter excludes it).
 */
async function reschedule(
	proposalId: number,
	displayId: string,
	deps: ApplyVerdictDeps,
	logger: PostReviewLogger,
	reason: string,
): Promise<ApplyVerdictResult> {
	const { rows } = await deps.queryFn<{ review_attempts: number }>(
		`SELECT review_attempts FROM roadmap_proposal.proposal WHERE id = $1`,
		[proposalId],
	);
	const attempts = Number(rows[0]?.review_attempts ?? 0);
	const nextAttempt = attempts + 1;

	if (nextAttempt >= POST_REVIEW_MAX_ATTEMPTS) {
		// Final attempt exhausted — escalate, do not reschedule further. Record the
		// verdict + bump attempts so selectDue's review_attempts<MAX filter excludes it.
		await deps.queryFn(
			`UPDATE roadmap_proposal.proposal
			    SET review_verdict = 'needs_iteration',
			        review_attempts = $2,
			        modified_at = now()
			  WHERE id = $1`,
			[proposalId, nextAttempt],
		);
		logger.warn(
			`[PostReview] ${displayId} needs_iteration exhausted ${POST_REVIEW_MAX_ATTEMPTS} attempts — escalating to operator (${reason})`,
		);
		return {
			action: "escalated",
			detail: `${displayId} escalated after ${nextAttempt} attempts: ${reason}`,
		};
	}

	await deps.queryFn(
		`UPDATE roadmap_proposal.proposal
		    SET review_verdict = NULL,
		        review_version = review_version + 1,
		        review_attempts = $2,
		        review_scheduled_at = now() + ($3 * interval '1 hour'),
		        modified_at = now()
		  WHERE id = $1`,
		[proposalId, nextAttempt, POST_REVIEW_RESCHEDULE_HOURS],
	);
	logger.log(
		`[PostReview] ${displayId} rescheduled +${POST_REVIEW_RESCHEDULE_HOURS}h (attempt ${nextAttempt}/${POST_REVIEW_MAX_ATTEMPTS}): ${reason}`,
	);
	return {
		action: "rescheduled",
		detail: `${displayId} rescheduled +${POST_REVIEW_RESCHEDULE_HOURS}h (attempt ${nextAttempt}): ${reason}`,
	};
}
