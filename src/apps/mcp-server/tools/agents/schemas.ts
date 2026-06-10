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
			description:
				"AI model provider (must match a route_provider in model_routes)",
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
		// P1129: agency-shape fields for self-service registration
		preferred_provider: {
			type: "string",
			enum: ["claude", "codex", "gemini", "copilot", "hermes"],
			description:
				"P1129: Canonical provider token for this agency. Reconciles legacy openai→codex / google→gemini on write.",
		},
		agent_cli: {
			type: "string",
			minLength: 1,
			maxLength: 64,
			description:
				"P1129: CLI executable name used to spawn child agents (e.g. 'claude', 'codex', 'gemini').",
		},
		host_affinity: {
			type: "string",
			minLength: 1,
			maxLength: 128,
			description:
				"P1129: Preferred execution host for this agency (e.g. 'bot', 'codex-host'). Soft placement hint.",
		},
		display_name: {
			type: "string",
			minLength: 1,
			maxLength: 128,
			description:
				"P1129: Human-friendly label for the agency (e.g. 'George Gemini Agency').",
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
			description: "Maximum results to return (default 50, max 500)",
		},
		include_terminal: {
			type: "boolean",
			description:
				"Include terminal statuses (inactive, retired). Default false.",
		},
		include_metadata: {
			type: "boolean",
			description: "Include metadata fields (skills, metadata). Default false.",
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
			description:
				"AI model route provider (route_provider from model_routes). Used to resolve default model and worktree if model is omitted.",
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
			description:
				"Optional: target worktree directory name. If omitted, auto-selected from model_routes agent_provider.",
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

export const agentRenameSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			description:
				"Target agent_identity OR existing display_alias (resolver matches either)",
		},
		alias: {
			type: "string",
			description:
				"New display_alias — must match ^[A-Z][A-Za-z0-9-]{2,63}$ (PascalCase start, 3-64 chars)",
		},
		force: {
			type: "boolean",
			default: false,
			description:
				"When true, bypass alias-collision check by releasing it from an inactive/stale-heartbeat prior owner",
		},
		operator: {
			type: "string",
			description:
				"Identity of the operator performing the rename; recorded in the audit trail as the 'by' field",
		},
	},
	required: ["identity", "alias"],
	additionalProperties: false,
};

export const agencyResumeSchema: JsonSchema = {
	type: "object",
	properties: {
		agency_id: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description:
				"Agency identity string (roadmap.agency.agency_id) to resume",
		},
	},
	required: ["agency_id"],
	additionalProperties: false,
};

export const agentForceReleaseAliasSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			description:
				"Agent identity (agent_identity from agent_registry) to release alias from",
		},
		force: {
			type: "boolean",
			default: false,
			description:
				"If true, allows forcing release from active agents with stale heartbeat (>90s)",
		},
	},
	required: ["identity"],
	additionalProperties: false,
};

// P1129: register_model — agency declares a model it supports
export const agentRegisterModelSchema: JsonSchema = {
	type: "object",
	properties: {
		model_name: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description:
				"Model identifier as it appears in roadmap.model_metadata (e.g. 'claude-sonnet-4-6', 'gemini-2.0-flash').",
		},
		route_provider: {
			type: "string",
			minLength: 1,
			maxLength: 64,
			description:
				"Who serves this route (e.g. 'anthropic', 'google', 'openai', 'nous'). Maps to model_routes.route_provider.",
		},
		agent_provider: {
			type: "string",
			enum: ["claude", "codex", "gemini", "copilot", "hermes", "openclaw"],
			description:
				"AgentProvider token for this route — the CLI family that uses it.",
		},
		agent_cli: {
			type: "string",
			minLength: 1,
			maxLength: 64,
			description:
				"CLI executable name (e.g. 'claude', 'codex', 'gemini'). Stored in model_routes.agent_cli.",
		},
		base_url: {
			type: "string",
			description:
				"Optional API endpoint override (e.g. local Ollama or proxy). NULL = provider default.",
		},
		cost_per_1k_input: {
			type: "number",
			minimum: 0,
			description: "USD cost per 1 000 input tokens. 0 for token-plan quota.",
		},
		cost_per_1k_output: {
			type: "number",
			minimum: 0,
			description: "USD cost per 1 000 output tokens. 0 for token-plan quota.",
		},
		plan_type: {
			type: "string",
			enum: ["token_plan", "api_key", "free"],
			description: "Billing plan type for this route.",
		},
		priority: {
			type: "integer",
			minimum: 1,
			maximum: 100,
			description:
				"Route selection order — lower wins. 1 = token-plan (cheapest first), 10 = pay-as-you-go.",
		},
		probe: {
			type: "boolean",
			default: false,
			description:
				"When true, run a CLI liveness probe (`<agent_cli> --model <model_name> -p x`) before upserting. Rejects models that fail the probe.",
		},
	},
	required: ["model_name", "route_provider", "agent_provider"],
	additionalProperties: false,
};

// P1129: agency_start — launch the liaison process for an agency
export const agencyStartSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description:
				"Agency agent_identity string (DB registration key in agent_registry). Activation is DB-only — the universal agenthive-a2a-host floor discovers it; there is no per-agency systemd unit.",
		},
		worktree: {
			type: "string",
			description:
				"Optional worktree directory name (e.g. 'codex-three'). Written to the env file if provided.",
		},
		provider: {
			type: "string",
			enum: ["claude", "codex", "gemini", "copilot", "hermes"],
			description:
				"Optional provider override. Written to the env file as AGENTHIVE_PROVIDER.",
		},
	},
	required: ["identity"],
	additionalProperties: false,
};

// P1129: agency_status — per-agency runtime state
export const agencyStatusSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description: "Agency agent_identity to query.",
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

