import type { RoadmapConfig } from "../../../../shared/types/index.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import {
	generateProposalCreateSchema,
	generateProposalEditSchema,
} from "../../utils/schema-generators.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type {
	ProposalCreateArgs,
	ProposalEditRequest,
	ProposalListArgs,
	ProposalSearchArgs,
} from "./handlers.ts";
import { ProposalHandlers } from "./handlers.ts";
import {
	proposalArchiveSchema,
	proposalClaimSchema,
	proposalCompleteSchema,
	proposalDemoteSchema,
	proposalExportSchema,
	proposalHeartbeatSchema,
	proposalImpactSchema,
	proposalListSchema,
	proposalMergeSchema,
	proposalMoveSchema,
	proposalPickupSchema,
	proposalPrioritySchema,
	proposalPromoteSchema,
	proposalPruneClaimsSchema,
	proposalReleaseSchema,
	proposalRenewSchema,
	proposalRequestEnrichmentSchema,
	proposalSearchSchema,
	proposalViewSchema,
} from "./schemas.ts";

export function registerProposalTools(
	server: McpServer,
	config: RoadmapConfig,
): void {
	const handlers = new ProposalHandlers(server);

	const proposalCreateSchema = generateProposalCreateSchema(config);
	const proposalEditSchema = generateProposalEditSchema(config);

	const proposalImpactTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_impact",
			description:
				"Analyze the forward impact of a proposal change (what breaks if this changes?)",
			inputSchema: proposalImpactSchema,
		},
		proposalImpactSchema,
		async (input) => handlers.impactProposal(input as { id: string }),
	);

	const createProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_create",
			description: "Create a new proposal using Roadmap.md",
			inputSchema: proposalCreateSchema,
		},
		proposalCreateSchema,
		async (input) => handlers.createProposal(input as ProposalCreateArgs),
	);

	const heartbeatProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_heartbeat",
			description:
				"Signal that the agent is still actively working on the proposal",
			inputSchema: proposalHeartbeatSchema,
		},
		proposalHeartbeatSchema,
		async (input) =>
			handlers.heartbeatProposal(input as { id: string; agent: string }),
	);

	const pruneClaimsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_prune_claims",
			description: "Remove claims that have exceeded their heartbeat timeout",
			inputSchema: proposalPruneClaimsSchema,
		},
		proposalPruneClaimsSchema,
		async (input) => handlers.pruneClaims(input as { timeoutMinutes?: number }),
	);

	const pickupProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_pickup",
			description:
				"Find the best ready proposal and claim it atomically for the requesting agent",
			inputSchema: proposalPickupSchema,
		},
		proposalPickupSchema,
		async (input) =>
			handlers.pickupProposal(
				input as { agent: string; dryRun?: boolean; durationMinutes?: number },
			),
	);

	const listProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_list",
			description: "List Roadmap.md proposals from with optional filtering",
			inputSchema: proposalListSchema,
		},
		proposalListSchema,
		async (input) => handlers.listProposals(input as ProposalListArgs),
	);

	const searchProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_search",
			description: "Search Roadmap.md proposals by title and description",
			inputSchema: proposalSearchSchema,
		},
		proposalSearchSchema,
		async (input) => handlers.searchProposals(input as ProposalSearchArgs),
	);

	const editProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_edit",
			description:
				"Edit a Roadmap.md proposal, including metadata, implementation plan/notes, dependencies, and acceptance criteria",
			inputSchema: proposalEditSchema,
		},
		proposalEditSchema,
		async (input) =>
			handlers.editProposal(input as unknown as ProposalEditRequest),
	);

	const viewProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_view",
			description: "View a Roadmap.md proposal details",
			inputSchema: proposalViewSchema,
		},
		proposalViewSchema,
		async (input) => handlers.viewProposal(input as { id: string }),
	);

	const archiveProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_archive",
			description: "Archive a Roadmap.md proposal",
			inputSchema: proposalArchiveSchema,
		},
		proposalArchiveSchema,
		async (input) => handlers.archiveProposal(input as { id: string }),
	);

	const completeProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_complete",
			description:
				"Complete a Roadmap.md proposal (move it to the completed folder)",
			inputSchema: proposalCompleteSchema,
		},
		proposalCompleteSchema,
		async (input) => handlers.completeProposal(input as { id: string }),
	);

	const claimProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_claim",
			description: "Claim a proposal for an agent with a short-lived lease",
			inputSchema: proposalClaimSchema,
		},
		proposalClaimSchema,
		async (input) =>
			handlers.claimProposal(
				input as {
					id: string;
					agent: string;
					durationMinutes?: number;
					message?: string;
					force?: boolean;
				},
			),
	);

	const releaseProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_release",
			description: "Release a claim on a proposal",
			inputSchema: proposalReleaseSchema,
		},
		proposalReleaseSchema,
		async (input) =>
			handlers.releaseProposal(
				input as { id: string; agent: string; force?: boolean },
			),
	);

	const renewProposalTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_renew",
			description: "Renew an existing claim, extending its expiration",
			inputSchema: proposalRenewSchema,
		},
		proposalRenewSchema,
		async (input) =>
			handlers.renewProposal(
				input as { id: string; agent: string; durationMinutes?: number },
			),
	);

	const listProposalMetadataTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_list_metadata",
			description:
				"List Roadmap.md proposals with only metadata (ID, Title, Status, Priority) to save tokens",
			inputSchema: proposalListSchema,
		},
		proposalListSchema,
		async (input) => handlers.listProposalsMetadata(input as ProposalListArgs),
	);

	server.addTool(createProposalTool);
	server.addTool(proposalImpactTool);
	server.addTool(heartbeatProposalTool);
	server.addTool(pruneClaimsTool);
	server.addTool(pickupProposalTool);
	server.addTool(listProposalTool);
	server.addTool(listProposalMetadataTool);
	server.addTool(searchProposalTool);
	server.addTool(editProposalTool);
	server.addTool(viewProposalTool);
	server.addTool(archiveProposalTool);
	server.addTool(completeProposalTool);
	server.addTool(claimProposalTool);
	server.addTool(releaseProposalTool);
	server.addTool(renewProposalTool);

	// S129: Roadmap Board Proposal Operations
	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_promote",
				description: "Promote a proposal to the next status level",
				inputSchema: proposalPromoteSchema,
			},
			proposalPromoteSchema,
			async (input) => handlers.promoteProposal(input as any),
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_demote",
				description: "Demote a proposal to the previous status level",
				inputSchema: proposalDemoteSchema,
			},
			proposalDemoteSchema,
			async (input) => handlers.demoteProposal(input as any),
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_priority_up",
				description: "Increase proposal priority",
				inputSchema: proposalPrioritySchema,
			},
			proposalPrioritySchema,
			async (input) => handlers.priorityUp(input as any),
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_priority_down",
				description: "Decrease proposal priority",
				inputSchema: proposalPrioritySchema,
			},
			proposalPrioritySchema,
			async (input) => handlers.priorityDown(input as any),
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_merge",
				description: "Merge one proposal into another",
				inputSchema: proposalMergeSchema,
			},
			proposalMergeSchema,
			async (input) => handlers.mergeProposals(input as any),
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_move",
				description: "Move a proposal in the board",
				inputSchema: proposalMoveSchema,
			},
			proposalMoveSchema,
			async (input) => handlers.moveProposal(input as any),
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_request_enrich",
				description: "Request research or enrichment for a proposal",
				inputSchema: proposalRequestEnrichmentSchema,
			},
			proposalRequestEnrichmentSchema,
			async (input) => handlers.requestEnrichment(input as any),
		),
	);

	server.addTool(
		createSimpleValidatedTool(
			{
				name: "proposal_export",
				description: "Export proposal to Markdown or JSON",
				inputSchema: proposalExportSchema,
			},
			proposalExportSchema,
			async (input) => handlers.proposalExport(input as any),
		),
	);
}

export type {
	ProposalCreateArgs,
	ProposalEditArgs,
	ProposalListArgs,
	ProposalSearchArgs,
} from "./handlers.ts";
export {
	proposalDemoteSchema,
	proposalExportSchema,
	proposalImpactSchema,
	proposalListSchema,
	proposalMergeSchema,
	proposalMoveSchema,
	proposalPickupSchema,
	proposalPrioritySchema,
	proposalPromoteSchema,
	proposalPruneClaimsSchema,
	proposalReleaseSchema,
	proposalRenewSchema,
	proposalRequestEnrichmentSchema,
	proposalSearchSchema,
	proposalViewSchema,
} from "./schemas.ts";
