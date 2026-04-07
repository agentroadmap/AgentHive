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

describe("CLI Board Integration", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-board-integration");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test CLI Board Project");

		// Disable remote operations for tests to prevent background git fetches
		const config = await core.filesystem.loadConfig();
		if (config) {
			config.remoteOperations = false;
			await core.filesystem.saveConfig(config);
		}

		// Create test proposals
		const proposalsDir = core.filesystem.proposalsDir;
		await writeFile(
			join(proposalsDir, "proposal-1 - Board Test Proposal.md"),
			`---
id: proposal-1
title: Board Test Proposal
status: Potential
assignee: []
created_date: '2025-07-05'
labels: []
dependencies: []
---

## Description

Test proposal for board CLI integration.`,
		);
	});

	afterEach(async () => {
		// Wait a bit to ensure any background operations from listProposalsWithMetadata complete
		await new Promise((resolve) => setTimeout(resolve, 100));
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should handle board command logic without crashing", async () => {
		// Test the main board loading logic that was failing
		const config = await core.filesystem.loadConfig();
		const statuses = config?.statuses || [];

		// Load proposals like the CLI does
		const [localProposals, _remoteProposals] = await Promise.all([
			core.listProposalsWithMetadata(),
			// Remote proposals would normally be loaded but will fail in test env - that's OK
			Promise.resolve([]),
		]);

		// Verify basic functionality
		assert.strictEqual(localProposals.length, 1);
		assert.strictEqual(localProposals[0]?.id, "proposal-1");
		assert.strictEqual(localProposals[0]?.status, "Potential");
		assert.ok(statuses.includes("Potential"));

		// Test that we can create the proposal map
		const proposalsById = new Map(
			localProposals.map((t) => [t.id, { ...t, origin: "local" as const }]),
		);
		assert.strictEqual(proposalsById.size, 1);
		expect(proposalsById.get("proposal-1")?.title).toBe("Board Test Proposal");
	});

	it("should properly handle cross-branch proposal resolution", async () => {
		// Test the function that was missing filesystem parameter
		const { getLatestProposalProposalsForIds } = await import(
			"../../src/core/dag/cross-branch-proposals.ts"
		);

		const proposals = await core.filesystem.listProposals();
		const proposalIds = proposals.map((t) => t.id);

		// This should not throw "fs is not defined" or parameter errors
		const result = await getLatestProposalProposalsForIds(
			core.gitOps,
			core.filesystem,
			proposalIds,
		);

		expect(result).toBeInstanceOf(Map);
		// The result may be empty in test environment without branches, but it shouldn't crash
	});

	it("should create ViewSwitcher with kanban view successfully", async () => {
		// Test the specific ViewSwitcher initialization that was failing
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

		// Immediately cleanup to prevent background operations
		viewSwitcher.cleanup();

		// Verify the ViewSwitcher has the required methods
		assert.strictEqual(typeof viewSwitcher.getKanbanData, "function");
		assert.strictEqual(typeof viewSwitcher.switchView, "function");
		assert.strictEqual(typeof viewSwitcher.isKanbanReady, "function");

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

		// Test that getKanbanData method exists and can be called
		const kanbanData = await viewSwitcher.getKanbanData();
		assert.notStrictEqual(kanbanData, undefined);
		expect(Array.isArray(kanbanData.proposals)).toBe(true);
		expect(Array.isArray(kanbanData.statuses)).toBe(true);

		// Clean up again to be sure
		viewSwitcher.cleanup();
	});
});
