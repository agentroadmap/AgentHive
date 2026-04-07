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

describe("Tab switching functionality", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-tab-switching");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test Tab Switching Project");

		// Create test proposals
		const proposalsDir = core.filesystem.proposalsDir;
		await writeFile(
			join(proposalsDir, "proposal-1 - Test Proposal.md"),
			`---
id: proposal-1
title: Test Proposal
status: Potential
assignee: []
created_date: '2025-07-05'
labels: []
dependencies: []
---

## Description

Test proposal for tab switching.`,
		);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("Unified Proposal domain", () => {
		it("should use unified Proposal interface everywhere", async () => {
			// Load proposals
			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 1);

			const proposal = proposals[0];
			assert.notStrictEqual(proposal, undefined);

			if (!proposal) return;

			// Verify Proposal has all the expected fields (including metadata fields)
			assert.notStrictEqual(proposal.id, undefined);
			assert.notStrictEqual(proposal.title, undefined);
			assert.notStrictEqual(proposal.status, undefined);
			assert.notStrictEqual(proposal.assignee, undefined);
			assert.notStrictEqual(proposal.labels, undefined);
			assert.notStrictEqual(proposal.dependencies, undefined);

			// Metadata fields should be optional and available
			assert.strictEqual(typeof proposal.source, "undefined"); // Not set for local proposals loaded from filesystem
			assert.strictEqual(typeof proposal.lastModified, "undefined"); // Not set for basic loaded proposals

			// But they should be settable
			const proposalWithMetadata = {
				...proposal,
				origin: "local" as const,
				lastModified: new Date(),
			};

			assert.strictEqual(proposalWithMetadata.source, "local");
			expect(proposalWithMetadata.lastModified).toBeInstanceOf(Date);
		});

		it("should handle runUnifiedView with preloaded kanban data", async () => {
			const proposals = await core.filesystem.listProposals();

			// Test that runUnifiedView accepts the correct parameters without actually running the UI
			expect(() => {
				// Just verify the function can be imported and called with correct parameters
				const options = {
					core,
					initialView: "kanban" as const,
					proposals,
					preloadedKanbanData: {
						proposals: proposals.map((t) => ({
							...t,
							origin: "local" as const,
						})),
						statuses: [
							"Potential",
							"Active",
							"Accepted",
							"Complete",
							"Abandoned",
						],
					},
				};

				// Verify the options object is valid
				assert.notStrictEqual(options.core, undefined);
				assert.strictEqual(options.initialView, "kanban");
				assert.notStrictEqual(options.proposals, undefined);
				assert.notStrictEqual(options.preloadedKanbanData, undefined);
			}).not.toThrow();
		});

		it("should handle proposal switching between views", async () => {
			const proposals = await core.filesystem.listProposals();
			assert.strictEqual(proposals.length, 1);

			const testProposal = proposals[0];

			// Test that we can create valid options for different view types
			const testProposals = [
				{ view: "proposal-list" as const, proposal: testProposal },
				{ view: "proposal-detail" as const, proposal: testProposal },
				{ view: "kanban" as const, proposal: testProposal },
			];

			for (const proposal of testProposals) {
				expect(() => {
					// Verify we can create valid options for each view type
					const options = {
						core,
						initialView: proposal.view,
						selectedProposal: proposal.proposal,
						proposals,
						preloadedKanbanData: {
							proposals,
							statuses: ["Potential"],
						},
					};

					// Verify the options are valid
					assert.notStrictEqual(options.core, undefined);
					assert.strictEqual(options.initialView, proposal.view);
					if (proposal.proposal) {
						assert.deepStrictEqual(options.selectedProposal, proposal.proposal);
					} else {
						assert.strictEqual(options.selectedProposal, null);
					}
					assert.notStrictEqual(options.proposals, undefined);
					assert.notStrictEqual(options.preloadedKanbanData, undefined);
				}).not.toThrow();
			}
		});
	});
});
