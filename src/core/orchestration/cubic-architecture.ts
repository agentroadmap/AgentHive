/**
 * Cubic Architecture - Isolated Sandbox for Expert Agents
 *
 * Implements STATE-090: Cubic Architecture
 *
 * Defines the core types, interfaces, and execution context for
 * phase-isolated agent sandboxes in the Cubic Architecture pattern.
 */

// ──────────────────────────────────────────
// AC#1: CubicPhase enum and CubicConfig type
// ──────────────────────────────────────────

/** Phases of the product development lifecycle in cubic order */
export const CubicPhase = {
	Design: "design",
	Build: "build",
	Test: "test",
	Ship: "ship",
} as const;

export type CubicPhase = (typeof CubicPhase)[keyof typeof CubicPhase];

/** Canonical ordering of phases */
export const PHASE_ORDER: CubicPhase[] = [
	CubicPhase.Design,
	CubicPhase.Build,
	CubicPhase.Test,
	CubicPhase.Ship,
];

/** Returns the next phase in the lifecycle, or null if at end */
export function nextPhase(current: CubicPhase): CubicPhase | null {
	const idx = PHASE_ORDER.indexOf(current);
	return idx < 0 || idx >= PHASE_ORDER.length - 1 ? null : PHASE_ORDER[idx + 1];
}

/** Returns the previous phase, or null if at start */
export function prevPhase(current: CubicPhase): CubicPhase | null {
	const idx = PHASE_ORDER.indexOf(current);
	return idx <= 0 ? null : PHASE_ORDER[idx - 1];
}

/** Configuration for a cubic sandbox */
export interface CubicConfig {
	/** Unique identifier for this cubic instance */
	cubicId: string;
	/** Which phase this cubic operates in */
	phase: CubicPhase;
	/** Maximum number of agents allowed in this cubic */
	maxAgents: number;
	/** Timeout in ms before an idle cubic is eligible for cleanup */
	idleTimeoutMs: number;
	/** Tools/capabilities available in this phase */
	allowedCapabilities: string[];
	/** Whether this cubic can initiate handoffs to the next phase */
	canHandoff: boolean;
}

/** Default capabilities per phase */
export const DEFAULT_PHASE_CAPABILITIES: Record<CubicPhase, string[]> = {
	[CubicPhase.Design]: [
		"research",
		"brainstorm",
		"document",
		"diagram",
		"review-specs",
	],
	[CubicPhase.Build]: ["code", "edit", "refactor", "implement", "create-files"],
	[CubicPhase.Test]: ["test", "lint", "benchmark", "validate", "run-tests"],
	[CubicPhase.Ship]: ["deploy", "release", "tag", "publish", "notify"],
};

// ──────────────────────────────────────────
// AC#2: CubicAgent interface
// ──────────────────────────────────────────

/** Phase-specific skill binding */
export interface PhaseSkill {
	/** Skill identifier (e.g., "code", "test", "deploy") */
	skillId: string;
	/** Proficiency level for this skill */
	level: "novice" | "competent" | "expert";
	/** Which phases this skill is active in */
	activePhases: CubicPhase[];
}

/** An expert agent bound to a specific cubic phase */
export interface CubicAgent {
	/** Unique agent identifier */
	agentId: string;
	/** Human-readable name */
	name: string;
	/** The phase this agent is specialized for */
	phase: CubicPhase;
	/** Skills the agent possesses */
	skills: PhaseSkill[];
	/** Current cubic instance this agent is assigned to */
	cubicId: string | null;
	/** Agent status within the cubic */
	status: "idle" | "active" | "handoff" | "blocked";
	/** Timestamp of last activity */
	lastActiveAt: number;
}

/** Returns true if the agent has the given skill active in its current phase */
export function agentHasCapability(
	agent: CubicAgent,
	capability: string,
): boolean {
	return agent.skills.some(
		(s) => s.skillId === capability && s.activePhases.includes(agent.phase),
	);
}

// ──────────────────────────────────────────
// AC#3: CubicSandbox class
// ──────────────────────────────────────────

/** Handoff contract between phases */
export interface HandoffPayload {
	/** Source phase */
	fromPhase: CubicPhase;
	/** Target phase */
	toPhase: CubicPhase;
	/** Agent initiating the handoff */
	initiatorAgentId: string;
	/** Readiness signal from the source agent */
	readySignal: string;
	/** Output artifacts from the source phase */
	artifacts: HandoffArtifact[];
	/** Timestamp */
	timestamp: number;
}

/** An artifact produced by a phase */
export interface HandoffArtifact {
	/** Artifact type (e.g., "spec", "code", "test-report", "release-notes") */
	type: string;
	/** Path or reference to the artifact */
	reference: string;
	/** Brief description */
	description: string;
}

/** Health status of a cubic */
export interface CubicHealth {
	cubicId: string;
	agentCount: number;
	isAlive: boolean;
	lastHeartbeat: number;
	idleMs: number;
}

/**
 * CubicSandbox — isolated execution context for phase-specific agents.
 *
 * Manages agent assignment, capability gating, health monitoring,
 * and phase handoffs within a single cubic instance.
 */
export class CubicSandbox {
	private config: CubicConfig;
	private agents: Map<string, CubicAgent> = new Map();
	private readonly createdAt: number;
	private lastHeartbeat: number;

	constructor(config: CubicConfig) {
		this.config = config;
		this.lastHeartbeat = Date.now();
		this.createdAt = Date.now();
	}

	/** Get the cubic configuration */
	getConfig(): CubicConfig {
		return { ...this.config };
	}

	/** Get current phase */
	getPhase(): CubicPhase {
		return this.config.phase;
	}

	/** Get cubic ID */
	getId(): string {
		return this.config.cubicId;
	}

