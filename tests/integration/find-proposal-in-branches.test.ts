import assert from "node:assert";
import { describe, it } from "node:test";
import {
	findProposalInLocalBranches,
	findProposalInRemoteBranches,
} from "../../src/core/storage/proposal-loader.ts";
import type { GitOperations } from "../../src/git/operations.ts";

type PartialGitOps = Partial<GitOperations>;

describe("findProposalInRemoteBranches", () => {
	it("should return null when git has no remotes", async () => {
		const mockGit: PartialGitOps = {
			hasAnyRemote: async () => false,
		};
		const result = await findProposalInRemoteBranches(
			mockGit as GitOperations,
			"proposal-999",
		);
		assert.strictEqual(result, null);
	});

	it("should return null when no branches exist", async () => {
		const mockGit: PartialGitOps = {
			hasAnyRemote: async () => true,
			listRecentRemoteBranches: async () => [],
		};
		const result = await findProposalInRemoteBranches(
			mockGit as GitOperations,
			"proposal-999",
		);
		assert.strictEqual(result, null);
	});

	it("should return null when proposal is not in any branch", async () => {
		const mockGit: PartialGitOps = {
			hasAnyRemote: async () => true,
			listRecentRemoteBranches: async () => ["main"],
			listFilesInTree: async () => [
				"roadmap/proposals/proposal-1 - some proposal.md",
			],
			getBranchLastModifiedMap: async () =>
				new Map([
					["roadmap/proposals/proposal-1 - some proposal.md", new Date()],
				]),
		};
		const result = await findProposalInRemoteBranches(
			mockGit as GitOperations,
			"proposal-999",
		);
		assert.strictEqual(result, null);
	});

	it("should find and load proposal from remote branch", async () => {
		const mockProposalContent = `---
id: proposal-123
title: Test Proposal
status: Potential
assignee: []
created_date: '2025-01-01 12:00'
labels: []
dependencies: []
---

## Description

Test description
`;
		const mockGit: PartialGitOps = {
			hasAnyRemote: async () => true,
			listRecentRemoteBranches: async () => ["feature"],
			listFilesInTree: async () => [
				"roadmap/proposals/proposal-123 - Test Proposal.md",
			],
			getBranchLastModifiedMap: async () =>
				new Map([
					[
						"roadmap/proposals/proposal-123 - Test Proposal.md",
						new Date("2025-01-01"),
					],
				]),
			showFile: async () => mockProposalContent,
		};

		const result = await findProposalInRemoteBranches(
			mockGit as GitOperations,
			"proposal-123",
		);
		assert.notStrictEqual(result, null);
		assert.strictEqual(result?.id, "proposal-123");
		assert.strictEqual(result?.source, "remote");
		assert.strictEqual(result?.branch, "feature");
	});
});

describe("findProposalInLocalBranches", () => {
	it("should return null when on detached HEAD", async () => {
		const mockGit: PartialGitOps = {
			getCurrentBranch: async () => "",
		};
		const result = await findProposalInLocalBranches(
			mockGit as GitOperations,
			"proposal-999",
		);
		assert.strictEqual(result, null);
	});

	it("should return null when only current branch exists", async () => {
		const mockGit: PartialGitOps = {
			getCurrentBranch: async () => "main",
			listRecentBranches: async () => ["main"],
		};
		const result = await findProposalInLocalBranches(
			mockGit as GitOperations,
			"proposal-999",
		);
		assert.strictEqual(result, null);
	});

	it("should find and load proposal from another local branch", async () => {
		const mockProposalContent = `---
id: proposal-456
title: Local Branch Proposal
status: Active
assignee: []
created_date: '2025-01-01 12:00'
labels: []
dependencies: []
---

## Description

From local branch
`;
		const mockGit: PartialGitOps = {
			getCurrentBranch: async () => "main",
			listRecentBranches: async () => ["main", "feature-branch"],
			listFilesInTree: async () => [
				"roadmap/proposals/proposal-456 - Local Branch Proposal.md",
			],
			getBranchLastModifiedMap: async () =>
				new Map([
					[
						"roadmap/proposals/proposal-456 - Local Branch Proposal.md",
						new Date("2025-01-01"),
					],
				]),
			showFile: async () => mockProposalContent,
		};

		const result = await findProposalInLocalBranches(
			mockGit as GitOperations,
			"proposal-456",
		);
		assert.notStrictEqual(result, null);
		assert.strictEqual(result?.id, "proposal-456");
		assert.strictEqual(result?.source, "local-branch");
		assert.strictEqual(result?.branch, "feature-branch");
	});
});
