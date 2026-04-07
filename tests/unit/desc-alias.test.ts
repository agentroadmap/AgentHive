import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("--desc alias functionality", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-desc-alias");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo first
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email "test@example.com"`, { cwd: TEST_DIR });

		// Initialize roadmap project using Core
		const core = new Core(TEST_DIR);
		await core.initializeProject("Desc Alias Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should create proposal with --desc alias", async () => {
		const _result = execSync(
			`node --experimental-strip-types ${cliPath} proposal create "Test --desc alias" --desc "Created with --desc"`,
			{ cwd: TEST_DIR },
		);

		// Check that command succeeded (no exception thrown)
		const output = execSync(
			`node --experimental-strip-types ${cliPath} proposal 1 --plain`,
			{ cwd: TEST_DIR },
		).text();
		assert.ok(output.includes("Test --desc alias"));
		assert.ok(output.includes("Created with --desc"));
	});

	it("should verify proposal created with --desc has correct description", async () => {
		// Create proposal with --desc
		execSync(
			`node --experimental-strip-types ${cliPath} proposal create "Test proposal" --desc "Description via --desc"`,
			{ cwd: TEST_DIR },
		);

		// Verify the proposal was created with correct description
		const core = new Core(TEST_DIR);
		const proposal = await core.filesystem.loadProposal("proposal-1");

		assert.notStrictEqual(proposal, null);
		assert.ok(proposal?.description?.includes("Description via --desc"));
	});

	it("should edit proposal description with --desc alias", async () => {
		// Create initial proposal
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Edit test proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-04",
				labels: [],
				dependencies: [],
				description: "Original description",
			},
			false,
		);

		// Edit with --desc
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 1 --desc "Updated via --desc"`,
			{ cwd: TEST_DIR },
		);

		// Command succeeded without throwing

		// Verify the description was updated
		const updatedProposal = await core.filesystem.loadProposal("proposal-1");
		assert.ok(updatedProposal?.description?.includes("Updated via --desc"));
	});

	it("should create draft with --desc alias", async () => {
		execSync(
			`node --experimental-strip-types ${cliPath} draft create "Draft with --desc" --desc "Draft description"`,
			{ cwd: TEST_DIR },
		);

		// Command succeeded without throwing
	});

	it("should verify draft created with --desc has correct description", async () => {
		// Create draft with --desc
		execSync(
			`node --experimental-strip-types ${cliPath} draft create "Test draft" --desc "Draft via --desc"`,
			{ cwd: TEST_DIR },
		);

		// Verify the draft was created with correct description
		const core = new Core(TEST_DIR);
		const draft = await core.filesystem.loadDraft("draft-1");

		assert.notStrictEqual(draft, null);
		assert.ok(draft?.description?.includes("Draft via --desc"));
	});

	it("should show --desc in help text", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal create --help`,
			{ cwd: TEST_DIR },
		).text();

		assert.ok(result.includes("-d, --description <text>"));
		assert.ok(result.includes("--desc <text>"));
		assert.ok(result.includes("alias for --description"));
	});
});
