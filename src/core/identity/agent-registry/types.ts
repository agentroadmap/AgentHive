/** Agent registration types for S147.1 */

/**
 * P1355: Expertise role labels sourced from agency-agents division taxonomy.
 * Used by orchestrator matchmaking and OpenClaw workspace export.
 */
export type ExpertiseRole =
	| "architect"
	| "reviewer"
	| "coder"
	| "debugger"
	| "writer"
	| "researcher"
	| "tester"
	| "devops"
	| "designer";

/**
 * P1355: Personality profile stored in agent_registry.personality JSONB.
 * Vocabulary sourced from agency-agents SOUL.md / frontmatter conventions.
 * Schema migration tracked in P1356.
 */
export interface AgentPersonality {
	/** ≤160-char punchy one-liner. Source: agency-agents frontmatter `vibe`. */
	vibe: string;
	/** Behavioral principles. Source: SOUL.md "Core Truths" bullets. */
	core_truths: string[];
	/** Hard limits / ethical guardrails. Source: SOUL.md "Boundaries" bullets. */
	boundaries: string[];
	/** Communication approach. Source: agent .md "Communication Style" section. */
	communication_style: string;
	/** Coarse expertise roles used by orchestrator for capability matching. */
	expertise: ExpertiseRole[];
}

/**
 * P1355: Display metadata stored in agent_registry.display_metadata JSONB.
 * Maps to agency-agents frontmatter + OpenClaw IDENTITY.md fields.
 */
export interface AgentDisplayMetadata {
	emoji?: string;
	color?: string;
	description?: string;
	/** Origin — 'agency-agents' for catalog imports, 'operator' for hand-crafted. */
	source?: string;
}

export type AgentType = "permanent" | "contract";

export type AgentRegistration = {
	agentId: string; // e.g., 'Andy', 'xGit1'
	instanceId: string; // unique: 'Andy' (permanent), 'xGit1-a3f2' (contract)
	agentType: AgentType; // permanent or contract
	role?: string; // e.g., 'git-researcher', 'CEO'
	capabilities: string[];
	channel: string;
	status: "active" | "inactive" | "suspended";
	registeredAt: string;
	lastSeen: string;
	currentTask?: string;
};

export type RegistrationRequest = {
	agentId: string;
	instanceId?: string; // auto-generated for contract agents if not provided
	agentType?: AgentType; // defaults to 'contract' if instanceId provided suffix
	role?: string;
	capabilities?: string[];
	channel?: string;
	/**
	 * P852: route abbreviation token (e.g. "ccs45ant"). When provided together
	 * with `host` and at least one capability, the registry assembles a
	 * structured identity via buildBaseName + resolveInstanceId. Falls back to
	 * AGENTHIVE_ROUTE_ABBR env if absent. When neither is set, the legacy
	 * `${agentId}-${uniqueSuffix()}` path is used.
	 */
	routeAbbr?: string;
	/** P852: spawning host segment (e.g. "mac", "bot"). Defaults to AGENTHIVE_HOST env. */
	host?: string;
	/**
	 * P931: Human-readable provider name from model_routes.agent_provider
	 * (e.g. 'Claude', 'Codex'). Used for Tier 2 display_alias label.
	 * Must NOT be a dense routeAbbr — assignDisplayAlias throws if it detects one.
	 */
	agentProvider?: string;
	/**
	 * P159 AC-1: Optional Ed25519 public key for cryptographic identity verification.
	 * When provided, upserts into agent_registry.public_key and sets key_rotated_at=NOW().
	 * If omitted, the agent registers with null public_key (backward compatible).
	 */
	publicKey?: string;
};

export type RegistrationResponse = {
	success: boolean;
	agentId: string;
	channel: string;
	message: string;
};

export type DeregisterRequest = {
	agentId: string;
	reason?: string;
};
