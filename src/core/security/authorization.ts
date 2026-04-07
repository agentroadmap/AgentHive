/**
 * STATE-54: Authorization & Access Control
 *
 * Role-based access control (RBAC) middleware for daemon API.
 * Enforces who can claim, edit, review, and reach proposals.
 *
 * AC#1: RBAC middleware integrated with daemon API
 * AC#2: Assignee enforcement (only assigned agent can edit)
 * AC#3: Phase-gate validation (cannot skip review)
 * AC#4: Admin override capability with audit logging
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ===================== Types =====================

/** Agent roles in the system */
export type AgentRole = "agent" | "reviewer" | "admin";

/** Permission types */
export type Permission =
	| "proposal:read"
	| "proposal:claim"
	| "proposal:edit"
	| "proposal:complete"
	| "proposal:delete"
	| "proposal:revert"
	| "phase:review"
	| "phase:certify"
	| "phase:transition"
	| "admin:config"
	| "admin:override"
	| "audit:read";

/** Phase types for proposal transitions */
export type Phase =
	| "explore"
	| "research"
	| "implement"
	| "review"
	| "certify"
	| "complete";

/** Role configuration */
export interface RoleConfig {
	role: AgentRole;
	permissions: Permission[];
	phaseAccess: Phase[];
	description: string;
}

/** Access control policy */
export interface AccessPolicy {
	/** Role configurations */
	roles: Record<AgentRole, RoleConfig>;
	/** Phase-to-role mapping */
	phaseRoles: Record<Phase, AgentRole[]>;
	/** Override settings */
	override: {
		enabled: boolean;
		requireApproval: boolean;
		maxOverridesPerHour: number;
	};
	/** Auto-escalation settings */
	autoEscalate: {
		enabled: boolean;
		violationThreshold: number;
		suspensionDurationMinutes: number;
	};
}

/** Agent role assignment */
export interface AgentRoleAssignment {
	agentId: string;
	role: AgentRole;
	assignedBy: string;
	assignedAt: string;
	expiresAt?: string;
	notes?: string;
}

/** Access check result */
export interface AccessCheckResult {
	allowed: boolean;
	agentId: string;
	requiredPermission: Permission | null;
	currentRole: AgentRole;
	reason: string;
	timestamp: string;
	violation?: boolean;
}

/** Audit event for access control */
export interface AccessAuditEvent {
	id: string;
	timestamp: string;
	agentId: string;
	action: string;
	resource: string;
	result: "allowed" | "denied" | "override";
	reason: string;
	roleAtTime: AgentRole;
	overrideUsed: boolean;
	overrideBy?: string;
}

/** Violation record */
export interface ViolationRecord {
	agentId: string;
	timestamp: string;
	action: string;
	reason: string;
	count: number;
	suspendedUntil?: string;
}

// ===================== Defaults =====================

/** Default role configurations with permissions */
const DEFAULT_ROLES: Record<AgentRole, RoleConfig> = {
	agent: {
		role: "agent",
		permissions: [
			"proposal:read",
			"proposal:claim",
			"proposal:edit",
			"proposal:complete",
		],
		phaseAccess: ["explore", "research", "implement", "complete"],
		description: "Standard agent - can work on assigned proposals",
	},
	reviewer: {
		role: "reviewer",
		permissions: [
			"proposal:read",
			"proposal:claim",
			"proposal:edit",
			"proposal:complete",
			"proposal:revert",
			"phase:review",
			"audit:read",
		],
		phaseAccess: ["explore", "research", "implement", "review", "complete"],
		description: "Can review and approve phase transitions",
	},
	admin: {
		role: "admin",
		permissions: [
			"proposal:read",
			"proposal:claim",
			"proposal:edit",
			"proposal:complete",
			"proposal:delete",
			"proposal:revert",
			"phase:review",
			"phase:certify",
			"admin:config",
			"admin:override",
			"audit:read",
		],
		phaseAccess: [
			"explore",
			"research",
			"implement",
			"review",
			"certify",
			"complete",
		],
		description: "Full system access with override capability",
	},
};

