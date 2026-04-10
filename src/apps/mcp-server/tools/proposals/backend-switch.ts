/**
 * AgentHive MCP proposal bootstrap.
 *
 * Registers the Postgres-backed `prop_*` tools used by the AgentHive-specific
 * MCP surface. Filesystem-native `proposal_*` tools are registered elsewhere.
 */
import type { McpServer } from "../../server.ts";
import { createAsyncValidatedTool } from "../../validation/tool-wrapper.ts";
import { PgProposalHandlers } from "./pg-handlers.ts";

export function registerProposalTools(
	server: McpServer,
	projectRoot: string,
): void {
	const handlers = new PgProposalHandlers(server, projectRoot);

	server.addTool({
		name: "prop_list",
		description:
			"List AgentHive proposals from Postgres, including workflow stage, type, and maturity",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", description: "Filter by status" },
				type: {
					type: "string",
					description: "Proposal type. Type determines which workflow applies.",
				},
				proposal_type: {
					type: "string",
					description: "Alias for type. Proposal type determines workflow selection.",
				},
				domain_id: { type: "string", description: "Filter by domain" },
				maturity_min: {
					type: "number",
					description: "Minimum maturity gate level when supported by the backend query",
				},
			},
		},
		handler: (args: any) => handlers.listProposals(args),
	});
	server.addTool({
		name: "prop_get",
		description: "Get an AgentHive proposal by ID",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
		},
		handler: (args: any) => handlers.getProposal(args),
	});
	server.addTool(
		createAsyncValidatedTool(
			{
				name: "prop_create",
				description:
					"Create a new AgentHive proposal. Proposal type is required because it determines workflow selection.",
				inputSchema: {
					type: "object",
					properties: {
						title: { type: "string" },
						type: {
							type: "string",
							description:
								"Proposal type. Determines which workflow template applies.",
						},
						proposal_type: {
							type: "string",
							description:
								"Alias for type. Determines which workflow template applies.",
						},
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
			},
			{
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
					tags: { type: "string" },
					author: { type: "string" },
				},
				required: ["title"],
			},
			async (input) => {
				if (!input.type && !input.proposal_type) {
					return [
						"One of 'type' or 'proposal_type' is required. Proposal type determines which workflow applies.",
					];
				}
				return [];
			},
			async (args: any) => handlers.createProposal(args),
		),
	);
	server.addTool({
		name: "prop_update",
		description: "Update an existing AgentHive proposal",
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
			"Transition a proposal to a new workflow stage. Gate transitions require decision notes.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				status: {
					type: "string",
					description: "Target workflow stage, for example Draft, Review, Develop, Merge, or Complete",
				},
				author: { type: "string" },
				summary: { type: "string" },
			},
			required: ["id", "status"],
		},
		handler: (args: any) => handlers.transitionProposal(args),
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
	server.addTool({
		name: "prop_set_maturity",
		description:
			"Set proposal maturity inside the current workflow stage (new/active/mature/obsolete). Setting to 'mature' triggers the gate pipeline.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Proposal ID (display_id like P048 or numeric)" },
				maturity: {
					type: "string",
					description: "Maturity state: new, active, mature, or obsolete",
					enum: ["new", "active", "mature", "obsolete"],
				},
				agent: { type: "string", description: "Agent identity making the change" },
			},
			required: ["id", "maturity"],
		},
		handler: (args: any) => handlers.setMaturity(args),
	});

	console.log("[MCP] Using Postgres proposal handlers (AgentHive)");
}
