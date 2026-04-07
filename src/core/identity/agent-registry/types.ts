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
