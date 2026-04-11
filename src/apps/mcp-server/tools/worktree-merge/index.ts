import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { WorktreeMergeHandlers } from "./handlers.ts";
import {
	worktreeMergeSchema,
	worktreeMergeStatusSchema,
	worktreeSyncSchema,
} from "./schemas.ts";

export function registerWorktreeMergeTools(
	server: McpServer,
	_projectRoot = process.cwd(),
): void {
	const handlers = new WorktreeMergeHandlers();

	const mergeTool = createSimpleValidatedTool(
		{
			name: "worktree_merge",
			description:
				"Merge a worktree branch back to main for a proposal. Validates proposal is in MERGE state, detects conflicts, performs the merge, pushes to origin, and records in the audit trail. Use dry_run to check for conflicts without committing.",
			inputSchema: worktreeMergeSchema,
		},
		worktreeMergeSchema,
		async (args) =>
			handlers.worktreeMerge(
				args as {
					proposal_id: string;
					worktree_path: string;
					branch?: string;
					target_branch?: string;
					dry_run?: boolean;
				},
			),
	);

	const syncTool = createSimpleValidatedTool(
		{
			name: "worktree_sync",
			description:
				"Sync active worktrees by rebasing them on the latest target branch (default: main). Runs after a merge to propagate changes to all active agents.",
			inputSchema: worktreeSyncSchema,
		},
		worktreeSyncSchema,
		async (args) =>
			handlers.worktreeSync(
				args as {
					target_branch?: string;
					worktree_paths?: string[];
					notify_agents?: boolean;
				},
			),
	);

	const statusTool = createSimpleValidatedTool(
		{
			name: "worktree_merge_status",
			description:
				"Check the merge history and status for a proposal. Shows past merge attempts, conflicts, and commit SHAs.",
			inputSchema: worktreeMergeStatusSchema,
		},
		worktreeMergeStatusSchema,
		async (args) =>
			handlers.worktreeMergeStatus(args as { proposal_id: string }),
	);

	server.addTool(mergeTool);
	server.addTool(syncTool);
	server.addTool(statusTool);
}
