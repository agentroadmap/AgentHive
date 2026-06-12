import type { JsonSchema } from "../../validation/validators.ts";

export const agencyRegisterSchema: JsonSchema = {
	type: "object",
	description:
		"Register an agency in agent_registry. EVERY agency registration also " +
		"spawns a liaison process — the agency and its liaison are one " +
		"combined long-lived service (P996 / P1367 '-a' suffix convention). " +
		"The liaison is required for the agency to receive offer_dispatch + " +
		"handle A2A inbox messages. There is no separate liaison_register call.\n\n" +
		"Naming (P996 + P1367):\n" +
		"  • Permanent agents use first-name pools: a* Claude, c* Codex, " +
		"g* Gemini, p* Copilot, h* Hermes.\n" +
		"  • Male names = builder, female names = skeptic.\n" +
		"  • Default-agency aliases: claude-a, codex-a, gemini-a, copilot-a.\n" +
		"  • Variant agencies: <style>-<llm>-a (e.g. claude-mimo-a).\n" +
		"  • Owner-scoped: <provider>-<owner>-a (e.g. copilot-gary-a).",
	properties: {
		identity: {
			type: "string",
			minLength: 1,
			maxLength: 200,
			description:
				"Agency identity. Prefer a first-name from the provider's pool " +
				"(adam, cooper, george, …) or a P1367 alias (claude-a, " +
				"codex-mimo-a). Legacy provider/name format (hermes/agency-example) " +
				"still accepted but discouraged.",
		},
		agentType: {
			type: "string",
			enum: ["agency", "workforce", "coordinator"],
			default: "agency",
			description:
				"Agent type — 'agency' is the long-lived identity that combines " +
				"worker + liaison. Always use 'agency' unless you're registering " +
				"a coordinator or legacy workforce row.",
		},
		provider: {
			type: "string",
			description: "AI provider that owns the auth (e.g., anthropic, openai, xiaomi, google).",
		},
		model: {
			type: "string",
			description: "Preferred model (resolved from model_routes at runtime).",
		},
		skills: {
			type: "array",
			items: { type: "string" },
			description:
				"Capabilities this agency can handle. Used by the orchestrator " +
				"matchmaker to score offer eligibility.",
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

export const agencyCapListSchema: JsonSchema = {
	type: "object",
	description:
		"List all agencies with their current dispatch capacity: max_in_flight, " +
		"in_flight_count, and status. Read-only; shows live capacity state from " +
		"provider_registry and v_agency_in_flight.",
	properties: {},
	additionalProperties: false,
};

export const agencyCapSetSchema: JsonSchema = {
	type: "object",
	description:
		"Set max_in_flight capacity for an agency (P1698 AC-2/6). Validates " +
		"agency exists in agent_registry. max_in_flight >= 0 required (0 = paused). " +
		"Audit writes to message_ledger; fires NOTIFY core_changed.",
	properties: {
		agencyIdentity: {
			type: "string",
			minLength: 1,
			description: "Agency identity — must exist in agent_registry",
		},
		maxInFlight: {
			type: "integer",
			minimum: 0,
			description: "New max_in_flight value (0 = paused, all claims blocked)",
		},
		projectId: {
			type: "string",
			description: "Optional project_id filter (if null, sets cap for all projects)",
		},
	},
	required: ["agencyIdentity", "maxInFlight"],
	additionalProperties: false,
};
