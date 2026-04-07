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
			enum: ["anthropic", "openai", "google", "local", "custom"],
			description: "AI model provider",
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
	},
	required: ["name", "model", "provider"],
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
			enum: ["anthropic", "openai", "google", "local", "custom"],
			description: "Filter by AI provider",
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
			description: "AI model to use",
		},
		provider: {
			type: "string",
			enum: ["anthropic", "openai", "google", "local", "custom"],
			description: "AI model provider",
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
			description: "Reason for spawning",
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
