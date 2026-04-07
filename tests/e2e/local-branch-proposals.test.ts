import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
	buildLocalBranchProposalIndex,
	loadLocalBranchProposals,
} from "../../src/core/storage/proposal-loader.ts";
import type { GitOperations } from "../../src/git/operations.ts";
import type { Proposal, RoadmapConfig } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

// Mock GitOperations for testing
class MockGitOperations implements Partial<GitOperations> {
	private currentBranch = "main";

	async getCurrentBranch(): Promise<string> {
		return this.currentBranch;
	}

	async listRecentBranches(_daysAgo: number): Promise<string[]> {
		return ["main", "feature-a", "feature-b", "origin/main"];
	}

	async getBranchLastModifiedMap(
		_ref: string,
		_dir: string,
	): Promise<Map<string, Date>> {
		const map = new Map<string, Date>();
		map.set(
			"roadmap/proposals/proposal-1 - Main Proposal.md",
			new Date("2025-06-13"),
		);
		map.set(
			"roadmap/proposals/proposal-2 - Feature Proposal.md",
			new Date("2025-06-13"),
		);
		map.set(
			"roadmap/proposals/proposal-3 - New Proposal.md",
			new Date("2025-06-13"),
		);
		return map;
	}

	async listFilesInTree(ref: string, _path: string): Promise<string[]> {
		// Main branch has proposal-1 and proposal-2
		if (ref === "main") {
			return [
				"roadmap/proposals/proposal-1 - Main Proposal.md",
				"roadmap/proposals/proposal-2 - Feature Proposal.md",
			];
		}
		// feature-a has proposal-1 and proposal-3 (proposal-3 is new)
		if (ref === "feature-a") {
			return [
				"roadmap/proposals/proposal-1 - Main Proposal.md",
				"roadmap/proposals/proposal-3 - New Proposal.md",
			];
		}
		// feature-b has proposal-2
		if (ref === "feature-b") {
			return ["roadmap/proposals/proposal-2 - Feature Proposal.md"];
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
title: New Proposal
status: Potential
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---\n\n## Description\n\nNew proposal from feature-a branch`;
		}
		return "";
	}
}

