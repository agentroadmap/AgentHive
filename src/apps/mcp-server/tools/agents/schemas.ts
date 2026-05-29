import type { JsonSchema } from "../../validation/validators.ts";

/**
 * STATE-77: Updated agent schemas with multi-model support
 * Supports: Claude, GPT, Gemini, local models, and any custom AI backend
 */

export const agentRegisterSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Unique agent identifier (auto-generated if omitted)",
		},
		name: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description:
				"Agent display name (defaults to git user if omitted in CLI)",
		},
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
			description: "Agent template type defining role and capabilities",
		},
		model: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description:
				"AI model identifier (e.g., claude-3-opus, gpt-4o, gemini-pro, local-llama)",
		},
		provider: {
			type: "string",
			description: "AI model provider (must match a route_provider in model_routes)",
		},
		identity: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description: "Agent identity (email, URL, handle)",
		},
		workspace: {
			type: "string",
			description: "Workspace path or identifier",
		},
		machineId: {
			type: "string",
			description: "Machine identifier (for multi-host tracking)",
		},
		capabilities: {
			type: "array",
			items: {
				type: "string",
				minLength: 1,
				maxLength: 50,
			},
			description:
				"List of agent skills or capabilities (e.g., typescript, testing, threejs, laravel)",
		},
		config: {
			type: "object",
			properties: {
				baseUrl: {
					type: "string",
					description: "Custom API endpoint (for local/custom models)",
				},
				temperature: {
					type: "number",
					minimum: 0,
					maximum: 2,
					description: "Model temperature",
				},
				maxTokens: {
					type: "integer",
					minimum: 1,
					maximum: 200000,
					description: "Max output tokens",
				},
				rateLimitPerMinute: {
					type: "integer",
					minimum: 1,
					description: "Rate limit for this agent",
				},
				timeoutMs: {
					type: "integer",
					minimum: 1000,
					description: "Request timeout in milliseconds",
				},
			},
			additionalProperties: false,
			description: "Model-specific configuration",
		},
		// P1129: agency-shape fields persisted in agent_registry
		preferred_provider: {
			type: "string",
			description: "Preferred LLM provider (e.g. 'claude', 'codex', 'gemini'). Stored in agent_registry.preferred_provider.",
		},
		agent_cli: {
			type: "string",
			description: "Full path to the agency CLI binary (e.g. '/usr/local/bin/claude'). Stored in agent_registry.agent_cli.",
		},
		host_affinity: {
			type: "string",
			description: "Host segment the agency prefers to run on (e.g. 'bot', 'mac'). Stored in agent_registry.host_affinity.",
		},
		display_alias: {
			type: "string",
			description: "Short human-readable alias (e.g. 'Claude Alpha'). Must be unique in agent_registry.",
		},
	},
	required: ["name", "model", "provider"],
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

// P1129: DB-backed agency self-registration schema
export const agentPgRegisterSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description: "Agent identity (email, URL, handle). PK in agent_registry.",
		},
		agent_type: {
			type: "string",
			enum: ["human", "llm", "tool", "hybrid", "agency", "workforce", "coordinator", "user"],
			description: "Agent type. Use 'agency' for full agencies.",
		},
		role: {
			type: "string",
			description: "Role name (e.g. 'developer', 'reviewer', 'architect').",
		},
		skills: {
			type: "string",
			description: "Comma-separated list or JSON array of skill tags stored as JSONB.",
		},
		preferred_provider: {
			type: "string",
			description: "Preferred LLM provider key (e.g. 'claude', 'codex', 'gemini').",
		},
		agent_cli: {
			type: "string",
			description: "Full path to agency CLI binary (e.g. '/usr/local/bin/claude').",
		},
		host_affinity: {
			type: "string",
			description: "Host segment the agency prefers (e.g. 'bot', 'mac').",
		},
		display_alias: {
			type: "string",
			description: "Short human-readable alias. Must be unique in agent_registry.",
		},
		display_name: {
			type: "string",
			description: "Full display name stored in agent_registry.display_name.",
		},
	},
	required: ["identity"],
	additionalProperties: false,
};

// P1129: Model self-registration schema (model_metadata + model_routes UPSERT with probe gate)
export const agentRegisterModelSchema: JsonSchema = {
	type: "object",
	properties: {
		agent_identity: {
			type: "string",
			description: "Caller identity. Used to verify trust_tier when skip_probe=true.",
		},
		model_name: {
			type: "string",
			description: "Model name to register (e.g. 'claude-opus-4-7', 'gpt-4o').",
		},
		route_provider: {
			type: "string",
			description: "Route provider key — PK side of model_metadata (e.g. 'anthropic', 'openai').",
		},
		agent_provider: {
			type: "string",
			description: "CLI/agent-side provider key (e.g. 'claude', 'codex', 'gemini'). Determines probe spec.",
		},
		agent_cli: {
			type: "string",
			description: "Optional: path to CLI binary. Resolved from agent_registry if omitted.",
		},
		base_url: {
			type: "string",
			description: "Optional: custom API base URL for the route.",
		},
		api_spec: {
			type: "string",
			description: "Optional: API spec type (e.g. 'openai-compat').",
		},
		tier: {
			type: "string",
			enum: ["frontier", "mid", "lower", "tool"],
			description: "Model tier stored in model_routes.",
		},
		skip_probe: {
			type: "boolean",
			description: "Skip CLI probe validation. Requires trust_tier='authority' in agent_registry.",
		},
	},
	required: ["agent_identity", "model_name", "route_provider", "agent_provider"],
	additionalProperties: false,
};
