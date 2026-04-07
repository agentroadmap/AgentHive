import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Decision, Document, Proposal } from "../../src/types";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;

describe("CLI ID Incrementing Behavior", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-incrementing-ids");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		core = new Core(TEST_DIR);
		// Initialize git repository first to avoid interactive prompts and ensure consistency
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		await core.initializeProject("ID Incrementing Test");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should increment proposal IDs correctly", async () => {
		const proposal1: Proposal = {
			id: "proposal-1",
			title: "First Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-01-01",
			labels: [],
			dependencies: [],
			description: "A test proposal.",
		};
		await core.createProposal(proposal1);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create "Second Proposal"`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
		expect(result.stdout.toString()).toContain("Created proposal proposal-2");

		const proposal2 = await core.filesystem.loadProposal("proposal-2");
		assert.notStrictEqual(proposal2, undefined);
		assert.strictEqual(proposal2?.title, "Second Proposal");
	});

	test("should increment document IDs correctly", async () => {
		const doc1: Document = {
			id: "doc-1",
			title: "First Doc",
			type: "other",
			createdDate: "",
			rawContent: "",
		};
		await core.createDocument(doc1);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} doc create "Second Doc"`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
		expect(result.stdout.toString()).toContain("Created document doc-2");

		const docs = await core.filesystem.listDocuments();
		const doc2 = docs.find((d) => d.id === "doc-2");
		assert.notStrictEqual(doc2, undefined);
		assert.strictEqual(doc2?.title, "Second Doc");
	});

	test("should increment decision IDs correctly", async () => {
		const decision1: Decision = {
			id: "decision-1",
			title: "First Decision",
			date: "",
			status: "proposed",
			context: "",
			decision: "",
			consequences: "",
			rawContent: "",
		};
		await core.createDecision(decision1);

		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} decision create "Second Decision"`,
			{ cwd: TEST_DIR },
		);

		assert.strictEqual(result.exitCode, 0);
		expect(result.stdout.toString()).toContain("Created decision decision-2");

		const decision2 = await core.filesystem.loadDecision("decision-2");
		assert.notStrictEqual(decision2, null);
		assert.strictEqual(decision2?.title, "Second Decision");
	});
});
