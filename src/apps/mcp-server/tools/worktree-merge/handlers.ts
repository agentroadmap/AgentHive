import { query } from "../../../../postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

type ProposalRow = {
	id: number;
	display_id: string;
	status: string;
	audit: unknown[];
};

type MergeLogRow = {
	id: number;
	proposal_id: number;
	commit_sha: string | null;
	status: string;
	conflict_files: string[] | null;
	error_message: string | null;
	created_at: string;
};

type WorktreeInfo = {
	branch: string;
	worktree_path: string;
	commit: string;
};

function errorResult(message: string, error: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${message}: ${error instanceof Error ? error.message : String(error)}`,
			},
		],
	};
}

/**
 * Execute a shell command and return its output.
 */
async function execCommand(
	cmd: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = new Deno.Command(cmd[0], {
		args: cmd.slice(1),
		cwd,
		stdout: "piped",
		stderr: "piped",
	});
	const result = await proc.output();
	return {
		stdout: new TextDecoder().decode(result.stdout).trim(),
		stderr: new TextDecoder().decode(result.stderr).trim(),
		exitCode: result.code,
	};
}

/**
 * Detect the current branch in a worktree.
 */
async function detectBranch(worktreePath: string): Promise<string | null> {
	const { stdout, exitCode } = await execCommand(
		["git", "rev-parse", "--abbrev-ref", "HEAD"],
		worktreePath,
	);
	return exitCode === 0 ? stdout : null;
}

/**
 * Check if a branch exists in the repo.
 */
async function branchExists(
	repoPath: string,
	branch: string,
): Promise<boolean> {
	const { exitCode } = await execCommand(
		["git", "rev-parse", "--verify", branch],
		repoPath,
	);
	return exitCode === 0;
}

/**
 * Detect merge conflicts by checking if merge would succeed.
 * Returns list of conflicting files or empty array.
 */
async function checkMergeConflicts(
	worktreePath: string,
	targetBranch: string,
): Promise<string[]> {
	// Try a merge-tree to detect conflicts without modifying anything
	const { stdout, exitCode } = await execCommand(
		["git", "merge-tree", targetBranch, "HEAD"],
		worktreePath,
	);

	if (exitCode !== 0) {
		// Fallback: try git merge --no-commit --no-ff then abort
		const mergeResult = await execCommand(
			["git", "merge", "--no-commit", "--no-ff", targetBranch],
			worktreePath,
		);
		if (mergeResult.exitCode !== 0) {
			// Get conflicting files
			const statusResult = await execCommand(
				["git", "diff", "--name-only", "--diff-filter=U"],
				worktreePath,
			);
			const conflicts = statusResult.stdout
				.split("\n")
				.filter((f) => f.trim());
			// Abort the merge
			await execCommand(["git", "merge", "--abort"], worktreePath);
			return conflicts;
		}
		// Merge succeeded, abort it (we're just checking)
		await execCommand(["git", "merge", "--abort"], worktreePath);
	}

	// Check for conflict markers in merge-tree output
	const conflictLines = stdout
		.split("\n")
		.filter((line) => line.startsWith("<<<<<<<"));
	if (conflictLines.length > 0) {
		// Extract file names from conflict output
		const files = new Set<string>();
		for (const line of stdout.split("\n")) {
			if (line.match(/^\+{3} b\//)) {
				files.add(line.replace(/^\+{3} b\//, ""));
			}
		}
		return Array.from(files);
	}

	return [];
}

/**
 * Get the latest commit SHA on a branch.
 */
async function getLatestCommit(
	repoPath: string,
	branch: string,
): Promise<string | null> {
	const { stdout, exitCode } = await execCommand(
		["git", "rev-parse", branch],
		repoPath,
	);
	return exitCode === 0 ? stdout : null;
}

/**
 * Find all active worktrees by parsing git worktree list.
 */
async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
	const { stdout, exitCode } = await execCommand(
		["git", "worktree", "list", "--porcelain"],
		repoPath,
	);
	if (exitCode !== 0) return [];

	const worktrees: WorktreeInfo[] = [];
	let currentPath = "";
	let currentBranch = "";
	let currentCommit = "";

	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			currentPath = line.substring(9);
		} else if (line.startsWith("branch ")) {
			currentBranch = line.substring(7).replace("refs/heads/", "");
		} else if (line.startsWith("HEAD ")) {
			currentCommit = line.substring(5);
		} else if (line === "" && currentPath) {
			if (currentBranch) {
				worktrees.push({
					branch: currentBranch,
					worktree_path: currentPath,
					commit: currentCommit,
				});
			}
			currentPath = "";
			currentBranch = "";
			currentCommit = "";
		}
	}

	// Handle last entry
	if (currentPath && currentBranch) {
		worktrees.push({
			branch: currentBranch,
			worktree_path: currentPath,
			commit: currentCommit,
		});
	}

	return worktrees;
}

export class WorktreeMergeHandlers {
	private async resolveProposal(
		proposalId: string,
	): Promise<ProposalRow | null> {
		const { rows } = await query<ProposalRow>(
			`SELECT id, display_id, status, audit
			 FROM proposal
			 WHERE display_id = $1 OR CAST(id AS text) = $1
			 LIMIT 1`,
			[proposalId],
		);
		return rows[0] ?? null;
	}

	/**
	 * AC-1: Validate proposal is in MERGE state, run git merge,
	 * handle conflicts, push to origin, record in audit trail.
	 */
	async worktreeMerge(args: {
		proposal_id: string;
		worktree_path: string;
		branch?: string;
		target_branch?: string;
		dry_run?: boolean;
	}): Promise<CallToolResult> {
		try {
			const proposal = await this.resolveProposal(args.proposal_id);
			if (!proposal) {
				return {
					content: [
						{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
					],
				};
			}

			// Validate proposal is in MERGE state
			const status = proposal.status?.toUpperCase();
			if (status !== "MERGE" && status !== "COMPLETE") {
				return {
					content: [
						{
							type: "text",
							text: `❌ Proposal ${args.proposal_id} is in ${proposal.status} state. Must be in MERGE or COMPLETE state to merge worktree.`,
						},
					],
				};
			}

			// Verify worktree path exists
			try {
				const stat = await Deno.stat(args.worktree_path);
				if (!stat.isDirectory) {
					return {
						content: [
							{
								type: "text",
								text: `❌ ${args.worktree_path} is not a directory.`,
							},
						],
					};
				}
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `❌ Worktree path ${args.worktree_path} does not exist. Worktree may have been cleaned up.`,
						},
					],
				};
			}

			const targetBranch = args.target_branch || "main";

			// Detect source branch
			const sourceBranch =
				args.branch || (await detectBranch(args.worktree_path));
			if (!sourceBranch) {
				return {
					content: [
						{
							type: "text",
							text: `❌ Could not detect branch in ${args.worktree_path}. Not a git worktree?`,
						},
					],
				};
			}

			// Find the repo root (parent git dir)
			const { stdout: gitDir } = await execCommand(
				["git", "rev-parse", "--git-dir"],
				args.worktree_path,
			);
			const repoRoot = gitDir.replace(/\/\.git.*/, "");

			// Check target branch exists
			if (!(await branchExists(repoRoot, targetBranch))) {
				return {
					content: [
						{
							type: "text",
							text: `❌ Target branch '${targetBranch}' does not exist in the repository.`,
						},
					],
				};
			}

			// Check for conflicts
			const conflicts = await checkMergeConflicts(
				args.worktree_path,
				targetBranch,
			);
			if (conflicts.length > 0) {
				if (args.dry_run) {
					return {
						content: [
							{
								type: "text",
								text: `⚠️ Merge would conflict. Conflicting files:\n${conflicts.map((f) => `  - ${f}`).join("\n")}`,
							},
						],
					};
				}

				// Record conflict in merge log
				await query(
					`INSERT INTO worktree_merge_log (proposal_id, status, conflict_files, error_message)
					 VALUES ($1, 'conflict', $2::jsonb, $3)`,
					[
						proposal.id,
						JSON.stringify(conflicts),
						`Merge conflict between ${sourceBranch} and ${targetBranch}`,
					],
				);

				return {
					content: [
						{
							type: "text",
							text: `❌ Merge conflict detected for ${args.proposal_id}. Conflicting files:\n${conflicts.map((f) => `  - ${f}`).join("\n")}\n\nManual resolution required. Proposal held at MERGE state.`,
						},
					],
				};
			}

			if (args.dry_run) {
				return {
					content: [
						{
							type: "text",
							text: `✅ Dry run: No conflicts detected. Merge of ${sourceBranch} → ${targetBranch} would succeed for ${args.proposal_id}.`,
						},
					],
				};
			}

			// Perform the merge in the worktree
			const mergeResult = await execCommand(
				["git", "merge", "--no-ff", "-m", `Merge ${sourceBranch} into ${targetBranch} [proposal ${proposal.display_id}]`, targetBranch],
				args.worktree_path,
			);

			if (mergeResult.exitCode !== 0) {
				// Abort if failed
				await execCommand(["git", "merge", "--abort"], args.worktree_path);

				await query(
					`INSERT INTO worktree_merge_log (proposal_id, status, error_message)
					 VALUES ($1, 'failed', $2)`,
					[proposal.id, mergeResult.stderr],
				);

				return {
					content: [
						{
							type: "text",
							text: `❌ Merge failed: ${mergeResult.stderr}`,
						},
					],
				};
			}

			// Get the merge commit SHA
			const commitSha = await getLatestCommit(args.worktree_path, "HEAD");

			// Push to origin
			const pushResult = await execCommand(
				["git", "push", "origin", targetBranch],
				args.worktree_path,
			);

			if (pushResult.exitCode !== 0) {
				return {
					content: [
						{
							type: "text",
							text: `⚠️ Merge committed locally (${commitSha}) but push failed: ${pushResult.stderr}\nYou may need to push manually.`,
						},
					],
				};
			}

			// Record successful merge in log
			await query(
				`INSERT INTO worktree_merge_log (proposal_id, commit_sha, status)
				 VALUES ($1, $2, 'merged')`,
				[proposal.id, commitSha],
			);

			// Update proposal audit trail
			const auditEntry = {
				TS: new Date().toISOString(),
				Agent: "worktree-merge",
				Activity: "WorktreeMerge",
				Commit: commitSha,
				Branch: `${sourceBranch} → ${targetBranch}`,
			};

			await query(
				`UPDATE proposal
				 SET audit = audit || $2::jsonb
				 WHERE id = $1`,
				[proposal.id, JSON.stringify([auditEntry])],
			);

			return {
				content: [
					{
						type: "text",
						text: `✅ Worktree merge complete for ${args.proposal_id}.\n• Branch: ${sourceBranch} → ${targetBranch}\n• Commit: ${commitSha}\n• Pushed to origin/${targetBranch}`,
					},
				],
			};
		} catch (error) {
			return errorResult("Failed to merge worktree", error);
		}
	}

	/**
	 * AC-2: Post-merge sync — rebase active worktrees on updated main.
	 */
	async worktreeSync(args: {
		target_branch?: string;
		worktree_paths?: string[];
		notify_agents?: boolean;
	}): Promise<CallToolResult> {
		try {
			const targetBranch = args.target_branch || "main";

			// Find repo root (use cwd or find .git)
			const { stdout: gitDir } = await execCommand([
				"git",
				"rev-parse",
				"--git-dir",
			]);
			const repoRoot = gitDir.replace(/\/\.git.*/, "");

			// Fetch latest from origin
			await execCommand(["git", "fetch", "origin", targetBranch], repoRoot);

			// Get all worktrees or specific ones
			let worktrees: WorktreeInfo[];
			if (args.worktree_paths && args.worktree_paths.length > 0) {
				worktrees = [];
				for (const p of args.worktree_paths) {
					const branch = await detectBranch(p);
					if (branch) {
						worktrees.push({ branch, worktree_path: p, commit: "" });
					}
				}
			} else {
				worktrees = await listWorktrees(repoRoot);
			}

			// Filter out the main branch worktree
			const activeWorktrees = worktrees.filter(
				(w) => w.branch !== targetBranch,
			);

			if (activeWorktrees.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "ℹ️ No active worktrees to sync.",
						},
					],
				};
			}

			const results: string[] = [];

			for (const wt of activeWorktrees) {
				// Rebase on updated target branch
				const rebaseResult = await execCommand(
					["git", "rebase", `origin/${targetBranch}`],
					wt.worktree_path,
				);

				if (rebaseResult.exitCode !== 0) {
					// Abort rebase
					await execCommand(["git", "rebase", "--abort"], wt.worktree_path);
					results.push(
						`⚠️ ${wt.branch} (${wt.worktree_path}): rebase conflict — ${rebaseResult.stderr}`,
					);
				} else {
					results.push(`✅ ${wt.branch} (${wt.worktree_path}): synced`);
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `## Worktree Sync Results (${activeWorktrees.length} worktrees)\n\n${results.join("\n")}`,
					},
				],
			};
		} catch (error) {
			return errorResult("Failed to sync worktrees", error);
		}
	}

	/**
	 * AC-3: Check merge status for a proposal.
	 */
	async worktreeMergeStatus(args: {
		proposal_id: string;
	}): Promise<CallToolResult> {
		try {
			const proposal = await this.resolveProposal(args.proposal_id);
			if (!proposal) {
				return {
					content: [
						{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
					],
				};
			}

			const { rows } = await query<MergeLogRow>(
				`SELECT id, proposal_id, commit_sha, status, conflict_files, error_message, created_at
				 FROM worktree_merge_log
				 WHERE proposal_id = $1
				 ORDER BY created_at DESC
				 LIMIT 10`,
				[proposal.id],
			);

			if (rows.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No merge history for ${args.proposal_id}. Status: ${proposal.status}`,
						},
					],
				};
			}

			const lines = rows.map((r) => {
				const ts = new Date(r.created_at).toLocaleString();
				if (r.status === "merged") {
					return `✅ [${ts}] Merged — commit ${r.commit_sha?.substring(0, 8)}`;
				} else if (r.status === "conflict") {
					return `⚠️ [${ts}] Conflict — ${r.conflict_files?.join(", ")}`;
				} else {
					return `❌ [${ts}] Failed — ${r.error_message}`;
				}
			});

			return {
				content: [
					{
						type: "text",
						text: `## Merge History for ${args.proposal_id}\n\n${lines.join("\n")}`,
					},
				],
			};
		} catch (error) {
			return errorResult("Failed to get merge status", error);
		}
	}
}
