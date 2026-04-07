import assert from "node:assert";
import { globSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	isWindows,
	safeCleanup,
} from "../support/test-utils.ts";

describe("Symlinked roadmap root", () => {
	const itIfSymlinks = isWindows() ? it.skip : it;
	let repoDir: string;
	let roadmapDir: string;

	beforeEach(async () => {
		repoDir = createUniqueTestDir("test-symlink-root-repo");
		roadmapDir = createUniqueTestDir("test-symlink-root-roadmap");
		await mkdir(repoDir, { recursive: true });
		await mkdir(roadmapDir, { recursive: true });
	});

	afterEach(async () => {
		await safeCleanup(repoDir);
		await safeCleanup(roadmapDir);
	});

	itIfSymlinks(
		"creates proposals when roadmap root is a symlink and autoCommit is false",
		async () => {
			await mkdir(join(roadmapDir, "proposals"), { recursive: true });
			await mkdir(join(roadmapDir, "drafts"), { recursive: true });
			await writeFile(
				join(roadmapDir, "config.yml"),
				`project_name: "Symlink Root"
statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"]
auto_commit: false
`,
			);

			await symlink(roadmapDir, join(repoDir, "roadmap"));

			const core = new Core(repoDir);
			const { proposal } = await core.createProposalFromInput({
				title: "Symlink root proposal",
			});

			const files = await Array.fromAsync(
				globSync("proposal-*.md", { cwd: join(roadmapDir, "proposals") }),
			);
			assert.strictEqual(files.length, 1);
			assert.strictEqual(proposal.id, "proposal-1");

			const proposals = await core.listProposalsWithMetadata();
			assert.strictEqual(proposals.length, 1);
			assert.strictEqual(proposals[0]?.id, "proposal-1");
		},
	);

	itIfSymlinks(
		"auto-commit writes to the symlinked roadmap repo when enabled",
		async () => {
			execSync(`git init`, { cwd: roadmapDir });
			execSync(`git config user.email test@example.com`, { cwd: roadmapDir });
			execSync(`git config user.name "Test User"`, { cwd: roadmapDir });
			await writeFile(join(roadmapDir, "README.md"), "# Roadmap Repo");
			execSync(`git add README.md`, { cwd: roadmapDir });
			execSync(`git commit -m "Initial commit"`, { cwd: roadmapDir });

			await mkdir(join(roadmapDir, "proposals"), { recursive: true });
			await mkdir(join(roadmapDir, "drafts"), { recursive: true });
			await writeFile(
				join(roadmapDir, "config.yml"),
				`project_name: "Symlink Root"
statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"]
auto_commit: true
`,
			);

			await symlink(roadmapDir, join(repoDir, "roadmap"));

			const core = new Core(repoDir);
			await core.createProposalFromInput({ title: "Symlink root auto-commit" });

			const { stdout } = execSync(`git log -1 --pretty=format:%s`, {
				cwd: roadmapDir,
			});
			expect(stdout.toString()).toContain("Create proposal");
		},
	);
});
