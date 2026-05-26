/** Agent registration types for S147.1 */

export type AgentType = "permanent" | "contract";

export type AgentRegistration = {
	agentId: string; // e.g., 'Andy', 'xGit1'
	instanceId: string; // unique: 'Andy' (permanent), 'xGit1-a3f2' (contract)
	agentType: AgentType; // permanent or contract
	role?: string; // e.g., 'git-researcher', 'CEO'
	capabilities: string[];
	channel: string;
	status: "online" | "offline" | "busy" | "error";
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