/** Default phase-to-role mapping */
const DEFAULT_PHASE_ROLES: Record<Phase, AgentRole[]> = {
	explore: ["agent", "reviewer", "admin"],
	research: ["agent", "reviewer", "admin"],
	implement: ["agent", "reviewer", "admin"],
	review: ["reviewer", "admin"],
	certify: ["admin"],
	complete: ["agent", "reviewer", "admin"],
};

/** Default policy */
const DEFAULT_POLICY: AccessPolicy = {
	roles: DEFAULT_ROLES,
	phaseRoles: DEFAULT_PHASE_ROLES,
	override: {
		enabled: true,
		requireApproval: true,
		maxOverridesPerHour: 3,
	},
	autoEscalate: {
		enabled: true,
		violationThreshold: 5,
		suspensionDurationMinutes: 60,
	},
};

const HOUR_MS = 60 * 60 * 1000;

// ===================== Authorization Service =====================

/**
 * Authorization service implementing STATE-54 RBAC.
 */
export class AuthorizationService {
	private policy: AccessPolicy;
	private roleAssignments: Map<string, AgentRoleAssignment> = new Map();
	private auditLog: AccessAuditEvent[] = [];
	private violations: Map<string, ViolationRecord[]> = new Map();
	private overrideCounts: Map<string, { count: number; windowStart: number }> =
		new Map();
	private storageDir: string;
	private suspendedAgents: Map<string, string> = new Map(); // agentId -> suspendedUntil ISO

	constructor(storageDir = ".auth", policy?: Partial<AccessPolicy>) {
		this.storageDir = storageDir;
		this.policy = {
			...DEFAULT_POLICY,
			...policy,
			roles: policy?.roles ?? DEFAULT_ROLES,
			phaseRoles: policy?.phaseRoles ?? DEFAULT_PHASE_ROLES,
		};

		this.ensureStorageDir();
		this.loadProposal();
	}

	// ===================== Core Permission Checks =====================

	/**
	 * Check if an agent has a specific permission.
	 * Unassigned agents get default 'agent' role permissions.
	 */
	checkPermission(agentId: string, permission: Permission): AccessCheckResult {
		const timestamp = new Date().toISOString();

		// Check if agent is suspended
		if (this.isSuspended(agentId)) {
			return this.denyAccess(
				agentId,
				permission,
				"Agent is suspended",
				timestamp,
				false,
			);
		}

		// Get agent's role (defaults to 'agent' if not assigned)
		const assignment = this.roleAssignments.get(agentId);
		const role: AgentRole = assignment?.role ?? "agent";
		const roleConfig = this.policy.roles[role];
		const allowed = roleConfig.permissions.includes(permission);

		if (allowed) {
			return {
				allowed: true,
				agentId,
				requiredPermission: permission,
				currentRole: role,
				reason: `Role '${role}' has permission '${permission}'`,
				timestamp,
				violation: false,
			};
		}

		const result = this.denyAccess(
			agentId,
			permission,
			`Role '${role}' lacks permission '${permission}'`,
			timestamp,
		);
		this.recordViolation(agentId, `permission:${permission}`);
		return result;
	}

	/**
	 * Check if an agent can edit a specific proposal (assignee enforcement).
	 */
	checkProposalEdit(
		agentId: string,
		proposalAssignee: string | null,
		proposalId: number,
	): AccessCheckResult {
		const timestamp = new Date().toISOString();

		// Check if agent is suspended
		if (this.isSuspended(agentId)) {
			return this.denyAccess(
				agentId,
				"proposal:edit",
				"Agent is suspended",
				timestamp,
			);
		}

		const assignment = this.roleAssignments.get(agentId);
		const role: AgentRole = assignment?.role ?? "agent";

		// Admins can edit any proposal
		if (role === "admin") {
			return this.allowAccess(
				agentId,
				"proposal:edit",
				role,
				timestamp,
				"Admin override",
			);
		}

		// Unclaimed proposal (null assignee) - agent with edit permission can claim it
		if (proposalAssignee === null) {
			return this.allowAccess(
				agentId,
				"proposal:edit",
				role,
				timestamp,
				"Unclaimed proposal - agent can claim",
			);
		}

		// Assignee enforcement - only assigned agent can edit
		if (proposalAssignee === agentId) {
			return this.allowAccess(
				agentId,
				"proposal:edit",
				role,
				timestamp,
				"Agent is assigned to this proposal",
			);
		}

		// Check if agent has override permission and hasn't exceeded limit
		if (this.policy.override.enabled && role === "reviewer") {
			if (this.canUseOverride(agentId)) {
				this.incrementOverrideCount(agentId);
				return this.allowAccess(
					agentId,
					"proposal:edit",
					role,
					timestamp,
					"Reviewer override used",
				);
			}
		}

		this.recordViolation(agentId, `proposal:edit:${proposalId}`);
		return this.denyAccess(
			agentId,
			"proposal:edit",
			`Agent '${agentId}' is not assigned to proposal ${proposalId}`,
			timestamp,
		);
	}

