/**
 * P465: Subscription-aware claim policy for liaisons.
 *
 * Before a liaison accepts an offer_dispatch it checks whether any active
 * subscription window (5h / daily / weekly / monthly) is below the
 * configured safety margin. If so, the offer is returned and the agency
 * self-declares throttled until the tightest window resets.
 *
 * Three-layer fallback for window data (AC-5):
 *   1. provider_api  — future P1018/P1022; stub returns null today
 *   2. local_meter   — agency.metadata.capacity_envelope written by heartbeat
 *   3. manual        — no windows configured → no constraint → allow
 *
 * Decision rule (per operator policy):
 *   resetSeconds <= SHORT_WINDOW_SECONDS → throttle route only (short window)
 *   resetSeconds  > SHORT_WINDOW_SECONDS → throttle route + pause agency (long window)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * P465 AC-9: Finish-in-flight invariant
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Throttle blocks NEW claims but allows in-flight runs to finish:
 *
 * 1. NEW CLAIM BLOCKED (at claim evaluation time):
 *    - claimOne() in agency-claim-loop.ts calls evaluateSubscriptionPolicy()
 *      BEFORE calling fn_claim_work_offer
 *    - If refused: return null (no claim made) + declareThrottle()
 *    - If allowed: proceed to fn_claim_work_offer and spawn
 *
 * 2. OFFER DISPATCH RETURNED (when offer arrives at handler):
 *    - handleOfferDispatch() calls evaluateSubscriptionPolicy()
 *      BEFORE spawning
 *    - If refused: call fn_return_work_offer() + declareThrottle()
 *      → offer goes back to pool for other agencies
 *    - If allowed: proceed to spawn + renew + complete
 *
 * 3. IN-FLIGHT RUN CONTINUES (once claimed):
 *    - Once an offer is claimed (fn_claim_work_offer succeeded), the claim
 *      holds a dispatch_id and claim_token
 *    - Lease renewal fires independently in runSpawn's renewalTimer loop
 *      (line ~388 in offer-dispatch-handler.ts)
 *    - declareThrottle() only touches agency.status and metadata;
 *      it does NOT interrupt active leases or kill spawns
 *    - fn_complete_work_offer() is called normally when spawn exits
 *      (line ~554 in offer-dispatch-handler.ts)
 *    - Result: in-flight run completes undisturbed
 *
 * This design avoids the failure mode where a half-done proposal is abandoned
 * because the agency hit a soft margin during a long operation.
 *
 * See tests/p465-finish-in-flight.test.ts for verification.
 */

import { SHORT_WINDOW_SECONDS } from "./usage-limit-detector.ts";

export type WindowKind = "5h" | "daily" | "weekly" | "monthly";
export type WindowSource = "provider_api" | "local_meter" | "manual";

// ── AC-1: SubscriptionWindow ──────────────────────────────────────────────────

export interface SubscriptionWindow {
	window_kind: WindowKind;
	/** When this quota window resets. */
	resets_at: Date;
	/** Null = unlimited. */
	quota_tokens: number | null;
	/** Null = unlimited. */
	quota_requests: number | null;
	used_tokens: number;
	used_requests: number;
	source: WindowSource;
}

// ── AC-2: CapacityEnvelope ────────────────────────────────────────────────────

export interface CapacityEnvelope {
	agency_id: string;
	windows: SubscriptionWindow[];
	free_claim_slots: number;
	in_flight_claims: number;
	last_updated_at: Date;
}

// ── Policy config (AC-7/AC-8) ─────────────────────────────────────────────────

export interface PolicyConfig {
	safety_margin: number;
	refuse_below_slots: number;
}

export const DEFAULT_SAFETY_MARGIN = 0.15;
export const DEFAULT_REFUSE_BELOW_SLOTS = 1;

// ── AC-3: Policy evaluation ───────────────────────────────────────────────────

export interface PolicyResult {
	allowed: boolean;
	tightest_window: WindowKind | null;
	resets_at: Date | null;
	/** Human-readable reason logged on refusal. */
	reason: string | null;
}

/**
 * Pure function: evaluate whether a new claim is allowed given the current
 * capacity envelope and policy config. No DB calls — inject pre-loaded data.
 *
 * estimated_tokens defaults to 0 when the caller doesn't have a cost estimate;
 * a zero estimate still catches windows where used ≥ quota * (1 - safety_margin).
 */
