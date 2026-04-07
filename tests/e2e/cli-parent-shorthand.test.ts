import assert from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createProposalPlatformAware,
	getCliHelpPlatformAware,
} from "../support/test-helpers.ts";
import { execSync } from "../support/test-utils.ts";

describe("CLI parent shorthand option", () => {
	let testDir: string;

	before(async () => {
		testDir = await mkdtemp(join(tmpdir(), "roadmap-test-"));

		// Initialize git repository first to avoid interactive prompts
		execSync(`git init -b main`, { cwd: testDir });
		execSync(`git config user.name "Test User"`, { cwd: testDir });
		execSync(`git config user.email test@example.com`, { cwd: testDir });

		// Initialize roadmap project using Core (simulating CLI)
		const core = new Core(testDir);
		await core.initializeProject("Test Project");
	});

	after(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("should accept -p as shorthand for --parent", async () => {
		// Create parent proposal
		const createParent = await createProposalPlatformAware(
			{ title: "Parent Proposal" },
			testDir,
		);
		assert.strictEqual(createParent.exitCode, 0);

		// Create subproposal using -p shorthand
		const createSubproposalShort = await createProposalPlatformAware(
			{ title: "Subproposal with -p", parent: "proposal-1" },
			testDir,
		);
		assert.strictEqual(createSubproposalShort.exitCode, 0);

		// Find the created subproposal file
		const proposalsDir = join(testDir, "roadmap", "proposals");
		const files = await readdir(proposalsDir);
		const subproposalFiles = files.filter(
			(f) => f.startsWith("proposal-1.1 - ") && f.endsWith(".md"),
		);
		assert.strictEqual(subproposalFiles.length, 1);

		// Verify the subproposal was created with correct parent
		if (subproposalFiles[0]) {
			const subproposalFile = await await readFile(
				join(proposalsDir, subproposalFiles[0]),
				"utf-8",
			);
			assert.ok(subproposalFile.includes("parent_proposal_id: proposal-1"));
		}
	});

	it("should work the same as --parent option", async () => {
		// Create subproposal using --parent
		const createSubproposalLong = await createProposalPlatformAware(
			{ title: "Subproposal with --parent", parent: "proposal-1" },
			testDir,
		);
		assert.strictEqual(createSubproposalLong.exitCode, 0);

		// Find both subproposal files
		const proposalsDir = join(testDir, "roadmap", "proposals");
		const files = await readdir(proposalsDir);
		const subproposalFiles1 = files.filter(
			(f) => f.startsWith("proposal-1.1 - ") && f.endsWith(".md"),
		);
		const subproposalFiles2 = files.filter(
			(f) => f.startsWith("proposal-1.2 - ") && f.endsWith(".md"),
		);

		assert.strictEqual(subproposalFiles1.length, 1);
		assert.strictEqual(subproposalFiles2.length, 1);

		// Verify both subproposals have the same parent
		if (subproposalFiles1[0] && subproposalFiles2[0]) {
			const subproposal1 = await await readFile(
				join(proposalsDir, subproposalFiles1[0]),
				"utf-8",
			);
			const subproposal2 = await await readFile(
				join(proposalsDir, subproposalFiles2[0]),
				"utf-8",
			);

			assert.ok(subproposal1.includes("parent_proposal_id: proposal-1"));
			assert.ok(subproposal2.includes("parent_proposal_id: proposal-1"));
		}
	});

	it("should show -p in help text", async () => {
		const helpResult = await getCliHelpPlatformAware(
			["proposal", "create", "--help"],
			testDir,
		);

		assert.ok(helpResult.stdout.includes("-p, --parent <proposalId>"));
		assert.ok(helpResult.stdout.includes("specify parent proposal ID"));
	});
});
