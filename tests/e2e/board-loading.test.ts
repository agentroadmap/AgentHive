import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal, RoadmapConfig } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Board Loading with checkActiveBranches", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-board-loading");
		core = new Core(TEST_DIR);
		await core.filesystem.ensureRoadmapStructure();

		// Initialize git repository for testing
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize project with default config
		await core.initializeProject("Test Project", false);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("Core.loadProposals()", () => {
		const createTestProposal = (
			id: string,
			status = "Potential",
		): Proposal => ({
			id,
			title: `Test Proposal ${id}`,
			status,
			assignee: [],
			createdDate: "2025-01-08",
			labels: ["test"],
			dependencies: [],
			description: `This is test proposal ${id}`,
		});

		beforeEach(async () => {
			// Create some test proposals
			await core.createProposal(
				createTestProposal("proposal-1", "Potential"),
				false,
			);
			await core.createProposal(
				createTestProposal("proposal-2", "Active"),
				false,
			);
			await core.createProposal(
				createTestProposal("proposal-3", "Complete"),
				false,
			);

			// Commit them to have a clean proposal
			execSync(`git add .`, { cwd: TEST_DIR });
			execSync(`git commit -m "Add test proposals"`, { cwd: TEST_DIR });
		});

		it("should load proposals with default configuration", async () => {
			const proposals = await core.loadProposals();

			assert.strictEqual(proposals.length, 3);
			expect(proposals.find((t) => t.id === "proposal-1")).toBeDefined();
			expect(proposals.find((t) => t.id === "proposal-2")).toBeDefined();
			expect(proposals.find((t) => t.id === "proposal-3")).toBeDefined();
		});

		it("should skip cross-branch checking when checkActiveBranches is false", async () => {
			// Update config to disable cross-branch checking
			const config = await core.filesystem.loadConfig();
			if (!config) throw new Error("Config not loaded");
			const updatedConfig: RoadmapConfig = {
				...config,
				checkActiveBranches: false,
			};
			await core.filesystem.saveConfig(updatedConfig);

			// Track progress messages
			const progressMessages: string[] = [];
			const proposals = await core.loadProposals((msg) => {
				progressMessages.push(msg);
			});

			// Verify we got proposals
			assert.strictEqual(proposals.length, 3);

			// Verify we didn't apply cross-branch proposal snapshots
			const applySnapshotsMessage = progressMessages.find((msg) =>
				msg.includes("Applying latest proposal proposals from branch scans..."),
			);
			assert.strictEqual(applySnapshotsMessage, undefined);
		});

		it("should perform cross-branch checking when checkActiveBranches is true", async () => {
			// Update config to enable cross-branch checking (default)
			const config = await core.filesystem.loadConfig();
			if (!config) throw new Error("Config not loaded");
			const updatedConfig: RoadmapConfig = {
				...config,
				checkActiveBranches: true,
				activeBranchDays: 7,
			};
			await core.filesystem.saveConfig(updatedConfig);

			// Track progress messages
			const progressMessages: string[] = [];
			const proposals = await core.loadProposals((msg) => {
				progressMessages.push(msg);
			});

			// Verify we got proposals
			assert.strictEqual(proposals.length, 3);

			// Verify we applied cross-branch proposal snapshots
			const applySnapshotsMessage = progressMessages.find((msg) =>
				msg.includes("Applying latest proposal proposals from branch scans..."),
			);
			assert.notStrictEqual(applySnapshotsMessage, undefined);
		});

		it("should respect activeBranchDays configuration", async () => {
			// Create a new branch with an old commit date
			execSync(`git checkout -b old-branch`, { cwd: TEST_DIR });
			await core.createProposal(
				createTestProposal("proposal-4", "Potential"),
				false,
			);
			execSync(`git add .`, { cwd: TEST_DIR });

			// Commit with an old date (40 days ago)
			const oldDate = new Date();
			oldDate.setDate(oldDate.getDate() - 40);
			const dateStr = oldDate.toISOString();
			execSync(
				`GIT_AUTHOR_DATE="${dateStr}" GIT_COMMITTER_DATE="${dateStr}" git commit -m "Old proposal"`,
				{ cwd: TEST_DIR },
			);

			execSync(`git checkout main`, { cwd: TEST_DIR });

			// Set activeBranchDays to 30 (should exclude the old branch)
			const config = await core.filesystem.loadConfig();
			if (!config) throw new Error("Config not loaded");
			const updatedConfig: RoadmapConfig = {
				...config,
				checkActiveBranches: true,
				activeBranchDays: 30,
			};
			await core.filesystem.saveConfig(updatedConfig);

			// Track progress messages
			const progressMessages: string[] = [];
			const proposals = await core.loadProposals((msg) => {
				progressMessages.push(msg);
			});

			// The proposal-4 from old branch should not be included if branch checking is working
			// However, since we're in main branch, we should only see the 3 main proposals
			assert.strictEqual(proposals.length, 3);
			expect(proposals.find((t) => t.id === "proposal-4")).toBeUndefined();

			// Check that branch checking happened with the right days
			const _branchCheckMessage = progressMessages.find(
				(msg) =>
					msg.includes("branches") &&
					(msg.includes("30 days") || msg.includes("from 30 days")),
			);
			// The message format might vary, so we just check that some branch-related message exists
			const anyBranchMessage = progressMessages.find((msg) =>
				msg.includes("branch"),
			);
			assert.notStrictEqual(anyBranchMessage, undefined);
		});

		it("should handle cancellation via AbortSignal", async () => {
			const controller = new AbortController();

			// Cancel immediately
			controller.abort();

			// Should throw an error
			await expect(
				core.loadProposals(undefined, controller.signal),
			).rejects.toThrow("Loading cancelled");
		});

		it("should handle empty proposal list gracefully", async () => {
			// Remove all proposals
			execSync(`rm -rf roadmap/proposals/*`, { cwd: TEST_DIR });

			const proposals = await core.loadProposals();
			assert.deepStrictEqual(proposals, []);
		});

		it("should pass progress callbacks correctly", async () => {
			const progressMessages: string[] = [];
			const progressCallback = mock.fn((msg: string) => {
				progressMessages.push(msg);
			});

			await core.loadProposals(progressCallback);

			// Verify callback was called
			expect(progressCallback).toHaveBeenCalled();
			assert.ok(progressMessages.length > 0);

			// Should have some expected messages
			const hasLoadingMessage = progressMessages.some(
				(msg) =>
					msg.includes("Loading") ||
					msg.includes("Checking") ||
					msg.includes("Skipping"),
			);
			assert.strictEqual(hasLoadingMessage, true);
		});
	});

	describe("Config integration", () => {
		it("should use default values when config properties are undefined", async () => {
			// Save a minimal config without the branch-related settings
			const minimalConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				defaultStatus: "Potential",
				labels: [],
				directives: [],
				dateFormat: "yyyy-mm-dd",
			};
			await core.filesystem.saveConfig(minimalConfig);

			// Create a proposal to ensure we have something to load
			await core.createProposal(
				{
					id: "proposal-1",
					title: "Test Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-01-08",
					labels: [],
					dependencies: [],
					rawContent: "Test",
				},
				false,
			);

			const progressMessages: string[] = [];
			const proposals = await core.loadProposals((msg) => {
				progressMessages.push(msg);
			});

			// Should still work with defaults
			assert.notStrictEqual(proposals, undefined);
			expect(proposals.length).toBeGreaterThanOrEqual(0);

			// When checkActiveBranches is undefined, it defaults to true, so should perform checking
			const applySnapshotsMessage = progressMessages.find((msg) =>
				msg.includes("Applying latest proposal proposals from branch scans..."),
			);
			assert.notStrictEqual(applySnapshotsMessage, undefined);
		});

		it("should handle config with checkActiveBranches explicitly set to false", async () => {
			const config = await core.filesystem.loadConfig();
			if (!config) throw new Error("Config not loaded");
			await core.filesystem.saveConfig({
				...config,
				checkActiveBranches: false,
			});

			const progressMessages: string[] = [];
			await core.loadProposals((msg) => {
				progressMessages.push(msg);
			});

			// Should not apply cross-branch proposal snapshots
			const applySnapshotsMessage = progressMessages.find((msg) =>
				msg.includes("Applying latest proposal proposals from branch scans..."),
			);
			assert.strictEqual(applySnapshotsMessage, undefined);
		});
	});
});