	/**
	 * Check if an agent can transition a proposal to a specific phase (phase-gate validation).
	 */
	checkPhaseTransition(
		agentId: string,
		currentPhase: Phase,
		targetPhase: Phase,
	): AccessCheckResult {
		const timestamp = new Date().toISOString();

		// Check if agent is suspended
		if (this.isSuspended(agentId)) {
			return this.denyAccess(
				agentId,
				"phase:transition",
				"Agent is suspended",
				timestamp,
			);
		}

		const assignment = this.roleAssignments.get(agentId);
		const role = assignment?.role ?? "agent";

		// Check if agent's role can access target phase
		const allowedRoles = this.policy.phaseRoles[targetPhase];
		if (!allowedRoles.includes(role)) {
			this.recordViolation(agentId, `phase:${currentPhase}->${targetPhase}`);
			return this.denyAccess(
				agentId,
				"phase:transition",
				`Role '${role}' cannot transition to phase '${targetPhase}'`,
				timestamp,
			);
		}

		// Validate phase sequence (cannot skip phases)
		const phaseOrder: Phase[] = [
			"explore",
			"research",
			"implement",
			"review",
			"certify",
			"complete",
		];
		const currentIndex = phaseOrder.indexOf(currentPhase);
		const targetIndex = phaseOrder.indexOf(targetPhase);

		if (targetIndex > currentIndex + 1 && targetPhase !== "complete") {
			return this.denyAccess(
				agentId,
				"phase:transition",
				`Cannot skip phases: ${currentPhase} -> ${targetPhase}`,
				timestamp,
			);
		}

		// Validate skip-allowed transitions
		if (currentPhase === "implement" && targetPhase === "complete") {
			// Direct to complete is allowed (skipping review/certify for non-critical proposals)
			return this.allowAccess(
				agentId,
				"phase:transition",
				role,
				timestamp,
				"Direct completion allowed",
			);
		}

		return this.allowAccess(
			agentId,
			"phase:transition",
			role,
			timestamp,
			`Phase transition ${currentPhase} -> ${targetPhase} allowed`,
		);
	}

	/**
	 * Admin override with audit logging.
	 */
	adminOverride(
		adminId: string,
		targetAgentId: string,
		action: string,
		reason: string,
	): AccessCheckResult {
		const timestamp = new Date().toISOString();

		// Verify admin has override permission
		const adminCheck = this.checkPermission(adminId, "admin:override");
		if (!adminCheck.allowed) {
			return this.denyAccess(
				adminId,
				"admin:override",
				"Admin override requires admin role",
				timestamp,
			);
		}

		// Log the override
		const auditEvent: AccessAuditEvent = {
			id: this.generateEventId(),
			timestamp,
			agentId: targetAgentId,
			action,
			resource: "admin_override",
			result: "override",
			reason,
			roleAtTime: this.roleAssignments.get(targetAgentId)?.role ?? "agent",
			overrideUsed: true,
			overrideBy: adminId,
		};
		this.auditLog.push(auditEvent);
		this.saveAuditLog();

		return {
			allowed: true,
			agentId: targetAgentId,
			requiredPermission: null,
			currentRole: this.roleAssignments.get(targetAgentId)?.role ?? "agent",
			reason: `Admin '${adminId}' granted override for '${action}': ${reason}`,
			timestamp,
			violation: false,
		};
	}

	// ===================== Role Management =====================

