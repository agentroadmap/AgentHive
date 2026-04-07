import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("CLI parent proposal filtering", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-parent-filter");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo first using shell API (same pattern as other tests)
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize roadmap project using Core (same pattern as other tests)
		const core = new Core(TEST_DIR);
		await core.initializeProject("Parent Filter Test Project");

		// Create a parent proposal
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Parent proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Parent proposal description",
			},
			false,
		);

		// Create child proposals
		await core.createProposal(
			{
				id: "proposal-1.1",
				title: "Child proposal 1",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Child proposal 1 description",
				parentProposalId: "proposal-1",
			},
			false,
		);

		await core.createProposal(
			{
				id: "proposal-1.2",
				title: "Child proposal 2",
				status: "Active",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Child proposal 2 description",
				parentProposalId: "proposal-1",
			},
			false,
		);

		// Create another standalone proposal
		await core.createProposal(
			{
				id: "proposal-2",
				title: "Standalone proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Standalone proposal description",
			},
			false,
		);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should filter proposals by parent with full proposal ID", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --parent proposal-1 --plain`,
			{ cwd: TEST_DIR },
		);

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(exitCode, 0);
		// Should contain only child proposals
		expect(result.stdout.toString()).toContain(
			"proposal-1.1 - Child proposal 1",
		);
		expect(result.stdout.toString()).toContain(
			"proposal-1.2 - Child proposal 2",
		);
		// Should not contain parent or standalone proposals
		expect(result.stdout.toString()).not.toContain(
			"proposal-1 - Parent proposal",
		);
		expect(result.stdout.toString()).not.toContain(
			"proposal-2 - Standalone proposal",
		);
	});

	it("should filter proposals by parent with short proposal ID", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --parent 1 --plain`,
			{ cwd: TEST_DIR },
		);

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(exitCode, 0);
		// Should contain only child proposals
		expect(result.stdout.toString()).toContain(
			"proposal-1.1 - Child proposal 1",
		);
		expect(result.stdout.toString()).toContain(
			"proposal-1.2 - Child proposal 2",
		);
		// Should not contain parent or standalone proposals
		expect(result.stdout.toString()).not.toContain(
			"proposal-1 - Parent proposal",
		);
		expect(result.stdout.toString()).not.toContain(
			"proposal-2 - Standalone proposal",
		);
	});

	it("should show error for non-existent parent proposal", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --parent proposal-999 --plain`,
			{ cwd: TEST_DIR },
		);

		const exitCode = result.exitCode;

		assert.strictEqual(exitCode, 1); // CLI exits with error for non-existent parent
		expect(result.stderr.toString()).toContain(
			"Parent proposal proposal-999 not found.",
		);
	});

	it("should show message when parent has no children", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --parent proposal-2 --plain`,
			{ cwd: TEST_DIR },
		);

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(exitCode, 0);
		expect(result.stdout.toString()).toContain(
			"No child proposals found for parent proposal proposal-2.",
		);
	});

	it("should work with -p shorthand flag", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list -p proposal-1 --plain`,
			{ cwd: TEST_DIR },
		);

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(exitCode, 0);
		// Should contain only child proposals
		expect(result.stdout.toString()).toContain(
			"proposal-1.1 - Child proposal 1",
		);
		expect(result.stdout.toString()).toContain(
			"proposal-1.2 - Child proposal 2",
		);
	});

	it("should combine parent filter with status filter", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --parent proposal-1 --status "Potential" --plain`,
			{ cwd: TEST_DIR },
		);

		const exitCode = result.exitCode;

		if (exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		assert.strictEqual(exitCode, 0);
		// Should contain only child proposal with "Potential" status
		expect(result.stdout.toString()).toContain(
			"proposal-1.1 - Child proposal 1",
		);
		// Should not contain child proposal with "Active" status
		expect(result.stdout.toString()).not.toContain(
			"proposal-1.2 - Child proposal 2",
		);
	});
});
