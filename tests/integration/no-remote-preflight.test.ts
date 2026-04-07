import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadRemoteProposals } from "../../src/core/storage/proposal-loader.ts";
import { GitOperations } from "../../src/git/operations.ts";
import type { RoadmapConfig } from "../../src/types/index.ts";
import { buildCliCommand, execSync, expect } from "../support/test-utils.ts";

describe("Missing git remote preflight", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-noremote-"));
		execSync(`git init`, { cwd: tempDir });
		execSync(`git config user.email test@example.com`, { cwd: tempDir });
		execSync(`git config user.name "Test User"`, { cwd: tempDir });
		await writeFile(join(tempDir, "README.md"), "# Test");
		execSync(`git add README.md`, { cwd: tempDir });
		execSync(`git commit -m "init"`, { cwd: tempDir });
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("GitOperations.fetch() silently skips when no remotes exist", async () => {
		const gitOps = new GitOperations(tempDir, {
			projectName: "Test",
			statuses: ["Potential", "Complete"],
			labels: [],
			directives: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: true,
		} as RoadmapConfig);

		// Capture console.warn to ensure no warning is printed during fetch
		const originalWarn = console.warn;
		const warns: string[] = [];
		console.warn = (msg: string) => {
			warns.push(msg);
		};

		await expect(async () => {
			await gitOps.fetch();
		}).not.toThrow();

		// Should not warn during fetch when no remotes
		assert.strictEqual(warns.length, 0);

		console.warn = originalWarn;
	});

	it("loadRemoteProposals() handles no-remote repos without throwing", async () => {
		const config: RoadmapConfig = {
			projectName: "Test",
			statuses: ["Potential", "Complete"],
			labels: [],
			directives: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: true,
		};

		const gitOps = new GitOperations(tempDir, config);
		const progress: string[] = [];
		const remoteProposals = await loadRemoteProposals(
			gitOps as unknown as typeof gitOps,
			config,
			(m) => progress.push(m),
		);
		expect(Array.isArray(remoteProposals)).toBe(true);
		assert.strictEqual(remoteProposals.length, 0);
	});

	it("CLI init with includeRemote=true in no-remote repo shows a final warning", async () => {
		const CLI_PATH = joinPath(process.cwd(), "src", "cli.ts");
		const result = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "init", "NoRemoteProj", "--defaults", "--check-branches", "true", "--include-remote", "true", "--auto-open-browser", "false"])}`,
			{ cwd: tempDir },
		);

		assert.strictEqual(result.exitCode, 0);
		const out = result.stdout.toString() + result.stderr.toString();
		expect(out.toLowerCase()).toContain("remoteoperations is enabled");
		expect(out.toLowerCase()).toContain("no git remotes are configured");
	});
});
