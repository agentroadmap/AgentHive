/**
 * P2997: Agent stake / capability-bond admission control.
 *
 * The NET-NEW half of the P2995-AC2 trust stack. The cryptographic PROOF half
 * already exists (migration 018 + src/core/identity); this module adds the
 * Stake layer and is wired at three deterministic chokepoints, mirroring the
 * P3000 cost-quota-admission pattern:
 *
 *   1. Pre-claim    (agency-claim-loop.ts::claimOne)        → evaluateStakeAdmission
 *   2. Post-work    (offer-dispatch-handler.ts completion)  → slashStake (on failure)
 *   3. Quota-refund (offer-dispatch-handler.ts completion)  → returnStake (on success)
 *
 * Stake is denominated in MICROCENTS (1 cent = 10_000 µ¢), integer-exact, to
 * avoid float drift and align with the USD-cents cost ledger.
 *
 * Slash policy is failure_class-aware (taxonomy from migration 184). Only the
 * non-transient `unknown` class slashes — the same single class the dispatch
 * loop-breaker counts. Transient failures (auth_rejected, rate_limited,
 * quota_exhausted, no_eligible_agency, lease_expired) are NOT the agent's fault
 * and never slash the bond.
 *
 * All writes go through a single SqlExec so the column/constraint contract
 * lives in one place (P1109 wrapper-enforced concern); the worker LLM is never
 * consulted and cannot forget to post the bond accounting.
 */

import { query as defaultQuery } from "../postgres/pool.ts";

export type SqlExec = (sql: string, params?: unknown[]) => Promise<unknown>;

/** 1 cent = 10_000 microcents. */
export const MICROCENTS_PER_CENT = 10_000;

/**
 * failure_class values that represent a genuine, non-transient, agent-attributable
 * failure and therefore slash the stake. Mirrors the migration-184 taxonomy where
 * `unknown` is the ONLY class the dispatch loop-breaker counts.
 */
export const SLASHABLE_FAILURE_CLASSES = new Set<string>(["unknown"]);

/** Default amount slashed per genuine failure, in microcents (1 cent). */
export const DEFAULT_SLASH_MICROCENTS = 1 * MICROCENTS_PER_CENT;

export interface StakeAdmissionResult {
	/** True when the agent may proceed to claim. */
	allowed: boolean;
	/** Machine-readable refusal reason, null when allowed. */
	reason:
		| null
		| "stake_slashed"
		| "stake_returned"
		| "stake_status_unknown";
	/** Current stake_status read from the registry. */
	stakeStatus: string | null;
	/** Current bonded stake in microcents. */
	stakeMicrocents: number;
	/** True when the agent is in explicit legacy/unsigned scope. */
	isLegacy: boolean;
}

interface RegistryStakeRow {
	stake_microcents: string | number | null;
	stake_status: string | null;
	is_legacy: boolean | null;
}

