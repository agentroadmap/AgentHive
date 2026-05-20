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
	 * P931: Human-friendly provider name from model_routes.agent_provider
	 * (e.g. "Claude", "Codex", "Hermes"). Used by the registry to construct
	 * Tier 2 display aliases. Must NOT be the dense P852 routeAbbr — the
	 * registry throws if assignDisplayAlias detects an abbr-shape value.
	 * When absent, Tier 2 alias assignment is skipped.
	 */
	agentProvider?: string;
	/**
	 * P159: Ed25519 public key (PEM-encoded) for cryptographic identity.
	 * When provided, stored in agent_registry.public_key via COALESCE upsert.
	 * A pre-check blocks registration if the existing key differs (use rotateKeyPair to rotate).
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
