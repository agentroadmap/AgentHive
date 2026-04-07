// Merge Status MCP Tool
// Updates and checks merge status for proposals

export const mergeStatusSchema = {
	name: "roadmap_merge_status",
	description: "Update or check merge status for proposals after merge to main",
	inputSchema: {
		type: "object",
		properties: {
			action: {
				type: "string",
				enum: ["set", "check"],
				description: "Set merge status or check it",
			},
			proposalId: {
				type: "string",
				description: "Proposal ID (e.g., 37, 41.1)",
			},
			status: {
				type: "string",
				enum: ["merged", "pending", "merging", "conflict"],
				description: "Merge status to set",
			},
			commit: {
				type: "string",
				description: "Git commit hash (optional)",
			},
		},
		required: ["action", "proposalId"],
	},
};
