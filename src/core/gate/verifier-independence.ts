/**
 * P3563 Pillar-3 (origination side): verifier-independence enforcement at
 * verify_ac time.
 *
 * The gate-side trigger (fn_guard_gate_advance, migration 291) asserts the
 * AGGREGATE invariant — no AC pass may be self-certified by a builder-agency
 * verifier. This module enforces the ORIGINATION invariant: a CONTENT AC pass
 * recorded by an actor whose agency built the proposal is refused the moment it
 * is submitted, with a clear, actionable error.
 *
 * "Content" = an AC pass with a substantive evidence category (schema/migration,
 * file/module, behavioral/test, mcp_tool). The automated metadata gate-agent may
 * AGGREGATE (via gate_decision) but may not ORIGINATE a content pass here.
 *
 * Resolution data (all live):
 *   - verifier agency:  roadmap_workforce.agent_registry.agency_id
 *   - builder agencies: roadmap_workforce.squad_dispatch.agency_identity
 *                       WHERE dispatch_role IN (developer, engineer, architect)
 *
 * Single-agency floor: when the ONLY builder agency equals the verifier agency
 * AND no independent agency exists for the project, the requirement degrades to
 * different-ACTOR + operator sign-off (documented). That degraded path is
 * detected here and surfaced as a distinct, non-blocking advisory so a
 * single-agency deployment never deadlocks; the operator sign-off is enforced
 * via the same operator-token path used by the diff-risk clause.
 *
 * Flag: AGENTHIVE_GATE_AC_INVARIANT_ENABLED (env>DB>default OFF). When OFF this
 * module is a no-op (returns null = allow), preserving pre-P3563 behavior.
 */

import { query } from "../../postgres/pool.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

/** Categories that count as substantive "content" evidence. */
const CONTENT_CATEGORIES = new Set([
	"schema/migration",
	"file/module",
	"behavioral/test",
	"mcp_tool",
]);

export interface IndependenceCheckResult {
	/** true ⇒ refuse the verify_ac call. */
	blocked: boolean;
	/** Human-readable reason (when blocked) or advisory (when degraded). */
	reason?: string;
	/** Programmatic code for callers/tests. */
	code?:
		| "BUILDER_AGENCY_SELF_CERT"
		| "SINGLE_AGENCY_FLOOR_ADVISORY";
	verifierAgency?: string | null;
	builderAgencies?: string[];
}

/**
 * Resolve the invariant flag with the standard env>DB>default cascade.
 * Fails to OFF (allow) on any error so verify_ac never wedges.
 */
export async function isInvariantEnabled(): Promise<boolean> {
	// Env layer first (envOverride:true on the flag key).
	const env = process.env.AGENTHIVE_GATE_AC_INVARIANT_ENABLED;
	if (env !== undefined) {
		return env === "1" || env.toLowerCase() === "true";
	}
	try {
		return (await runtimeConfig.get(FlagKeys.GATE_AC_INVARIANT_ENABLED)) === true;
	} catch {
		return false; // default OFF
	}
}

/**
 * Resolve the verifier's agency TEXT identity (NULL if unresolved).
 * agent_registry.agency_id is a BIGINT self-reference to the agency's own
 * registry row, so we self-join to get the agency's text agent_identity, which
 * is what squad_dispatch.agency_identity stores.
 */
async function resolveVerifierAgency(verifier: string): Promise<string | null> {
	const { rows } = await query<{ agency_identity: string | null }>(
		`SELECT ag.agent_identity AS agency_identity
		   FROM roadmap_workforce.agent_registry vr
		   JOIN roadmap_workforce.agent_registry ag ON ag.id = vr.agency_id
		  WHERE vr.agent_identity = $1 LIMIT 1`,
		[verifier],
	);
	return rows[0]?.agency_identity ?? null;
}

/** Resolve the proposal's builder agencies (build-role dispatch). */
async function resolveBuilderAgencies(proposalId: number): Promise<string[]> {
	const { rows } = await query<{ agency_identity: string }>(
		`SELECT DISTINCT agency_identity
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND dispatch_role IN ('developer','engineer','architect')
		    AND agency_identity IS NOT NULL`,
		[proposalId],
	);
	return rows.map((r) => r.agency_identity);
}

/**
 * P3563 Pillar-3 origination guard. Call from verify_ac BEFORE the UPDATE, only
 * for status='pass'. Returns {blocked:true} when a content pass is being
 * originated by a builder-agency verifier (flag ON). Returns {blocked:false}
 * (allow) when: flag OFF, non-content category, verifier agency unresolved
 * (cannot prove dependence — surfaced separately, not blocked here), or
 * verifier is independent.
 *
 * @param numericProposalId resolved numeric proposal id
 * @param verifier          verified_by identity
 * @param category          evidence category (from args.category or details.category)
 */
export async function checkPillar3Origination(
	numericProposalId: number,
	verifier: string,
	category: string | undefined,
): Promise<IndependenceCheckResult> {
	if (!(await isInvariantEnabled())) {
		return { blocked: false };
	}

	// Only content categories are origination-restricted. Unknown/absent
	// category is treated as content (fail-safe): a substantive pass must carry
	// a category, and the P707 evidence guard already requires one for content.
	if (category && !CONTENT_CATEGORIES.has(category)) {
		return { blocked: false };
	}

	const verifierAgency = await resolveVerifierAgency(verifier);
	const builderAgencies = await resolveBuilderAgencies(numericProposalId);

	// Verifier agency unresolved → cannot prove dependence. Do NOT block at
	// origination (the gate-side view records this as NULL/unknown). Surfacing it
	// as a hard block here would deadlock operator/persona verifiers.
	if (verifierAgency === null) {
		return { blocked: false, verifierAgency: null, builderAgencies };
	}

	// No builder agencies recorded → nothing to be dependent on.
	if (builderAgencies.length === 0) {
		return { blocked: false, verifierAgency, builderAgencies };
	}

	const verifierIsBuilder = builderAgencies.includes(verifierAgency);
	if (!verifierIsBuilder) {
		return { blocked: false, verifierAgency, builderAgencies };
	}

	// Single-agency floor: the ONLY builder agency is the verifier's agency.
	// Degrade to advisory (do not hard-block) so single-agency deployments are
	// not deadlocked; the gate still requires operator sign-off via the
	// operator-token path for terminal advance under these conditions.
	const distinctBuilders = new Set(builderAgencies);
	if (distinctBuilders.size === 1) {
		return {
			blocked: false,
			code: "SINGLE_AGENCY_FLOOR_ADVISORY",
			verifierAgency,
			builderAgencies,
			reason:
				`Single-agency floor: verifier agency '${verifierAgency}' is the only builder ` +
				`agency for this proposal. Content pass allowed under degraded mode, but a ` +
				`terminal advance requires a DIFFERENT actor + operator sign-off (P3563 Pillar-3 floor).`,
		};
	}

	// Multi-agency: a builder-agency verifier self-certifying content is refused.
	return {
		blocked: true,
		code: "BUILDER_AGENCY_SELF_CERT",
		verifierAgency,
		builderAgencies,
		reason:
			`Verifier '${verifier}' belongs to builder agency '${verifierAgency}', which built ` +
			`this proposal. A CONTENT acceptance-criterion pass may not be self-certified by a ` +
			`builder agency. Re-verify this AC from an INDEPENDENT agency (P3563 Pillar-3). ` +
			`The automated metadata gate-agent may aggregate via gate_decision but may not ` +
			`originate a content pass.`,
	};
}
