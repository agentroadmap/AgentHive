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

describe("CLI directive filtering", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-directive-filter");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Directive Filter Test Project");
		const newDirective =
			await core.filesystem.createDirective("New Directives UI");

		await core.createProposal(
			{
				id: "proposal-1",
				title: "Directive proposal one",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Proposal in release directive",
				directive: "Release-1",
			},
			false,
		);

		await core.createProposal(
			{
				id: "proposal-2",
				title: "Directive proposal two",
				status: "Active",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Proposal in same directive with different case",
				directive: "release-1",
			},
			false,
		);

		await core.createProposal(
			{
				id: "proposal-3",
				title: "Other directive proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Proposal in different directive",
				directive: "Release-2",
			},
			false,
		);

		await core.createProposal(
			{
				id: "proposal-4",
				title: "No directive proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Proposal without directive",
			},
			false,
		);

		await core.createProposal(
			{
				id: "proposal-5",
				title: "Roadmap directive proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Proposal in roadmap directive",
				directive: "Roadmap Alpha",
			},
			false,
		);

		await core.createProposal(
			{
				id: "proposal-6",
				title: "ID directive proposal",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-18",
				labels: [],
				dependencies: [],
				description: "Proposal with directive stored as ID",
				directive: newDirective.id,
			},
			false,
		);
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - unique directory names prevent conflicts
		}
	});

	it("filters by directive with case-insensitive matching", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --directive RELEASE-1 --plain`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
		const output = result.stdout.toString();

		assert.ok(output.includes("proposal-1 - Directive proposal one"));
		assert.ok(output.includes("proposal-2 - Directive proposal two"));
		assert.ok(!output.includes("proposal-3 - Other directive proposal"));
		assert.ok(!output.includes("proposal-4 - No directive proposal"));
		assert.ok(!output.includes("proposal-5 - Roadmap directive proposal"));
		assert.ok(!output.includes("proposal-6 - ID directive proposal"));
	});

	it("supports -m shorthand and combines directive with status filter", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list -m release-1 --status "Potential" --plain`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
		const output = result.stdout.toString();

		assert.ok(output.includes("proposal-1 - Directive proposal one"));
		assert.ok(!output.includes("proposal-2 - Directive proposal two"));
		assert.ok(!output.includes("proposal-3 - Other directive proposal"));
		assert.ok(!output.includes("proposal-4 - No directive proposal"));
		assert.ok(!output.includes("proposal-5 - Roadmap directive proposal"));
		assert.ok(!output.includes("proposal-6 - ID directive proposal"));
	});

	it("matches closest directive for partial and typo inputs", async () => {
		const typoResult = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --directive releas-1 --plain`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(typoResult.exitCode, 0);
		const typoOutput = typoResult.stdout.toString();

		assert.ok(typoOutput.includes("proposal-1 - Directive proposal one"));
		assert.ok(typoOutput.includes("proposal-2 - Directive proposal two"));
		assert.ok(!typoOutput.includes("proposal-3 - Other directive proposal"));
		assert.ok(!typoOutput.includes("proposal-4 - No directive proposal"));
		assert.ok(!typoOutput.includes("proposal-5 - Roadmap directive proposal"));

		const partialResult = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --directive roadmp --plain`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(partialResult.exitCode, 0);
		const partialOutput = partialResult.stdout.toString();

		assert.ok(
			partialOutput.includes("proposal-5 - Roadmap directive proposal"),
		);
		assert.ok(!partialOutput.includes("proposal-1 - Directive proposal one"));
		assert.ok(!partialOutput.includes("proposal-2 - Directive proposal two"));
		assert.ok(!partialOutput.includes("proposal-3 - Other directive proposal"));
		assert.ok(!partialOutput.includes("proposal-4 - No directive proposal"));
		assert.ok(!partialOutput.includes("proposal-6 - ID directive proposal"));
	});

	it("matches directive title when proposals store directive IDs", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list -m new --plain`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);
		const output = result.stdout.toString();

		assert.ok(output.includes("proposal-6 - ID directive proposal"));
		assert.ok(!output.includes("proposal-1 - Directive proposal one"));
		assert.ok(!output.includes("proposal-2 - Directive proposal two"));
		assert.ok(!output.includes("proposal-3 - Other directive proposal"));
		assert.ok(!output.includes("proposal-4 - No directive proposal"));
		assert.ok(!output.includes("proposal-5 - Roadmap directive proposal"));
	});

	it("preserves existing listing behavior when directive filter is omitted", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal list --plain`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
		const output = result.stdout.toString();

		assert.ok(output.includes("proposal-1 - Directive proposal one"));
		assert.ok(output.includes("proposal-2 - Directive proposal two"));
		assert.ok(output.includes("proposal-3 - Other directive proposal"));
		assert.ok(output.includes("proposal-4 - No directive proposal"));
		assert.ok(output.includes("proposal-5 - Roadmap directive proposal"));
		assert.ok(output.includes("proposal-6 - ID directive proposal"));
	});
});
