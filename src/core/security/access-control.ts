/**
 * Role-Based Access Control Middleware (STATE-54)
 *
 * Enforces who can claim, edit, review, and reach proposals.
 * Prevents unauthorized modifications.
 *
 * AC#1: RBAC middleware integrated with daemon API
 * AC#2: Assignee enforcement (only assigned agent can edit)
 * AC#3: Phase-gate validation (cannot skip review)
 * AC#4: Admin override capability with audit logging
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type Role = "admin" | "reviewer" | "developer" | "viewer" | "agent";

export type Resource =
	| "proposal"
	| "directive"
	| "config"
	| "message"
	| "knowledge"
	| "audit";

export type Action =
	| "read"
	| "create"
	| "edit"
	| "delete"
	| "claim"
	| "review"
	| "reach"
	| "admin";

export interface RolePermissions {
	role: Role;
	permissions: PermissionEntry[];
}

export interface PermissionEntry {
	resource: Resource;
	actions: Action[];
}

export interface AccessControlConfig {
	configDir: string;
	enforceAssignee: boolean;
	enforcePhaseGate: boolean;
	adminOverrideRequiresAudit: boolean;
}

export interface Agent {
	agentId: string;
	roles: Role[];
	assignedProposals: string[]; // Proposal IDs this agent is assigned to
	createdAt: string;
	updatedAt: string;
}

export interface ProposalPhase {
	proposalId: string;
	currentStatus: string; // "Potential", "In Progress", "Review", "Complete"
	previousStatus?: string;
}

export interface AccessRequest {
	agentId: string;
	action: Action;
	resource: Resource;
	resourceId?: string;
	proposal?: ProposalPhase;
	timestamp: string;
}

export interface AccessResult {
	allowed: boolean;
	reason: string;
	deniedBy?: "role" | "assignee" | "phase-gate";
	auditId?: string;
}

export interface AdminOverride {
	overrideId: string;
	adminAgentId: string;
	targetAgentId: string;
	action: Action;
	resource: Resource;
	resourceId?: string;
	reason: string;
	timestamp: string;
}

export interface AuditEntry {
	id: string;
	timestamp: string;
	agentId: string;
	action: string;
	resource: string;
	resourceId?: string;
	allowed: boolean;
	reason: string;
	deniedBy?: string;
	adminOverride?: AdminOverride;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: AccessControlConfig = {
	configDir: ".roadmap/access-control",
	enforceAssignee: true,
	enforcePhaseGate: true,
	adminOverrideRequiresAudit: true,
};

const AGENTS_FILE = "agents.json";
const AUDIT_FILE = "access-audit.jsonl";
const ROLES_FILE = "roles.json";

/**
 * Default role-permission matrix.
 */
const DEFAULT_ROLE_PERMISSIONS: RolePermissions[] = [
	{
		role: "admin",
		permissions: [
			{
				resource: "proposal",
				actions: [
					"read",
					"create",
					"edit",
					"delete",
					"claim",
					"review",
					"reach",
					"admin",
				],
			},
			{
				resource: "directive",
				actions: ["read", "create", "edit", "delete", "admin"],
			},
			{ resource: "config", actions: ["read", "edit", "admin"] },
			{ resource: "message", actions: ["read", "create", "edit", "delete"] },
			{ resource: "knowledge", actions: ["read", "create", "edit", "delete"] },
			{ resource: "audit", actions: ["read", "admin"] },
		],
	},
	{
		role: "reviewer",
		permissions: [
			{ resource: "proposal", actions: ["read", "review", "claim"] },
			{ resource: "directive", actions: ["read"] },
			{ resource: "message", actions: ["read", "create"] },
			{ resource: "knowledge", actions: ["read", "create", "edit"] },
		],
	},
	{
		role: "developer",
		permissions: [
			{ resource: "proposal", actions: ["read", "create", "edit", "claim"] },
			{ resource: "directive", actions: ["read"] },
			{ resource: "message", actions: ["read", "create"] },
			{ resource: "knowledge", actions: ["read", "create"] },
		],
	},
	{
		role: "agent",
		permissions: [
			{ resource: "proposal", actions: ["read", "create", "edit", "claim"] },
			{ resource: "message", actions: ["read", "create"] },
			{ resource: "knowledge", actions: ["read"] },
		],
	},
	{
		role: "viewer",
		permissions: [
			{ resource: "proposal", actions: ["read"] },
			{ resource: "directive", actions: ["read"] },
			{ resource: "message", actions: ["read"] },
			{ resource: "knowledge", actions: ["read"] },
		],
	},
];

