import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { RoadmapConfig } from "../../src/types/index.ts";
import { execSync } from "../support/test-utils.ts";

describe("Offline Integration Tests", () => {
	let tempDir: string;
	let core: Core;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-offline-integration-"));

		// Initialize a git repo without remote
		execSync(`git init`, { cwd: tempDir });
		execSync(`git config user.email test@example.com`, { cwd: tempDir });
		execSync(`git config user.name "Test User"`, { cwd: tempDir });

		// Create initial commit
		await writeFile(join(tempDir, "README.md"), "# Test Project");
		execSync(`git add README.md`, { cwd: tempDir });
		execSync(`git commit -m "Initial commit"`, { cwd: tempDir });

		// Create basic roadmap structure
		const roadmapDir = join(tempDir, "roadmap");
		await mkdir(roadmapDir, { recursive: true });
		await mkdir(join(roadmapDir, "proposals"), { recursive: true });
		await mkdir(join(roadmapDir, "drafts"), { recursive: true });

		// Create config with remote operations disabled
		const config: RoadmapConfig = {
			projectName: "Offline Test Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: ["bug", "feature"],
			directives: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: false,
		};

		await writeFile(
			join(roadmapDir, "config.yml"),
			`project_name: "${config.projectName}"
statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"]
labels: ["bug", "feature"]
directives: []
date_format: YYYY-MM-DD
roadmap_directory: "roadmap"
remote_operations: false
`,
		);

		core = new Core(tempDir);
	});

	afterEach(async () => {
		if (tempDir) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("should work in offline mode without remote", async () => {
		// Ensure config migration works with remoteOperations
		await core.ensureConfigMigrated();
		const config = await core.filesystem.loadConfig();
		assert.strictEqual(config?.remoteOperations, false);

		// Create a proposal - this should work without any remote operations
		const proposal = {
			id: "proposal-1",
			title: "Test proposal in offline mode",
			description: "This proposal should be created without remote operations",
			status: "Potential",
			assignee: [],
			createdDate: new Date().toISOString().split("T")[0] ?? "",
			updatedDate: new Date().toISOString().split("T")[0] ?? "",
			labels: ["feature"],
			dependencies: [],
			priority: "medium" as const,
		};

		const filepath = await core.createProposal(proposal);
		assert.ok(filepath.includes("proposal-1"));

		// List proposals should work without remote operations
		const proposals = await core.listProposalsWithMetadata();
		assert.strictEqual(proposals.length, 1);
		assert.strictEqual(proposals[0]?.id, "proposal-1");
		assert.strictEqual(proposals[0]?.title, "Test proposal in offline mode");
	});

	it("should handle proposal ID generation in offline mode", async () => {
		// Create multiple proposals to test ID generation
		const proposal1 = {
			id: "proposal-1",
			title: "First proposal",
			description: "First proposal description",
			status: "Potential",
			assignee: [],
			createdDate: new Date().toISOString().split("T")[0] ?? "",
			updatedDate: new Date().toISOString().split("T")[0] ?? "",
			labels: [],
			dependencies: [],
			priority: "medium" as const,
		};

		const proposal2 = {
			id: "proposal-2",
			title: "Second proposal",
			description: "Second proposal description",
			status: "Active",
			assignee: [],
			createdDate: new Date().toISOString().split("T")[0] ?? "",
			updatedDate: new Date().toISOString().split("T")[0] ?? "",
			labels: [],
			dependencies: [],
			priority: "high" as const,
		};

		await core.createProposal(proposal1);
		await core.createProposal(proposal2);

		const proposals = await core.listProposalsWithMetadata();
		assert.strictEqual(proposals.length, 2);

		const proposalIds = proposals.map((t) => t.id);
		assert.ok(proposalIds.includes("proposal-1"));
		assert.ok(proposalIds.includes("proposal-2"));
	});

	it("should handle repository without remote origin gracefully", async () => {
		// Try to verify that git operations don't fail when there's no remote
		// This simulates a local-only git repository

		// Get git operations instance
		const gitOps = await core.getGitOps();

		// These operations should not fail even without remote
		try {
			await gitOps.fetch();
			// Should complete without error due to remoteOperations: false
		} catch (error) {
			// If it does error, it should be handled gracefully
			assert.strictEqual(error, undefined);
		}

		// Verify that we can still work with local git operations
		const lastCommit = await gitOps.getLastCommitMessage();
		// Should be empty or the initial commit
		assert.strictEqual(typeof lastCommit, "string");
	});

	it("should work with config command to set remoteOperations", async () => {
		// Load initial config
		const initialConfig = await core.filesystem.loadConfig();
		assert.strictEqual(initialConfig?.remoteOperations, false);

		// Simulate config set command
		if (!initialConfig) throw new Error("Config not loaded");
		const updatedConfig: RoadmapConfig = {
			...initialConfig,
			remoteOperations: true,
		};
		await core.filesystem.saveConfig(updatedConfig);

		// Verify config was updated
		const newConfig = await core.filesystem.loadConfig();
		assert.strictEqual(newConfig?.remoteOperations, true);

		// Test changing it back
		if (!newConfig) throw new Error("Config not loaded");
		const finalConfig: RoadmapConfig = {
			...newConfig,
			remoteOperations: false,
		};
		await core.filesystem.saveConfig(finalConfig);

		const verifyConfig = await core.filesystem.loadConfig();
		assert.strictEqual(verifyConfig?.remoteOperations, false);
	});

	it("should migrate existing configs to include remoteOperations", async () => {
		// Create a config without remoteOperations field
		const roadmapDir = join(tempDir, "roadmap");
		await writeFile(
			join(roadmapDir, "config.yml"),
			`project_name: "Legacy Project"
statuses: ["Potential", "Complete"]
labels: []
directives: []
date_format: YYYY-MM-DD
roadmap_directory: "roadmap"
`,
		);

		// Create new Core instance to trigger migration
		const legacyCore = new Core(tempDir);
		await legacyCore.ensureConfigMigrated();

		// Verify that remoteOperations was added with default value
		const migratedConfig = await legacyCore.filesystem.loadConfig();
		assert.strictEqual(migratedConfig?.remoteOperations, true); // Default should be true
		assert.strictEqual(migratedConfig?.projectName, "Legacy Project");
	});

	it("should handle loadRemoteProposals in offline mode", async () => {
		const config = await core.filesystem.loadConfig();
		assert.strictEqual(config?.remoteOperations, false);

		// Import loadRemoteProposals
		const { loadRemoteProposals } = await import(
			"../../src/core/storage/proposal-loader.ts"
		);

		const progressMessages: string[] = [];
		const remoteProposals = await loadRemoteProposals(
			core.gitOps,
			config,
			(msg: string) => progressMessages.push(msg),
		);

		// Should return empty array and skip remote operations
		assert.deepStrictEqual(remoteProposals, []);
		assert.ok(
			progressMessages.includes(
				"Remote operations disabled - skipping remote proposals",
			),
		);
	});
});
