import { defineContract } from "./contract.ts";

/**
 * Contract for mcp_proposal tool.
 *
 * This is the reference implementation showing how to define a contract
 * for an existing MCP tool surface. The contract will be wired into the
 * dispatch layer to validate inputs before handler invocation.
 *
 * AC-2 evidence: Directory src/apps/mcp-server/contracts exists with tool contracts.
 */
export const mcp_proposal_contract = defineContract({
	name: "mcp_proposal",
	description:
		"Proposal lifecycle management — create, retrieve, update, gate, merge, and complete proposals via the roadmap.",
	persistence: "durable",
	argsSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				description:
					"Action to perform (list_actions, get, list, create, update, gate_decision, submit_review, etc.)",
				enum: [
					"list_actions",
					"get",
					"list",
					"create",
					"update",
					"gate_decision",
					"submit_review",
					"set_maturity",
					"claim",
					"lease",
					"release",
					"add_dependency",
					"obsolete",
				],
			},
			proposal_id: {
				type: "number",
				description: "ID of the proposal (required for most actions)",
			},
			title: {
				type: "string",
				description: "Proposal title (for create action)",
			},
			summary: {
				type: "string",
				description: "Proposal summary (for create/update)",
			},
			design: {
				type: "string",
				description: "Detailed design document (for create/update)",
			},
			status: {
				type: "string",
				enum: ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"],
				description: "Workflow status",
			},
			maturity: {
				type: "string",
				enum: ["new", "active", "mature", "obsolete"],
				description: "Maturity level within current status",
			},
			args: {
				type: "object",
				additionalProperties: true,
				description:
					"Action-specific arguments (nested as JSON object or string)",
			},
		},
		required: ["action"],
		additionalProperties: true,
	},
	aliases: [
		{
			deprecated: "proposal_id",
			canonical: "proposal_id",
			removedAt: "2026-09-01", // Example date
		},
	],
	sampleCall: {
		action: "get",
		proposal_id: 475,
	},
	commonErrors: [
		{
			code: "INVALID_ARGUMENT",
			message: "Unknown action or missing required parameter",
			example: "action=unknown_action → suggests valid actions",
		},
		{
			code: "NOT_FOUND",
			message: "Proposal with given ID does not exist",
			example: "proposal_id=99999 → 404",
		},
		{
			code: "PERMISSION_DENIED",
			message: "User does not have permission to perform this action",
			example: "Non-author attempting gate_decision",
		},
		{
			code: "CONFLICT",
			message: "Proposal is in a state that does not allow this action",
			example: "Attempting to gate a DRAFT proposal",
		},
		{
			code: "DATABASE_ERROR",
			message: "Database query failed",
			retriable: true,
			example: "Connection timeout",
		},
	],
	handler: async (args: Record<string, unknown>) => {
		// This is a placeholder. The actual handler will be in the existing
		// tools/proposals or tools/consolidated.ts codebase.
		// The dispatch layer will call this after contract enforcement.
		return {
			isError: true,
			content: [
				{
					type: "text",
					text: "Placeholder: mcp_proposal contract handler not yet wired",
				},
			],
		};
	},
	metadata: {
		version: "1.0",
		nameAliases: ["prop", "proposal"],
	},
});