/**
 * Valid proposal transitions (phase-gate rules).
 */
const VALID_TRANSITIONS: Record<string, string[]> = {
	Potential: ["In Progress"],
	"In Progress": ["Review", "Potential"], // Can demote back
	Review: ["Complete", "In Progress"], // Can reject back to progress
	Complete: [], // Terminal proposal (use demote for exceptional cases)
};

// ─── Access Control Implementation ───────────────────────────────────

export class AccessControl {
	private config: AccessControlConfig;
	private agents: Map<string, Agent> = new Map();
	private rolePermissions: RolePermissions[] = [];
	private auditLog: AuditEntry[] = [];
	private adminOverrides: AdminOverride[] = [];

	constructor(config?: Partial<AccessControlConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.rolePermissions = [...DEFAULT_ROLE_PERMISSIONS];
	}

	/**
	 * Initialize the access control system.
	 */
	async initialize(): Promise<void> {
		await mkdir(this.config.configDir, { recursive: true });
		await this.loadAgents();
		await this.loadRolePermissions();
	}

	// ─── AC#1: RBAC Middleware ─────────────────────────────────────────

	/**
	 * Check if an agent has permission to perform an action on a resource.
	 * This is the main entry point for RBAC middleware.
	 */
	async checkPermission(request: AccessRequest): Promise<AccessResult> {
		const agent = this.agents.get(request.agentId);

		if (!agent) {
			return this.deny(request, "Agent not registered", "role");
		}

		// Check role-based permissions
		const hasRolePermission = this.hasPermission(
			agent,
			request.resource,
			request.action,
		);
		if (!hasRolePermission) {
			return this.deny(
				request,
				`Role ${agent.roles.join(", ")} lacks ${request.action} on ${request.resource}`,
				"role",
			);
		}

		// AC#2: Check assignee enforcement (blocks non-assigned, allows bypass)
		if (
			this.config.enforceAssignee &&
			request.resource === "proposal" &&
			request.resourceId
		) {
			const assigneeCheck = this.checkAssigneeEnforcement(agent, request);
			if (!assigneeCheck.allowed) {
				return assigneeCheck;
			}
			// Track if admin/reviewer bypass occurred (for audit, but continue to phase-gate)
		}

		// AC#3: Check phase-gate validation
		if (
			this.config.enforcePhaseGate &&
			request.resource === "proposal" &&
			request.proposal
		) {
			const phaseCheck = this.checkPhaseGate(request);
			if (!phaseCheck.allowed) {
				return phaseCheck;
			}
		}

		// Allowed
		const auditId = randomUUID();
		const entry: AuditEntry = {
			id: auditId,
			timestamp: request.timestamp,
			agentId: request.agentId,
			action: request.action,
			resource: request.resource,
			resourceId: request.resourceId,
			allowed: true,
			reason: "Permission granted",
		};
		this.auditLog.push(entry);

		return { allowed: true, reason: "Permission granted", auditId };
	}

	/**
	 * Check if an agent has a specific permission based on their roles.
	 */
	private hasPermission(
		agent: Agent,
		resource: Resource,
		action: Action,
	): boolean {
		for (const role of agent.roles) {
			const rolePerm = this.rolePermissions.find((rp) => rp.role === role);
			if (!rolePerm) continue;

			const resourcePerm = rolePerm.permissions.find(
				(p) => p.resource === resource,
			);
			if (resourcePerm?.actions.includes(action)) {
				return true;
			}
		}
		return false;
	}