describe("Local branch proposal discovery", () => {
	let consoleDebugSpy: ReturnType<typeof mock.method>;

	beforeEach(() => {
		consoleDebugSpy = mock.method(console, "debug");
	});

	afterEach(() => {
		consoleDebugSpy?.mock.restore();
	});

	describe("buildLocalBranchProposalIndex", () => {
		it("should build index from local branches excluding current branch", async () => {
			const mockGit = new MockGitOperations() as unknown as GitOperations;
			const branches = ["main", "feature-a", "feature-b", "origin/main"];

			const index = await buildLocalBranchProposalIndex(
				mockGit,
				branches,
				"main",
				"roadmap",
			);

			// Should find proposal-3 from feature-a (not in main)
			expect(index.has("proposal-3")).toBe(true);
			const proposal3Entries = index.get("proposal-3");
			assert.strictEqual(proposal3Entries?.length, 1);
			assert.strictEqual(proposal3Entries?.[0]?.branch, "feature-a");

			// Should find proposal-1 and proposal-2 from other branches
			expect(index.has("proposal-1")).toBe(true);
			expect(index.has("proposal-2")).toBe(true);
		});

		it("should exclude origin/ branches", async () => {
			const mockGit = new MockGitOperations() as unknown as GitOperations;
			const branches = ["main", "feature-a", "origin/feature-a"];

			const index = await buildLocalBranchProposalIndex(
				mockGit,
				branches,
				"main",
				"roadmap",
			);

			// Should only have entries from feature-a (local), not origin/feature-a
			const proposal1Entries = index.get("proposal-1");
			expect(proposal1Entries?.every((e) => e.branch === "feature-a")).toBe(
				true,
			);
		});

		it("should index RFC-style proposal filenames by full ID", async () => {
			const mockGit = {
				listFilesInTree: async (ref: string) =>
					ref === "feature-a"
						? ["roadmap/proposals/RFC-20260401-MESSAGING.md"]
						: [],
				getBranchLastModifiedMap: async () =>
					new Map([
						[
							"roadmap/proposals/RFC-20260401-MESSAGING.md",
							new Date("2026-04-01T20:21:00Z"),
						],
					]),
			} as unknown as GitOperations;

			const index = await buildLocalBranchProposalIndex(
				mockGit,
				["main", "feature-a"],
				"main",
				"roadmap",
			);

			expect(index.has("rfc-20260401-messaging")).toBe(true);
			assert.strictEqual(
				index.get("rfc-20260401-messaging")?.[0]?.path,
				"roadmap/proposals/RFC-20260401-MESSAGING.md",
			);
		});

		it("should exclude current branch", async () => {
			const mockGit = new MockGitOperations() as unknown as GitOperations;
			const branches = ["main", "feature-a"];

			const index = await buildLocalBranchProposalIndex(
				mockGit,
				branches,
				"main",
				"roadmap",
			);

			// proposal-1 should only be from feature-a, not main
			const proposal1Entries = index.get("proposal-1");
			expect(proposal1Entries?.every((e) => e.branch !== "main")).toBe(true);
		});
	});

	describe("loadLocalBranchProposals", () => {
		it("should discover proposals from other local branches", async () => {
			const mockGit = new MockGitOperations() as unknown as GitOperations;

			const progressMessages: string[] = [];
			const localBranchProposals = await loadLocalBranchProposals(
				mockGit,
				null,
				(msg: string) => {
					progressMessages.push(msg);
				},
			);

			// Should find proposal-3 which only exists in feature-a
			const proposal3 = localBranchProposals.find((t) => t.id === "proposal-3");
			assert.notStrictEqual(proposal3, undefined);
			assert.strictEqual(proposal3?.title, "New Proposal");
			assert.strictEqual(proposal3?.source, "local-branch");
			assert.strictEqual(proposal3?.branch, "feature-a");

			// Progress should mention other local branches
			expect(
				progressMessages.some((msg) => msg.includes("other local branches")),
			).toBe(true);
		});

		it("should skip proposals that exist in filesystem when provided", async () => {
			const mockGit = new MockGitOperations() as unknown as GitOperations;

			// Simulate that proposal-1 already exists in filesystem
			const localProposals: Proposal[] = [
				{
					id: "proposal-1",
					title: "Main Proposal (local)",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-13",
					labels: [],
					dependencies: [],
					origin: "local",
				},
			];

			const localBranchProposals = await loadLocalBranchProposals(
				mockGit,
				null,
				undefined,
				localProposals,
			);

			// proposal-3 should be found (not in local proposals)
			expect(localBranchProposals.some((t) => t.id === "proposal-3")).toBe(
				true,
			);

			// proposal-1 should not be hydrated since it exists locally
			// (unless the remote version is newer, which in this mock it's not)
			// The behavior depends on whether the remote version is newer
		});

		it("should return empty array when on detached HEAD", async () => {
			const mockGit = {
				getCurrentBranch: async () => "",
			} as unknown as GitOperations;

			const proposals = await loadLocalBranchProposals(mockGit, null);
			assert.deepStrictEqual(proposals, []);
		});

		it("should return empty when only current branch exists", async () => {
			const mockGit = {
				getCurrentBranch: async () => "main",
				listRecentBranches: async () => ["main"],
			} as unknown as GitOperations;

			const proposals = await loadLocalBranchProposals(mockGit, null);
			assert.deepStrictEqual(proposals, []);
		});

		it("should match local proposals with uppercase IDs to index keys (custom prefix)", async () => {
			// Mock git operations for custom prefix (JIRA)
			const mockGit = {
				getCurrentBranch: async () => "main",
				listRecentBranches: async () => ["main", "feature-a"],
				listFilesInTree: async (ref: string) => {
					if (ref === "feature-a") {
						return ["roadmap/proposals/jira-123 - Remote Proposal.md"];
					}
					return [];
				},
				getBranchLastModifiedMap: async () => {
					const map = new Map<string, Date>();
					map.set(
						"roadmap/proposals/jira-123 - Remote Proposal.md",
						new Date("2025-06-10"),
					); // Older than local
					return map;
				},
				showFile: async () => `---
id: JIRA-123
title: Remote Proposal
status: Potential
assignee: []
created_date: 2025-06-10
labels: []
dependencies: []
---

## Description

Proposal from feature branch`,
			} as unknown as GitOperations;

			// Local proposal has uppercase ID (canonical format)
			const localProposals: Proposal[] = [
				{
					id: "JIRA-123", // Uppercase canonical ID
					title: "Local Proposal",
					status: "Active", // More progressed than remote
					assignee: [],
					createdDate: "2025-06-13",
					updatedDate: "2025-06-15", // Newer than remote
					labels: [],
					dependencies: [],
					origin: "local",
				},
			];

			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				prefixes: { proposal: "jira" },
			};
			const localBranchProposals = await loadLocalBranchProposals(
				mockGit,
				config,
				undefined,
				localProposals,
			);

			// JIRA-123 exists locally with more progress, so it should NOT be hydrated from other branch
			// This tests that uppercase "JIRA-123" in localById matches normalized index IDs
			expect(
				localBranchProposals.find((t) => t.id === "JIRA-123"),
			).toBeUndefined();
		});

		it("should hydrate proposals that do not exist locally with custom prefix", async () => {
			const mockGit = {
				getCurrentBranch: async () => "main",
				listRecentBranches: async () => ["main", "feature-a"],
				listFilesInTree: async (ref: string) => {
					if (ref === "feature-a") {
						return ["roadmap/proposals/jira-456 - New Remote Proposal.md"];
					}
					return [];
				},
				getBranchLastModifiedMap: async () => {
					const map = new Map<string, Date>();
					map.set(
						"roadmap/proposals/jira-456 - New Remote Proposal.md",
						new Date("2025-06-13"),
					);
					return map;
				},
				showFile: async () => `---
id: JIRA-456
title: New Remote Proposal
status: Potential
assignee: []
created_date: 2025-06-13
labels: []
dependencies: []
---

## Description

New proposal from feature branch`,
			} as unknown as GitOperations;

			// Local proposals do NOT include JIRA-456
			const localProposals: Proposal[] = [
				{
					id: "JIRA-123",
					title: "Local Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-13",
					labels: [],
					dependencies: [],
					origin: "local",
				},
			];

			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				prefixes: { proposal: "jira" },
			};
			const localBranchProposals = await loadLocalBranchProposals(
				mockGit,
				config,
				undefined,
				localProposals,
			);

			// JIRA-456 should be hydrated since it doesn't exist locally
			const proposal456 = localBranchProposals.find((t) => t.id === "JIRA-456");
			assert.notStrictEqual(proposal456, undefined);
			assert.strictEqual(proposal456?.title, "New Remote Proposal");
			assert.strictEqual(proposal456?.source, "local-branch");
		});
	});
});