	/**
	 * Assign a role to an agent.
	 */
	assignRole(
		agentId: string,
		role: AgentRole,
		assignedBy: string,
		notes?: string,
	): AgentRoleAssignment {
		const assignment: AgentRoleAssignment = {
			agentId,
			role,
			assignedBy,
			assignedAt: new Date().toISOString(),
			notes,
		};

		this.roleAssignments.set(agentId, assignment);
		this.saveProposal();

		// Audit the role assignment
		const auditEvent: AccessAuditEvent = {
			id: this.generateEventId(),
			timestamp: new Date().toISOString(),
			agentId,
			action: "role_assigned",
			resource: `role:${role}`,
			result: "allowed",
			reason: `Role '${role}' assigned by '${assignedBy}'`,
			roleAtTime: role,
			overrideUsed: false,
		};
		this.auditLog.push(auditEvent);
		this.saveAuditLog();

		return assignment;
	}

	/**
	 * Get an agent's current role assignment.
	 */
	getRoleAssignment(agentId: string): AgentRoleAssignment | undefined {
		return this.roleAssignments.get(agentId);
	}

	/**
	 * Get all role assignments.
	 */
	getAllRoleAssignments(): AgentRoleAssignment[] {
		return Array.from(this.roleAssignments.values());
	}

	/**
	 * Revoke an agent's role (returns to default 'agent' role).
	 */
	revokeRole(agentId: string, revokedBy: string, reason: string): void {
		this.roleAssignments.delete(agentId);
		this.saveProposal();

		const auditEvent: AccessAuditEvent = {
			id: this.generateEventId(),
			timestamp: new Date().toISOString(),
			agentId,
			action: "role_revoked",
			resource: "role",
			result: "allowed",
			reason: `Role revoked by '${revokedBy}': ${reason}`,
			roleAtTime: "agent",
			overrideUsed: false,
		};
		this.auditLog.push(auditEvent);
		this.saveAuditLog();
	}

	// ===================== Suspension =====================

	/**
	 * Suspend an agent.
	 */
	suspendAgent(
		agentId: string,
		suspendedBy: string,
		reason: string,
		durationMinutes?: number,
	): void {
		const duration =
			durationMinutes ?? this.policy.autoEscalate.suspensionDurationMinutes;
		const suspendedUntil = new Date(
			Date.now() + duration * 60 * 1000,
		).toISOString();
		this.suspendedAgents.set(agentId, suspendedUntil);
		this.saveProposal();

		const auditEvent: AccessAuditEvent = {
			id: this.generateEventId(),
			timestamp: new Date().toISOString(),
			agentId,
			action: "agent_suspended",
			resource: "agent",
			result: "allowed",
			reason: `Suspended by '${suspendedBy}' for ${duration} minutes: ${reason}`,
			roleAtTime: this.roleAssignments.get(agentId)?.role ?? "agent",
			overrideUsed: false,
		};
		this.auditLog.push(auditEvent);
		this.saveAuditLog();
	}

	/**
	 * Unsuspend an agent.
	 */
	unsuspendAgent(agentId: string, unsuspendedBy: string): void {
		this.suspendedAgents.delete(agentId);
		this.saveProposal();

		const auditEvent: AccessAuditEvent = {
			id: this.generateEventId(),
			timestamp: new Date().toISOString(),
			agentId,
			action: "agent_unsuspended",
			resource: "agent",
			result: "allowed",
			reason: `Unsuspended by '${unsuspendedBy}'`,
			roleAtTime: this.roleAssignments.get(agentId)?.role ?? "agent",
			overrideUsed: false,
		};
		this.auditLog.push(auditEvent);
		this.saveAuditLog();
	}

	/**
	 * Check if an agent is currently suspended.
	 */
	isSuspended(agentId: string): boolean {
		const suspendedUntil = this.suspendedAgents.get(agentId);
		if (!suspendedUntil) return false;

		if (new Date(suspendedUntil).getTime() < Date.now()) {
			// Suspension expired
			this.suspendedAgents.delete(agentId);
			this.saveProposal();
			return false;
		}
		return true;
	}