	// ─── AC#2: Assignee Enforcement ───────────────────────────────────

	/**
	 * Check if the agent is assigned to the target proposal.
	 * Only assigned agents can edit their proposals (unless admin).
	 */
	private checkAssigneeEnforcement(
		agent: Agent,
		request: AccessRequest,
	): AccessResult {
		// Admins bypass assignee check
		if (agent.roles.includes("admin")) {
			return { allowed: true, reason: "Admin bypasses assignee check" };
		}

		// Reviewers can review any proposal
		if (request.action === "review" && agent.roles.includes("reviewer")) {
			return { allowed: true, reason: "Reviewer can review any proposal" };
		}

		// For edit/claim/reach actions, must be assigned
		const requiresAssignee: Action[] = ["edit", "delete", "reach"];
		if (requiresAssignee.includes(request.action) && request.resourceId) {
			if (!agent.assignedProposals.includes(request.resourceId)) {
				return this.deny(
					request,
					`Agent not assigned to proposal ${request.resourceId}. Cannot ${request.action}.`,
					"assignee",
				);
			}
		}

		return { allowed: true, reason: "Assignee check passed" };
	}

	/**
	 * Assign an agent to a proposal.
	 */
	assignAgentToProposal(agentId: string, proposalId: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;

		if (!agent.assignedProposals.includes(proposalId)) {
			agent.assignedProposals.push(proposalId);
			agent.updatedAt = new Date().toISOString();
		}
		return true;
	}

	/**
	 * Unassign an agent from a proposal.
	 */
	unassignAgentFromProposal(agentId: string, proposalId: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;

		const idx = agent.assignedProposals.indexOf(proposalId);
		if (idx >= 0) {
			agent.assignedProposals.splice(idx, 1);
			agent.updatedAt = new Date().toISOString();
		}
		return true;
	}

	// ─── AC#3: Phase-Gate Validation ──────────────────────────────────

	/**
	 * Validate proposal transition based on phase-gate rules.
	 * Prevents skipping review or jumping to invalid proposals.
	 */
	private checkPhaseGate(request: AccessRequest): AccessResult {
		const { proposal } = request;
		if (!proposal || !proposal.currentStatus) {
			return { allowed: true, reason: "No proposal phase info to validate" };
		}

		// Only validate status transitions (edit with status change)
		if (request.action !== "edit" && request.action !== "reach") {
			return { allowed: true, reason: "Action does not trigger phase-gate" };
		}

		// If no previous status (no transition), allow
		if (!proposal.previousStatus) {
			return { allowed: true, reason: "No status transition detected" };
		}

		const validNext = VALID_TRANSITIONS[proposal.previousStatus];
		if (!validNext) {
			// Unknown previous status, allow (backward compatibility)
			return {
				allowed: true,
				reason: `Unknown previous status: ${proposal.previousStatus}`,
			};
		}

		if (!validNext.includes(proposal.currentStatus)) {
			return this.deny(
				request,
				`Invalid phase transition: ${proposal.previousStatus} → ${proposal.currentStatus}. Valid: ${validNext.join(", ")}`,
				"phase-gate",
			);
		}

		return { allowed: true, reason: "Phase-gate transition valid" };
	}

	/**
	 * Get valid transitions for a given status.
	 */
	getValidTransitions(status: string): string[] {
		return VALID_TRANSITIONS[status] ?? [];
	}

	/**
	 * Check if a transition is valid without enforcing it.
	 */
	isValidTransition(from: string, to: string): boolean {
		const validNext = VALID_TRANSITIONS[from];
		return validNext ? validNext.includes(to) : false;
	}

	// ─── AC#4: Admin Override ──────────────────────────────────────────

