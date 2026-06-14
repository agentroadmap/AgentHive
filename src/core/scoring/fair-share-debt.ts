/**
 * P3000 (P2995-AC6): Fair-share DEBT tracker — METER-INDEPENDENT foundation.
 *
 * Anti-starvation accounting measured in dispatch CYCLES, not dollars, so it
 * needs NO cost meter (the per-agent cumulative cost meter is P1018 Phase-1 and
 * is currently absent — see AC-6/AC-10 BLOCKED notes in the proposal).
 *
 * Model:
 *   - Every time an agent's offer is REJECTED (not claimed this cycle), its
 *     cycles_since_dispatch increments by 1.
 *   - On a SUCCESSFUL dispatch, cycles_since_dispatch resets to 0 and the
 *     one-shot reserved-override latch clears.
 *   - When cycles_since_dispatch exceeds the starvation threshold (default 10),
 *     the agent earns a ONE-TIME reserved-slot priority override: its effective
 *     priority_tier is forced to RESERVED_SLOT_TIER (-1), jumping it ahead of
 *     all normal tiers (1..5). The latch makes it fire exactly once per episode.
 *
 * Layering (mirrors reliability-ledger.ts):
 *   - Pure decision logic (no DB)        → unit-testable with zero I/O.
 *   - Thin query functions (injectable)  → overridable in tests with a fake.
 *   - Observability emits routed through the quota metric writer (AC-8).
 *
 * NOT wired into the live claim/dispatch chokepoint here. Any admission hook
 * must sit behind a default-FALSE flag and be a shadow no-op until the meter
 * exists. This module only provides the pure primitives + storage.
 */

import {
	emitQuotaMetric,
	type QuotaMetricEmitter,
} from "../observability/quota-metrics.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cycles-since-dispatch above which an agent is "starved". */
export const DEFAULT_STARVATION_THRESHOLD = 10;

/**
 * Effective priority tier granted to a starved agent for its one-time reserved
 * slot. Lower = higher priority; normal tiers are 1..5, so -1 outranks all.
 */
export const RESERVED_SLOT_TIER = -1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Current persisted debt state for one agent. */
export interface DebtState {
	agentIdentity: string;
	cyclesSinceDispatch: number;
	lastClaimedAt: Date | null;
	/** True if a reserved-slot override is already active (one-shot latch). */
	reservedOverrideActive: boolean;
}

/** Outcome of evaluating whether a starvation override should be granted. */
export interface StarvationDecision {
	/** True if this agent is at/over the starvation threshold. */
	starved: boolean;
	/**
	 * True ONLY on the transition into starvation (latch not yet set). Drives the
	 * one-time reserved-slot grant + the starvation_recovery metric.
	 */
	grantReservedSlot: boolean;
	/** Priority tier to use this cycle: RESERVED_SLOT_TIER when granting, else the agent's normal tier. */
	effectivePriorityTier: number;
}

/**
 * Injectable query function — defaults to the control-plane pool's query() but
 * is overridable in tests with an in-memory fake (no live DB). Mirrors
 * reliability-ledger.ts QueryFn.
 */
export type QueryFn = <T = any>(text: string, params?: any[]) => Promise<{ rows: T[] }>;

let defaultQuery: QueryFn | null = null;

async function getDefaultQuery(): Promise<QueryFn> {
	if (!defaultQuery) {
		const { query } = await import("../../infra/postgres/pool.ts");
		defaultQuery = query as unknown as QueryFn;
	}
	return defaultQuery;
}

// ---------------------------------------------------------------------------
// PURE decision logic (no DB, no I/O) — fully unit-testable
// ---------------------------------------------------------------------------

/** Increment debt by one cycle. Pure. */
export function incrementCycles(state: DebtState): DebtState {
	return { ...state, cyclesSinceDispatch: state.cyclesSinceDispatch + 1 };
}

/** Reset debt to zero and clear the override latch. Pure. */
export function resetDebt(state: DebtState, claimedAt: Date): DebtState {
	return {
		...state,
		cyclesSinceDispatch: 0,
		lastClaimedAt: claimedAt,
		reservedOverrideActive: false,
	};
}

/**
 * Decide whether a starved agent should receive its one-time reserved-slot
 * priority override this cycle. Pure.
 *
 * @param state           current debt state
 * @param normalTier      the agent's configured priority_tier (1..5)
 * @param threshold       starvation threshold (cycles)
 */
export function evaluateStarvation(
	state: DebtState,
	normalTier: number,
	threshold: number = DEFAULT_STARVATION_THRESHOLD,
): StarvationDecision {
	const starved = state.cyclesSinceDispatch > threshold;
	// One-shot: grant only on the transition (not already latched).
	const grantReservedSlot = starved && !state.reservedOverrideActive;
	const effectivePriorityTier =
		starved ? RESERVED_SLOT_TIER : normalTier;
	return { starved, grantReservedSlot, effectivePriorityTier };
}

