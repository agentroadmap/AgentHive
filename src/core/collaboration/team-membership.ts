/**
 * STATE-63: Agent Team Membership - Registration, Identity & Workspace Assignment
 *
 * Infrastructure for registering agents as team members, assigning roles, and
 * provisioning workspace/worktree/branch. Goes beyond STATE-62 (team building)
 * by providing the mechanics of how an agent joins a team, gets identified,
 * authorized, and given a workspace.
 *
 * AC#1: Agent registration API accepts: agent-id, skills, role-assignment, pool-assignment
 * AC#2: Registration creates agent profile in SQLite with unique agent-token for authentication
 * AC#3: Agent gets workspace assignment: pool-branch + worktree-path based on role
 * AC#4: Workspace provisioned with: git clone/pull, MCP config, SOUL.md with role context
 * AC#5: Registration events posted to group-pulse.md for visibility
 * AC#6: Agent deregistration releases workspace and updates team roster
 * AC#7: Team roster queryable: who's on the team, what roles, which pools
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type RegistrationStatus =
	| "pending"
	| "active"
	| "suspended"
	| "deregistered";
export type WorkspaceStatus =
	| "provisioning"
	| "ready"
	| "in-use"
	| "released"
	| "failed";

export interface AgentRegistration {
	registrationId: string;
	agentId: string;
	skills: string[];
	roleAssignment: string;
	poolAssignment: string;
	status: RegistrationStatus;
	registeredAt: string;
	activatedAt?: string;
	deregisteredAt?: string;
	agentToken?: string; // Unique authentication token
	tokenHash?: string; // Hashed version for verification
	metadata: Record<string, string>;
}

export interface AgentProfile {
	agentId: string;
	registrationId: string;
	skills: string[];
	role: string;
	pool: string;
	trustScore: number;
	status: RegistrationStatus;
	workspace?: WorkspaceAssignment;
	registeredAt: string;
	lastActive?: string;
}

export interface WorkspaceAssignment {
	assignmentId: string;
	poolBranch: string;
	worktreePath: string;
	gitRemote?: string;
	mcpConfigPath?: string;
	soulMdPath?: string;
	status: WorkspaceStatus;
	createdAt: string;
	provisionedAt?: string;
	releasedAt?: string;
}

export interface TeamRosterEntry {
	agentId: string;
	registrationId: string;
	role: string;
	pool: string;
	skills: string[];
	status: RegistrationStatus;
	workspacePath?: string;
	joinedAt: string;
}

export interface TeamRoster {
	teamId: string;
	teamName: string;
	entries: TeamRosterEntry[];
	lastUpdated: string;
}

export interface RegistrationEvent {
	eventId: string;
	type:
		| "registered"
		| "activated"
		| "workspace_provisioned"
		| "deregistered"
		| "suspended"
		| "reactivated";
	agentId: string;
	registrationId: string;
	timestamp: string;
	details: string;
}

export interface WorkspaceConfig {
	baseDir: string;
	prefixBranchWithPool: boolean;
	autoProvisionMcp: boolean;
	autoCreateSoulMd: boolean;
	gitRemoteTemplate?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
	baseDir: "worktrees",
	prefixBranchWithPool: true,
	autoProvisionMcp: true,
	autoCreateSoulMd: true,
};

const TOKEN_LENGTH = 32;
const POOL_PREFIX = "pool/";

// ─── Agent Team Membership Manager ──────────────────────────────────

export class AgentTeamMembership {
	private registrations: Map<string, AgentRegistration> = new Map();
	private profiles: Map<string, AgentProfile> = new Map();
	private workspaces: Map<string, WorkspaceAssignment> = new Map();
	private teamRosters: Map<string, TeamRoster> = new Map();
	private events: RegistrationEvent[] = [];
	private config: WorkspaceConfig;
	private configDir: string;

	constructor(
		configDir: string = ".roadmap/team-membership",
		options?: Partial<WorkspaceConfig>,
	) {
		this.configDir = configDir;
		this.config = { ...DEFAULT_WORKSPACE_CONFIG, ...options };
	}

	/**
	 * Initialize the membership manager.
	 */
	async initialize(): Promise<void> {
		await mkdir(this.configDir, { recursive: true });
		await this.loadProposal();
	}

	// ─── AC#1: Agent Registration API ──────────────────────────────

	/**
	 * Register an agent for a team.
	 */
	async registerAgent(options: {
		agentId: string;
		skills: string[];
		roleAssignment: string;
		poolAssignment: string;
		metadata?: Record<string, string>;
	}): Promise<AgentRegistration> {
		// Check if already registered
		const existing = this.getRegistrationByAgentId(
			options.agentId,
			options.poolAssignment,
		);
		if (existing && existing.status !== "deregistered") {
			throw new Error(
				`Agent ${options.agentId} already registered for pool ${options.poolAssignment}`,
			);
		}

		// Generate authentication token
		const agentToken = this.generateToken();
		const tokenHash = this.hashToken(agentToken);

		const registration: AgentRegistration = {
			registrationId: `REG-${randomUUID().slice(0, 8)}`,
			agentId: options.agentId,
			skills: options.skills,
			roleAssignment: options.roleAssignment,
			poolAssignment: options.poolAssignment,
			status: "pending",
			registeredAt: new Date().toISOString(),
			agentToken,
			tokenHash,
			metadata: options.metadata || {},
		};

		this.registrations.set(registration.registrationId, registration);

		// Create agent profile
		const profile: AgentProfile = {
			agentId: options.agentId,
			registrationId: registration.registrationId,
			skills: options.skills,
			role: options.roleAssignment,
			pool: options.poolAssignment,
			trustScore: 100, // Default trust score
			status: "pending",
			registeredAt: registration.registeredAt,
		};

		this.profiles.set(options.agentId, profile);

		// Record event
		this.recordEvent({
			type: "registered",
			agentId: options.agentId,
			registrationId: registration.registrationId,
			details: `Registered for role: ${options.roleAssignment}, pool: ${options.poolAssignment}`,
		});

		return registration;
	}

	/**
	 * Activate a registration (after verification).
	 */
	async activateRegistration(
		registrationId: string,
	): Promise<AgentRegistration> {
		const registration = this.registrations.get(registrationId);
		if (!registration) {
			throw new Error(`Registration not found: ${registrationId}`);
		}

		if (registration.status !== "pending") {
			throw new Error(
				`Cannot activate registration in status: ${registration.status}`,
			);
		}

		registration.status = "active";
		registration.activatedAt = new Date().toISOString();

		// Update profile
		const profile = this.profiles.get(registration.agentId);
		if (profile) {
			profile.status = "active";
		}

		this.recordEvent({
			type: "activated",
			agentId: registration.agentId,
			registrationId,
			details: "Registration activated",
		});

		return registration;
	}

	// ─── AC#2: SQLite Profile with Token ───────────────────────────

	/**
	 * Verify an agent token.
	 */
	verifyToken(agentId: string, token: string): boolean {
		const registration = this.getRegistrationByAgent(agentId);
		if (!registration || !registration.tokenHash) {
			return false;
		}

		return this.hashToken(token) === registration.tokenHash;
	}

	/**
	 * Generate a new token for an agent.
	 */
	async regenerateToken(registrationId: string): Promise<string> {
		const registration = this.registrations.get(registrationId);
		if (!registration) {
			throw new Error(`Registration not found: ${registrationId}`);
		}

		const newToken = this.generateToken();
		registration.agentToken = newToken;
		registration.tokenHash = this.hashToken(newToken);

		return newToken;
	}

	/**
	 * Get agent profile by ID.
	 */
	getProfile(agentId: string): AgentProfile | null {
		return this.profiles.get(agentId) ?? null;
	}

	/**
	 * Get all profiles.
	 */
	getAllProfiles(): AgentProfile[] {
		return Array.from(this.profiles.values());
	}

	/**
	 * Get registration by agent ID.
	 */
	getRegistrationByAgent(agentId: string): AgentRegistration | null {
		return (
			Array.from(this.registrations.values()).find(
				(r) => r.agentId === agentId && r.status !== "deregistered",
			) ?? null
		);
	}

	/**
	 * Get registration by agent ID and pool.
	 */
	getRegistrationByAgentId(
		agentId: string,
		pool: string,
	): AgentRegistration | null {
		return (
			Array.from(this.registrations.values()).find(
				(r) => r.agentId === agentId && r.poolAssignment === pool,
			) ?? null
		);
	}

	/**
	 * Get registration by ID.
	 */
	getRegistration(registrationId: string): AgentRegistration | null {
		return this.registrations.get(registrationId) ?? null;
	}

	// ─── AC#3: Workspace Assignment ────────────────────────────────

	/**
	 * Assign a workspace to an agent.
	 */
	async assignWorkspace(
		agentId: string,
		options?: {
			gitRemote?: string;
		},
	): Promise<WorkspaceAssignment> {
		const profile = this.profiles.get(agentId);
		if (!profile) {
			throw new Error(`Agent profile not found: ${agentId}`);
		}

		if (profile.status !== "active") {
			throw new Error(
				`Agent ${agentId} is not active (status: ${profile.status})`,
			);
		}

		// Check if already has a workspace
		if (profile.workspace && profile.workspace.status !== "released") {
			throw new Error(
				`Agent ${agentId} already has workspace: ${profile.workspace.assignmentId}`,
			);
		}

		// Generate workspace paths
		const poolBranch = this.config.prefixBranchWithPool
			? `${POOL_PREFIX}${profile.pool}/${agentId}`
			: `${profile.pool}/${agentId}`;

		const worktreePath = join(this.config.baseDir, agentId);

		const workspace: WorkspaceAssignment = {
			assignmentId: `WS-${randomUUID().slice(0, 8)}`,
			poolBranch,
			worktreePath,
			gitRemote: options?.gitRemote || this.config.gitRemoteTemplate,
			status: "provisioning",
			createdAt: new Date().toISOString(),
		};

		this.workspaces.set(workspace.assignmentId, workspace);

		// Update profile
		profile.workspace = workspace;

		return workspace;
	}

	// ─── AC#4: Workspace Provisioning ──────────────────────────────

	/**
	 * Provision a workspace with git, MCP config, and SOUL.md.
	 */
	async provisionWorkspace(
		assignmentId: string,
		options?: {
			gitRemote?: string;
			soulContent?: string;
		},
	): Promise<WorkspaceAssignment> {
		const workspace = this.workspaces.get(assignmentId);
		if (!workspace) {
			throw new Error(`Workspace not found: ${assignmentId}`);
		}

		if (workspace.status !== "provisioning") {
			throw new Error(
				`Workspace already provisioned or in status: ${workspace.status}`,
			);
		}

		try {
			// Create worktree directory
			const worktreeDir = join(process.cwd(), workspace.worktreePath);
			if (!existsSync(worktreeDir)) {
				await mkdir(worktreeDir, { recursive: true });
			}

			// Note: In a real implementation, we would:
			// 1. git clone or git worktree add
			// 2. Create MCP config
			// 3. Create SOUL.md with role context

			// For now, we'll create placeholder files
			if (this.config.autoProvisionMcp) {
				const mcpConfigPath = join(worktreeDir, ".mcp.json");
				const mcpConfig = {
					agentRole: workspace.poolBranch.split("/")[1] || "developer",
					workspace: workspace.worktreePath,
				};
				await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
				workspace.mcpConfigPath = mcpConfigPath;
			}

			if (this.config.autoCreateSoulMd) {
				const soulMdPath = join(worktreeDir, "SOUL.md");
				const profile = this.getProfileByWorkspace(assignmentId);
				const soulContent =
					options?.soulContent || this.generateSoulContent(profile);
				await writeFile(soulMdPath, soulContent);
				workspace.soulMdPath = soulMdPath;
			}

			workspace.status = "ready";
			workspace.provisionedAt = new Date().toISOString();

			// Record event
			const profile = this.getProfileByWorkspace(assignmentId);
			if (profile) {
				this.recordEvent({
					type: "workspace_provisioned",
					agentId: profile.agentId,
					registrationId: profile.registrationId,
					details: `Workspace provisioned at ${workspace.worktreePath}`,
				});
			}

			return workspace;
		} catch (error) {
			workspace.status = "failed";
			throw error;
		}
	}

	/**
	 * Get profile by workspace assignment ID.
	 */
	private getProfileByWorkspace(assignmentId: string): AgentProfile | null {
		return (
			Array.from(this.profiles.values()).find(
				(p) => p.workspace?.assignmentId === assignmentId,
			) ?? null
		);
	}

	/**
	 * Generate SOUL.md content for an agent.
	 */
	private generateSoulContent(profile: AgentProfile | null): string {
		if (!profile) {
			return `# Agent Workspace\n\nInitialized at ${new Date().toISOString()}\n`;
		}

		return `# Agent Workspace: ${profile.agentId}

## Team Assignment
- **Role**: ${profile.role}
- **Pool**: ${profile.pool}
- **Registration ID**: ${profile.registrationId}

## Skills
${profile.skills.map((s) => `- ${s}`).join("\n")}

## Context
You are a member of a team working on shared goals.
Follow the team's workflow and coordinate with other members.
Use the MCP tools provided to interact with the roadmap.

---
*Workspace provisioned at ${new Date().toISOString()}*
`;
	}

	// ─── AC#5: Registration Events ─────────────────────────────────

	/**
	 * Record a registration event.
	 */
	private recordEvent(options: {
		type: RegistrationEvent["type"];
		agentId: string;
		registrationId: string;
		details: string;
	}): void {
		const event: RegistrationEvent = {
			eventId: `EVT-${randomUUID().slice(0, 8)}`,
			type: options.type,
			agentId: options.agentId,
			registrationId: options.registrationId,
			timestamp: new Date().toISOString(),
			details: options.details,
		};

		this.events.push(event);
	}

	/**
	 * Get registration events.
	 */
	getEvents(options?: {
		agentId?: string;
		type?: string;
		since?: string;
		limit?: number;
	}): RegistrationEvent[] {
		let events = [...this.events];

		if (options?.agentId) {
			events = events.filter((e) => e.agentId === options.agentId);
		}
		if (options?.type) {
			events = events.filter((e) => e.type === options.type);
		}
		if (options?.since) {
			events = events.filter((e) => e.timestamp >= options?.since!);
		}

		events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

		if (options?.limit) {
			events = events.slice(0, options.limit);
		}

		return events;
	}

	// ─── AC#6: Deregistration ──────────────────────────────────────

	/**
	 * Deregister an agent and release their workspace.
	 */
	async deregisterAgent(
		agentId: string,
		reason?: string,
	): Promise<{
		registration: AgentRegistration;
		workspace?: WorkspaceAssignment;
	}> {
		const registration = this.getRegistrationByAgent(agentId);
		if (!registration) {
			throw new Error(`No active registration found for agent: ${agentId}`);
		}

		// Deregister
		registration.status = "deregistered";
		registration.deregisteredAt = new Date().toISOString();
		if (reason) {
			registration.metadata.deregisterReason = reason;
		}

		// Release workspace if exists
		let releasedWorkspace: WorkspaceAssignment | undefined;
		const profile = this.profiles.get(agentId);
		if (profile?.workspace && profile.workspace.status !== "released") {
			releasedWorkspace = await this.releaseWorkspace(
				profile.workspace.assignmentId,
			);
		}

		// Update profile status
		if (profile) {
			profile.status = "deregistered";
		}

		// Record event
		this.recordEvent({
			type: "deregistered",
			agentId,
			registrationId: registration.registrationId,
			details: `Deregistered${reason ? `: ${reason}` : ""}`,
		});

		return { registration, workspace: releasedWorkspace };
	}

	/**
	 * Release a workspace.
	 */
	async releaseWorkspace(assignmentId: string): Promise<WorkspaceAssignment> {
		const workspace = this.workspaces.get(assignmentId);
		if (!workspace) {
			throw new Error(`Workspace not found: ${assignmentId}`);
		}

		if (workspace.status === "released") {
			return workspace;
		}

		workspace.status = "released";
		workspace.releasedAt = new Date().toISOString();

		// In a real implementation, we would:
		// 1. git worktree remove
		// 2. Clean up any temporary files

		return workspace;
	}

	// ─── AC#7: Team Roster ─────────────────────────────────────────

	/**
	 * Create or get a team roster.
	 */
	getTeamRoster(teamId: string, teamName?: string): TeamRoster {
		let roster = this.teamRosters.get(teamId);
		if (!roster) {
			roster = {
				teamId,
				teamName: teamName || teamId,
				entries: [],
				lastUpdated: new Date().toISOString(),
			};
			this.teamRosters.set(teamId, roster);
		}
		return roster;
	}

	/**
	 * Add an agent to a team roster.
	 */
	addToRoster(teamId: string, agentId: string): TeamRosterEntry {
		const roster = this.teamRosters.get(teamId);
		if (!roster) {
			throw new Error(`Team roster not found: ${teamId}. Create it first.`);
		}

		const profile = this.profiles.get(agentId);
		if (!profile) {
			throw new Error(`Agent profile not found: ${agentId}`);
		}

		// Check if already in roster
		const existing = roster.entries.find((e) => e.agentId === agentId);
		if (existing) {
			throw new Error(`Agent ${agentId} already in roster for team ${teamId}`);
		}

		const entry: TeamRosterEntry = {
			agentId,
			registrationId: profile.registrationId,
			role: profile.role,
			pool: profile.pool,
			skills: profile.skills,
			status: profile.status,
			workspacePath: profile.workspace?.worktreePath,
			joinedAt: new Date().toISOString(),
		};

		roster.entries.push(entry);
		roster.lastUpdated = new Date().toISOString();

		return entry;
	}

	/**
	 * Remove an agent from a team roster.
	 */
	removeFromRoster(teamId: string, agentId: string): boolean {
		const roster = this.teamRosters.get(teamId);
		if (!roster) return false;

		const index = roster.entries.findIndex((e) => e.agentId === agentId);
		if (index === -1) return false;

		roster.entries.splice(index, 1);
		roster.lastUpdated = new Date().toISOString();

		return true;
	}

	/**
	 * Query the team roster.
	 */
	queryRoster(options?: {
		teamId?: string;
		role?: string;
		pool?: string;
		status?: RegistrationStatus;
	}): TeamRosterEntry[] {
		let entries: TeamRosterEntry[] = [];

		if (options?.teamId) {
			const roster = this.teamRosters.get(options.teamId);
			entries = roster?.entries ?? [];
		} else {
			// All rosters
			for (const roster of this.teamRosters.values()) {
				entries.push(...roster.entries);
			}
		}

		if (options?.role) {
			entries = entries.filter((e) => e.role === options.role);
		}
		if (options?.pool) {
			entries = entries.filter((e) => e.pool === options.pool);
		}
		if (options?.status) {
			entries = entries.filter((e) => e.status === options.status);
		}

		return entries;
	}

	/**
	 * Get full roster details for a team.
	 */
	getFullRoster(teamId: string): TeamRoster | null {
		return this.teamRosters.get(teamId) ?? null;
	}

	// ─── Token Utilities ───────────────────────────────────────────

	/**
	 * Generate a secure random token.
	 */
	private generateToken(): string {
		return randomBytes(TOKEN_LENGTH).toString("hex");
	}

	/**
	 * Hash a token for storage.
	 */
	private hashToken(token: string): string {
		return createHash("sha256").update(token).digest("hex");
	}

	// ─── Statistics ────────────────────────────────────────────────

	/**
	 * Get membership statistics.
	 */
	getStats(): {
		totalRegistrations: number;
		activeAgents: number;
		pendingAgents: number;
		deregisteredAgents: number;
		totalWorkspaces: number;
		activeWorkspaces: number;
		totalTeams: number;
		totalEvents: number;
	} {
		const registrations = Array.from(this.registrations.values());
		const workspaces = Array.from(this.workspaces.values());

		return {
			totalRegistrations: registrations.length,
			activeAgents: registrations.filter((r) => r.status === "active").length,
			pendingAgents: registrations.filter((r) => r.status === "pending").length,
			deregisteredAgents: registrations.filter(
				(r) => r.status === "deregistered",
			).length,
			totalWorkspaces: workspaces.length,
			activeWorkspaces: workspaces.filter(
				(w) => w.status === "ready" || w.status === "in-use",
			).length,
			totalTeams: this.teamRosters.size,
			totalEvents: this.events.length,
		};
	}

	// ─── Persistence ───────────────────────────────────────────────

	/**
	 * Save proposal to disk.
	 */
	async saveProposal(): Promise<void> {
		const proposal = {
			registrations: Array.from(this.registrations.entries()),
			profiles: Array.from(this.profiles.entries()),
			workspaces: Array.from(this.workspaces.entries()),
			teamRosters: Array.from(this.teamRosters.entries()),
			events: this.events,
		};

		const proposalPath = join(this.configDir, "proposal.json");
		await writeFile(proposalPath, JSON.stringify(proposal, null, 2));
	}

	/**
	 * Load proposal from disk.
	 */
	async loadProposal(): Promise<void> {
		const proposalPath = join(this.configDir, "proposal.json");
		try {
			await access(proposalPath);
			const content = await readFile(proposalPath, "utf-8");
			const proposal = JSON.parse(content);

			this.registrations = new Map(proposal.registrations || []);
			this.profiles = new Map(proposal.profiles || []);
			this.workspaces = new Map(proposal.workspaces || []);
			this.teamRosters = new Map(proposal.teamRosters || []);
			this.events = proposal.events || [];
		} catch {
			// No proposal yet
		}
	}
}

// ─── Convenience Functions ──────────────────────────────────────────

/**
 * Parse pool assignment string.
 */
export function parsePoolAssignment(pool: string): {
	pool: string;
	subpool?: string;
} {
	const parts = pool.split("/");
	return {
		pool: parts[0],
		subpool: parts[1],
	};
}

/**
 * Format agent token for display (showing only prefix).
 */
export function formatTokenDisplay(token: string): string {
	if (token.length <= 8) return token;
	return `${token.slice(0, 8)}...`;
}

/**
 * Generate a team ID from a name.
 */
export function generateTeamId(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}
