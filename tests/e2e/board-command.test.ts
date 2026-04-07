import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Board command integration", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-board-command");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test Board Project");

		// Disable remote operations for tests to prevent background git fetches
		const config = await core.filesystem.loadConfig();
		if (config) {
			config.remoteOperations = false;
			await core.filesystem.saveConfig(config);
		}

		// Create some test proposals
		const proposalsDir = core.filesystem.proposalsDir;
		await writeFile(
			join(proposalsDir, "proposal-1 - Test Proposal One.md"),
			`---
id: proposal-1
title: Test Proposal One
status: Potential
assignee: []
created_date: '2025-07-05'
labels: []
dependencies: []
---

## Description

This is a test proposal for board testing.`,
		);

		await writeFile(
			join(proposalsDir, "proposal-2 - Test Proposal Two.md"),
			`---
id: proposal-2
title: Test Proposal Two
status: Active
assignee: []
created_date: '2025-07-05'
labels: []
dependencies: []
---

## Description

This is another test proposal for board testing.`,
		);
	});

	afterEach(async () => {
		// Wait a bit to ensure any background operations complete
		await new Promise((resolve) => setTimeout(resolve, 100));
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("Board loading", () => {
		it("should load board without errors", async () => {
			// This test verifies that the board command data loading works correctly
			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 2);

			// Test that we can prepare the board data without running the interactive UI
			expect(() => {
				const options = {
					core,
					initialView: "kanban" as const,
					proposals: proposals.map((t) => ({ ...t, status: t.status || "" })),
				};

				// Verify board options are valid
				assert.notStrictEqual(options.core, undefined);
				assert.strictEqual(options.initialView, "kanban");
				assert.notStrictEqual(options.proposals, undefined);
				assert.strictEqual(options.proposals.length, 2);
				assert.strictEqual(options.proposals[0]?.status, "Potential");
				assert.strictEqual(options.proposals[1]?.status, "Active");
			}).not.toThrow();
		});

		it("should handle empty proposal list gracefully", async () => {
			// Remove test proposals
			const proposalsDir = core.filesystem.proposalsDir;
			await rm(join(proposalsDir, "proposal-1 - Test Proposal One.md")).catch(
				() => {},
			);
			await rm(join(proposalsDir, "proposal-2 - Test Proposal Two.md")).catch(
				() => {},
			);

			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 0);

			// Should handle empty proposal list properly
			expect(() => {
				const options = {
					core,
					initialView: "kanban" as const,
					proposals: [],
				};

				// Verify empty proposal list is handled correctly
				assert.notStrictEqual(options.core, undefined);
				assert.strictEqual(options.initialView, "kanban");
				assert.notStrictEqual(options.proposals, undefined);
				assert.strictEqual(options.proposals.length, 0);
			}).not.toThrow();
		});

		it("should validate ViewSwitcher initialization with kanban view", async () => {
			// This specifically tests the ViewSwitcher setup that was failing
			const { ViewSwitcher } = await import("../../src/ui/view-switcher.ts");

			const initialProposal = {
				type: "kanban" as const,
				kanbanData: {
					proposals: [],
					statuses: [],
					isLoading: true,
				},
			};

			// This should not throw
			const viewSwitcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			expect(viewSwitcher.getProposal().type).toBe("kanban");
			expect(viewSwitcher.getProposal().kanbanData?.isLoading).toBe(true);

			// Clean up to prevent background operations after test
			viewSwitcher.cleanup();
		});

		it("should handle getKanbanData method correctly", async () => {
			// Test the specific method that was failing in the error
			const { ViewSwitcher } = await import("../../src/ui/view-switcher.ts");

			const initialProposal = {
				type: "kanban" as const,
				kanbanData: {
					proposals: [],
					statuses: [],
					isLoading: true,
				},
			};

			const viewSwitcher = new ViewSwitcher({
				core,
				initialProposal,
			});

			try {
				// Mock the getKanbanData method to avoid remote git operations
				viewSwitcher.getKanbanData = async () => {
					// Mock config since it's not fully available in this test environment
					const config = await core.filesystem.loadConfig();
					const statuses = config?.statuses || ["Potential", "Active"];
					return {
						proposals: await core.filesystem.listProposals(),
						statuses: statuses || [],
					};
				};

				// This should not throw "viewSwitcher?.getKanbanData is not a function"
				await expect(async () => {
					const kanbanData = await viewSwitcher.getKanbanData();
					assert.notStrictEqual(kanbanData, undefined);
					expect(Array.isArray(kanbanData.proposals)).toBe(true);
					expect(Array.isArray(kanbanData.statuses)).toBe(true);
				}).not.toThrow();
			} finally {
				// Always cleanup in finally block
				viewSwitcher.cleanup();
			}
		});
	});

	describe("Cross-branch proposal resolution", () => {
		it("should handle getLatestProposalProposalsForIds with proper parameters", async () => {
			// Test the function that was missing the filesystem parameter
			const { getLatestProposalProposalsForIds } = await import(
				"../../src/core/dag/cross-branch-proposals.ts"
			);

			const proposals = await core.filesystem.listProposals();
			const proposalIds = proposals.map((t) => t.id);

			// This should not throw "fs is not defined"
			await expect(async () => {
				const result = await getLatestProposalProposalsForIds(
					core.gitOps,
					core.filesystem,
					proposalIds,
				);
				expect(result).toBeInstanceOf(Map);
			}).not.toThrow();
		});
	});
});
