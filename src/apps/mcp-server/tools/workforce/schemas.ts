import type { JsonSchema } from "../../validation/validators.ts";

export const agencyRegisterSchema: JsonSchema = {
	type: "object",
	properties: {
		identity: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description: "Agency identity (format: provider/agency-name; e.g., hermes/agency-example)",
		},
		agentType: {
			type: "string",
			enum: ["agency", "workforce", "coordinator"],
			default: "agency",
			description: "Agent type — agency is the long-lived identity",
		},
		provider: {
			type: "string",
			description: "AI provider (e.g., anthropic, openai, xiaomi)",
		},
		model: {
			type: "string",
			description: "Preferred model (resolved from model_routes table at runtime)",
		},
		skills: {
			type: "array",
			items: { type: "string" },
			description: "Capabilities this agency can handle",
		},
	},
	required: ["identity"],
	additionalProperties: false,
};

export const providerRegisterSchema: JsonSchema = {
	type: "object",
	properties: {
		agencyIdentity: {
			type: "string",
			minLength: 1,
			description: "Agency identity (must already be registered)",
		},
		projectId: {
			type: "string",
			description: "Project to serve — null = all projects",
		},
		squadName: {
			type: "string",
			description: "Squad to serve — null = all squads",
		},
		capabilities: {
			type: "array",
			items: { type: "string" },
			description: "Capabilities for this registration",
		},
	},
	required: ["agencyIdentity"],
	additionalProperties: false,
};

export const dispatchListSchema: JsonSchema = {
	type: "object",
	properties: {
		status: {
			type: "string",
			enum: ["open", "claimed", "active", "delivered", "failed", "expired"],
			description: "Filter by offer status",
		},
		limit: {
			type: "integer",
			minimum: 1,
			maximum: 100,
			default: 20,
		},
	},
	additionalProperties: false,
};

export const workerRegisterSchema: JsonSchema = {
	type: "object",
	properties: {
		workerIdentity: {
			type: "string",
			minLength: 1,
			description: "Worker identity (format: provider/agency-name/worker-id; e.g., hermes/agency-example/worker-42)",
		},
		agencyIdentity: {
			type: "string",
			minLength: 1,
			description: "Parent agency identity",
		},
		skills: {
			type: "array",
			items: { type: "string" },
			description: "Worker capabilities",
		},
		model: {
			type: "string",
			description: "Worker's preferred model",
		},
	},
	required: ["workerIdentity", "agencyIdentity"],
	additionalProperties: false,
};