	/**
	 * Get all suspended agents.
	 */
	getSuspendedAgents(): Array<{ agentId: string; suspendedUntil: string }> {
		const now = Date.now();
		const result: Array<{ agentId: string; suspendedUntil: string }> = [];
		for (const [agentId, suspendedUntil] of this.suspendedAgents) {
			if (new Date(suspendedUntil).getTime() > now) {
				result.push({ agentId, suspendedUntil });
			}
		}
		return result;
	}

	// ===================== Policy Management =====================

	/**
	 * Update the access policy.
	 */
	updatePolicy(updates: Partial<AccessPolicy>): void {
		this.policy = {
			...this.policy,
			...updates,
			roles: updates.roles ?? this.policy.roles,
			phaseRoles: updates.phaseRoles ?? this.policy.phaseRoles,
		};
		this.saveProposal();

		const auditEvent: AccessAuditEvent = {
			id: this.generateEventId(),
			timestamp: new Date().toISOString(),
			agentId: "system",
			action: "policy_updated",
			resource: "access_policy",
			result: "allowed",
			reason: "Access policy updated",
			roleAtTime: "admin",
			overrideUsed: false,
		};
		this.auditLog.push(auditEvent);
		this.saveAuditLog();
	}

	/**
	 * Get current policy.
	 */
	getPolicy(): AccessPolicy {
		return { ...this.policy };
	}

	// ===================== Audit =====================

	/**
	 * Query audit log with filters.
	 */
	queryAuditLog(filters: {
		agentId?: string;
		action?: string;
		startTime?: string;
		endTime?: string;
		result?: "allowed" | "denied" | "override";
	}): AccessAuditEvent[] {
		let filtered = [...this.auditLog];

		if (filters.agentId) {
			filtered = filtered.filter((e) => e.agentId === filters.agentId);
		}
		if (filters.action) {
			filtered = filtered.filter((e) => e.action === filters.action);
		}
		if (filters.startTime) {
			const start = new Date(filters.startTime).getTime();
			filtered = filtered.filter(
				(e) => new Date(e.timestamp).getTime() >= start,
			);
		}
		if (filters.endTime) {
			const end = new Date(filters.endTime).getTime();
			filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= end);
		}
		if (filters.result) {
			filtered = filtered.filter((e) => e.result === filters.result);
		}

