/**
 * P4996 (V3.1-S1): Builder≠decider independence on the PUSH path.
 *
 * The authoritative enforcement is the claim-time invariant in
 * fn_claim_work_offer (migration 316, "Gate 6b"): an agency that built a proposal
 * cannot CLAIM that proposal's `decide` (gate-decision) offer. This module mirrors
 * the SAME check on the orchestrator PUSH path (offer-dispatch-handler) so that
 * independence holds regardless of whether work arrives via pull-claim or
 * push-assignment.
 *
 * Builder resolution is intentionally identical to the DB side
 * (roadmap_proposal.fn_proposal_builder_agencies) AND to P3563's
 * v_ac_verifier_independence builder semantics: a builder agency is one that
 * produced a build-role (developer/engineer/architect) run or dispatch on the
 * proposal. We call the DB function directly so the two paths can never drift.
 *
 * Single-agency floor (mirrors P3563 AC-12): when the ONLY builder agency is the
 * candidate decider AND no independent agency exists, the assignment is ALLOWED
 * (degraded, never a deadlock) and surfaced as a distinct advisory; the terminal
 * advance still requires a different actor + operator sign-off downstream.
 *
 * Flag: AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED (env>DB>default OFF).
 * Flag OFF ⇒ this module is a no-op (allow), preserving pre-P4996 behavior.
 */

import { query } from "../../infra/postgres/pool.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import { isDecideOfferRole } from "../orchestration/unified-pool-builder.ts";

export interface ClaimIndependenceResult {
	/** true ⇒ refuse the push assignment of this decide offer to this agency. */
	blocked: boolean;
	/** Human-readable reason (when blocked) or advisory (when degraded). */
	reason?: string;
	code?:
		| "BUILDER_AGENCY_AS_DECIDER"
		| "SINGLE_AGENCY_FLOOR_ADVISORY";
	builderAgencies?: string[];
}

/**
 * Resolve the claim-independence flag with the standard env>DB>default cascade.
 * Fails to OFF (allow) on any error so dispatch never wedges.
 */
export async function isClaimIndependenceEnabled(): Promise<boolean> {
	const env = process.env.AGENTHIVE_GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED;
	if (env !== undefined) {
		return env === "1" || env.toLowerCase() === "true";
	}
	try {
		return (
			(await runtimeConfig.get(
				FlagKeys.GATE_INDEPENDENCE_CLAIM_INVARIANT_ENABLED,
			)) === true
		);
	} catch {
		return false; // default OFF
	}
}

/**
 * Resolve a proposal's builder agencies via the SAME DB function the claim-time
 * invariant uses (roadmap_proposal.fn_proposal_builder_agencies). Returns [] on
 * any error (fail-open: independence is enforced authoritatively at claim time).
 */
export async function resolveBuilderAgencies(
	proposalId: number,
): Promise<string[]> {
	try {
		const { rows } = await query<{ agency_identity: string }>(
			`SELECT agency_identity
			   FROM roadmap_proposal.fn_proposal_builder_agencies($1)
			  WHERE agency_identity IS NOT NULL`,
			[proposalId],
		);
		return rows.map((r) => r.agency_identity);
	} catch {
		return [];
	}
}

/**
 * P4996 push-path mirror. Call from the dispatch handler BEFORE spawning a
 * gate-decision worker.
 *
 * @param proposalId  resolved numeric proposal id (undefined ⇒ allow; nothing to bind to)
 * @param role        the offer role/kind (payload.role)
 * @param agencyId    the agency that would execute the decision
 */
export async function checkClaimIndependence(
	proposalId: number | undefined,
	role: string | null | undefined,
	agencyId: string,
): Promise<ClaimIndependenceResult> {
	// Flag OFF → no-op (allow), preserving pre-P4996 behavior.
	if (!(await isClaimIndependenceEnabled())) {
		return { blocked: false };
	}

	// Only decide (gate-decision) offers are independence-restricted.
	if (!isDecideOfferRole(role)) {
		return { blocked: false };
	}

	if (proposalId === undefined || proposalId === null) {
		return { blocked: false };
	}

	const builderAgencies = await resolveBuilderAgencies(proposalId);
	if (builderAgencies.length === 0) {
		// No builders recorded → nothing to be dependent on.
		return { blocked: false, builderAgencies };
	}

	const agencyIsBuilder = builderAgencies.includes(agencyId);
	if (!agencyIsBuilder) {
		return { blocked: false, builderAgencies };
	}

	// Single-agency floor: the ONLY builder agency is the candidate decider.
	// Degrade to advisory (do NOT block) so single-agency deployments never
	// deadlock; the terminal advance still requires a different actor + operator
	// sign-off (P3563 AC-12 floor), enforced downstream at the gate.
	const distinctBuilders = new Set(builderAgencies);
	if (distinctBuilders.size === 1) {
		return {
			blocked: false,
			code: "SINGLE_AGENCY_FLOOR_ADVISORY",
			builderAgencies,
			reason:
				`Single-agency floor: agency '${agencyId}' is the only builder agency for ` +
				`proposal ${proposalId}. Decide offer allowed under degraded mode, but the ` +
				`terminal advance requires a DIFFERENT actor + operator sign-off ` +
				`(P4996 / P3563 AC-12 floor).`,
		};
	}

	// Multi-agency: a builder agency may not decide its own proposal's gate.
	return {
		blocked: true,
		code: "BUILDER_AGENCY_AS_DECIDER",
		builderAgencies,
		reason:
			`Agency '${agencyId}' built proposal ${proposalId} and may not be the ` +
			`DECIDER of its gate (builder≠decider). Route the decide offer to an ` +
			`INDEPENDENT agency (P4996). Builder agencies: ${builderAgencies.join(", ")}.`,
	};
}
