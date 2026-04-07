/**
 * MCP tools for team operations
 *
 * STATE-62: Dynamic Team Building
 * STATE-63: Agent Team Membership
 * STATE-61: Agent Proposal & Lease-Based Backlog System
 * STATE-46: Multi-Host Federation
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { TeamHandlers } from "./handlers.ts";
import {
	federationStatusSchema,
	leaseAcquireSchema,
	leaseRenewSchema,
	proposalReviewSchema,
	proposalSubmitSchema,
	teamAcceptSchema,
	teamCreateSchema,
	teamDeclineSchema,
	teamDissolveSchema,
	teamRegisterAgentSchema,
	teamRosterSchema,
} from "./schemas.ts";

export async function registerTeamTools(server: McpServer): Promise<void> {
	const handlers = new TeamHandlers(server);
	await handlers.initialize();

	// STATE-62: Team Creation
	const teamCreateTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_create",
			description:
				"Create a team based on project requirements and agent capabilities",
			inputSchema: teamCreateSchema,
		},
		teamCreateSchema,
		async (input) => handlers.createTeam(input as any),
	);

	// STATE-62: Accept Invitation
	const teamAcceptTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_accept",
			description: "Accept a team invitation",
			inputSchema: teamAcceptSchema,
		},
		teamAcceptSchema,
		async (input) => handlers.acceptInvitation(input as any),
	);

	// STATE-62: Decline Invitation
	const teamDeclineTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_decline",
			description: "Decline a team invitation",
			inputSchema: teamDeclineSchema,
		},
		teamDeclineSchema,
		async (input) => handlers.declineInvitation(input as any),
	);

	// STATE-62: Dissolve Team
	const teamDissolveTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_dissolve",
			description: "Dissolve a team when project is complete",
			inputSchema: teamDissolveSchema,
		},
		teamDissolveSchema,
		async (input) => handlers.dissolveTeam(input as any),
	);

	// STATE-62/63: Query Roster
	const teamRosterTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_roster",
			description: "Query team roster (who's on the team, roles, pools)",
			inputSchema: teamRosterSchema,
		},
		teamRosterSchema,
		async (input) => handlers.queryRoster(input as any),
	);

	// STATE-63: Register Agent
	const teamRegisterTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_register_agent",
			description:
				"Register an agent for team membership with skills, role, and pool",
			inputSchema: teamRegisterAgentSchema,
		},
		teamRegisterAgentSchema,
		async (input) => handlers.registerAgent(input as any),
	);

	// STATE-61: Submit Proposal
	const proposalSubmitTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_submit",
			description: "Submit a proposal for a new component or feature",
			inputSchema: proposalSubmitSchema,
		},
		proposalSubmitSchema,
		async (input) => handlers.submitProposal(input as any),
	);

	// STATE-61: Review Proposal
	const proposalReviewTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "proposal_review",
			description: "Submit a review for a proposal (PM/Architect)",
			inputSchema: proposalReviewSchema,
		},
		proposalReviewSchema,
		async (input) => handlers.reviewProposal(input as any),
	);

	// STATE-61: Acquire Lease
	const leaseAcquireTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "lease_acquire",
			description: "Acquire a lease on a backlog item for limited time",
			inputSchema: leaseAcquireSchema,
		},
		leaseAcquireSchema,
		async (input) => handlers.acquireLease(input as any),
	);

	// STATE-61: Renew Lease
	const leaseRenewTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "lease_renew",
			description: "Renew a lease using heartbeat proof",
			inputSchema: leaseRenewSchema,
		},
		leaseRenewSchema,
		async (input) => handlers.renewLease(input as any),
	);

	// STATE-46: Federation Status
	const federationStatusTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "federation_status",
			description: "Get multi-host federation status",
			inputSchema: federationStatusSchema,
		},
		federationStatusSchema,
		async () => handlers.getFederationStatus(),
	);

	server.addTool(teamCreateTool);
	server.addTool(teamAcceptTool);
	server.addTool(teamDeclineTool);
	server.addTool(teamDissolveTool);
	server.addTool(teamRosterTool);
	server.addTool(teamRegisterTool);
	server.addTool(proposalSubmitTool);
	server.addTool(proposalReviewTool);
	server.addTool(leaseAcquireTool);
	server.addTool(leaseRenewTool);
	server.addTool(federationStatusTool);
}
