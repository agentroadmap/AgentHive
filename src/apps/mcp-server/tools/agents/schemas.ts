import type { JsonSchema } from "../../validation/validators.ts";

/**
 * STATE-77: Updated agent schemas with multi-model support
 * Supports: Claude, GPT, Gemini, local models, and any custom AI backend
 */

export const agentRegisterSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description: "Agent identity (primary key in agent_registry, e.g. 'alan', 'george')",
		},
		agent_type: {
			type: "string",
			description: "Agent type, e.g. 'agency', 'worker'",
		},
		role: {
			type: "string",
			description: "Role label, e.g. 'developer', 'reviewer'",
		},
		skills: {
			type: "string",
			description: "JSON array or comma-separated skills string",
		},
		preferred_provider: {
			type: "string",
			description: "Provider name matching model_metadata.provider (e.g. 'claude', 'codex', 'gemini', 'copilot')",
		},
		agent_cli: {
			type: "string",
			description: "CLI binary used to launch this agent (e.g. 'claude', 'codex', 'gemini', 'copilot')",
		},
		host_affinity: {
			type: "string",
			description: "Preferred host identifier (e.g. 'bot')",
		},
		display_alias: {
			type: "string",
			description: "Short human-readable alias for the agent",
		},
		display_name: {
			type: "string",
			description: "Human-readable display name",
		},
		// Legacy in-memory pool fields — accepted but ignored by the DB path
		id: { type: "string" },
		name: { type: "string" },
		template: { type: "string" },
		model: { type: "string" },
		provider: { type: "string" },
		workspace: { type: "string" },
		machineId: { type: "string" },
		capabilities: { type: "array", items: { type: "string" } },
		config: { type: "object", additionalProperties: true },
	},
	required: ["identity"],
	additionalProperties: false,
};

export const agentGetSchema: JsonSchema = {
	type: "object",
	properties: {
		agentId: {
			type: "string",
			description: "Agent ID to retrieve details for",
		},
	},
	required: ["agentId"],
	additionalProperties: false,
};

export const agentListSchema: JsonSchema = {
	type: "object",
	properties: {
		status: {
			type: "string",
			enum: ["online", "idle", "busy", "offline", "error"],
			description: "Filter by agent status",
		},
		provider: {
			type: "string",
			description: "Filter by AI provider (route_provider from model_routes)",
		},
		template: {
			type: "string",
			description: "Filter by agent template",
		},
		capabilities: {
			type: "array",
			items: { type: "string" },
			description: "Filter by required capabilities",
		},
		limit: {
			type: "number",
			description:
				"Maximum results to return (default 50, max 500)",
		},
		include_terminal: {
			type: "boolean",
			description:
				"Include terminal statuses (inactive, retired). Default false.",
		},
		include_metadata: {
			type: "boolean",
			description:
				"Include metadata fields (skills, metadata). Default false.",
		},
	},
	additionalProperties: false,
};

export const agentAssignSchema: JsonSchema = {
	type: "object",
	properties: {
		agentId: {
			type: "string",
			description: "Agent to assign work to",
		},
		proposalId: {
			type: "string",
			description: "Proposal ID to assign",
		},
		priority: {
			type: "string",
			enum: ["critical", "high", "normal", "low"],
			default: "normal",
			description: "Assignment priority",
		},
		notes: {
			type: "string",
			description: "Assignment notes",
		},
		ttlMinutes: {
			type: "integer",
			minimum: 5,
			maximum: 480,
			default: 60,
			description: "Claim time-to-live in minutes",
		},
	},
	required: ["agentId", "proposalId"],
	additionalProperties: false,
};

export const agentHeartbeatSchema: JsonSchema = {
	type: "object",
	properties: {
		agentId: {
			type: "string",
			description: "Agent sending the heartbeat",
		},
		load: {
			type: "integer",
			minimum: 0,
			maximum: 100,
			description: "Current agent load (0-100)",
		},
		claimsCount: {
			type: "integer",
			minimum: 0,
			description: "Number of active claims",
		},
		latencyMs: {
			type: "integer",
			minimum: 0,
			description: "Network latency in milliseconds",
		},
	},
	required: ["agentId", "load", "claimsCount"],
	additionalProperties: false,
};

export const agentSpawnSchema: JsonSchema = {
	type: "object",
	properties: {
		template: {
			type: "string",
			enum: [
				"senior-developer",
				"developer",
				"tester",
				"reviewer",
				"pm",
				"architect",
				"devops",
				"custom",
			],
			description: "Agent template to spawn",
		},
		model: {
			type: "string",
			description: "AI model to use (must exist in model_routes)",
		},
		provider: {
			type: "string",
			description: "AI model route provider (route_provider from model_routes). Used to resolve default model and worktree if model is omitted.",
		},
		capabilities: {
			type: "array",
			items: { type: "string" },
			description: "Required capabilities for the new agent",
		},
		targetProposalId: {
			type: "string",
			description: "Optional: Proposal to assign immediately",
		},
		reason: {
			type: "string",
			description: "Reason for spawning (becomes the task prompt)",
		},
		worktree: {
			type: "string",
			description: "Optional: target worktree directory name. If omitted, auto-selected from model_routes agent_provider.",
		},
		timeoutMs: {
			type: "integer",
			minimum: 1000,
			maximum: 3600000,
			description: "Spawn timeout in milliseconds (default: 300000)",
		},
	},
	required: ["template", "model", "provider", "reason"],
	additionalProperties: false,
};

export const agentRetireSchema: JsonSchema = {
	type: "object",
	properties: {
		agentId: {
			type: "string",
			description: "Agent to retire",
		},
		reason: {
			type: "string",
			description: "Reason for retirement",
		},
		releaseClaims: {
			type: "boolean",
			default: true,
			description: "Whether to release all active claims",
		},
	},
	required: ["agentId", "reason"],
	additionalProperties: false,
};

export const agentForceReleaseAliasSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			description: "Agent identity (agent_identity from agent_registry) to release alias from",
		},
		force: {
			type: "boolean",
			default: false,
			description: "If true, allows forcing release from active agents with stale heartbeat (>90s)",
		},
	},
	required: ["identity"],
	additionalProperties: false,
};
