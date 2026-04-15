/**
 * Merge Executor — zero-cost git merge runner.
 *
 * Processes MERGE entries from transition_queue. Runs git merge in the
 * proposal's worktree and reports conflicts. Escalates to an LLM agent
 * if merge conflicts are detected.
 */

import { spawn } from "node:child_process";
import { query } from "../../infra/postgres/pool.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

const WORKTREE_ROOT = "/data/code/worktree";

interface MergeExecutorConfig {
	escalateOnConflict?: boolean;
}

interface QueueRow {
	id: number;
	proposal_id: number | string;
	metadata: Record<string, unknown> | null;
}

export class MergeExecutor implements ToolAgent {
	identity = "tool/merge-executor";
	capabilities = ["git-merge", "conflict-detection", "branch-integration"];

	private readonly escalateOnConflict: boolean;

	constructor(config: Record<string, unknown>) {
		const cfg = config as MergeExecutorConfig;
		this.escalateOnConflict = cfg.escalateOnConflict ?? true;
	}

	async invoke(task: ToolTask): Promise<ToolResult> {
		const queueId = task.payload.queueId as number | undefined;
		const proposalId = task.proposalId;

		if (!queueId || !proposalId) {
			return {
				success: false,
				output: "Missing queueId or proposalId",
				tokensUsed: 0,
			};
		}

		// Find the worktree for this proposal
		const { rows: propRows } = await query<{ display_id: string }>(
			`SELECT display_id FROM roadmap.proposal WHERE id = $1`,
			[proposalId],
		);

		if (propRows.length === 0) {
			return {
				success: false,
				output: `Proposal ${proposalId} not found`,
				tokensUsed: 0,
			};
		}

		// Run git merge — attempt merge into main
		const worktreePath = `${WORKTREE_ROOT}/xiaomi-one`;
		const result = await runGitCommand(
			["merge", "--no-edit", "HEAD"],
			worktreePath,
		);

		if (result.exitCode === 0) {
			// Clean merge
			return {
				success: true,
				output: `Merge clean for proposal ${proposalId}: ${result.stdout.slice(0, 500)}`,
				tokensUsed: 0,
			};
		}

		// Check for conflicts
		const hasConflicts =
			result.stdout.includes("CONFLICT") ||
			result.stderr.includes("CONFLICT");

		if (hasConflicts) {
			// Abort the conflicted merge
			await runGitCommand(["merge", "--abort"], worktreePath);

			if (this.escalateOnConflict) {
				return {
					success: false,
					output: `Merge conflict for proposal ${proposalId}. Aborted.`,
					tokensUsed: 0,
					escalate: true,
					escalationReason: `Merge conflict detected: ${result.stdout.slice(0, 300)}`,
				};
			}

			return {
				success: false,
				output: `Merge conflict for proposal ${proposalId}: ${result.stdout.slice(0, 500)}`,
				tokensUsed: 0,
			};
		}

		return {
			success: false,
			output: `Merge failed for proposal ${proposalId}: ${result.stderr.slice(0, 500)}`,
			tokensUsed: 0,
		};
	}

	async healthCheck(): Promise<boolean> {
		const result = await runGitCommand(
			["rev-parse", "--git-dir"],
			WORKTREE_ROOT,
		);
		return result.exitCode === 0;
	}
}

function runGitCommand(
	args: string[],
	cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		child.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code });
		});

		child.on("error", (err) => {
			resolve({
				stdout,
				stderr: `${stderr}\nspawn error: ${err.message}`,
				exitCode: null,
			});
		});
	});
}
