import type { JsonSchema } from "../../validation/validators.ts";

export const worktreeMergeSchema: JsonSchema = {
	type: "object",
	properties: {
		proposal_id: {
			type: "string",
			description: "The proposal ID to merge (e.g., P090, 90)",
			maxLength: 50,
		},
		worktree_path: {
			type: "string",
			description: "Path to the worktree directory containing the branch to merge",
			maxLength: 500,
		},
		branch: {
			type: "string",
			description: "Branch name to merge (auto-detected from worktree if omitted)",
			maxLength: 200,
		},
		target_branch: {
			type: "string",
			description: "Target branch to merge into (default: main)",
			default: "main",
			maxLength: 200,
		},
		dry_run: {
			type: "boolean",
			description: "If true, validate and check for conflicts without performing merge",
			default: false,
		},
	},
	required: ["proposal_id", "worktree_path"],
};

export const worktreeSyncSchema: JsonSchema = {
	type: "object",
	properties: {
		target_branch: {
			type: "string",
			description: "Branch to sync from (default: main)",
			default: "main",
			maxLength: 200,
		},
		worktree_paths: {
			type: "array",
			description: "Specific worktree paths to sync (if omitted, syncs all active worktrees)",
			items: { type: "string", maxLength: 500 },
		},
		notify_agents: {
			type: "boolean",
			description: "Whether to notify agents of conflicts via the channel system",
			default: true,
		},
	},
	required: [],
};

export const worktreeMergeStatusSchema: JsonSchema = {
	type: "object",
	properties: {
		proposal_id: {
			type: "string",
			description: "The proposal ID to check merge status for",
			maxLength: 50,
		},
	},
	required: ["proposal_id"],
};
