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

describe("Proposal edit section preservation", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-proposal-edit-preservation");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo first
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email "test@example.com"`, { cwd: TEST_DIR });

		// Initialize roadmap project using Core
		const core = new Core(TEST_DIR);
		await core.initializeProject("Proposal Edit Preservation Test");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should preserve all sections when updating description", async () => {
		// Create a proposal with all sections
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Full proposal test",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-04",
				labels: [],
				dependencies: [],
				description: "Original description",
			},
			false,
		);

		// Add acceptance criteria
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 1 --ac "Criterion 1,Criterion 2"`,
			{ cwd: TEST_DIR },
		);

		// Add implementation plan
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 1 --plan "Step 1\nStep 2\nStep 3"`,
			{ cwd: TEST_DIR },
		);

		// Add implementation notes
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 1 --notes "Original implementation notes"`,
			{ cwd: TEST_DIR },
		);

		// Verify all sections exist
		let result = execSync(
			`node --experimental-strip-types ${cliPath} proposal 1 --plain`,
			{ cwd: TEST_DIR },
		).text();

		assert.ok(result.includes("Original description"));
		assert.ok(result.includes("Criterion 1"));
		assert.ok(result.includes("Criterion 2"));
		assert.ok(result.includes("Step 1"));
		assert.ok(result.includes("Step 2"));
		assert.ok(result.includes("Step 3"));
		assert.ok(result.includes("Original implementation notes"));

		// Update just the description
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 1 -d "UPDATED description"`,
			{ cwd: TEST_DIR },
		);

		// Verify ALL sections are preserved
		result = execSync(
			`node --experimental-strip-types ${cliPath} proposal 1 --plain`,
			{ cwd: TEST_DIR },
		).text();

		assert.ok(result.includes("UPDATED description"));
		assert.ok(result.includes("Criterion 1"));
		assert.ok(result.includes("Criterion 2"));
		assert.ok(result.includes("Step 1"));
		assert.ok(result.includes("Step 2"));
		assert.ok(result.includes("Step 3"));
		assert.ok(result.includes("Original implementation notes"));
	});

	it("should preserve all sections when updating acceptance criteria", async () => {
		// Create a proposal with all sections
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-2",
				title: "AC update test",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-04",
				labels: [],
				dependencies: [],
				description: "Test description",
			},
			false,
		);

		// Add all sections
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 2 --ac "Original criterion"`,
			{ cwd: TEST_DIR },
		);
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 2 --plan "Original plan"`,
			{ cwd: TEST_DIR },
		);
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 2 --notes "Original notes"`,
			{ cwd: TEST_DIR },
		);

		// Add new acceptance criteria (now adds instead of replacing)
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 2 --ac "Updated criterion 1" --ac "Updated criterion 2"`,
			{ cwd: TEST_DIR },
		);

		// Verify all sections are preserved
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal 2 --plain`,
			{ cwd: TEST_DIR },
		).text();

		assert.ok(result.includes("Test description"));
		assert.ok(result.includes("Original criterion")); // Now preserved
		assert.ok(result.includes("Updated criterion 1"));
		assert.ok(result.includes("Updated criterion 2"));
		assert.ok(result.includes("Original plan"));
		assert.ok(result.includes("Original notes"));
	});

	it("should preserve all sections when updating implementation plan", async () => {
		// Create a proposal with all sections
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-3",
				title: "Plan update test",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-04",
				labels: [],
				dependencies: [],
				description: "Test description",
			},
			false,
		);

		// Add all sections
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 3 --ac "Test criterion"`,
			{ cwd: TEST_DIR },
		);
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 3 --plan "Original plan"`,
			{ cwd: TEST_DIR },
		);
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 3 --notes "Original notes"`,
			{ cwd: TEST_DIR },
		);

		// Update implementation plan
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 3 --plan "Updated plan step 1\nUpdated plan step 2"`,
			{ cwd: TEST_DIR },
		);

		// Verify all sections are preserved
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal 3 --plain`,
			{ cwd: TEST_DIR },
		).text();

		assert.ok(result.includes("Test description"));
		assert.ok(result.includes("Test criterion"));
		assert.ok(result.includes("Updated plan step 1"));
		assert.ok(result.includes("Updated plan step 2"));
		assert.ok(result.includes("Original notes"));
		assert.ok(!result.includes("Original plan"));
	});

	it("should preserve all sections when updating implementation notes", async () => {
		// Create a proposal with all sections
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-4",
				title: "Notes update test",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-04",
				labels: [],
				dependencies: [],
				description: "Test description",
			},
			false,
		);

		// Add all sections
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 4 --ac "Test criterion"`,
			{ cwd: TEST_DIR },
		);
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 4 --plan "Test plan"`,
			{ cwd: TEST_DIR },
		);
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 4 --notes "Original notes"`,
			{ cwd: TEST_DIR },
		);

		// Update implementation notes (should overwrite existing)
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 4 --notes "Additional notes"`,
			{ cwd: TEST_DIR },
		);

		// Verify all sections are preserved and notes are appended
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal 4 --plain`,
			{ cwd: TEST_DIR },
		).text();

		assert.ok(result.includes("Test description"));
		assert.ok(result.includes("Test criterion"));
		assert.ok(result.includes("Test plan"));
		assert.ok(!result.includes("Original notes"));
		assert.ok(result.includes("Additional notes"));
	});

	it("should handle proposals with minimal content", async () => {
		// Create a proposal with just description
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-5",
				title: "Minimal proposal test",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-04",
				labels: [],
				dependencies: [],
				description: "Minimal description",
			},
			false,
		);

		// Update description
		execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 5 -d "Updated minimal description"`,
			{ cwd: TEST_DIR },
		);

		// Should have updated description and default AC text
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal 5 --plain`,
			{ cwd: TEST_DIR },
		).text();

		assert.ok(result.includes("Updated minimal description"));
		assert.ok(result.includes("No acceptance criteria defined"));
	});
});
