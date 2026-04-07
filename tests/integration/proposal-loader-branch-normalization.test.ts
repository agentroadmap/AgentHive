import assert from "node:assert";
import { describe, it } from "node:test";
import { buildRemoteProposalIndex } from "../../src/core/storage/proposal-loader.ts";
import type { GitOperations } from "../../src/git/operations.ts";

class MockGit implements Partial<GitOperations> {
	public refs: string[] = [];

	async listFilesInTree(ref: string, _path: string): Promise<string[]> {
		this.refs.push(ref);
		return ["roadmap/proposals/proposal-1 - Test.md"];
	}

	async getBranchLastModifiedMap(
		_ref: string,
		_path: string,
	): Promise<Map<string, Date>> {
		return new Map([["roadmap/proposals/proposal-1 - Test.md", new Date()]]);
	}
}

describe("buildRemoteProposalIndex branch handling", () => {
	it("normalizes various branch forms to canonical refs", async () => {
		const git = new MockGit();
		await buildRemoteProposalIndex(git as unknown as GitOperations, [
			"main",
			"origin/main",
			"refs/remotes/origin/main",
		]);
		assert.deepStrictEqual(git.refs, [
			"origin/main",
			"origin/main",
			"origin/main",
		]);
	});

	it("filters out invalid branch entries", async () => {
		const git = new MockGit();
		await buildRemoteProposalIndex(git as unknown as GitOperations, [
			"main",
			"origin",
			"origin/HEAD",
			"HEAD",
			"origin/origin",
			"refs/remotes/origin/origin",
		]);
		assert.deepStrictEqual(git.refs, ["origin/main"]);
	});
});
