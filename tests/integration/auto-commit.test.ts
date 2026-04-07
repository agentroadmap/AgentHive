import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal, RoadmapConfig } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Auto-commit configuration", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-auto-commit");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test Auto-commit Project", true);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("Config migration", () => {
		it("should include autoCommit in default config with false value", async () => {
			const config = await core.filesystem.loadConfig();
			assert.notStrictEqual(config, undefined);
			assert.strictEqual(config?.autoCommit, false);
		});

		it("should migrate existing config to include autoCommit", async () => {
			// Create config without autoCommit
			const oldConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "yyyy-mm-dd",
			};
			await core.filesystem.saveConfig(oldConfig);

			// Trigger migration
			await core.ensureConfigMigrated();

			const migratedConfig = await core.filesystem.loadConfig();
			assert.notStrictEqual(migratedConfig, undefined);
			assert.strictEqual(migratedConfig?.autoCommit, false);
		});
	});

	describe("Core operations with autoCommit disabled", () => {
		beforeEach(async () => {
			// Set autoCommit to false
			const config = await core.filesystem.loadConfig();
			if (config) {
				config.autoCommit = false;
				await core.filesystem.saveConfig(config);
			}
		});

		it("should not auto-commit when creating proposal with autoCommit disabled in config", async () => {
			const proposal: Proposal = {
				id: "proposal-1",
				title: "Test Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};

			await core.createProposal(proposal);

			// Check that there are uncommitted changes
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, false);
		});

		it("should auto-commit when explicitly passing true to createProposal", async () => {
			const proposal: Proposal = {
				id: "proposal-2",
				title: "Test Proposal 2",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};

			await core.createProposal(proposal, true);

			// Check that working directory is clean (changes were committed)
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, true);
		});

		it("should not auto-commit when updating proposal with autoCommit disabled in config", async () => {
			// First create a proposal with explicit commit
			const proposal: Proposal = {
				id: "proposal-3",
				title: "Test Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};
			await core.createProposal(proposal, true);

			// Update the proposal (should not auto-commit)
			await core.updateProposalFromInput("proposal-3", {
				title: "Updated Proposal",
			});

			// Check that there are uncommitted changes
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, false);
		});

		it("should not auto-commit when archiving proposal with autoCommit disabled in config", async () => {
			// First create a proposal with explicit commit
			const proposal: Proposal = {
				id: "proposal-4",
				title: "Test Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};
			await core.createProposal(proposal, true);

			// Archive the proposal (should not auto-commit)
			await core.archiveProposal("proposal-4");

			// Check that there are uncommitted changes
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, false);
		});
	});

	describe("Core operations with autoCommit enabled", () => {
		beforeEach(async () => {
			// Set autoCommit to true
			const config = await core.filesystem.loadConfig();
			if (config) {
				config.autoCommit = true;
				await core.filesystem.saveConfig(config);
			}

			// Commit the config change to start with a clean proposal
			const git = await core.getGitOps();
			await git.addFile(join(TEST_DIR, "roadmap", "config.yml"));
			await git.commitChanges("Update autoCommit config for test");
		});

		it("should auto-commit when creating proposal with autoCommit enabled in config", async () => {
			const proposal: Proposal = {
				id: "proposal-5",
				title: "Test Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};

			await core.createProposal(proposal);

			// Check that working directory is clean (changes were committed)
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, true);
		});

		it("should not auto-commit when explicitly passing false to createProposal", async () => {
			const proposal: Proposal = {
				id: "proposal-6",
				title: "Test Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};

			await core.createProposal(proposal, false);

			// Check that there are uncommitted changes
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, false);
		});

		it("should auto-commit archive cleanup updates when archiving a proposal", async () => {
			const archiveTarget: Proposal = {
				id: "proposal-7",
				title: "Archive target",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Proposal to archive",
			};

			const dependentProposal: Proposal = {
				id: "proposal-8",
				title: "Dependent proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: ["proposal-7"],
				references: ["proposal-7", "https://example.com/proposals/proposal-7"],
				description: "Proposal that references archive target",
			};

			await core.createProposal(archiveTarget);
			await core.createProposal(dependentProposal);
			await core.archiveProposal("proposal-7");

			const updatedProposal = await core.filesystem.loadProposal("proposal-8");
			assert.deepStrictEqual(updatedProposal?.dependencies, []);
			assert.deepStrictEqual(updatedProposal?.references, [
				"https://example.com/proposals/proposal-7",
			]);

			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, true);
		});
	});

	describe("Draft operations", () => {
		beforeEach(async () => {
			// Set autoCommit to false
			const config = await core.filesystem.loadConfig();
			if (config) {
				config.autoCommit = false;
				await core.filesystem.saveConfig(config);
			}
		});

		it("should respect autoCommit config for draft operations", async () => {
			const proposal: Proposal = {
				id: "draft-1",
				title: "Test Draft",
				status: "Draft",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};

			await core.createDraft(proposal);

			// Check that there are uncommitted changes
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, false);
		});

		it("should respect autoCommit config for promote draft operations", async () => {
			// First create a draft with explicit commit
			const proposal: Proposal = {
				id: "draft-2",
				title: "Test Draft",
				status: "Draft",
				assignee: [],
				createdDate: "2025-07-07",
				labels: [],
				dependencies: [],
				description: "Test description",
			};
			await core.createDraft(proposal, true);

			// Promote the draft (should not auto-commit)
			await core.promoteDraft("draft-2");

			// Check that there are uncommitted changes
			const git = await core.getGitOps();
			const isClean = await git.isClean();
			assert.strictEqual(isClean, false);
		});
	});
});
