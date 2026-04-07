import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
	loadRemoteProposals,
	resolveProposalConflict,
} from "../../src/core/storage/proposal-loader.ts";
import type { GitOperations } from "../../src/git/operations.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

// Mock GitOperations for testing
class MockGitOperations implements Partial<GitOperations> {
	async fetch(): Promise<void> {
		// Mock fetch
	}

	async listRemoteBranches(): Promise<string[]> {
		return ["main", "feature", "feature2"];
	}

	async listRecentRemoteBranches(_daysAgo: number): Promise<string[]> {
		return ["main", "feature", "feature2"];
	}

	async getBranchLastModifiedMap(
		_ref: string,
		_dir: string,
	): Promise<Map<string, Date>> {
		const map = new Map<string, Date>();
		// Add all files with the same date for simplicity
		map.set(
			"roadmap/proposals/proposal-1 - Main Proposal.md",
			new Date("2025-06-13"),
		);
		map.set(
			"roadmap/proposals/proposal-2 - Feature Proposal.md",
			new Date("2025-06-13"),
		);
		map.set(
			"roadmap/proposals/proposal-3 - Feature2 Proposal.md",
			new Date("2025-06-13"),
		);
		return map;
	}

	async listFilesInTree(ref: string, _path: string): Promise<string[]> {
		if (ref === "origin/main") {
			return ["roadmap/proposals/proposal-1 - Main Proposal.md"];
		}
		if (ref === "origin/feature") {
			return ["roadmap/proposals/proposal-2 - Feature Proposal.md"];
		}
		if (ref === "origin/feature2") {
			return ["roadmap/proposals/proposal-3 - Feature2 Proposal.md"];
		}
		return [];
	}

	async showFile(_ref: string, file: string): Promise<string> {
		if (file.includes("proposal-1")) {
			return `---
id: proposal-1
title: Main Proposal
status: Potential
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---\n\n## Description\n\nMain proposal`;
		}
		if (file.includes("proposal-2")) {
			return `---
id: proposal-2
title: Feature Proposal
status: Active
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---\n\n## Description\n\nFeature proposal`;
		}
		if (file.includes("proposal-3")) {
			return `---
id: proposal-3
title: Feature2 Proposal
status: Complete
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---\n\n## Description\n\nFeature2 proposal`;
		}
		return "";
	}

	async getFileLastModifiedTime(
		_ref: string,
		_file: string,
	): Promise<Date | null> {
		return new Date("2025-06-13");
	}
}

describe("Parallel remote proposal loading", () => {
	let consoleErrorSpy: ReturnType<typeof mock.method>;

	beforeEach(() => {
		consoleErrorSpy = mock.method(console, "error");
	});

	afterEach(() => {
		consoleErrorSpy?.mock.restore();
	});

	it("should load proposals from multiple branches in parallel", async () => {
		const mockGitOperations =
			new MockGitOperations() as unknown as GitOperations;

		// Track progress messages
		const progressMessages: string[] = [];
		const remoteProposals = await loadRemoteProposals(
			mockGitOperations,
			null,
			(msg: string) => {
				progressMessages.push(msg);
			},
		);

		// Verify results - we should have proposals from all remote branches
		assert.strictEqual(remoteProposals.length, 3);
		const proposalIds = remoteProposals.map((t) => t.id);
		assert.ok(proposalIds.includes("proposal-1"));
		assert.ok(proposalIds.includes("proposal-2"));
		assert.ok(proposalIds.includes("proposal-3"));

		// Verify each proposal has correct metadata
		const proposal1 = remoteProposals.find((t) => t.id === "proposal-1");
		assert.strictEqual(proposal1?.source, "remote");
		assert.strictEqual(proposal1?.branch, "main");
		assert.strictEqual(proposal1?.status, "Potential");

		// Verify progress reporting
		expect(
			progressMessages.some((msg) => msg.includes("Fetching remote branches")),
		).toBe(true);
		expect(
			progressMessages.some((msg) =>
				msg.includes("Found 3 unique proposals across remote branches"),
			),
		).toBe(true);
		expect(
			progressMessages.some((msg) => msg.includes("Loaded 3 remote proposals")),
		).toBe(true);
	});

	it("should handle errors gracefully", async () => {
		// Create a mock that throws an error
		const errorGitOperations = {
			fetch: async () => {
				throw new Error("Network error");
			},
			listRecentRemoteBranches: async (_daysAgo: number) => {
				throw new Error("Network error");
			},
		} as unknown as GitOperations;

		// Should return empty array on error
		const remoteProposals = await loadRemoteProposals(errorGitOperations, null);
		assert.deepStrictEqual(remoteProposals, []);

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			"Failed to fetch remote proposals:",
			expect.any(Error),
		);
	});

	it("should resolve proposal conflicts correctly", async () => {
		const statuses = [
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		];

		const localProposal: Proposal = {
			id: "proposal-1",
			title: "Local Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-06-13",
			labels: [],
			dependencies: [],
			description: "Local version",
			origin: "local",
			lastModified: new Date("2025-06-13T10:00:00Z"),
		};

		const remoteProposal: Proposal = {
			id: "proposal-1",
			title: "Remote Proposal",
			status: "Complete",
			assignee: [],
			createdDate: "2025-06-13",
			labels: [],
			dependencies: [],
			description: "Remote version",
			origin: "remote",
			branch: "feature",
			lastModified: new Date("2025-06-13T12:00:00Z"),
		};

		// Test most_progressed strategy - should pick Complete over Potential
		const resolved1 = resolveProposalConflict(
			localProposal,
			remoteProposal,
			statuses,
			"most_progressed",
		);
		assert.strictEqual(resolved1.status, "Complete");
		assert.strictEqual(resolved1.title, "Remote Proposal");

		// Test most_recent strategy - should pick the more recent one
		const resolved2 = resolveProposalConflict(
			localProposal,
			remoteProposal,
			statuses,
			"most_recent",
		);
		assert.deepStrictEqual(
			resolved2.lastModified,
			new Date("2025-06-13T12:00:00Z"),
		);
		assert.strictEqual(resolved2.title, "Remote Proposal");
	});
});