	/**
	 * Admin override: bypass all checks and perform the action.
	 * Creates an audit trail entry for the override.
	 */
	async adminOverride(
		adminAgentId: string,
		targetAgentId: string,
		action: Action,
		resource: Resource,
		resourceId: string | undefined,
		reason: string,
	): Promise<AccessResult> {
		const admin = this.agents.get(adminAgentId);
		if (!admin) {
			return { allowed: false, reason: "Admin agent not found" };
		}

		if (!admin.roles.includes("admin")) {
			return { allowed: false, reason: "Agent is not an admin" };
		}

		if (!reason || reason.trim().length === 0) {
			return { allowed: false, reason: "Admin override requires a reason" };
		}

		const override: AdminOverride = {
			overrideId: randomUUID(),
			adminAgentId,
			targetAgentId,
			action,
			resource,
			resourceId,
			reason,
			timestamp: new Date().toISOString(),
		};

		this.adminOverrides.push(override);

		// AC#4: Audit log the override
		const auditEntry: AuditEntry = {
			id: randomUUID(),
			timestamp: override.timestamp,
			agentId: targetAgentId,
			action,
			resource,
			resourceId,
			allowed: true,
			reason: `Admin override by ${adminAgentId}: ${reason}`,
			deniedBy: undefined,
			adminOverride: override,
		};
		this.auditLog.push(auditEntry);

		return {
			allowed: true,
			reason: `Admin override granted by ${adminAgentId}`,
			auditId: override.overrideId,
		};
	}

	/**
	 * Get all admin overrides (for audit review).
	 */
	getAdminOverrides(): AdminOverride[] {
		return [...this.adminOverrides];
	}

	// ─── Agent Management ─────────────────────────────────────────────

	/**
	 * Register a new agent with roles.
	 */
	registerAgent(agentId: string, roles: Role[]): Agent {
		const now = new Date().toISOString();
		const agent: Agent = {
			agentId,
			roles,
			assignedProposals: [],
			createdAt: now,
			updatedAt: now,
		};
		this.agents.set(agentId, agent);
		return agent;
	}

	/**
	 * Update an agent's roles.
	 */
	updateAgentRoles(agentId: string, roles: Role[]): Agent | null {
		const agent = this.agents.get(agentId);
		if (!agent) return null;

		agent.roles = roles;
		agent.updatedAt = new Date().toISOString();
		return agent;
	}

	/**
	 * Get an agent by ID.
	 */
	getAgent(agentId: string): Agent | null {
		return this.agents.get(agentId) ?? null;
	}

	/**
	 * Get all registered agents.
	 */
	getAllAgents(): Agent[] {
		return Array.from(this.agents.values());
	}

	/**
	 * Deregister an agent.
	 */
	deregisterAgent(agentId: string): boolean {
		return this.agents.delete(agentId);
	}

	// ─── Role Permissions ─────────────────────────────────────────────

	/**
	 * Get current role permissions.
	 */
	getRolePermissions(): RolePermissions[] {
		return [...this.rolePermissions];
	}

	/**
	 * Update permissions for a role.
	 */
	updateRolePermissions(role: Role, permissions: PermissionEntry[]): boolean {
		const idx = this.rolePermissions.findIndex((rp) => rp.role === role);
		if (idx < 0) return false;

		this.rolePermissions[idx] = { role, permissions };
		return true;
	}

	// ─── Audit ────────────────────────────────────────────────────────

	/**
	 * Get the audit log, optionally filtered.
	 */
	getAuditLog(filters?: {
		agentId?: string;
		resource?: string;
		allowed?: boolean;
	}): AuditEntry[] {
		let entries = [...this.auditLog];

		if (filters?.agentId) {
			entries = entries.filter((e) => e.agentId === filters.agentId);
		}
		if (filters?.resource) {
			entries = entries.filter((e) => e.resource === filters.resource);
		}
		if (filters?.allowed !== undefined) {
			entries = entries.filter((e) => e.allowed === filters.allowed);
		}

		return entries;
	}

	/**
	 * Flush audit log to disk.
	 */
	async flushAuditLog(): Promise<void> {
		if (this.auditLog.length === 0) return;

		await mkdir(this.config.configDir, { recursive: true });
		const auditPath = join(this.config.configDir, AUDIT_FILE);
		const lines = `${this.auditLog.map((e) => JSON.stringify(e)).join("\n")}\n`;
		await writeFile(auditPath, lines, { flag: "a" });
		this.auditLog = [];
	}

