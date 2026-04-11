/**
 * SpacetimeDB Agent Registry - Type Definitions
 *
 * Implements STATE-80: SpacetimeDB Agent Registry Implementation
 * Roles from STATE-78: Product & Building Team Role Definitions
 */

// ===================== Roles (from STATE-78) =====================

/** Product Team roles */
export type ProductTeamRole =
	| "product-manager"
	| "ux-researcher"
	| "business-analyst"
	| "qa-strategist";

/** Building Team roles */
export type BuildingTeamRole =
	| "architect"
	| "senior-developer"
	| "frontend-developer"
	| "security-engineer"
	| "code-reviewer"
	| "qa-engineer";

/** Operations Team roles */
export type OperationsTeamRole = "orchestrator" | "merge-coordinator" | "devops";

/** All valid agent roles */
export type AgentRole =
	| ProductTeamRole
	| BuildingTeamRole
	| OperationsTeamRole;

/** Mandatory roles required in every project */
export const MANDATORY_ROLES: AgentRole[] = [
	"product-manager",
	"senior-developer",
	"orchestrator",
];

/** Roles that cannot be combined with each other */
export const INCOMPATIBLE_ROLE_PAIRS: [AgentRole, AgentRole][] = [
	["orchestrator", "senior-developer"],
	["orchestrator", "architect"],
	["orchestrator", "frontend-developer"],
	["orchestrator", "code-reviewer"],
	["orchestrator", "security-engineer"],
	["orchestrator", "qa-engineer"],
	["product-manager", "architect"],
];

/** Maximum total workload percentage per agent (from STATE-78) */
export const MAX_WORKLOAD_PCT = 60;

/** Workload increment per proposal claim */
export const WORKLOAD_PER_STATE = 20;

// ===================== Agent Status Lifecycle =====================

/** Agent status lifecycle proposals */
export type AgentStatus = "online" | "idle" | "busy" | "offline" | "suspended";

/** Valid status transitions */
export const STATUS_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
	online: ["idle", "busy", "offline", "suspended"],
	idle: ["online", "busy", "offline", "suspended"],
	busy: ["idle", "offline", "suspended"],
	offline: ["online"],
	suspended: ["online", "offline"],
};

// ===================== Agent Registry Types =====================

/** Agent record in the registry */
export interface AgentRecord {
	/** Unique agent identifier (e.g., "carter", "bob") */
	id: string;
	/** Human-readable name */
	name: string;
	/** Current status in lifecycle */
	status: AgentStatus;
	/** Roles assigned to this agent (JSON array of AgentRole) */
	roles: AgentRole[];
	/** Capabilities (JSON array of strings like ["typescript", "rust", "testing"]) */
	capabilities: string[];
	/** Currently assigned proposal ID (if busy) */
	currentProposalId: string | null;
	/** Workspace URL for this agent */
	workspaceUrl: string;
	/** Timestamp of last heartbeat */
	lastHeartbeat: number;
	/** Timestamp when agent joined */
	joinedDate: number;
	/** Current workload percentage (0-100, capped at 60 per STATE-78) */
	workloadPct: number;
	/** Number of forced disconnects (for monitoring) */
	disconnectCount: number;
}

/** Agent-to-proposal assignment record */
export interface AgentAssignment {
	/** Auto-incrementing ID */
	id: number;
	/** Agent ID */
	agentId: string;
	/** Proposal ID being worked on */
	proposalId: string;
	/** Which role is being used for this assignment */
	roleUsed: AgentRole;
	/** When the assignment was created */
	assignedAt: number;
	/** When the agent started active work (null if claimed but not started) */
	claimedAt: number | null;
	/** Actual workload cost for this assignment (STATE-81: configurable) */
	workloadCost: number;
}

/** Input for registering a new agent */
export interface RegisterAgentInput {
	id: string;
	name: string;
	roles: AgentRole[];
	capabilities: string[];
	workspaceUrl: string;
}

/** Input for claiming a proposal */
export interface ClaimProposalInput {
	agentId: string;
	proposalId: string;
	roleUsed: AgentRole;
	/** Actual workload cost for this proposal (default: WORKLOAD_PER_STATE) */
	workloadCost?: number;
}

/** Agent discovery query filters */
export interface AgentDiscoveryFilter {
	/** Filter by required role */
	role?: AgentRole;
	/** Filter by required capability */
	capability?: string;
	/** Filter by status */
	status?: AgentStatus;
	/** Maximum workload percentage */
	maxWorkload?: number;
}

/** Pool status summary */
export interface PoolSummary {
	online: number;
	idle: number;
	busy: number;
	offline: number;
	suspended: number;
	total: number;
}

/** Heartbeat configuration */
export interface HeartbeatConfig {
	/** Interval in milliseconds */
	intervalMs: number;
	/** Timeout before marking agent as offline */
	timeoutMs: number;
}