// ---------------------------------------------------------------------------
// THIN query functions (DB writes isolated here)
// ---------------------------------------------------------------------------

const SCHEMA = "roadmap_workforce";

/** Read the debt row for an agent (null if none yet). */
export async function fetchDebtState(
	agentIdentity: string,
	q?: QueryFn,
): Promise<DebtState | null> {
	const run = q ?? (await getDefaultQuery());
	const { rows } = await run<{
		agent_identity: string;
		cycles_since_dispatch: number;
		last_claimed_at: Date | null;
		reserved_override_active: boolean;
	}>(
		`SELECT agent_identity, cycles_since_dispatch, last_claimed_at, reserved_override_active
		   FROM ${SCHEMA}.fair_share_debt
		  WHERE agent_identity = $1`,
		[agentIdentity],
	);
	if (rows.length === 0) return null;
	const r = rows[0];
	return {
		agentIdentity: r.agent_identity,
		cyclesSinceDispatch: Number(r.cycles_since_dispatch),
		lastClaimedAt: r.last_claimed_at ?? null,
		reservedOverrideActive: Boolean(r.reserved_override_active),
	};
}

/**
 * Record an offer REJECTION: increment cycles_since_dispatch (upsert).
 * Returns the new cycle count.
 */
export async function recordRejection(
	agentIdentity: string,
	q?: QueryFn,
): Promise<number> {
	const run = q ?? (await getDefaultQuery());
	const { rows } = await run<{ cycles_since_dispatch: number }>(
		`INSERT INTO ${SCHEMA}.fair_share_debt (agent_identity, cycles_since_dispatch, updated_at)
		 VALUES ($1, 1, now())
		 ON CONFLICT (agent_identity) DO UPDATE
		   SET cycles_since_dispatch = ${SCHEMA}.fair_share_debt.cycles_since_dispatch + 1,
		       updated_at = now()
		 RETURNING cycles_since_dispatch`,
		[agentIdentity],
	);
	return Number(rows[0]?.cycles_since_dispatch ?? 0);
}

/**
 * Record a SUCCESSFUL dispatch: reset cycles to 0, clear the override latch,
 * stamp last_claimed_at.
 */
export async function recordDispatch(
	agentIdentity: string,
	q?: QueryFn,
): Promise<void> {
	const run = q ?? (await getDefaultQuery());
	await run(
		`INSERT INTO ${SCHEMA}.fair_share_debt
		   (agent_identity, cycles_since_dispatch, last_claimed_at, reserved_override_active, updated_at)
		 VALUES ($1, 0, now(), false, now())
		 ON CONFLICT (agent_identity) DO UPDATE
		   SET cycles_since_dispatch = 0,
		       last_claimed_at = now(),
		       reserved_override_active = false,
		       updated_at = now()`,
		[agentIdentity],
	);
}

/** Latch the one-shot reserved-override flag after a grant. */
export async function markReservedOverrideGranted(
	agentIdentity: string,
	q?: QueryFn,
): Promise<void> {
	const run = q ?? (await getDefaultQuery());
	await run(
		`UPDATE ${SCHEMA}.fair_share_debt
		    SET reserved_override_active = true, updated_at = now()
		  WHERE agent_identity = $1`,
		[agentIdentity],
	);
}

// ---------------------------------------------------------------------------
// Orchestration: evaluate + emit observability (AC-7 + AC-8)
// ---------------------------------------------------------------------------

/**
 * Evaluate starvation for an agent and emit the matching AC-8 metric(s).
 * Pure decision is delegated to evaluateStarvation; this wrapper adds the
 * metric emit (injectable for tests via `emit`).
 *
 * Returns the StarvationDecision so a caller (future, flag-gated, shadow-only)
 * can consume the effective priority tier. It does NOT itself touch the live
 * claim/dispatch path.
 */
export function evaluateStarvationWithMetrics(
	state: DebtState,
	normalTier: number,
	opts?: { threshold?: number; emit?: QuotaMetricEmitter },
): StarvationDecision {
	const decision = evaluateStarvation(state, normalTier, opts?.threshold);
	const emit = opts?.emit ?? emitQuotaMetric;
	if (decision.grantReservedSlot) {
		emit({
			metricName: "quota:starvation_recovery",
			agentIdentity: state.agentIdentity,
			attributes: { cyclesSinceDispatch: state.cyclesSinceDispatch },
		});
		emit({
			metricName: "quota:reserved_headroom_granted",
			agentIdentity: state.agentIdentity,
			attributes: { effectivePriorityTier: decision.effectivePriorityTier },
		});
	}
	return decision;
}
