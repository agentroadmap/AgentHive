import assert from "node:assert";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import type { Proposal } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

async function initGitRepo(dir: string) {
	execSync(`git init -b main`, { cwd: dir });
	execSync(`git config user.name "Test User"`, { cwd: dir });
	execSync(`git config user.email test@example.com`, { cwd: dir });
}

describe("CLI parent proposal id normalization", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-parent-normalization");
		await mkdir(TEST_DIR, { recursive: true });
		await initGitRepo(TEST_DIR);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	it("should normalize parent proposal id when creating subproposals", async () => {
		const core = new Core(TEST_DIR);
		await core.initializeProject("Normalization Test", true);

		const parent: Proposal = {
			id: "proposal-4",
			title: "Parent",
			status: "Potential",
			assignee: [],
			createdDate: "2025-06-08",
			labels: [],
			dependencies: [],
		};
		await core.createProposal(parent, true);

		execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create Child --parent 4`,
			{ cwd: TEST_DIR },
		);

		const child = await core.filesystem.loadProposal("proposal-4.1");
		assert.strictEqual(child?.parentProposalId, "proposal-4");
	});
});
