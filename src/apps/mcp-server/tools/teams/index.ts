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
import { PgTeamGovernanceHandlers } from "./pg-governance-handlers.ts";
import {
	federationStatusSchema,
	leaseAcquireSchema,
	leaseRenewSchema,
	proposalReviewSchema,
	proposalSubmitSchema,
	teamAcceptSchema,
	teamAddMemberSchema,
	teamCharterCreateSchema,
	teamCreateSchema,
	teamDeclineSchema,
	teamDisputeLogSchema,
	teamDissolveSchema,
	teamGovernanceArchiveSchema,
	teamListSchema,
	teamNormsSetSchema,
	teamRegisterAgentSchema,
	teamRosterSchema,
} from "./schemas.ts";

export async function registerTeamTools(server: McpServer): Promise<void> {
	const handlers = new TeamHandlers(server);
	await handlers.initialize();

	const govHandlers = new PgTeamGovernanceHandlers(server);

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

// P055: List Teams
const teamListTool: McpToolHandler = createSimpleValidatedTool(
	{
		name: "team_list",
		description:
			"List all teams with optional filtering by status (active/archived/all) " +
			"and team type (feature/ops/research/admin). P055: Team & Squad Composition.",
		inputSchema: teamListSchema,
	},
	teamListSchema,
	async (input) => handlers.listTeams(input as any),
);

// P055: Add Member to Team
const teamAddMemberTool: McpToolHandler = createSimpleValidatedTool(
	{
		name: "team_add_member",
		description:
			"Add an agent as a member to an existing team with a specified role. " +
			"P055: Team & Squad Composition. Enforces squad size limits.",
		inputSchema: teamAddMemberSchema,
	},
	teamAddMemberSchema,
	async (input) => handlers.addTeamMember(input as any),
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

	// P182: Team Charter Creation (AC-1, AC-6)
	const teamCharterCreateTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_charter_create",
			description:
				"Create a team charter at squad assembly. Stores team:charter and default " +
				"governance norms in team_norms. Idempotent — safe to call again. " +
				"P182: Team Governance Layer (Ostrom Principle 8).",
			inputSchema: teamCharterCreateSchema,
		},
		teamCharterCreateSchema,
		async (input) => govHandlers.teamCharterCreate(input as any),
	);

	// P182: Team Norms Set (AC-2)
	const teamNormsSetTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_norms_set",
			description:
				"Set or update a named governance norm for a team. " +
				"Keys must start with 'team:' (e.g. team:norm:handoff, team:decision:X). " +
				"P182: Team Governance Layer.",
			inputSchema: teamNormsSetSchema,
		},
		teamNormsSetSchema,
		async (input) => govHandlers.teamNormsSet(input as any),
	);

	// P182: Team Dispute Log (AC-3, AC-4, AC-5)
	const teamDisputeLogTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_dispute_log",
			description:
				"Log or update a dispute between agents on a proposal. " +
				"Supports three-tier ladder: L1(self) → L2(peer) → L3(team) → L4(society). " +
				"Use status=team_resolved for disputes settled at team level. " +
				"P182: Team Governance Layer.",
			inputSchema: teamDisputeLogSchema,
		},
		teamDisputeLogSchema,
		async (input) => govHandlers.teamDisputeLog(input as any),
	);

	server.addTool(teamCreateTool);
	server.addTool(teamAcceptTool);
	server.addTool(teamDeclineTool);
	server.addTool(teamDissolveTool);
	server.addTool(teamListTool);
	server.addTool(teamAddMemberTool);
	server.addTool(teamRosterTool);
	server.addTool(teamRegisterTool);
	server.addTool(proposalSubmitTool);
	server.addTool(proposalReviewTool);
	server.addTool(leaseAcquireTool);
	server.addTool(leaseRenewTool);
	server.addTool(federationStatusTool);
	// P182: Team Governance Archive (AC-7)
	const teamGovernanceArchiveTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "team_governance_archive",
			description:
				"Archive team governance entries when a proposal completes. " +
				"Marks team:charter and team:decision:* as archived; deletes transient norms. " +
				"P182: Team Governance Layer (AC-7).",
			inputSchema: teamGovernanceArchiveSchema,
		},
		teamGovernanceArchiveSchema,
		async (input) => govHandlers.teamGovernanceArchive(input as any),
	);

	// P182 governance tools
	server.addTool(teamCharterCreateTool);
	server.addTool(teamNormsSetTool);
	server.addTool(teamDisputeLogTool);
	server.addTool(teamGovernanceArchiveTool);
}