export function evaluatePolicy(
	envelope: CapacityEnvelope,
	config: PolicyConfig,
	estimated_tokens = 0,
): PolicyResult {
	if (envelope.free_claim_slots < config.refuse_below_slots) {
		return {
			allowed: false,
			tightest_window: null,
			resets_at: null,
			reason: `free_claim_slots=${envelope.free_claim_slots} < refuse_below_slots=${config.refuse_below_slots}`,
		};
	}

	let tightest: SubscriptionWindow | null = null;
	let lowestMargin = 1.0;

	for (const win of envelope.windows) {
		// Token quota check
		if (win.quota_tokens !== null && win.quota_tokens > 0) {
			const remaining = win.quota_tokens - win.used_tokens;
			const projected = remaining - estimated_tokens;
			const margin = projected / win.quota_tokens;
			if (margin < lowestMargin) {
				lowestMargin = margin;
				tightest = win;
			}
		}
		// Request quota check (each claim = 1 request)
		if (win.quota_requests !== null && win.quota_requests > 0) {
			const remaining = win.quota_requests - win.used_requests;
			const projected = remaining - 1;
			const margin = projected / win.quota_requests;
			if (margin < lowestMargin) {
				lowestMargin = margin;
				tightest = win;
			}
		}
	}

	if (lowestMargin < config.safety_margin) {
		return {
			allowed: false,
			tightest_window: tightest?.window_kind ?? null,
			resets_at: tightest?.resets_at ?? null,
			reason: `margin=${lowestMargin.toFixed(3)} < safety_margin=${config.safety_margin} (window=${tightest?.window_kind})`,
		};
	}

	return { allowed: true, tightest_window: null, resets_at: null, reason: null };
}

// ── SqlExec type alias (mirrors offer-dispatch-handler) ───────────────────────

export type SqlExec = (sql: string, params?: unknown[]) => Promise<unknown>;

// ── AC-5: Three-layer envelope loader ─────────────────────────────────────────

/**
 * Load the capacity envelope for an agency using the three-layer fallback.
 *
 * Returns null when no envelope is available (no constraint → allow the claim).
 * Never throws — errors are swallowed and null is returned so a transient DB
 * issue never blocks a claim.
 */
export async function loadCapacityEnvelope(
	agencyId: string,
	exec: SqlExec,
): Promise<CapacityEnvelope | null> {
	// Layer 1: provider_api — deferred to P1018/P1022; no-op today
	// (stub: returns null, falls through)

	// Layer 2: local_meter — read from agency.metadata.capacity_envelope
	try {
		const result = (await exec(
			`SELECT metadata->'capacity_envelope' AS envelope
			 FROM roadmap.agency WHERE agency_id = $1`,
			[agencyId],
		)) as { rows: Array<{ envelope: unknown }> } | undefined;

		const raw = result?.rows?.[0]?.envelope;
		if (raw && typeof raw === "object" && raw !== null) {
			return parseRawEnvelope(agencyId, raw as Record<string, unknown>);
		}
	} catch {
		// fall through to layer 3
	}

	// Layer 3: manual — no envelope stored → no configured constraint → allow
	return null;
}

/**
 * Parse a raw JSONB envelope from agency.metadata into the domain type.
 * Missing or malformed fields are given safe defaults.
 */
function parseRawEnvelope(
	agencyId: string,
	raw: Record<string, unknown>,
): CapacityEnvelope {
	const rawWindows = Array.isArray(raw.windows) ? raw.windows : [];
	const windows: SubscriptionWindow[] = [];

	for (const w of rawWindows) {
		if (!w || typeof w !== "object") continue;
		const win = w as Record<string, unknown>;
		try {
			windows.push({
				window_kind: win.window_kind as WindowKind,
				resets_at: new Date(win.resets_at as string),
				quota_tokens: win.quota_tokens != null ? Number(win.quota_tokens) : null,
				quota_requests:
					win.quota_requests != null ? Number(win.quota_requests) : null,
				used_tokens: Number(win.used_tokens ?? 0),
				used_requests: Number(win.used_requests ?? 0),
				source: (win.source as WindowSource) ?? "local_meter",
			});
		} catch {
			// skip malformed window entries
		}
	}

	return {
		agency_id: agencyId,
		windows,
		free_claim_slots: Number(raw.free_claim_slots ?? 999),
		in_flight_claims: Number(raw.in_flight_claims ?? 0),
		last_updated_at: raw.last_updated_at
			? new Date(raw.last_updated_at as string)
			: new Date(),
	};
}

