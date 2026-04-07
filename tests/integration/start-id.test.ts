import assert from "node:assert";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
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

describe("proposal id generation", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-start-id");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
		await initGitRepo(TEST_DIR);
		const core = new Core(TEST_DIR);
		await core.initializeProject("ID Test");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("starts numbering proposals at 1", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal create First`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const files = await readdir(join(TEST_DIR, "roadmap", "proposals"));
		const first = files.find((f) => f.startsWith("proposal-1 -"));
		assert.notStrictEqual(first, undefined);
	});
});
