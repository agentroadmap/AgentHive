/**
 * P1699 Phase 3: Dynamic usage-driven dispatch capacity controller.
 *
 * Pure-logic core of the AIMD (Additive-Increase / Multiplicative-Decrease)
 * capacity controller. This module computes the effective dispatch cap for an
 * agency from a usage *meter signal* and adjusts it over time in response to
 * spawn outcomes. It deliberately holds NO DB handle and reads NO clock — the
 * caller supplies the signal and the current time, so the whole controller is
 * unit-testable by simulation (the form the ACs ask for).
 *
 * Meter dependency (AC-3): the controller is INERT until the upstream usage
 * meter is available. The meter is fed by P1859 (agent_usage_snapshot) and
 * P1018 (agent_budget_ledger → remaining quota). As of this writing the
 * agent_budget_ledger table is not deployed, so `remainingQuota` is null in
 * production and `nextCapacity()` returns `{ inert: true }` — the loop stays
 * dark exactly as specified, and the live wiring (reading the real ledger and
 * applying the cap at the dispatch sites) is the one remaining blocked AC.
 */

/**
 * The signal the controller consumes each tick. Assembled by the (future) live
 * meter from P1859 + P1018; hand-built in simulation tests.
 */
export interface MeterSignal {
	/**
	 * Remaining quota units for the agency (e.g. tokens left in the window).
	 * `null` means the meter is unavailable (P1018 ledger absent) — the controller
	 * treats this as "no signal" and stays inert.
	 */
	remainingQuota: number | null;
	/** Epoch ms until which a route/provider cooldown is in effect, or null. */
	cooldownUntil: number | null;
	/** Epoch ms until which the agency's auth is known down, or null. */
	authDownUntil: number | null;
	/** Recent spawn failure rate in [0, 1]. */
	failureRate: number;
}

/** Spawn outcome events that drive the AIMD adjustment. */
export type CapacityEvent = "completion" | "sigterm" | "failure";

/** Tuning for the AIMD control law. All bounds are inclusive. */
export interface AimdConfig {
	/** Hard upper bound on capacity (typically provider_registry.max_in_flight). */
	ceiling: number;
	/** Lower bound on capacity. Defaults to 0 (fully throttled). */
	floor?: number;
	/** Multiplicative-decrease factor in (0, 1). Applied on sigterm/failure. */
	decreaseFactor: number;
	/** Additive-increase step (>= 1). Applied on completion. */
	increaseStep: number;
}

const DEFAULT_FLOOR = 0;

/** Clamp `n` into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

/**
 * AC-3 gate: is the usage meter available? The controller only runs when the
 * remaining-quota signal is present (P1018 ledger live). A missing or negative
 * signal keeps the loop inert.
 */
export function isMeterAvailable(signal: MeterSignal | null): boolean {
	return (
		signal != null &&
		signal.remainingQuota != null &&
		Number.isFinite(signal.remainingQuota) &&
		signal.remainingQuota >= 0
	);
}

/**
 * AC-1 formula: effective cap = min(max_in_flight, floor(remaining_quota *
 * target_quota_pct)), never below zero. Pure function of its inputs; the knob
 * (target_quota_pct, default 0.98) visibly changes the computed cap.
 */
export function computeEffectiveCap(
	maxInFlight: number,
	remainingQuota: number,
	targetQuotaPct: number,
): number {
	const quotaBound = Math.floor(remainingQuota * targetQuotaPct);
	return Math.max(0, Math.min(maxInFlight, quotaBound));
}

/**
 * AC-5 control law: one AIMD step.
 *  - `completion` → additive increase: current + increaseStep, capped at ceiling.
 *  - `sigterm` / `failure` → multiplicative decrease: floor(current * factor),
 *    not below the floor.
 * Result is always within [floor, ceiling].
 */
export function aimdNext(
	current: number,
	event: CapacityEvent,
	cfg: AimdConfig,
): number {
	const floor = cfg.floor ?? DEFAULT_FLOOR;
	let next: number;
	if (event === "completion") {
		next = current + cfg.increaseStep;
	} else {
		// sigterm or failure → multiplicative decrease
		next = Math.floor(current * cfg.decreaseFactor);
	}
	return clamp(next, floor, cfg.ceiling);
}

export interface NextCapacityInput {
	/** Current AIMD capacity estimate (carried across ticks). */
	current: number;
	/** The latest meter signal, or null if unavailable. */
	signal: MeterSignal | null;
	/** Most recent spawn outcome to apply, or null for a no-event refresh. */
	event: CapacityEvent | null;
	/** Per-agency hard ceiling (max_in_flight). */
	maxInFlight: number;
	/** Hot-reloadable knob ORCHESTRATOR_TARGET_QUOTA_PCT (default 0.98). */
	targetQuotaPct: number;
	/** AIMD tuning (decreaseFactor / increaseStep / floor). */
	aimd: Omit<AimdConfig, "ceiling">;
	/** Current epoch ms — supplied by the caller (no clock read here). */
	nowMs: number;
}

export interface NextCapacityResult {
	/** The capacity to enforce this tick. 0 while inert. */
	cap: number;
	/** True when the meter is unavailable / forced down — loop stays dark. */
	inert: boolean;
	/** Human-readable reason for the decision. */
	reason: string;
}

/**
 * Top-level controller tick. Combines the meter gate (AC-3), the quota formula
 * (AC-1), and the AIMD law (AC-5):
 *
 *  1. No meter → inert (cap 0, loop dark). This is the live production state.
 *  2. Auth down or in cooldown → forced to floor (active backpressure).
 *  3. Otherwise → AIMD-adjust `current` for the event, then clamp to the
 *     quota-derived effective cap.
 */
export function nextCapacity(input: NextCapacityInput): NextCapacityResult {
	const { signal, maxInFlight, targetQuotaPct, aimd, nowMs } = input;

	if (!isMeterAvailable(signal)) {
		return {
			cap: 0,
			inert: true,
			reason: "meter unavailable (P1859/P1018 signal absent) — controller inert",
		};
	}
	// isMeterAvailable guarantees remainingQuota is a finite number >= 0.
	const remainingQuota = (signal as MeterSignal).remainingQuota as number;
	const effectiveCap = computeEffectiveCap(
		maxInFlight,
		remainingQuota,
		targetQuotaPct,
	);
	const cfg: AimdConfig = { ...aimd, ceiling: effectiveCap };
	const floor = cfg.floor ?? DEFAULT_FLOOR;

	const authDown =
		signal!.authDownUntil != null && signal!.authDownUntil > nowMs;
	const cooling =
		signal!.cooldownUntil != null && signal!.cooldownUntil > nowMs;
	if (authDown || cooling) {
		return {
			cap: floor,
			inert: false,
			reason: authDown
				? `auth down until ${signal!.authDownUntil} — forced to floor ${floor}`
				: `cooldown until ${signal!.cooldownUntil} — forced to floor ${floor}`,
		};
	}

	const adjusted =
		input.event == null
			? clamp(input.current, floor, effectiveCap)
			: aimdNext(input.current, input.event, cfg);

	return {
		cap: adjusted,
		inert: false,
		reason: `aimd ${input.event ?? "refresh"} → cap ${adjusted} (effective ${effectiveCap}, remaining ${remainingQuota})`,
	};
}