// ── AC-7/AC-8: Config loader ──────────────────────────────────────────────────

/**
 * Read per-agency policy config from agency_capacity_config. Falls back to
 * defaults when the row is missing or the query fails.
 */
export async function loadCapacityConfig(
	agencyId: string,
	exec: SqlExec,
): Promise<PolicyConfig> {
	try {
		const result = (await exec(
			`SELECT safety_margin, refuse_below_slots
			 FROM roadmap.agency_capacity_config
			 WHERE agency_id = $1`,
			[agencyId],
		)) as
			| {
					rows: Array<{
						safety_margin: number;
						refuse_below_slots: number;
					}>;
			  }
			| undefined;
		const row = result?.rows?.[0];
		if (row) {
			return {
				safety_margin: Number(row.safety_margin),
				refuse_below_slots: row.refuse_below_slots,
			};
		}
	} catch {
		// fall through to defaults
	}
	return {
		safety_margin: DEFAULT_SAFETY_MARGIN,
		refuse_below_slots: DEFAULT_REFUSE_BELOW_SLOTS,
	};
}

// ── Combined evaluator (used by offer-dispatch-handler) ───────────────────────

/**
 * Load envelope + config and evaluate policy. Returns allowed=true on any
 * error so a transient DB issue never blocks a claim.
 */
export async function evaluateSubscriptionPolicy(
	agencyId: string,
	exec: SqlExec,
	logger: Pick<Console, "log" | "warn" | "error">,
	estimatedTokens = 0,
): Promise<PolicyResult> {
	try {
		const [envelope, config] = await Promise.all([
			loadCapacityEnvelope(agencyId, exec),
			loadCapacityConfig(agencyId, exec),
		]);
		if (envelope === null) {
			return { allowed: true, tightest_window: null, resets_at: null, reason: null };
		}
		return evaluatePolicy(envelope, config, estimatedTokens);
	} catch (err) {
		logger.warn(
			`[SubscriptionPolicy] ${agencyId}: evaluation failed; allowing claim:`,
			err instanceof Error ? err.message : err,
		);
		return { allowed: true, tightest_window: null, resets_at: null, reason: null };
	}
}

// ── AC-4: Throttle declaration ────────────────────────────────────────────────

/**
 * Set agency.status = 'throttled' and record the reset timestamp in metadata.
 * Also sets metadata.throttled_reason so operators can see why.
 *
 * Uses isLongWindow() to decide whether to also pause the agency (long window =
 * pause so other agencies pick up the requeued offer).
 */
export async function declareThrottle(
	agencyId: string,
	resetsAt: Date | null,
	reason: string,
	exec: SqlExec,
): Promise<void> {
	const untilIso = resetsAt?.toISOString() ?? null;
	const resetSeconds = resetsAt
		? Math.ceil((resetsAt.getTime() - Date.now()) / 1000)
		: null;
	const isLong = resetSeconds === null || resetSeconds > SHORT_WINDOW_SECONDS;

	if (isLong && untilIso !== null) {
		// Long window: pause the agency so the orchestrator re-routes
		await exec(
			`UPDATE roadmap.agency
			    SET status = 'throttled',
			        status_reason = $2,
			        metadata = metadata || jsonb_build_object(
			          'throttled_until', to_jsonb($3::text),
			          'throttled_reason', to_jsonb($2::text),
			          'paused_until', to_jsonb($3::text),
			          'pause_reason', to_jsonb($2::text),
			          'paused_at', to_jsonb(now()::text)
			        )
			  WHERE agency_id = $1`,
			[agencyId, reason, untilIso],
		);
	} else {
		// Short window: throttle only (agency stays in pool but this route is slow)
		await exec(
			`UPDATE roadmap.agency
			    SET status = 'throttled',
			        status_reason = $2,
			        metadata = metadata || jsonb_build_object(
			          'throttled_until', to_jsonb($3::text),
			          'throttled_reason', to_jsonb($2::text)
			        )
			  WHERE agency_id = $1`,
			[agencyId, reason, untilIso ?? "null"],
		);
	}
}
