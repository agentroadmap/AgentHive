/**
 * P208: Default Trust Rules Applied on Agent Registration
 *
 * Called after an agent is inserted into agent_registry. Sets trust_tier
 * in the registry row based on identity and agent type:
 *   - AUTHORITY_IDENTITIES (orchestrator-agent, gary, system) → authority
 *   - agent_type = 'system' or identity = 'system'           → known
 *   - everything else                                         → restricted (default)
 *
 * Same-team trust is handled structurally by resolveTrust step 4 (team prefix
 * heuristic) and does not require explicit agent_trust rows.
 */

import { query } from "../postgres/pool.ts";
import { AUTHORITY_IDENTITIES, DEFAULT_TIER, type TrustTier } from "./trust-model.ts";

function computeDefaultTier(identity: string, agentType: string): TrustTier {
	if (AUTHORITY_IDENTITIES.has(identity)) return "authority";
	for (const auth of AUTHORITY_IDENTITIES) {
		if (identity.startsWith(auth + "/")) return "authority";
	}
	if (agentType === "system" || identity === "system") return "known";
	return DEFAULT_TIER;
}

/**
 * Apply default trust rules for a newly registered agent.
 *
 * Updates trust_tier in agent_registry if the computed tier differs from the
 * default. No-op for ordinary workforce agents (they keep the 'restricted' default).
 */
export async function applyDefaultTrustRules(
	agentIdentity: string,
	agentType: string,
): Promise<void> {
	const tier = computeDefaultTier(agentIdentity, agentType);
	if (tier === DEFAULT_TIER) return;

	await query(
		`UPDATE roadmap_workforce.agent_registry
		 SET trust_tier = $1
		 WHERE agent_identity = $2`,
		[tier, agentIdentity],
	);
}

export { computeDefaultTier };
