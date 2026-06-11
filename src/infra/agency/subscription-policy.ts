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
import { query } from "../postgres/pool.ts";

export type WindowKind = "5h" | "daily" | "weekly" | "monthly" | "custom";
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

// ── ClaimCostEstimate ─────────────────────────────────────────────────────────

export interface ClaimCostEstimate {
	tokens: number;
	requests: number;
}

// ── CapacityCheckResult ───────────────────────────────────────────────────────

export interface CapacityCheckResult {
	allowed: boolean;
	/** Set when refused: 'throttle:<window_kind>' */
	refuse_reason?: string;
	/** Timestamp when the tightest window resets (safe to re-check after this). */
	throttle_until?: Date;
}

// ── Window boundary helpers ───────────────────────────────────────────────────

/**
 * Compute the start of the current window (UTC-aligned).
 * e.g. for '5h' at 14:30 → 10:00 today.
 */
export function computeWindowStart(
	windowKind: WindowKind,
	now: Date = new Date(),
): Date {
	const d = new Date(now);
	switch (windowKind) {
		case "5h": {
			const boundary = Math.floor(d.getUTCHours() / 5) * 5;
			d.setUTCHours(boundary, 0, 0, 0);
			return d;
		}
		case "daily": {
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
		case "weekly": {
			// ISO week starts Monday; we use Sunday=0 convention for simplicity
			d.setUTCDate(d.getUTCDate() - d.getUTCDay());
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
		case "monthly": {
			d.setUTCDate(1);
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
		default: {
			// custom: treat as daily boundary
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
	}
}

/**
 * Compute when the current window expires (next boundary after `now`).
 * e.g. for 'daily' at 14:30 → midnight tonight.
 */
export function computeWindowResetAt(
	windowKind: WindowKind,
	now: Date = new Date(),
): Date {
	const d = new Date(now);
	switch (windowKind) {
		case "5h": {
			const nextBoundaryH = (Math.floor(d.getUTCHours() / 5) + 1) * 5;
			if (nextBoundaryH >= 24) {
				d.setUTCDate(d.getUTCDate() + 1);
				d.setUTCHours(0, 0, 0, 0);
			} else {
				d.setUTCHours(nextBoundaryH, 0, 0, 0);
			}
			return d;
		}
		case "daily": {
			d.setUTCDate(d.getUTCDate() + 1);
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
		case "weekly": {
			const daysUntilNextSunday = 7 - d.getUTCDay();
			d.setUTCDate(d.getUTCDate() + daysUntilNextSunday);
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
		case "monthly": {
			d.setUTCMonth(d.getUTCMonth() + 1, 1);
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
		default: {
			// custom: treat as daily boundary
			d.setUTCDate(d.getUTCDate() + 1);
			d.setUTCHours(0, 0, 0, 0);
			return d;
		}
	}
}

// ── AC-3: Policy evaluation ───────────────────────────────────────────────────

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
	exec: SqlExec = query as SqlExec,
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
 * Internal interface for full capacity config with windows.
 */
interface FullCapacityConfig {
	windows: WindowConfig[];
	safety_margin: number;
	refuse_below_slots: number;
}

interface WindowConfig {
	window_kind: WindowKind;
	quota_tokens?: number;
	quota_requests?: number;
}

/**
 * Internal: Load full capacity config including windows for getCapacityEnvelope.
 * Three-tier fallback (per-agency, provider defaults, built-in defaults).
 * Returns null when no config is found.
 */
async function loadFullCapacityConfig(
	agencyId: string,
	exec: SqlExec = query as SqlExec,
): Promise<FullCapacityConfig | null> {
	// Tier 1: per-agency config
	try {
		const result = (await exec(
			`SELECT windows, safety_margin, refuse_below_slots
			 FROM roadmap.agency_capacity_config
			 WHERE agency_id = $1`,
			[agencyId],
		)) as
			| {
					rows: Array<{
						windows: unknown;
						safety_margin: string | number;
						refuse_below_slots: number;
					}>;
			  }
			| undefined;
		const row = result?.rows?.[0];
		if (row) {
			const rawWindows = Array.isArray(row.windows) ? (row.windows as WindowConfig[]) : [];
			return {
				windows: rawWindows,
				safety_margin: typeof row.safety_margin === "string"
					? parseFloat(row.safety_margin)
					: row.safety_margin,
				refuse_below_slots: row.refuse_below_slots,
			};
		}
	} catch {
		// Schema drift — fall through to tier 2
	}

	// Tier 2: provider defaults (not implemented yet)
	// Tier 3: built-in defaults
	return null;
}

/**
 * Internal: Load usage for a specific window.
 */
async function loadWindowUsage(
	agencyId: string,
	windowKind: string,
	windowStart: Date,
	exec: SqlExec = query as SqlExec,
): Promise<{ used_tokens: number; used_requests: number; source: string }> {
	try {
		const result = (await exec(
			`SELECT used_tokens, used_requests, source
			 FROM roadmap.agency_usage_meter
			 WHERE agency_id = $1 AND window_kind = $2 AND window_start = $3`,
			[agencyId, windowKind, windowStart.toISOString()],
		)) as
			| {
					rows: Array<{
						used_tokens: string | number;
						used_requests: string | number;
						source: string;
					}>;
			  }
			| undefined;
		if ((result?.rows?.length ?? 0) === 0) {
			return { used_tokens: 0, used_requests: 0, source: "local_meter" };
		}
		const row = result!.rows![0];
		return {
			used_tokens: typeof row.used_tokens === "string"
				? parseInt(row.used_tokens, 10)
				: row.used_tokens,
			used_requests: typeof row.used_requests === "string"
				? parseInt(row.used_requests, 10)
				: row.used_requests,
			source: row.source,
		};
	} catch {
		return { used_tokens: 0, used_requests: 0, source: "local_meter" };
	}
}

/**
 * Read per-agency policy config from agency_capacity_config. Falls back to
 * defaults when the row is missing or the query fails.
 */
export async function loadCapacityConfig(
	agencyId: string,
	exec: SqlExec = query as SqlExec,
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
	exec: SqlExec = query as SqlExec,
	logger: Pick<Console, "log" | "warn" | "error"> = console,
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
	exec: SqlExec = query as SqlExec,
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

/**
 * Record usage in the local meter (all applicable windows for this agency).
 * Upserts to ensure idempotent accumulation within the same window boundary.
 */
export async function recordUsage(
	agencyId: string,
	tokensUsed: number,
	requestsUsed: number = 1,
	exec: SqlExec = query,
): Promise<void> {
	const config = await loadFullCapacityConfig(agencyId, exec);
	if (!config || config.windows.length === 0) return;

	const now = new Date();
	for (const wc of config.windows) {
		const windowStart = computeWindowStart(wc.window_kind, now);
		await exec(
			`INSERT INTO roadmap.agency_usage_meter
			        (agency_id, window_kind, window_start, used_tokens, used_requests, source, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'local_meter', now())
			 ON CONFLICT (agency_id, window_kind, window_start)
			 DO UPDATE SET
			   used_tokens   = roadmap.agency_usage_meter.used_tokens   + EXCLUDED.used_tokens,
			   used_requests = roadmap.agency_usage_meter.used_requests + EXCLUDED.used_requests,
			   updated_at    = now()`,
			[agencyId, wc.window_kind, windowStart.toISOString(), tokensUsed, requestsUsed],
		);
	}
}

/**
 * Restore the agency to active once the throttle window has passed.
 * No-op when the agency is not currently throttled.
 */
export async function clearThrottleIfExpired(
	agencyId: string,
	exec: SqlExec = query,
): Promise<boolean> {
	const result = await exec(
		`UPDATE roadmap.agency
		    SET status          = 'active',
		        status_reason   = 'Quota window reset',
		        throttled_until = NULL
		  WHERE agency_id = $1
		    AND status = 'throttled'
		    AND throttled_until IS NOT NULL
		    AND throttled_until <= now()
		  RETURNING agency_id`,
		[agencyId],
	);
	return (result.rowCount ?? 0) > 0;
}

/**
 * Record that a hard provider limit (429) was hit (AC-6).
 * Sets paused_at_provider_limit=true and provider_limit_paused_at on the dispatch row,
 * and writes a claim_paused message to message_ledger for the orchestrator.
 */
export async function recordProviderHardLimit(
	agencyId: string,
	dispatchId: number,
	resumeEligibleAt: Date,
	exec: SqlExec = query,
): Promise<void> {
	await exec(
		`UPDATE roadmap_workforce.squad_dispatch
		    SET paused_at_provider_limit = true,
		        provider_limit_paused_at = now(),
		        metadata = COALESCE(metadata, '{}'::jsonb)
		                   || jsonb_build_object('resume_eligible_at', $3::text)
		  WHERE id = $1 AND agent_identity = $2`,
		[dispatchId, agencyId, resumeEligibleAt.toISOString()],
	);

	// Best-effort notification to orchestrator channel
	try {
		await exec(
			`INSERT INTO roadmap.message_ledger
			        (from_agent, channel, message_content, message_type, metadata)
			 VALUES ($1, 'system:operator', $2, 'alert', $3)`,
			[
				agencyId,
				`Claim paused at provider hard limit for dispatch ${dispatchId}`,
				JSON.stringify({
					kind: "claim_paused",
					dispatch_id: dispatchId,
					agency_id: agencyId,
					reason: "provider_hard_limit",
					resume_eligible_at: resumeEligibleAt.toISOString(),
				}),
			],
		);
	} catch {
		/* best-effort */
	}
}

/**
 * Build the full CapacityEnvelope for an agency.
 * Returns null when no config is registered (unconstrained).
 */
export async function getCapacityEnvelope(
	agencyId: string,
	exec: SqlExec = query,
): Promise<CapacityEnvelope | null> {
	const config = await loadFullCapacityConfig(agencyId, exec);
	if (!config) return null;

	const now = new Date();
	const windows: SubscriptionWindow[] = [];

	for (const wc of config.windows) {
		const windowStart = computeWindowStart(wc.window_kind, now);
		const resets_at = computeWindowResetAt(wc.window_kind, now);
		const usage = await loadWindowUsage(agencyId, wc.window_kind, windowStart, exec);

		windows.push({
			window_kind: wc.window_kind as "5h" | "daily" | "weekly" | "monthly" | "custom",
			resets_at,
			quota_tokens: wc.quota_tokens,
			quota_requests: wc.quota_requests,
			used_tokens: usage.used_tokens,
			used_requests: usage.used_requests,
			source: usage.source as SubscriptionWindow["source"],
		});
	}

	const { rows: inFlightRows } = await exec<{ cnt: string }>(
		`SELECT COUNT(*) AS cnt
		   FROM roadmap_workforce.squad_dispatch
		  WHERE agent_identity = $1
		    AND offer_status = 'claimed'
		    AND completed_at IS NULL`,
		[agencyId],
	);
	const in_flight_claims = Number(inFlightRows[0]?.cnt ?? 0);

	return {
		agency_id: agencyId,
		windows,
		free_claim_slots: Math.max(0, config.refuse_below_slots - in_flight_claims),
		in_flight_claims,
		last_updated_at: now,
	};
}

/**
 * Check whether the agency has quota capacity to absorb a new claim.
 *
 * Iterates all configured windows; if any window's projected remaining
 * fraction after spending `cost` falls below `safety_margin`, the check
 * fails and returns the tightest (soonest-resetting) window as the basis
 * for `throttle_until`.
 *
 * Returns `{ allowed: true }` when no config exists (unconstrained).
 */
export async function checkCapacityBeforeClaim(
	agencyId: string,
	cost?: ClaimCostEstimate,
	exec: SqlExec = query,
): Promise<CapacityCheckResult> {
	const config = await loadFullCapacityConfig(agencyId, exec);
	if (!config || config.windows.length === 0) {
		return { allowed: true };
	}

	const effectiveCost: ClaimCostEstimate = cost ?? {
		tokens: 50_000,
		requests: 1,
	};

	const now = new Date();
	// Track the window that is tightest (soonest to reset) that triggered refusal
	let tightest: { window_kind: string; resets_at: Date } | null = null;

	for (const wc of config.windows) {
		const windowStart = computeWindowStart(wc.window_kind, now);
		const resets_at = computeWindowResetAt(wc.window_kind, now);
		const usage = await loadWindowUsage(agencyId, wc.window_kind, windowStart, exec);

		// Token quota check
		if (wc.quota_tokens != null && wc.quota_tokens > 0) {
			const remaining = wc.quota_tokens - usage.used_tokens;
			const projected = remaining - effectiveCost.tokens;
			const margin = projected / wc.quota_tokens;
			if (margin < config.safety_margin) {
				if (!tightest || resets_at < tightest.resets_at) {
					tightest = { window_kind: wc.window_kind, resets_at };
				}
			}
		}

		// Request quota check
		if (wc.quota_requests != null && wc.quota_requests > 0) {
			const remaining = wc.quota_requests - usage.used_requests;
			const projected = remaining - effectiveCost.requests;
			const margin = projected / wc.quota_requests;
			if (margin < config.safety_margin) {
				if (!tightest || resets_at < tightest.resets_at) {
					tightest = { window_kind: wc.window_kind, resets_at };
				}
			}
		}
	}

	if (tightest) {
		return {
			allowed: false,
			refuse_reason: `throttle:${tightest.window_kind}`,
			throttle_until: tightest.resets_at,
		};
	}

	return { allowed: true };
}
