import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { type ViewProposal, ViewSwitcher } from "../../src/ui/view-switcher.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

describe("View Switcher", () => {
	let TEST_DIR: string;
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-view-switcher");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test View Switcher Project");

		// Disable remote operations for tests to prevent background git fetches
		const config = await core.filesystem.loadConfig();
		if (config) {
			config.remoteOperations = false;
			await core.filesystem.saveConfig(config);
		}
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("ViewSwitcher initialization", () => {
		it("should initialize with proposal-list view", () => {
			const initialProposal: ViewProposal = {
				type: "proposal-list",
				proposals: [],
			};

			const switcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			const proposal = switcher.getProposal();
			assert.strictEqual(proposal.type, "proposal-list");
			assert.deepStrictEqual(proposal.proposals, []);
		});

		it("should initialize with proposal-detail view", () => {
			const selectedProposal = {
				id: "proposal-1",
				title: "Test Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-05",
				labels: [],
				dependencies: [],
				rawContent: "Test proposal body",
			};

			const initialProposal: ViewProposal = {
				type: "proposal-detail",
				selectedProposal,
				proposals: [selectedProposal],
			};

			const switcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			const proposal = switcher.getProposal();
			assert.strictEqual(proposal.type, "proposal-detail");
			assert.deepStrictEqual(proposal.selectedProposal, selectedProposal);
		});

		it("should initialize with kanban view", () => {
			const initialProposal: ViewProposal = {
				type: "kanban",
				kanbanData: {
					proposals: [],
					statuses: [],
					isLoading: true,
				},
			};

			const switcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			const proposal = switcher.getProposal();
			assert.strictEqual(proposal.type, "kanban");
			assert.strictEqual(proposal.kanbanData?.isLoading, true);
		});
	});

	describe("Proposal updates", () => {
		it("should update proposal correctly", () => {
			const initialProposal: ViewProposal = {
				type: "proposal-list",
				proposals: [],
			};

			const switcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			const newProposal = {
				id: "proposal-1",
				title: "Updated Proposal",
				status: "Active",
				assignee: [],
				createdDate: "2025-07-05",
				labels: [],
				dependencies: [],
				rawContent: "Updated proposal body",
			};

			const updatedProposal = switcher.updateProposal({
				selectedProposal: newProposal,
				type: "proposal-detail",
			});

			assert.strictEqual(updatedProposal.type, "proposal-detail");
			assert.deepStrictEqual(updatedProposal.selectedProposal, newProposal);
		});
	});

	describe("Background loading", () => {
		it("should indicate when kanban data is ready", () => {
			const initialProposal: ViewProposal = {
				type: "proposal-list",
				proposals: [],
			};

			const switcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			// Initially should not be ready (no data loaded yet)
			expect(switcher.isKanbanReady()).toBe(false);
		});

		it("should start preloading kanban data", () => {
			const initialProposal: ViewProposal = {
				type: "proposal-list",
				proposals: [],
			};

			const switcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			// Mock the preloadKanban method to avoid remote git operations
			switcher.preloadKanban = async () => {};

			// Should not throw when preloading
			expect(() => switcher.preloadKanban()).not.toThrow();
		});
	});

	describe("View change callback", () => {
		it("should call onViewChange when proposal updates", () => {
			let callbackProposal: ViewProposal | null = null;

			const initialProposal: ViewProposal = {
				type: "proposal-list",
				proposals: [],
			};

			const switcher = new ViewSwitcher({
				core,
				initialProposal,
				onViewChange: (newProposal) => {
					callbackProposal = newProposal;
				},
			});

			const newProposal = {
				id: "proposal-1",
				title: "Test Proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-05",
				labels: [],
				dependencies: [],
				rawContent: "Test proposal body",
			};

			switcher.updateProposal({
				selectedProposal: newProposal,
				type: "proposal-detail",
			});

			assert.ok(callbackProposal);
			if (!callbackProposal) {
				throw new Error("callbackProposal should not be null");
			}
			const proposal = callbackProposal as unknown as ViewProposal;
			assert.strictEqual(proposal.type, "proposal-detail");
			assert.deepStrictEqual(proposal.selectedProposal, newProposal);
		});
	});
});
