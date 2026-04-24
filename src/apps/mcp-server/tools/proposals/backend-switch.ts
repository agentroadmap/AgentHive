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
					description:
						"Alias for type. Proposal type determines workflow selection.",
				},
				domain_id: { type: "string", description: "Filter by domain" },
				maturity_min: {
					type: "number",
					description:
						"Minimum maturity gate level when supported by the backend query",
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
	server.addTool({
		name: "mcp_get_proposal_projection",
		description:
			"Get a projection of one proposal as YAML metadata plus Markdown narrative. Accepts fields or a compact projection string such as `roadmap proposal detail {id:P190, title, maturity, design, acceptance_criteria}`.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Proposal display_id or numeric id",
				},
				projection: {
					type: "string",
					description:
						"Optional compact projection expression, e.g. roadmap proposal detail {id:P190, title, maturity, design}",
				},
				fields: {
					oneOf: [
						{ type: "array", items: { type: "string" } },
						{ type: "string" },
					],
					description:
						"Fields to include. Supported: title, type, status, maturity, priority, summary, motivation, design, drawbacks, alternatives, dependency, dependencies, acceptance_criteria, lease, workflow, latest_decision, decisions, tags.",
				},
				format: {
					type: "string",
					enum: ["yaml_md", "json"],
					description: "Output format. Defaults to yaml_md.",
				},
			},
		},
		handler: (args: any) => handlers.getProposalProjection(args),
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
					description:
						"Target workflow stage, for example Draft, Review, Develop, Merge, or Complete",
				},
				author: { type: "string" },
				reason: {
					type: "string",
					description:
						"Transition reason: mature | decision | iteration | depend | discard | rejected | research | division | submit",
				},
				notes: {
					type: "string",
					description:
						"Required for gate decision transitions — record what was decided and why",
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
			"Setting 'mature' on DRAFT/REVIEW/DEVELOP/MERGE marks the proposal gate-ready " +
			"without changing status; COMPLETE is terminal and does not queue a gate advance.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Proposal display_id (e.g. P048)" },
				maturity: {
					type: "string",
					enum: ["new", "active", "mature", "obsolete"],
					description: "Target maturity level",
				},
				agent: { type: "string", description: "Agent making the declaration" },
				reason: {
					type: "string",
					description: "Optional note explaining the maturity declaration",
				},
			},
			required: ["id", "maturity"],
		},
		handler: (args: any) => handlers.setMaturity(args),
	});
	server.addTool({
		name: "prop_claim",
		description: "Claim an AgentHive proposal by creating a Postgres lease",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Proposal display_id or numeric id, for example P056",
				},
				agent: {
					type: "string",
					description: "Agent identity claiming the proposal",
				},
				durationMinutes: {
					type: "number",
					description: "Lease duration in minutes; defaults to 120",
				},
				force: {
					type: "boolean",
					description: "Release any active lease before claiming",
				},
			},
			required: ["id", "agent"],
		},
		handler: (args: any) => handlers.claimProposal(args),
	});
	server.addTool({
		name: "prop_release",
		description: "Release an active AgentHive proposal lease",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Proposal display_id or numeric id, for example P056",
				},
				agent: {
					type: "string",
					description: "Agent identity releasing the proposal",
				},
				reason: {
					type: "string",
					description: "Optional release reason",
				},
			},
			required: ["id", "agent"],
		},
		handler: (args: any) => handlers.releaseProposal(args),
	});
	server.addTool({
		name: "prop_renew",
		description: "Renew an active AgentHive proposal lease",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Proposal display_id or numeric id, for example P056",
				},
				agent: {
					type: "string",
					description: "Agent identity renewing the proposal",
				},
				durationMinutes: {
					type: "number",
					description: "Lease duration in minutes from now; defaults to 120",
				},
			},
			required: ["id", "agent"],
		},
		handler: (args: any) => handlers.renewProposal(args),
	});
	server.addTool({
		name: "prop_leases",
		description: "List active AgentHive proposal leases",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Optional proposal display_id or numeric id",
				},
			},
		},
		handler: (args: any) => handlers.listLeases(args),
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
	console.error("[MCP] Using Postgres proposal handlers (AgentHive)");
	server.addTool({
		name: "prop_get_projection",
		description:
			"Get a proposal as a YAML+MD projection — assembles metadata (id, type, status, maturity, lease, decision) and narrative (summary, design, ACs, deps) into a single prompt-ready block.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Proposal display_id or numeric id (e.g. P190)",
				},
			},
			required: ["id"],
		},
		handler: (args: any) => handlers.getProposalProjection(args),
	});

	// prop_get_detail - comprehensive single-call proposal with ALL children
	server.addTool({
		name: "prop_get_detail",
		description:
			"Get complete proposal detail in one call: main sections, acceptance criteria, dependencies, discussions, reviews, gate decision history, active dispatches, lease, and workflow state. Returns JSON by default.",
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "Proposal display_id or numeric id (e.g. P206)",
				},
				format: {
					type: "string",
					enum: ["json", "yaml_md"],
					description: "Output format. Defaults to json.",
				},
			},
			required: ["id"],
		},
		handler: (args: any) => handlers.getProposalDetail(args),
	});
}
