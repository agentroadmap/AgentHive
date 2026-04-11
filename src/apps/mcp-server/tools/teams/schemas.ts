/**
 * MCP tool schemas for team operations
 */

export const teamCreateSchema = {
	type: "object",
	properties: {
		projectName: {
			type: "string",
			description: "Name of the project to build a team for",
		},
		description: {
			type: "string",
			description: "Project description",
		},
		requirements: {
			type: "array",
			items: {
				type: "object",
				properties: {
					role: { type: "string" },
					skills: { type: "array", items: { type: "string" } },
					count: { type: "number" },
					priority: { type: "string", enum: ["required", "preferred"] },
				},
			},
			description: "Team role and skill requirements",
		},
		skills: {
			type: "array",
			items: { type: "string" },
			description: "Overall skills coverage needed",
		},
	},
	required: ["projectName", "requirements", "skills"],
};

export const teamAcceptSchema = {
	type: "object",
	properties: {
		teamId: {
			type: "string",
			description: "Team ID to accept invitation for",
		},
		agentId: {
			type: "string",
			description: "Agent accepting the invitation",
		},
	},
	required: ["teamId", "agentId"],
};

export const teamDeclineSchema = {
	type: "object",
	properties: {
		teamId: {
			type: "string",
			description: "Team ID to decline invitation for",
		},
		agentId: {
			type: "string",
			description: "Agent declining the invitation",
		},
		reason: {
			type: "string",
			description: "Reason for declining",
		},
	},
	required: ["teamId", "agentId"],
};

export const teamDissolveSchema = {
	type: "object",
	properties: {
		teamId: {
			type: "string",
			description: "Team ID to dissolve",
		},
		reason: {
			type: "string",
			description: "Reason for dissolution",
		},
	},
	required: ["teamId", "reason"],
};

export const teamRosterSchema = {
	type: "object",
	properties: {
		teamId: {
			type: "string",
			description:
				"Team ID to query roster for (optional, returns all if omitted)",
		},
		role: {
			type: "string",
			description: "Filter by role",
		},
		pool: {
			type: "string",
			description: "Filter by pool",
		},
	},
	required: [],
};

export const teamRegisterAgentSchema = {
	type: "object",
	properties: {
		agentId: {
			type: "string",
			description: "Agent ID to register",
		},
		skills: {
			type: "array",
			items: { type: "string" },
			description: "Agent skills",
		},
		role: {
			type: "string",
			description: "Role assignment",
		},
		pool: {
			type: "string",
			description: "Pool assignment",
		},
	},
	required: ["agentId", "skills", "role", "pool"],
};

export const proposalSubmitSchema = {
	type: "object",
	properties: {
		proposalId: {
			type: "string",
			description: "Proposal ID to propose",
		},
		title: {
			type: "string",
			description: "Proposal title",
		},
		description: {
			type: "string",
			description: "Proposal description",
		},
		proposedBy: {
			type: "string",
			description: "Proposing agent ID",
		},
		tags: {
			type: "array",
			items: { type: "string" },
			description: "Tags for the proposal",
		},
		priority: {
			type: "string",
			enum: ["low", "medium", "high", "critical"],
			description: "Proposal priority",
		},
	},
	required: ["proposalId", "title", "description", "proposedBy"],
};

export const proposalReviewSchema = {
	type: "object",
	properties: {
		proposalId: {
			type: "string",
			description: "Proposal ID to review",
		},
		reviewerId: {
			type: "string",
			description: "Reviewer agent ID",
		},
		role: {
			type: "string",
			enum: ["pm", "architect", "lead", "peer"],
			description: "Reviewer role",
		},
		recommendation: {
			type: "string",
			enum: ["approve", "reject", "needs-revision"],
			description: "Review recommendation",
		},
		score: {
			type: "number",
			description: "Review score (1-10)",
		},
		comments: {
			type: "string",
			description: "Review comments",
		},
	},
	required: [
		"proposalId",
		"reviewerId",
		"role",
		"recommendation",
		"score",
		"comments",
	],
};

export const leaseAcquireSchema = {
	type: "object",
	properties: {
		itemId: {
			type: "string",
			description: "Backlog item ID to lease",
		},
		agentId: {
			type: "string",
			description: "Agent leasing the item",
		},
		durationHours: {
			type: "number",
			description: "Lease duration in hours (default: 48)",
		},
	},
	required: ["itemId", "agentId"],
};

export const leaseRenewSchema = {
	type: "object",
	properties: {
		leaseId: {
			type: "string",
			description: "Lease ID to renew",
		},
		agentId: {
			type: "string",
			description: "Agent renewing the lease",
		},
	},
	required: ["leaseId", "agentId"],
};

export const teamListSchema = {
	type: "object",
	properties: {
		status: {
			type: "string",
			enum: ["active", "archived", "all"],
			description: "Filter by team status (default: active)",
		},
		teamType: {
			type: "string",
			enum: ["feature", "ops", "research", "admin"],
			description: "Filter by team type",
		},
	},
	required: [],
};

export const teamAddMemberSchema = {
	type: "object",
	properties: {
		teamId: {
			type: "string",
			description: "Team ID to add member to",
		},
		agentId: {
			type: "string",
			description: "Agent ID to add as member",
		},
		role: {
			type: "string",
			description: "Role for the new member (e.g., lead, member, observer)",
		},
	},
	required: ["teamId", "agentId", "role"],
};

export const federationStatusSchema = {
	type: "object",
	properties: {},
	required: [],
};

export const federationSyncSchema = {
	type: "object",
	properties: {
		hostname: {
			type: "string",
			description: "Peer hostname to sync with",
		},
		port: {
			type: "number",
			description: "Peer port",
		},
		since: {
			type: "string",
			description: "Sync changes since timestamp (ISO 8601)",
		},
	},
	required: ["hostname", "port"],
};
