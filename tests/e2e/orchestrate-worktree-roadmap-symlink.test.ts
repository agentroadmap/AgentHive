import assert from "node:assert";
import { lstat, mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runAgentJoinCommand } from "../../src/commands/orchestrate.ts";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	isWindows,
	safeCleanup,
} from "../support/test-utils.ts";

describe("runAgentJoinCommand", () => {
	const itIfSymlinks = isWindows() ? it.skip : it;
	let rootDir: string;

	beforeEach(async () => {
		rootDir = createUniqueTestDir("test-orchestrate-worktree-roadmap-symlink");
		await mkdir(join(rootDir, "roadmap", "messages"), { recursive: true });
		await writeFile(
			join(rootDir, "roadmap", "config.yml"),
			`project_name: "Orchestrate Symlink"
statuses: ["To Do", "In Progress", "Done"]
auto_commit: false
`,
		);
		await writeFile(
			join(rootDir, "roadmap", "messages", "PUBLIC.md"),
			"# Public Announcement\n",
		);
		await writeFile(join(rootDir, "README.md"), "# Test Repo\n");

		execSync("git init", { cwd: rootDir });
		execSync("git config user.email test@example.com", { cwd: rootDir });
		execSync('git config user.name "Test User"', { cwd: rootDir });
		execSync("git add README.md roadmap", { cwd: rootDir });
		execSync('git commit -m "Initial commit"', { cwd: rootDir });
	});

	afterEach(async () => {
		await safeCleanup(rootDir);
	});

	itIfSymlinks(
		"symlinks the entire roadmap directory into the provisioned worktree",
		async () => {
			const core = new Core(rootDir);
			await runAgentJoinCommand(core, "agent-1", "Specialist");

			const agentRoadmapPath = join(rootDir, "worktrees", "agent-1", "roadmap");
			const roadmapStats = await lstat(agentRoadmapPath);

			assert.ok(
				roadmapStats.isSymbolicLink(),
				"expected worktree roadmap path to be a symlink",
			);

			const linkTarget = await readlink(agentRoadmapPath);
			assert.ok(
				linkTarget.includes(join("roadmap")),
				`expected symlink target to reference roadmap, got: ${linkTarget}`,
			);

			const resolvedAgentRoadmap = await realpath(agentRoadmapPath);
			const resolvedSharedRoadmap = await realpath(join(rootDir, "roadmap"));

			assert.strictEqual(resolvedAgentRoadmap, resolvedSharedRoadmap);
		},
	);
});