		return filtered;
	}

	/**
	 * Get violation count for an agent.
	 */
	getViolationCount(agentId: string, sinceMinutes?: number): number {
		const violations = this.violations.get(agentId) ?? [];
		if (!sinceMinutes) return violations.reduce((sum, v) => sum + v.count, 0);

		const cutoff = Date.now() - sinceMinutes * 60 * 1000;
		return violations
			.filter((v) => new Date(v.timestamp).getTime() > cutoff)
			.reduce((sum, v) => sum + v.count, 0);
	}

	/**
	 * Get violation records for an agent.
	 */
	getViolations(agentId: string): ViolationRecord[] {
		return this.violations.get(agentId) ?? [];
	}

	// ===================== Private Helpers =====================

	private allowAccess(
		agentId: string,
		permission: Permission | null,
		role: AgentRole,
		timestamp: string,
		reason: string,
	): AccessCheckResult {
		return {
			allowed: true,
			agentId,
			requiredPermission: permission,
			currentRole: role,
			reason,
			timestamp,
			violation: false,
		};
	}

	private denyAccess(
		agentId: string,
		permission: Permission | null,
		reason: string,
		timestamp: string,
		isViolation = true,
	): AccessCheckResult {
		const assignment = this.roleAssignments.get(agentId);
		const result: AccessCheckResult = {
			allowed: false,
			agentId,
			requiredPermission: permission,
			currentRole: assignment?.role ?? "agent",
			reason,
			timestamp,
			violation: isViolation,
		};

		// Log denial to audit trail
		const auditEvent: AccessAuditEvent = {
			id: this.generateEventId(),
			timestamp,
			agentId,
			action: permission ?? "unknown",
			resource: "access_check",
			result: "denied",
			reason,
			roleAtTime: assignment?.role ?? "agent",
			overrideUsed: false,
		};
		this.auditLog.push(auditEvent);
		this.saveAuditLog();

		return result;
	}

	private recordViolation(agentId: string, action: string): void {
		const violations = this.violations.get(agentId) ?? [];
		const now = new Date().toISOString();

		violations.push({
			agentId,
			timestamp: now,
			action,
			reason: `Violation: ${action}`,
			count: 1,
		});

		this.violations.set(agentId, violations);

		// Auto-suspend if threshold exceeded
		if (this.policy.autoEscalate.enabled) {
			const recentCount = this.getViolationCount(agentId, 60);
			if (recentCount >= this.policy.autoEscalate.violationThreshold) {
				this.suspendAgent(
					agentId,
					"system:auto-escalate",
					`Auto-suspended after ${recentCount} violations in 60 minutes`,
				);
			}
		}

		this.saveViolations();
	}

	private canUseOverride(agentId: string): boolean {
		const record = this.overrideCounts.get(agentId);
		if (!record) return true;

		const now = Date.now();
		if (now - record.windowStart > HOUR_MS) {
			// Window expired
			return true;
		}

		return record.count < this.policy.override.maxOverridesPerHour;
	}

	private incrementOverrideCount(agentId: string): void {
		const record = this.overrideCounts.get(agentId);
		const now = Date.now();

		if (!record || now - record.windowStart > HOUR_MS) {
			this.overrideCounts.set(agentId, { count: 1, windowStart: now });
		} else {
			record.count++;
		}
	}

	private generateEventId(): string {
		return createHash("sha256")
			.update(`${Date.now()}-${randomBytes(8).toString("hex")}`)
			.digest("hex")
			.slice(0, 16);
	}

	private ensureStorageDir(): void {
		if (!existsSync(this.storageDir)) {
			mkdirSync(this.storageDir, { recursive: true });
		}
	}

	private loadProposal(): void {
		const rolesFile = join(this.storageDir, "roles.json");
		if (existsSync(rolesFile)) {
			try {
				const data = JSON.parse(readFileSync(rolesFile, "utf-8"));
				if (data.roles) {
					for (const [agentId, assignment] of Object.entries(data.roles)) {
						this.roleAssignments.set(
							agentId,
							assignment as AgentRoleAssignment,
						);
					}
				}
			} catch {
				// Ignore corrupt file
			}
		}

		const auditFile = join(this.storageDir, "audit.json");
		if (existsSync(auditFile)) {
			try {
				this.auditLog = JSON.parse(readFileSync(auditFile, "utf-8"));
			} catch {
				this.auditLog = [];
			}
		}

		const violationsFile = join(this.storageDir, "violations.json");
		if (existsSync(violationsFile)) {
			try {
				const data = JSON.parse(readFileSync(violationsFile, "utf-8"));
				for (const [agentId, records] of Object.entries(data)) {
					this.violations.set(agentId, records as ViolationRecord[]);
				}
			} catch {
				// Ignore corrupt file
			}
		}

		const suspendedFile = join(this.storageDir, "suspended.json");
		if (existsSync(suspendedFile)) {
			try {
				const data = JSON.parse(readFileSync(suspendedFile, "utf-8"));
				for (const [agentId, until] of Object.entries(data)) {
					this.suspendedAgents.set(agentId, until as string);
				}
			} catch {
				// Ignore corrupt file
			}
		}
	}

	private saveProposal(): void {
		const rolesData: Record<string, AgentRoleAssignment> = {};
		for (const [agentId, assignment] of this.roleAssignments) {
			rolesData[agentId] = assignment;
		}
		writeFileSync(
			join(this.storageDir, "roles.json"),
			JSON.stringify({ roles: rolesData }, null, 2),
		);

		const suspendedData: Record<string, string> = {};
		for (const [agentId, until] of this.suspendedAgents) {
			suspendedData[agentId] = until;
		}
		writeFileSync(
			join(this.storageDir, "suspended.json"),
			JSON.stringify(suspendedData, null, 2),
		);
	}

	private saveAuditLog(): void {
		writeFileSync(
			join(this.storageDir, "audit.json"),
			JSON.stringify(this.auditLog, null, 2),
		);
	}

	private saveViolations(): void {
		const data: Record<string, ViolationRecord[]> = {};
		for (const [agentId, records] of this.violations) {
			data[agentId] = records;
		}
		writeFileSync(
			join(this.storageDir, "violations.json"),
			JSON.stringify(data, null, 2),
		);
	}
}
