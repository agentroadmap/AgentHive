/**
 * AgentHive MCP proposal bootstrap.
 *
 * Registers the Postgres-backed `prop_*` tools used by the AgentHive-specific
 * MCP surface. Filesystem-native `proposal_*` tools are registered elsewhere.
 */
import type { McpServer } from "../../server.ts";
import { PgProposalHandlers } from "./pg-handlers.ts";

export function registerProposalTools(
	server: McpServer,
	projectRoot: string,
): void {
	const handlers = new PgProposalHandlers(server, projectRoot);

	server.addTool({
		name: "prop_list",
		description: "List proposals from AgentHive Postgres database",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", description: "Filter by status" },
				type: { type: "string", description: "Filter by proposal type" },
				proposal_type: { type: "string", description: "Legacy alias for type" },
				domain_id: { type: "string", description: "Filter by domain" },
				maturity_min: { type: "number", description: "Minimum maturity level" },
			},
		},
		handler: (args: any) => handlers.listProposals(args),
	});
	server.addTool({
		name: "prop_get",
		description: "Get a proposal by ID",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		handler: (args: any) => handlers.getProposal(args),
	});
	server.addTool({
		name: "prop_create",
		description: "Create a new proposal",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				type: { type: "string" },
				proposal_type: { type: "string" },
				display_id: { type: "string" },
				parent_id: { type: "string" },
				summary: { type: "string" },
				motivation: { type: "string" },
				design: { type: "string" },
				drawbacks: { type: "string" },
				alternatives: { type: "string" },
				dependency: { type: "string" },
				priority: { type: "string" },
				body_markdown: { type: "string" },
				status: { type: "string" },
				tags: { type: "string", description: "JSON string" },
				author: { type: "string" },
			},
			required: ["title"],
		},
		handler: (args: any) => handlers.createProposal(args),
	});
	server.addTool({
		name: "prop_update",
		description: "Update an existing proposal",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				title: { type: "string" },
				status: { type: "string" },
				summary: { type: "string" },
				motivation: { type: "string" },
				design: { type: "string" },
				drawbacks: { type: "string" },
				alternatives: { type: "string" },
				dependency: { type: "string" },
				priority: { type: "string" },
				body_markdown: { type: "string" },
				tags: { type: "string", description: "JSON string" },
				author: { type: "string" },
			},
			required: ["id"],
		},
		handler: (args: any) => handlers.updateProposal(args),
	});
	server.addTool({
		name: "prop_transition",
		description:
			"Transition proposal to a new status. " +
			"Gate transitions (DRAFT→REVIEW, REVIEW→DEVELOP, DEVELOP→MERGE, MERGE→COMPLETE) " +
			"with reason='decision' require non-empty 'notes' for auditability.",
		inputSchema: {
			type: "object",
			properties: {
				id:     { type: "string" },
				status: { type: "string" },
				author: { type: "string" },
				reason: {
					type: "string",
					description: "Transition reason: mature | decision | iteration | depend | discard | rejected | research | division | submit",
				},
				notes: {
					type: "string",
					description: "Required for gate decision transitions — record what was decided and why",
				},
			},
			required: ["id", "status"],
		},
		handler: (args: any) => handlers.transitionProposal(args),
	});
	server.addTool({
		name: "prop_set_maturity",
		description:
			"Set the maturity of a proposal within its current state. " +
			"Maturity flows: new → active → mature → obsolete. " +
			"Setting 'mature' fires a gate-ready event (pg_notify proposal_gate_ready) " +
			"to queue the appropriate D* gating review without changing the proposal status.",
		inputSchema: {
			type: "object",
			properties: {
				id:       { type: "string", description: "Proposal display_id (e.g. P048)" },
				maturity: {
					type: "string",
					enum: ["new", "active", "mature", "obsolete"],
					description: "Target maturity level",
				},
				agent:  { type: "string", description: "Agent making the declaration" },
				reason: { type: "string", description: "Optional note explaining the maturity declaration" },
			},
			required: ["id", "maturity"],
		},
		handler: (args: any) => handlers.setMaturity(args),
	});
	server.addTool({
		name: "prop_delete",
		description: "Delete a proposal",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		handler: (args: any) => handlers.deleteProposal(args),
	});

	console.log("[MCP] Using Postgres proposal handlers (AgentHive)");
}
