/**
 * P208: Agent Trust & Authorization Model
 *
 * Defines the five trust tiers for Agent-to-Agent communication and
 * the policy matrix that controls what each tier can do.
 *
 * DB table: roadmap_workforce.agent_trust (trust_level column)
 * DB CHECK: trust_level IN ('authority','trusted','known','restricted','blocked')
 */

export type TrustTier = "authority" | "trusted" | "known" | "restricted" | "blocked";

export interface TrustPolicy {
	/** Can send messages of these types to other agents */
	canSendMessageTypes: string[];
	/** Can require another agent to perform an action */
	canRequireAction: boolean;
	/** Can modify trust lists of other agents (grant/revoke tiers) */
	canModifyTrustLists: boolean;
	/** Can override block decisions */
	canOverrideBlocks: boolean;
	/** Can initiate direct messages (not just respond) */
	canDirectMessage: boolean;
}

/**
 * Policy matrix for each trust tier.
 *
 * authority — orchestrator, system, gary. Full control.
 * trusted   — same team, verified agents. Broad access.
 * known     — registered system agents. Standard communication.
 * restricted — new/unverified agents. Limited to responses.
 * blocked   — no communication allowed.
 */
export const TRUST_POLICIES: Record<TrustTier, TrustPolicy> = {
	authority: {
		canSendMessageTypes: ["text", "task", "notify", "ack", "error", "event", "query", "response", "status", "ping", "pong"],
		canRequireAction: true,
		canModifyTrustLists: true,
		canOverrideBlocks: true,
		canDirectMessage: true,
	},
	trusted: {
		canSendMessageTypes: ["text", "task", "notify", "ack", "error", "event", "query", "response", "status", "ping", "pong"],
		canRequireAction: true,
		canModifyTrustLists: false,
		canOverrideBlocks: false,
		canDirectMessage: true,
	},
	known: {
		canSendMessageTypes: ["text", "notify", "event", "query", "response", "status", "ping", "pong"],
		canRequireAction: false,
		canModifyTrustLists: false,
		canOverrideBlocks: false,
		canDirectMessage: true,
	},
	restricted: {
		canSendMessageTypes: ["response", "pong"],
		canRequireAction: false,
		canModifyTrustLists: false,
		canOverrideBlocks: false,
		canDirectMessage: false,
	},
	blocked: {
		canSendMessageTypes: [],
		canRequireAction: false,
		canModifyTrustLists: false,
		canOverrideBlocks: false,
		canDirectMessage: false,
	},
};

/**
 * Default trust tier for unknown agents.
 */
export const DEFAULT_TIER: TrustTier = "restricted";

/**
 * Well-known authority identities that always get authority tier.
 */
export const AUTHORITY_IDENTITIES = new Set([
	"orchestrator-agent",
	"gary",
	"system",
]);