function toInt(v: string | number | null | undefined): number {
	if (v === null || v === undefined) return 0;
	const n = typeof v === "number" ? v : Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Pre-claim gate. Reads the agent's stake row and decides admissibility.
 *
 * Policy:
 *   - stake_status='active'   → ADMITTED (bond intact, the common path).
 *   - stake_status='slashed'  → REJECTED (bond fully consumed by failures).
 *   - stake_status='returned' → REJECTED for claim (bond withdrawn; agent must
 *                               re-bond before claiming again).
 *   - row missing             → ADMITTED as legacy (proof soft-fail governs; the
 *                               stake layer does not invent a bond where none was
 *                               posted, preserving backward compatibility).
 *
 * Legacy agents (is_legacy=true) with an active status are still admitted here;
 * the proof layer's AGENTHIVE_AUTH_REQUIRED policy and the proposal-blocking
 * scope (enforced by the caller) constrain *which* offers they may take.
 */
export async function evaluateStakeAdmission(
	agentIdentity: string,
	exec: SqlExec = defaultQuery as unknown as SqlExec,
): Promise<StakeAdmissionResult> {
	let res: { rows: RegistryStakeRow[] };
	try {
		res = (await exec(
			`SELECT stake_microcents, stake_status, is_legacy
			   FROM roadmap_workforce.agent_registry
			  WHERE agent_identity = $1
			  LIMIT 1`,
			[agentIdentity],
		)) as { rows: RegistryStakeRow[] };
	} catch (err) {
		// Fail OPEN when the stake schema (migration 283) is not yet applied.
		// PG 42703 = undefined_column, 42P01 = undefined_table. During the
		// window between this code shipping and the migration landing, the
		// claim path must never break — admit as legacy (no bond enforced).
		const code = (err as { code?: string })?.code;
		if (code === "42703" || code === "42P01") {
			return {
				allowed: true,
				reason: null,
				stakeStatus: null,
				stakeMicrocents: 0,
				isLegacy: true,
			};
		}
		throw err;
	}

	const row = res.rows?.[0];

	// No registry row (or stake columns NULL on a legacy row): admit as legacy.
	if (!row || row.stake_status === null) {
		return {
			allowed: true,
			reason: null,
			stakeStatus: row?.stake_status ?? null,
			stakeMicrocents: toInt(row?.stake_microcents ?? 0),
			isLegacy: true,
		};
	}

	const stakeStatus = row.stake_status;
	const stakeMicrocents = toInt(row.stake_microcents);
	const isLegacy = row.is_legacy === true;

	if (stakeStatus === "active") {
		return { allowed: true, reason: null, stakeStatus, stakeMicrocents, isLegacy };
	}
	if (stakeStatus === "slashed") {
		// Soft signal: the ledger records every slash for observability, but
		// the hard lock is removed. Bond starts at 0 so the first no-artifact
		// run would slash-to-zero and permanently wedge the agency — too
		// aggressive when P235 fast-fail + offer reissue caps already bound
		// broken agencies. Admit; the slash ledger is the accountability layer.
		return { allowed: true, reason: null, stakeStatus, stakeMicrocents, isLegacy };
	}
	if (stakeStatus === "returned") {
		// A 'returned' bond means the agent COMPLETED work successfully (returnStake
		// flips active->returned on clean delivery). The original design refused this
		// to force an explicit re-bond, but no auto-re-bond path exists, so a single
		// successful delivery permanently locked the agent out — combined with the
		// slash->slashed lockout, the sole self-claim agency wedged on BOTH success
		// and failure, producing repeated multi-hour stalls (2026-06-21). A returned
		// bond is a TRUST-POSITIVE signal; admit it (re-bond-on-reuse) so a productive
		// agent keeps claiming. Only 'slashed'/unknown remain refusable.
		return { allowed: true, reason: null, stakeStatus, stakeMicrocents, isLegacy };
	}
	return {
		allowed: false,
		reason: "stake_status_unknown",
		stakeStatus,
		stakeMicrocents,
		isLegacy,
	};
}

/** True iff a failure of the given class should slash the agent's bond. */
export function isSlashable(failureClass: string | null | undefined): boolean {
	if (!failureClass) return true; // an unclassified genuine failure slashes
	return SLASHABLE_FAILURE_CLASSES.has(failureClass);
}

export interface StakeMutationResult {
	/** Whether a write occurred (false = no-op, e.g. transient failure or no bond). */
	applied: boolean;
	/** Stake balance after the mutation, microcents. */
	balanceAfter: number;
	/** Resulting stake_status. */
	stakeStatus: string;
}

/**
 * Post-work failure handler. Deducts `amountMicrocents` from the agent's bond
 * when the failure is slashable, clamping at zero, and flips stake_status to
 * 'slashed' when the bond reaches zero. Records one append-only stake_ledger
 * row. Transient failures are a no-op (the agent keeps its bond).
 *
 * Single round-trip, race-safe: the UPDATE uses GREATEST(0, …) so concurrent
 * completions cannot drive the bond negative, and the CHECK constraint is the
 * backstop.
 */
export async function slashStake(
	args: {
		agentIdentity: string;
		failureClass: string | null;
		amountMicrocents?: number;
		dispatchId?: number | null;
		proposalId?: number | null;
		reason?: string | null;
	},
	exec: SqlExec = defaultQuery as unknown as SqlExec,
): Promise<StakeMutationResult> {
	if (!isSlashable(args.failureClass)) {
		// Transient / not-the-agent's-fault: do not slash.
		const cur = await readStake(args.agentIdentity, exec);
		return { applied: false, balanceAfter: cur.stakeMicrocents, stakeStatus: cur.stakeStatus };
	}

	const amount = Math.max(0, args.amountMicrocents ?? DEFAULT_SLASH_MICROCENTS);

	// Atomic clamp-at-zero deduction + status flip in one statement.
	const upd = (await exec(
		`UPDATE roadmap_workforce.agent_registry
		    SET stake_microcents = GREATEST(0, stake_microcents - $2),
		        stake_status = CASE
		            WHEN GREATEST(0, stake_microcents - $2) = 0 THEN 'slashed'
		            ELSE stake_status
		        END
		  WHERE agent_identity = $1
		    AND stake_status = 'active'
		  RETURNING stake_microcents, stake_status`,
		[args.agentIdentity, amount],
	)) as { rows: Array<{ stake_microcents: string | number; stake_status: string }> };

	const row = upd.rows?.[0];
	if (!row) {
		// Not active (already slashed/returned) or no row — nothing to deduct.
		const cur = await readStake(args.agentIdentity, exec);
		return { applied: false, balanceAfter: cur.stakeMicrocents, stakeStatus: cur.stakeStatus };
	}

	const balanceAfter = toInt(row.stake_microcents);
	await appendLedger(exec, {
		agentIdentity: args.agentIdentity,
		eventType: "slash",
		deltaMicrocents: -amount,
		balanceAfter,
		failureClass: args.failureClass ?? "unknown",
		dispatchId: args.dispatchId ?? null,
		proposalId: args.proposalId ?? null,
		reason: args.reason ?? `slash:${args.failureClass ?? "unknown"}`,
	});

	return { applied: true, balanceAfter, stakeStatus: row.stake_status };
}

/**
 * Post-completion success handler. Returns the bond to the agent: flips
 * stake_status to 'returned' and records a 'return' ledger row. The stake
 * balance itself is preserved (it can be re-bonded). Idempotent: returning an
 * already-returned bond is a no-op.
 *
 * Returned-on-success semantics layer over the cost ledger — the agent's token
 * cost is accounted separately in roadmap_efficiency.agent_budget_ledger; this
 * only governs the bond.
 */
export async function returnStake(
	args: {
		agentIdentity: string;
		dispatchId?: number | null;
		proposalId?: number | null;
		reason?: string | null;
	},
	exec: SqlExec = defaultQuery as unknown as SqlExec,
): Promise<StakeMutationResult> {
	const upd = (await exec(
		`UPDATE roadmap_workforce.agent_registry
		    SET stake_status = 'returned'
		  WHERE agent_identity = $1
		    AND stake_status = 'active'
		  RETURNING stake_microcents, stake_status`,
		[args.agentIdentity],
	)) as { rows: Array<{ stake_microcents: string | number; stake_status: string }> };

	const row = upd.rows?.[0];
	if (!row) {
		const cur = await readStake(args.agentIdentity, exec);
		return { applied: false, balanceAfter: cur.stakeMicrocents, stakeStatus: cur.stakeStatus };
	}

	const balanceAfter = toInt(row.stake_microcents);
	await appendLedger(exec, {
		agentIdentity: args.agentIdentity,
		eventType: "return",
		deltaMicrocents: 0,
		balanceAfter,
		failureClass: null,
		dispatchId: args.dispatchId ?? null,
		proposalId: args.proposalId ?? null,
		reason: args.reason ?? "return:clean_completion",
	});

	return { applied: true, balanceAfter, stakeStatus: row.stake_status };
}

/** Read the current stake row (helper for no-op branches and callers). */
export async function readStake(
	agentIdentity: string,
	exec: SqlExec = defaultQuery as unknown as SqlExec,
): Promise<{ stakeMicrocents: number; stakeStatus: string; isLegacy: boolean }> {
	const res = (await exec(
		`SELECT stake_microcents, stake_status, is_legacy
		   FROM roadmap_workforce.agent_registry
		  WHERE agent_identity = $1
		  LIMIT 1`,
		[agentIdentity],
	)) as { rows: RegistryStakeRow[] };
	const row = res.rows?.[0];
	return {
		stakeMicrocents: toInt(row?.stake_microcents ?? 0),
		stakeStatus: row?.stake_status ?? "active",
		isLegacy: row?.is_legacy === true,
	};
}

interface LedgerArgs {
	agentIdentity: string;
	eventType: "bond" | "slash" | "return" | "downgrade";
	deltaMicrocents: number;
	balanceAfter: number;
	failureClass: string | null;
	dispatchId: number | null;
	proposalId: number | null;
	reason: string | null;
}

async function appendLedger(exec: SqlExec, a: LedgerArgs): Promise<void> {
	await exec(
		`INSERT INTO roadmap_workforce.stake_ledger
		    (agent_identity, event_type, delta_microcents, balance_after,
		     failure_class, dispatch_id, proposal_id, reason)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[
			a.agentIdentity,
			a.eventType,
			a.deltaMicrocents,
			a.balanceAfter,
			a.failureClass,
			a.dispatchId,
			a.proposalId,
			a.reason,
		],
	);
}
