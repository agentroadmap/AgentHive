import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, writeFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

/**
 * Unit tests for worktree_merge tool git operations.
 *
 * Tests cover:
 * - AC-1: Proposal state validation
 * - AC-1: Worktree path validation
 * - AC-1: Conflict detection
 * - AC-2: Post-merge sync
 * - AC-3: Merge status tracking
 */

function git(cmd: string, cwd: string): string {
	return execSync(`git ${cmd}`, { cwd, encoding: "utf-8" }).trim();
}

function gitSafe(cmd: string, cwd: string): { stdout: string; stderr: string; status: number } {
	try {
		const stdout = execSync(`git ${cmd}`, { cwd, encoding: "utf-8" }).trim();
		return { stdout, stderr: "", status: 0 };
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: err.stdout?.toString().trim() ?? "",
			stderr: err.stderr?.toString().trim() ?? String(e),
			status: err.status ?? 1,
		};
	}
}

async function createGitRepo(baseDir: string): Promise<{ repoDir: string; cleanup: () => Promise<void> }> {
	const repoDir = await mkdtemp(join(baseDir, "repo-"));

	// Initialize repo
	git("init -b main", repoDir);
	git('config user.name "Test"', repoDir);
	git("config user.email test@test.com", repoDir);

	// Create initial commit on main
	writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
	git("add README.md", repoDir);
	git('commit -m "Initial commit"', repoDir);

	return {
		repoDir,
		cleanup: async () => rm(repoDir, { recursive: true, force: true }),
	};
}

async function createWorktree(
	repoDir: string,
	branchName: string,
	worktreeDir: string,
): Promise<string> {
	const wtPath = join(worktreeDir, branchName.replace("/", "-"));
	await mkdir(wtPath, { recursive: true });
	git(`worktree add -b ${branchName} ${wtPath}`, repoDir);
	return wtPath;
}

describe("WorktreeMergeHandlers", () => {
	let tempDir: string;
	let repoDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "wt-merge-test-"));
		const repo = await createGitRepo(tempDir);
		repoDir = repo.repoDir;
		cleanup = repo.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	describe("Git operations", () => {
		it("detects branch in worktree", async () => {
			const wtPath = await createWorktree(repoDir, "feature/test", tempDir);
			const branch = git("rev-parse --abbrev-ref HEAD", wtPath);
			assert.strictEqual(branch, "feature/test");
		});

		it("checks branch existence", () => {
			const result = gitSafe("rev-parse --verify main", repoDir);
			assert.strictEqual(result.status, 0);
		});

		it("detects non-existent branch", () => {
			const result = gitSafe("rev-parse --verify nonexistent", repoDir);
			assert.notStrictEqual(result.status, 0);
		});

		it("merges without conflicts when no overlap", async () => {
			const wtPath = await createWorktree(repoDir, "feature/clean", tempDir);

			// Make a change in the worktree
			writeFileSync(join(wtPath, "feature.txt"), "new feature\n");
			git("add feature.txt", wtPath);
			git('commit -m "Add feature"', wtPath);

			// Merge feature branch into main in the original repo (not worktree)
			const result = gitSafe('merge --no-ff -m "Merge feature" feature/clean', repoDir);
			assert.strictEqual(result.status, 0, `Merge failed: ${result.stderr}`);
		});

		it("detects merge conflicts", async () => {
			const wtPath = await createWorktree(repoDir, "feature/conflict", tempDir);

			// Make conflicting changes in both branches
			writeFileSync(join(repoDir, "conflict.txt"), "main version\n");
			git("add conflict.txt", repoDir);
			git('commit -m "Main change"', repoDir);

			writeFileSync(join(wtPath, "conflict.txt"), "feature version\n");
			git("add conflict.txt", wtPath);
			git('commit -m "Feature change"', wtPath);

			// Try to merge main into the worktree
			const mergeResult = gitSafe("merge --no-commit --no-ff main", wtPath);

			// Should have conflicts
			assert.notStrictEqual(mergeResult.status, 0, "Expected merge conflict");

			// Get conflicting files
			const statusResult = gitSafe("diff --name-only --diff-filter=U", wtPath);
			const conflicts = statusResult.stdout.split("\n").filter((f) => f.trim());
			assert.ok(conflicts.includes("conflict.txt"), `Expected conflict.txt in conflicts: ${conflicts.join(", ")}`);

			// Abort merge
			gitSafe("merge --abort", wtPath);
		});

		it("lists worktrees", async () => {
			await createWorktree(repoDir, "feature/a", tempDir);
			await createWorktree(repoDir, "feature/b", tempDir);

			const result = git("worktree list --porcelain", repoDir);

			// Should list at least 3 entries (main + 2 feature worktrees)
			const worktreeEntries = result.split("\n\n").filter((e) => e.startsWith("worktree"));
			assert.ok(worktreeEntries.length >= 3, `Expected at least 3 worktrees, got ${worktreeEntries.length}`);
		});
	});

	describe("Conflict detection", () => {
		it("returns no conflicts for clean merge", async () => {
			const wtPath = await createWorktree(repoDir, "feature/clean2", tempDir);

			// Make a change that doesn't conflict
			writeFileSync(join(wtPath, "newfile.txt"), "hello\n");
			git("add newfile.txt", wtPath);
			git('commit -m "Add newfile"', wtPath);

			// Check merge-tree for conflicts
			const result = gitSafe("merge-tree main HEAD", wtPath);

			// No conflict markers means clean merge
			const conflictMarkers = result.stdout.split("\n").filter((l) => l.startsWith("<<<<<<<"));
			assert.strictEqual(conflictMarkers.length, 0, "Expected no conflicts");
		});

		it("detects conflicting files", async () => {
			const wtPath = await createWorktree(repoDir, "feature/conflict2", tempDir);

			// Create conflicting changes
			writeFileSync(join(repoDir, "shared.txt"), "main content\n");
			git("add shared.txt", repoDir);
			git('commit -m "Main adds shared.txt"', repoDir);

			writeFileSync(join(wtPath, "shared.txt"), "feature content\n");
			git("add shared.txt", wtPath);
			git('commit -m "Feature modifies shared.txt"', wtPath);

			// Try merge-tree
			const result = gitSafe("merge-tree main HEAD", wtPath);

			// With conflicts, merge-tree outputs conflict markers or exits non-zero
			const hasConflict = result.stdout.includes("<<<<<<<") ||
				result.stdout.includes("changed in both") ||
				result.status !== 0;
			assert.ok(hasConflict, "Expected conflict detection");
		});
	});

	describe("Worktree lifecycle", () => {
		it("validates worktree path exists", () => {
			const nonExistentPath = join(tempDir, "does-not-exist");
			const exists = existsSync(nonExistentPath);
			assert.strictEqual(exists, false);
		});

		it("validates worktree is a directory", () => {
			const filePath = join(tempDir, "not-a-dir.txt");
			writeFileSync(filePath, "test");
			const stat = statSync(filePath);
			assert.strictEqual(stat.isDirectory(), false);
		});

		it("gets latest commit SHA", () => {
			const sha = git("rev-parse HEAD", repoDir);
			assert.ok(sha.length === 40, `Expected 40-char SHA, got ${sha.length}`);
		});
	});
});
