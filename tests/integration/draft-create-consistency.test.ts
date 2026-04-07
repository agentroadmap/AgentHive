import assert from "node:assert";
import { mkdir, readdir, rm } from "node:fs/promises";
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
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Draft creation consistency", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-draft-create-consistency");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email "test@example.com"`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Draft Consistency Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("keeps IDs and filenames consistent between draft create and proposal create --draft", async () => {
		const first = execSync(
			`node --experimental-strip-types ${CLI_PATH} draft create "Hallo"`,
			{ cwd: TEST_DIR },
		);
		const second = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create --draft "Goodbye"`,
			{ cwd: TEST_DIR },
		);

		expect(first.combined).toContain("Created draft draft-1");
		expect(second.combined).toContain("Created draft draft-2");
		expect(second.combined).toContain("draft-2 - Goodbye.md");
		expect(second.combined).not.toContain("draft-proposal-");

		const draftFiles = await readdir(join(TEST_DIR, "roadmap", "drafts"));
		assert.ok(draftFiles.includes("draft-1 - Hallo.md"));
		assert.ok(draftFiles.includes("draft-2 - Goodbye.md"));
		expect(draftFiles.some((file) => file.startsWith("draft-proposal-"))).toBe(
			false,
		);

		const core = new Core(TEST_DIR);
		const secondDraft = await core.filesystem.loadDraft("draft-2");
		assert.notStrictEqual(secondDraft, null);
		assert.strictEqual(secondDraft?.id, "draft-2");
	});

	it("uses DRAFT IDs in plain output for proposal create --draft", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create --draft "Plain sample" --plain`,
			{ cwd: TEST_DIR },
		);
		const output = result.stdout.toString();

		assert.ok(output.includes("draft-1 - Plain-sample.md"));
		assert.ok(output.includes("Proposal draft-1 - Plain sample"));
		assert.ok(!output.includes("Proposal proposal-1"));
	});
});
