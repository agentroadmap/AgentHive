import type { JsonSchema } from "../../validation/validators.ts";

export const proposalListSchema: JsonSchema = {
	type: "object",
	properties: {
		status: {
			type: "string",
			maxLength: 100,
		},
		assignee: {
			type: "string",
			maxLength: 100,
		},
		directive: {
			type: "string",
			maxLength: 100,
		},
		labels: {
			type: "array",
			items: { type: "string", maxLength: 50 },
		},
		ready: {
			type: "boolean",
			description:
				"Filter for proposals that are ready for pickup (unblocked and unassigned)",
		},
		search: {
			type: "string",
			maxLength: 200,
		},
		rationale: {
			type: "string",
			maxLength: 100,
		},
		limit: {
			type: "number",
			minimum: 1,
			maximum: 1000,
		},
	},
	required: [],
	additionalProperties: false,
};

export const proposalSearchSchema: JsonSchema = {
	type: "object",
	properties: {
		query: {
			type: "string",
			minLength: 1,
			maxLength: 200,
		},
		status: {
			type: "string",
			maxLength: 100,
		},
		priority: {
			type: "string",
			enum: ["high", "medium", "low"],
		},
		rationale: {
			type: "string",
			maxLength: 100,
		},
		ready: {
			type: "boolean",
			description:
				"Filter for proposals that are ready for pickup (unblocked and unassigned)",
		},
		limit: {
			type: "number",
			minimum: 1,
			maximum: 100,
		},
	},
	required: ["query"],
	additionalProperties: false,
};

export const proposalViewSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
	},
	required: ["id"],
	additionalProperties: false,
};

export const proposalArchiveSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
	},
	required: ["id"],
	additionalProperties: false,
};

export const proposalCompleteSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
	},
	required: ["id"],
	additionalProperties: false,
};

export const proposalDemoteSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
	},
	required: ["id"],
	additionalProperties: false,
};

export const proposalClaimSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
		agent: {
			type: "string",
			minLength: 1,
			maxLength: 100,
		},
		durationMinutes: {
			type: "number",
			minimum: 1,
			maximum: 10080, // 1 week
		},
		message: {
			type: "string",
			maxLength: 500,
		},
		force: {
			type: "boolean",
		},
	},
	required: ["id", "agent"],
	additionalProperties: false,
};

export const proposalReleaseSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
		agent: {
			type: "string",
			minLength: 1,
			maxLength: 100,
		},
		force: {
			type: "boolean",
		},
	},
	required: ["id", "agent"],
	additionalProperties: false,
};

export const proposalRenewSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
		},
		agent: {
			type: "string",
			minLength: 1,
			maxLength: 100,
		},
		durationMinutes: {
			type: "number",
			minimum: 1,
			maximum: 10080, // 1 week
		},
	},
	required: ["id", "agent"],
	additionalProperties: false,
};

export const proposalPickupSchema: JsonSchema = {
	type: "object",
	properties: {
		agent: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Agent identifier (who is picking up the proposal)",
		},
		dryRun: {
			type: "boolean",
			description:
				"If true, only explain what would be picked up without creating a claim",
		},
		durationMinutes: {
			type: "number",
			minimum: 1,
			maximum: 10080,
			description: "Lease duration in minutes (defaults to 1 hour)",
		},
	},
	required: ["agent"],
	additionalProperties: false,
};

export const proposalHeartbeatSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
			description: "Proposal ID to send heartbeat for",
		},
		agent: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Agent identifier sending the heartbeat",
		},
	},
	required: ["id", "agent"],
	additionalProperties: false,
};

export const proposalPruneClaimsSchema: JsonSchema = {
	type: "object",
	properties: {
		timeoutMinutes: {
			type: "number",
			minimum: 1,
			maximum: 43200, // 30 days
			description: "Heartbeat timeout in minutes (defaults to 30 minutes)",
		},
	},
	required: [],
	additionalProperties: false,
};

export const proposalImpactSchema: JsonSchema = {
	type: "object",
	properties: {
		id: {
			type: "string",
			minLength: 1,
			maxLength: 50,
			description: "Proposal ID to analyze forward impact for",
		},
	},
	required: ["id"],
	additionalProperties: false,
};

export const proposalPromoteSchema: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 50 },
		agent: { type: "string", maxLength: 100 },
	},
	required: ["id"],
	additionalProperties: false,
};

export const proposalPrioritySchema: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 50 },
		agent: { type: "string", maxLength: 100 },
		rationale: { type: "string", maxLength: 500 },
	},
	required: ["id"],
	additionalProperties: false,
};

export const proposalMergeSchema: JsonSchema = {
	type: "object",
	properties: {
		sourceId: { type: "string", minLength: 1, maxLength: 50 },
		targetId: { type: "string", minLength: 1, maxLength: 50 },
		agent: { type: "string", maxLength: 100 },
	},
	required: ["sourceId", "targetId"],
	additionalProperties: false,
};

export const proposalMoveSchema: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 50 },
		targetStatus: { type: "string", maxLength: 100 },
		targetIndex: { type: "number", minimum: 0 },
		agent: { type: "string", maxLength: 100 },
	},
	required: ["id", "targetStatus", "targetIndex"],
	additionalProperties: false,
};

export const proposalRequestEnrichmentSchema: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 50 },
		topic: { type: "string", minLength: 1, maxLength: 500 },
		agent: { type: "string", maxLength: 100 },
	},
	required: ["id", "topic"],
	additionalProperties: false,
};

export const proposalExportSchema: JsonSchema = {
	type: "object",
	properties: {
		id: { type: "string", minLength: 1, maxLength: 50 },
		format: { type: "string", enum: ["markdown", "json"] },
	},
	required: ["id", "format"],
	additionalProperties: false,
};