	/** Get cubic creation time */
	getCreatedAt(): number {
		return this.createdAt;
	}

	// ──────────────────────────────────────────
	// AC#4: Phase capability gating
	// ──────────────────────────────────────────

	/**
	 * Check if a capability is allowed in this cubic's phase.
	 * Returns true if the capability is in the allowed list.
	 */
	isCapabilityAllowed(capability: string): boolean {
		return this.config.allowedCapabilities.includes(capability);
	}

	/**
	 * Attempt to use a capability in this cubic.
	 * Throws if the capability is not allowed in this phase.
	 */
	useCapability(capability: string): { allowed: boolean; reason?: string } {
		if (!this.isCapabilityAllowed(capability)) {
			return {
				allowed: false,
				reason: `Capability '${capability}' not allowed in ${this.config.phase} phase. Allowed: [${this.config.allowedCapabilities.join(", ")}]`,
			};
		}
		return { allowed: true };
	}

	// ──────────────────────────────────────────
	// Agent management
	// ──────────────────────────────────────────

	/** Register an agent in this cubic. Returns false if at capacity. */
	joinAgent(agent: CubicAgent): boolean {
		if (this.agents.size >= this.config.maxAgents) {
			return false;
		}
		agent.cubicId = this.config.cubicId;
		agent.status = "idle";
		this.agents.set(agent.agentId, agent);
		return true;
	}

	/** Remove an agent from this cubic */
	leaveAgent(agentId: string): boolean {
		const agent = this.agents.get(agentId);
		if (!agent) return false;
		agent.cubicId = null;
		agent.status = "idle";
		this.agents.delete(agentId);
		return true;
	}

	/** Get all agents in this cubic */
	getAgents(): CubicAgent[] {
		return Array.from(this.agents.values());
	}

	/** Get agent by ID */
	getAgent(agentId: string): CubicAgent | undefined {
		return this.agents.get(agentId);
	}

	/** Get agent count */
	getAgentCount(): number {
		return this.agents.size;
	}

	// ──────────────────────────────────────────
	// AC#5: Health monitoring
	// ──────────────────────────────────────────

	/** Send a heartbeat to keep the cubic alive */
	heartbeat(): void {
		this.lastHeartbeat = Date.now();
	}

	/** Get current health status */
	getHealth(): CubicHealth {
		const now = Date.now();
		return {
			cubicId: this.config.cubicId,
			agentCount: this.agents.size,
			isAlive: now - this.lastHeartbeat < this.config.idleTimeoutMs,
			lastHeartbeat: this.lastHeartbeat,
			idleMs: now - this.lastHeartbeat,
		};
	}

	/** Check if this cubic has expired (idle too long) */
	isExpired(): boolean {
		return Date.now() - this.lastHeartbeat > this.config.idleTimeoutMs;
	}

	// ──────────────────────────────────────────
	// AC#6: Handoff contract
	// ──────────────────────────────────────────

	/**
	 * Validate a handoff payload for correctness.
	 * Checks: source matches current phase, target is next phase, agent is in this cubic.
	 */
	validateHandoff(payload: HandoffPayload): {
		valid: boolean;
		errors: string[];
	} {
		const errors: string[] = [];

		if (payload.fromPhase !== this.config.phase) {
			errors.push(
				`Handoff from '${payload.fromPhase}' doesn't match cubic phase '${this.config.phase}'`,
			);
		}

		const expectedNext = nextPhase(this.config.phase);
		if (!expectedNext || payload.toPhase !== expectedNext) {
			errors.push(
				`Invalid handoff target '${payload.toPhase}'. Expected next phase after '${this.config.phase}'`,
			);
		}

		if (!this.config.canHandoff) {
			errors.push(
				`Cubic '${this.config.cubicId}' is not allowed to hand off (canHandoff=false)`,
			);
		}

		const agent = this.agents.get(payload.initiatorAgentId);
		if (!agent) {
			errors.push(
				`Agent '${payload.initiatorAgentId}' not found in cubic '${this.config.cubicId}'`,
			);
		}

		return { valid: errors.length === 0, errors };
	}

	/**
	 * Execute a handoff, marking the initiating agent as in handoff proposal.
	 * Returns the validated payload if successful, or errors.
	 */
	executeHandoff(payload: HandoffPayload): {
		success: boolean;
		errors?: string[];
	} {
		const validation = this.validateHandoff(payload);
		if (!validation.valid) {
			return { success: false, errors: validation.errors };
		}

		const agent = this.agents.get(payload.initiatorAgentId)!;
		agent.status = "handoff";

		return { success: true };
	}

	/**
	 * Mark the cubic as having completed a handoff.
	 * Clears handoff agents back to idle.
	 */
	completeHandoff(): void {
		for (const agent of this.agents.values()) {
			if (agent.status === "handoff") {
				agent.status = "idle";
			}
		}
	}
}

// ──────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────

/** Create a default cubic configuration for a given phase */
export function createDefaultCubicConfig(
	phase: CubicPhase,
	cubicId?: string,
): CubicConfig {
	return {
		cubicId: cubicId || `cubic-${phase}-${Date.now()}`,
		phase,
		maxAgents: 5,
		idleTimeoutMs: 30 * 60 * 1000, // 30 minutes
		allowedCapabilities: DEFAULT_PHASE_CAPABILITIES[phase],
		canHandoff: phase !== CubicPhase.Ship, // Ship is the final phase
	};
}

/** Create a cubic agent with default values */
export function createCubicAgent(
	agentId: string,
	name: string,
	phase: CubicPhase,
	skills?: PhaseSkill[],
): CubicAgent {
	return {
		agentId,
		name,
		phase,
		skills: skills || [],
		cubicId: null,
		status: "idle",
		lastActiveAt: Date.now(),
	};
}