	// ─── Configuration ────────────────────────────────────────────────

	/**
	 * Update access control configuration.
	 */
	updateConfig(config: Partial<AccessControlConfig>): AccessControlConfig {
		this.config = { ...this.config, ...config };
		return this.config;
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): AccessControlConfig {
		return { ...this.config };
	}

	// ─── Internal Helpers ─────────────────────────────────────────────

	private deny(
		request: AccessRequest,
		reason: string,
		deniedBy: "role" | "assignee" | "phase-gate",
	): AccessResult {
		const auditId = randomUUID();
		const entry: AuditEntry = {
			id: auditId,
			timestamp: request.timestamp,
			agentId: request.agentId,
			action: request.action,
			resource: request.resource,
			resourceId: request.resourceId,
			allowed: false,
			reason,
			deniedBy,
		};
		this.auditLog.push(entry);

		return { allowed: false, reason, deniedBy, auditId };
	}

	private async loadAgents(): Promise<void> {
		const agentsPath = join(this.config.configDir, AGENTS_FILE);
		try {
			await access(agentsPath);
			const raw = await readFile(agentsPath, "utf-8");
			const data = JSON.parse(raw) as Agent[];
			this.agents = new Map(data.map((a) => [a.agentId, a]));
		} catch {
			// No existing agents file
		}
	}

	private async loadRolePermissions(): Promise<void> {
		const rolesPath = join(this.config.configDir, ROLES_FILE);
		try {
			await access(rolesPath);
			const raw = await readFile(rolesPath, "utf-8");
			this.rolePermissions = JSON.parse(raw) as RolePermissions[];
		} catch {
			// Use defaults
		}
	}

	/**
	 * Persist agents to disk.
	 */
	async saveAgents(): Promise<void> {
		await mkdir(this.config.configDir, { recursive: true });
		const agentsPath = join(this.config.configDir, AGENTS_FILE);
		const data = Array.from(this.agents.values());
		await writeFile(agentsPath, JSON.stringify(data, null, 2));
	}

	/**
	 * Persist role permissions to disk.
	 */
	async saveRolePermissions(): Promise<void> {
		await mkdir(this.config.configDir, { recursive: true });
		const rolesPath = join(this.config.configDir, ROLES_FILE);
		await writeFile(rolesPath, JSON.stringify(this.rolePermissions, null, 2));
	}
}

// ─── Middleware Factory ──────────────────────────────────────────────

/**
 * Create an RBAC middleware function for HTTP handlers.
 * Returns a function that checks permissions and returns AccessResult.
 */
export function createRBACMiddleware(accessControl: AccessControl) {
	return async (
		agentId: string,
		action: Action,
		resource: Resource,
		resourceId?: string,
		proposal?: ProposalPhase,
	): Promise<AccessResult> => {
		const request: AccessRequest = {
			agentId,
			action,
			resource,
			resourceId,
			proposal,
			timestamp: new Date().toISOString(),
		};

		return accessControl.checkPermission(request);
	};
}

// ─── Convenience Helpers ─────────────────────────────────────────────

/**
 * Quick permission check helper.
 */
export async function hasAccess(
	ac: AccessControl,
	agentId: string,
	action: Action,
	resource: Resource,
	resourceId?: string,
): Promise<boolean> {
	const result = await ac.checkPermission({
		agentId,
		action,
		resource,
		resourceId,
		timestamp: new Date().toISOString(),
	});
	return result.allowed;
}

/**
 * Validate a proposal transition without enforcing it.
 * Useful for UI previews.
 */
export function previewTransition(
	ac: AccessControl,
	fromStatus: string,
	toStatus: string,
): {
	valid: boolean;
	validOptions: string[];
} {
	return {
		valid: ac.isValidTransition(fromStatus, toStatus),
		validOptions: ac.getValidTransitions(fromStatus),
	};
}
