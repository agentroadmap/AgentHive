import { execSync, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { RoadmapConfig } from "../../types/index.ts";

/**
 * A simple wrapper around execSync to mimic some of Bun's $ behavior
 */
function _$(
	strings: TemplateStringsArray,
	...values: any[]
): { text(): string } {
	const command = strings.reduce(
		(acc, str, i) => acc + str + (values[i] ?? ""),
		"",
	);
	try {
		const output = execSync(command, { encoding: "utf-8", stdio: "pipe" });
		return { text: () => output.trim() };
	} catch (error: any) {
		const message = error.stderr?.toString() || error.message;
		throw new Error(`Command failed: ${command}\n${message}`);
	}
}

type GitPathContext = {
	repoRoot: string;
	relativePath: string;
};

export class GitOperations {
	private projectRoot: string;
	private config: RoadmapConfig | null = null;

	constructor(projectRoot: string, config: RoadmapConfig | null = null) {
		this.projectRoot = projectRoot;
		this.config = config;
	}

	setConfig(config: RoadmapConfig | null): void {
		this.config = config;
	}

	async addFile(filePath: string): Promise<void> {
		const context = await this.getPathContext(filePath);
		if (context) {
			await this.execGit(["add", context.relativePath], {
				cwd: context.repoRoot,
			});
			return;
		}

		// Convert absolute paths to relative paths from project root to avoid Windows encoding issues
		const relativePath = relative(this.projectRoot, filePath).replace(
			/\\/g,
			"/",
		);
		await this.execGit(["add", relativePath]);
	}

	async addFiles(filePaths: string[]): Promise<void> {
		// Convert absolute paths to relative paths from project root to avoid Windows encoding issues
		const relativePaths = filePaths.map((filePath) =>
			relative(this.projectRoot, filePath).replace(/\\/g, "/"),
		);
		await this.execGit(["add", ...relativePaths]);
	}

	async commitProposalChange(
		proposalId: string,
		message: string,
		filePath?: string,
	): Promise<void> {
		const commitMessage = `${proposalId} - ${message}`;
		const args = ["commit", "-m", commitMessage];
		if (this.config?.bypassGitHooks) {
			args.push("--no-verify");
		}
		const repoRoot = filePath
			? (await this.getPathContext(filePath))?.repoRoot
			: undefined;
		await this.execGit(args, { cwd: repoRoot });
	}

	async commitChanges(
		message: string,
		repoRoot?: string | null,
	): Promise<void> {
		const args = ["commit", "-m", message];
		if (this.config?.bypassGitHooks) {
			args.push("--no-verify");
		}
		await this.execGit(args, { cwd: repoRoot ?? undefined });
	}

	async commitFiles(
		message: string,
		filePaths: string[],
		repoRoot?: string | null,
	): Promise<void> {
		const uniqueFilePaths = Array.from(
			new Set(
				filePaths.map((path) => path.trim()).filter((path) => path.length > 0),
			),
		);
		if (uniqueFilePaths.length === 0) {
			return;
		}

		const resolvedRepoRoot =
			repoRoot ??
			(await this.getPathContext(uniqueFilePaths[0] ?? ""))?.repoRoot ??
			this.projectRoot;
		const relativePaths: string[] = [];
		for (const filePath of uniqueFilePaths) {
			const relativePath = await this.getRelativePathForRepo(
				filePath,
				resolvedRepoRoot,
			);
			relativePaths.push(relativePath ?? filePath);
		}
		const uniqueRelativePaths = Array.from(
			new Set(relativePaths.filter((path) => path.length > 0)),
		);
		if (uniqueRelativePaths.length === 0) {
			return;
		}

		const { stdout: stagedForPaths } = await this.execGit(
			["diff", "--name-only", "--cached", "--", ...uniqueRelativePaths],
			{
				cwd: resolvedRepoRoot,
				readOnly: true,
			},
		);
		if (!stagedForPaths.trim()) {
			return;
		}

		const args = ["commit", "-m", message];
		if (this.config?.bypassGitHooks) {
			args.push("--no-verify");
		}
		args.push("--", ...uniqueRelativePaths);
		await this.execGit(args, { cwd: resolvedRepoRoot });
	}

	async resetIndex(repoRoot?: string | null): Promise<void> {
		// Reset the staging area without affecting working directory
		try {
			// Check if there is any commit history (HEAD exists)
			await this.execGit(["rev-parse", "HEAD"], {
				cwd: repoRoot ?? undefined,
				readOnly: true,
			});
			await this.execGit(["reset", "HEAD"], { cwd: repoRoot ?? undefined });
		} catch {
			// If HEAD doesn't exist (new repo), we can't reset, but we don't need to
			// as there's nothing to reset from.
		}
	}

	async resetPaths(
		filePaths: string[],
		repoRoot?: string | null,
	): Promise<void> {
		const uniqueFilePaths = Array.from(
			new Set(
				filePaths.map((path) => path.trim()).filter((path) => path.length > 0),
			),
		);
		if (uniqueFilePaths.length === 0) {
			return;
		}

		const resolvedRepoRoot =
			repoRoot ??
			(await this.getPathContext(uniqueFilePaths[0] ?? ""))?.repoRoot ??
			this.projectRoot;
		const relativePaths: string[] = [];
		for (const filePath of uniqueFilePaths) {
			const relativePath = await this.getRelativePathForRepo(
				filePath,
				resolvedRepoRoot,
			);
			relativePaths.push(relativePath ?? filePath);
		}
		const uniqueRelativePaths = Array.from(
			new Set(relativePaths.filter((path) => path.length > 0)),
		);
		if (uniqueRelativePaths.length === 0) {
			return;
		}

		await this.execGit(["reset", "HEAD", "--", ...uniqueRelativePaths], {
			cwd: resolvedRepoRoot,
		});
	}

	async commitStagedChanges(
		message: string,
		repoRoot?: string | null,
	): Promise<void> {
		// Check if there are any staged changes before committing
		const { stdout: status } = await this.execGit(["status", "--porcelain"], {
			cwd: repoRoot ?? undefined,
		});
		const hasStagedChanges = status
			.split("\n")
			.some((line) => line.match(/^[AMDRC]/));

		if (!hasStagedChanges) {
			throw new Error("No staged changes to commit");
		}

		const args = ["commit", "-m", message];
		if (this.config?.bypassGitHooks) {
			args.push("--no-verify");
		}
		await this.execGit(args, { cwd: repoRoot ?? undefined });
	}

	async retryGitOperation<T>(
		operation: () => Promise<T>,
		operationName: string,
		maxRetries = 3,
	): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				if (process.env.DEBUG) {
					console.warn(
						`Git operation '${operationName}' failed on attempt ${attempt}/${maxRetries}:`,
						lastError.message,
					);
				}

				// Don't retry on the last attempt
				if (attempt === maxRetries) {
					break;
				}

				// Wait briefly before retrying (exponential backoff)
				await new Promise((resolve) =>
					setTimeout(resolve, 2 ** (attempt - 1) * 100),
				);
			}
		}

		throw new Error(
			`Git operation '${operationName}' failed after ${maxRetries} attempts: ${lastError?.message}`,
		);
	}

	async getStatus(): Promise<string> {
		const { stdout } = await this.execGit(["status", "--porcelain"], {
			readOnly: true,
		});
		return stdout;
	}

	async isClean(): Promise<boolean> {
		const status = await this.getStatus();
		return status.trim() === "";
	}

	async getCurrentBranch(): Promise<string> {
		const { stdout } = await this.execGit(["branch", "--show-current"], {
			readOnly: true,
		});
		return stdout.trim();
	}
	async hasUncommittedChanges(): Promise<boolean> {
		const status = await this.getStatus();
		return status.trim() !== "";
	}

	async getLastCommitMessage(): Promise<string> {
		const { stdout } = await this.execGit(["log", "-1", "--pretty=format:%s"], {
			readOnly: true,
		});
		return stdout.trim();
	}

	async getLocalUser(): Promise<{ name: string; email: string } | null> {
		try {
			const { execSync } = await import("node:child_process");
			const name = execSync("git config user.name", {
				cwd: this.projectRoot,
				encoding: "utf-8",
				timeout: 2000,
			}).trim();
			const email = execSync("git config user.email", {
				cwd: this.projectRoot,
				encoding: "utf-8",
				timeout: 2000,
			}).trim();

			if (!name && !email) {
				return null;
			}

			return { name, email };
		} catch {
			return null;
		}
	}

	async fetch(remote = "origin"): Promise<void> {
		// Check if remote operations are disabled
		if (this.config?.remoteOperations === false) {
			if (process.env.DEBUG) {
				console.warn(
					"Remote operations are disabled in config. Skipping fetch.",
				);
			}
			return;
		}

		// Preflight: skip if repository has no remotes configured
		const hasRemotes = await this.hasAnyRemote();
		if (!hasRemotes) {
			// No remotes configured; silently skip fetch. A consolidated warning is shown during init if applicable.
			return;
		}

		try {
			// Use --prune to remove dead refs and reduce later scans
			await this.execGit(["fetch", remote, "--prune", "--quiet"]);
		} catch (error) {
			// Check if this is a network-related error
			if (this.isNetworkError(error)) {
				// Don't show console warnings - let the calling code handle user messaging
				if (process.env.DEBUG) {
					console.warn(`Network error details: ${error}`);
				}
				return;
			}
			// Re-throw non-network errors
			throw error;
		}
	}

	private isNetworkError(error: unknown): boolean {
		if (typeof error === "string") {
			return this.containsNetworkErrorPattern(error);
		}
		if (error instanceof Error) {
			return this.containsNetworkErrorPattern(error.message);
		}
		return false;
	}

	private containsNetworkErrorPattern(message: string): boolean {
		const networkErrorPatterns = [
			"could not resolve host",
			"connection refused",
			"network is unreachable",
			"timeout",
			"no route to host",
			"connection timed out",
			"temporary failure in name resolution",
			"operation timed out",
		];

		const lowerMessage = message.toLowerCase();
		return networkErrorPatterns.some((pattern) =>
			lowerMessage.includes(pattern),
		);
	}
	async addAndCommitProposalFile(
		proposalId: string,
		filePath: string,
		action: "create" | "update" | "archive",
	): Promise<void> {
		const actionMessages = {
			create: `Create proposal ${proposalId}`,
			update: `Update proposal ${proposalId}`,
			archive: `Archive proposal ${proposalId}`,
		};

		const context = await this.getPathContext(filePath);
		const repoRoot = context?.repoRoot ?? this.projectRoot;
		const pathForAdd =
			context?.relativePath ??
			relative(this.projectRoot, filePath).replace(/\\/g, "/");

		// Retry git operations to handle transient failures
		await this.retryGitOperation(async () => {
			// Reset index to ensure only the specific file is staged
			await this.resetIndex(repoRoot);

			// Stage only the specific proposal file
			await this.execGit(["add", pathForAdd], { cwd: repoRoot });

			// Commit only the staged file
			await this.commitStagedChanges(actionMessages[action], repoRoot);
		}, `commit proposal file ${filePath}`);
	}

	async stageRoadmapDirectory(roadmapDir = "roadmap"): Promise<string | null> {
		const context = await this.getPathContext(roadmapDir);
		if (context) {
			const pathForAdd =
				context.relativePath === "." ? "." : context.relativePath;
			await this.execGit(["add", pathForAdd], { cwd: context.repoRoot });
			return context.repoRoot;
		}

		await this.execGit(["add", `${roadmapDir}/`]);
		return null;
	}
	async stageFileMove(
		fromPath: string,
		toPath: string,
	): Promise<string | null> {
		const toContext = await this.getPathContext(toPath);
		const repoRoot = toContext?.repoRoot;
		const relativeFrom = repoRoot
			? await this.getRelativePathForRepo(fromPath, repoRoot)
			: null;
		const relativeTo = toContext?.relativePath ?? null;

		// Stage the deletion of the old file and addition of the new file
		// Git will automatically detect this as a rename if the content is similar enough
		try {
			// First try to stage the removal of the old file (if it still exists)
			await this.execGit(["add", "--all", relativeFrom ?? fromPath], {
				cwd: repoRoot ?? undefined,
			});
		} catch {
			// If the old file doesn't exist, that's okay - it was already moved
		}

		// Always stage the new file location
		await this.execGit(["add", relativeTo ?? toPath], {
			cwd: repoRoot ?? undefined,
		});
		return repoRoot ?? null;
	}

	async listRemoteBranches(remote = "origin"): Promise<string[]> {
		try {
			// Fast-path: if no remotes, return empty
			if (!(await this.hasAnyRemote())) return [];
			const { stdout } = await this.execGit(
				["branch", "-r", "--format=%(refname:short)"],
				{ readOnly: true },
			);
			return stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.filter((branch) => branch.startsWith(`${remote}/`))
				.map((branch) => branch.substring(`${remote}/`.length));
		} catch {
			// If remote doesn't exist or other error, return empty array
			return [];
		}
	}

	/**
	 * List remote branches that have been active within the specified days
	 * Much faster than listRemoteBranches for filtering old branches
	 */
	async listRecentRemoteBranches(
		daysAgo: number,
		remote = "origin",
	): Promise<string[]> {
		try {
			// Fast-path: if no remotes, return empty
			if (!(await this.hasAnyRemote())) return [];
			const { stdout } = await this.execGit(
				[
					"for-each-ref",
					"--format=%(refname:short)|%(committerdate:iso8601)",
					`refs/remotes/${remote}`,
				],
				{ readOnly: true },
			);
			const since = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
			return (
				stdout
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean)
					.map((line) => {
						const [ref, iso] = line.split("|");
						return { ref, t: Date.parse(iso || "") };
					})
					.filter((x) => Number.isFinite(x.t) && x.t >= since && x.ref)
					.map((x) => x.ref?.replace(`${remote}/`, ""))
					// Filter out invalid/ambiguous entries that would normalize to empty or "origin"
					.filter((b): b is string => Boolean(b))
					.filter((b) => b !== "HEAD" && b !== remote && b !== `${remote}`)
			);
		} catch {
			return [];
		}
	}

	async listRecentBranches(daysAgo: number): Promise<string[]> {
		try {
			// Get all branches with their last commit date
			// Using for-each-ref which is more efficient than multiple branch commands
			const since = new Date();
			since.setDate(since.getDate() - daysAgo);

			// Build refs to check based on remoteOperations config
			const refs = ["refs/heads"];
			if (this.config?.remoteOperations !== false) {
				refs.push("refs/remotes/origin");
			}

			// Get local and remote branches with commit dates
			const { stdout } = await this.execGit(
				[
					"for-each-ref",
					"--format=%(refname:short)|%(committerdate:iso8601)",
					...refs,
				],
				{ readOnly: true },
			);

			const recentBranches: string[] = [];
			const lines = stdout.split("\n").filter(Boolean);

			for (const line of lines) {
				const [branch, dateStr] = line.split("|");
				if (!branch || !dateStr) continue;

				const commitDate = new Date(dateStr);
				if (commitDate >= since) {
					// Keep the full branch name including origin/ prefix
					// This allows cross-branch checking to distinguish local vs remote
					if (!recentBranches.includes(branch)) {
						recentBranches.push(branch);
					}
				}
			}

			return recentBranches;
		} catch {
			// Fallback to all branches if the command fails
			return this.listAllBranches();
		}
	}

	async listLocalBranches(): Promise<string[]> {
		try {
			const { stdout } = await this.execGit(
				["branch", "--format=%(refname:short)"],
				{ readOnly: true },
			);
			return stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	async listAllBranches(_remote = "origin"): Promise<string[]> {
		try {
			// Use -a flag only if remote operations are enabled
			const branchArgs =
				this.config?.remoteOperations === false
					? ["branch", "--format=%(refname:short)"]
					: ["branch", "-a", "--format=%(refname:short)"];

			const { stdout } = await this.execGit(branchArgs, { readOnly: true });
			return stdout
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.filter((b) => !b.includes("HEAD"));
		} catch {
			return [];
		}
	}

	/**
	 * Returns true if the current repository has any remotes configured
	 */
	async hasAnyRemote(): Promise<boolean> {
		try {
			const { stdout } = await this.execGit(["remote"], { readOnly: true });
			return (
				stdout
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean).length > 0
			);
		} catch {
			return false;
		}
	}

	/**
	 * Returns true if a specific remote exists (default: origin)
	 */
	async hasRemote(remote = "origin"): Promise<boolean> {
		try {
			const { stdout } = await this.execGit(["remote"], { readOnly: true });
			return stdout.split("\n").some((r) => r.trim() === remote);
		} catch {
			return false;
		}
	}

	async listFilesInTree(ref: string, path: string): Promise<string[]> {
		const { stdout } = await this.execGit(
			["ls-tree", "-r", "--name-only", "-z", ref, "--", path],
			{ readOnly: true },
		);
		return stdout.split("\0").filter(Boolean);
	}
	async showFile(ref: string, filePath: string): Promise<string> {
		const { stdout } = await this.execGit(["show", `${ref}:${filePath}`], {
			readOnly: true,
		});
		return stdout;
	}
	/**
	 * Build a map of file -> last modified date for all files in a directory in one git log pass
	 * Much more efficient than individual getFileLastModifiedTime calls
	 * Returns a Map of filePath -> Date
	 */
	async getBranchLastModifiedMap(
		ref: string,
		dir: string,
		sinceDays?: number,
	): Promise<Map<string, Date>> {
		const out = new Map<string, Date>();

		try {
			// Build args with optional --since filter
			const args = [
				"log",
				"--pretty=format:%ct%x00", // Unix timestamp + NUL for bulletproof parsing
				"--name-only",
				"-z", // Null-delimited for safety
			];

			if (sinceDays) {
				args.push(`--since=${sinceDays}.days`);
			}

			args.push(ref, "--", dir);

			// Null-delimited to be safe with filenames
			const { stdout } = await this.execGit(args, { readOnly: true });

			// Parse null-delimited output
			// Format is: timestamp\0 file1\0 file2\0 ... timestamp\0 file1\0 ...
			const parts = stdout.split("\0").filter(Boolean);
			let i = 0;

			while (i < parts.length) {
				const timestampStr = parts[i]?.trim();
				if (timestampStr && /^\d+$/.test(timestampStr)) {
					// This is a timestamp, files follow until next timestamp
					const epoch = Number(timestampStr);
					const date = new Date(epoch * 1000);
					i++;

					// Process files until we hit another timestamp or end
					// Check if next part looks like a timestamp (digits only)
					while (
						i < parts.length &&
						parts[i] &&
						!/^\d+$/.test(parts[i]?.trim() || "")
					) {
						const file = parts[i]?.trim();
						// First time we see a file is its last modification
						if (file && !out.has(file)) {
							out.set(file, date);
						}
						i++;
					}
				} else {
					// Skip unexpected content
					i++;
				}
			}
		} catch (error) {
			// If the command fails, return empty map
			console.error(
				`Failed to get branch last modified map for ${ref}:${dir}`,
				error,
			);
		}

		return out;
	}

	async getFileLastModifiedBranch(filePath: string): Promise<string | null> {
		try {
			// Get the hash of the last commit that touched the file
			const { stdout: commitHash } = await this.execGit(
				["log", "-1", "--format=%H", "--", filePath],
				{
					readOnly: true,
				},
			);
			if (!commitHash) return null;

			// Find all branches that contain this commit
			const { stdout: branches } = await this.execGit([
				"branch",
				"-a",
				"--contains",
				commitHash.trim(),
				"--format=%(refname:short)",
			]);

			if (!branches) return "main"; // Default to main if no specific branch found

			// Prefer non-remote branches and 'main' or 'master'
			const branchList = branches
				.split("\n")
				.map((b) => b.trim())
				.filter(Boolean);
			const mainBranch = branchList.find((b) => b === "main" || b === "master");
			if (mainBranch) return mainBranch;

			const nonRemote = branchList.find((b) => !b.startsWith("remotes/"));
			return nonRemote || branchList[0] || "main";
		} catch {
			return null;
		}
	}

	private async execGit(
		args: string[],
		options?: { readOnly?: boolean; cwd?: string },
	): Promise<{ stdout: string; stderr: string }> {
		const env = options?.readOnly
			? ({ ...process.env, GIT_OPTIONAL_LOCKS: "0" } as Record<string, string>)
			: (process.env as Record<string, string>);

		return new Promise((resolve, reject) => {
			const subprocess = spawn("git", args, {
				cwd: options?.cwd ?? this.projectRoot,
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});

			let stdout = "";
			let stderr = "";

			subprocess.stdout?.on("data", (data) => {
				stdout += data.toString();
			});

			subprocess.stderr?.on("data", (data) => {
				stderr += data.toString();
			});

			subprocess.on("close", (code) => {
				if (code !== 0) {
					reject(
						new Error(
							`Git command failed (exit code ${code}): git ${args.join(" ")}\n${stderr}`,
						),
					);
				} else {
					resolve({ stdout, stderr });
				}
			});

			subprocess.on("error", (err) => {
				reject(err);
			});
		});
	}

	private async getPathContext(
		targetPath: string,
	): Promise<GitPathContext | null> {
		const absolutePath = isAbsolute(targetPath)
			? targetPath
			: join(this.projectRoot, targetPath);
		const resolvedPath = await realpath(absolutePath).catch(() => null);
		if (resolvedPath) {
			return this.buildContext(resolvedPath);
		}

		const resolvedDir = await realpath(dirname(absolutePath)).catch(() => null);
		if (!resolvedDir) return null;
		const reconstructedPath = join(resolvedDir, basename(absolutePath));
		return this.buildContext(reconstructedPath, resolvedDir);
	}

	private async getRelativePathForRepo(
		targetPath: string,
		repoRoot: string,
	): Promise<string | null> {
		const absolutePath = isAbsolute(targetPath)
			? targetPath
			: join(this.projectRoot, targetPath);
		const resolvedPath = await realpath(absolutePath).catch(() => null);
		const pathForRelative =
			resolvedPath ?? (await this.resolveMissingPath(absolutePath));
		if (!pathForRelative) return null;

		const relativePath = this.normalizeGitPath(
			relative(repoRoot, pathForRelative),
		);
		if (!relativePath || relativePath.startsWith("..")) return null;
		return relativePath === "" ? "." : relativePath;
	}

	private async resolveRepoRoot(startDir: string): Promise<string | null> {
		try {
			const { stdout } = await this.execGit(["rev-parse", "--show-toplevel"], {
				readOnly: true,
				cwd: startDir,
			});
			const root = stdout.trim();
			return root.length > 0 ? root : null;
		} catch {
			return null;
		}
	}

	private async resolveMissingPath(
		absolutePath: string,
	): Promise<string | null> {
		const resolvedDir = await realpath(dirname(absolutePath)).catch(() => null);
		if (!resolvedDir) return null;
		return join(resolvedDir, basename(absolutePath));
	}

	private async buildContext(
		resolvedPath: string,
		resolvedDirHint?: string,
	): Promise<GitPathContext | null> {
		let cwd = resolvedDirHint;
		if (!cwd) {
			const stats = await stat(resolvedPath).catch(() => null);
			if (!stats) {
				cwd = dirname(resolvedPath);
			} else {
				cwd = stats.isDirectory() ? resolvedPath : dirname(resolvedPath);
			}
		}

		const repoRoot = cwd ? await this.resolveRepoRoot(cwd) : null;
		if (!repoRoot) return null;

		const relativePath = this.normalizeGitPath(
			relative(repoRoot, resolvedPath),
		);
		if (!relativePath || relativePath.startsWith("..")) return null;
		return { repoRoot, relativePath: relativePath === "" ? "." : relativePath };
	}

	private normalizeGitPath(pathValue: string): string {
		return pathValue.replace(/\\/g, "/");
	}
}

export async function isGitRepository(projectRoot: string): Promise<boolean> {
	try {
		const { execSync } = await import("node:child_process");
		execSync("git rev-parse --is-inside-work-tree", {
			cwd: projectRoot,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

export async function initializeGitRepository(
	projectRoot: string,
): Promise<void> {
	try {
		const { execSync } = await import("node:child_process");
		execSync("git init", {
			cwd: projectRoot,
			stdio: "ignore",
		});
	} catch (error) {
		throw new Error(`Failed to initialize git repository: ${error}`);
	}
}
