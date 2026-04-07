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

describe("CLI --plain for proposal create/edit", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-plain-create-edit");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {}
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo first using shell API (same as other tests)
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize roadmap project using Core
		const core = new Core(TEST_DIR);
		await core.initializeProject("Plain Create/Edit Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {}
	});

	it("prints plain details after proposal create --plain", async () => {
		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal create "Example" --desc "Hello" --plain`,
			{ cwd: TEST_DIR },
		);

		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		const out = result.stdout.toString();
		assert.strictEqual(result.exitCode, 0);
		// Begins with File: line and contains key sections
		assert.ok(out.includes("File: "));
		assert.ok(out.includes("Proposal proposal-1 - Example"));
		assert.ok(out.includes("Status:"));
		assert.ok(out.includes("Created:"));
		assert.ok(out.includes("Description:"));
		assert.ok(out.includes("Hello"));
		assert.ok(out.includes("Acceptance Criteria:"));
		// Should not contain TUI escape codes
		assert.ok(!out.includes("[?1049h"));
		assert.ok(!out.includes("\x1b"));
	});

	it("prints plain details after proposal edit --plain", async () => {
		// Create base proposal first (without plain)
		execSync(
			`node --experimental-strip-types ${cliPath} proposal create "Edit Me" --desc "First"`,
			{ cwd: TEST_DIR },
		);

		const result = execSync(
			`node --experimental-strip-types ${cliPath} proposal edit 1 -s "Active" --plain`,
			{ cwd: TEST_DIR },
		);

		if (result.exitCode !== 0) {
			console.error("STDOUT:", result.stdout.toString());
			console.error("STDERR:", result.stderr.toString());
		}

		const out = result.stdout.toString();
		assert.strictEqual(result.exitCode, 0);
		// Begins with File: line and contains updated details
		assert.ok(out.includes("File: "));
		assert.ok(out.includes("Proposal proposal-1 - Edit Me"));
		assert.ok(out.includes("Status: ◒ Active"));
		assert.ok(out.includes("Created:"));
		assert.ok(out.includes("Updated:"));
		assert.ok(out.includes("Description:"));
		assert.ok(out.includes("Acceptance Criteria:"));
		// Should not contain TUI escape codes
		assert.ok(!out.includes("[?1049h"));
		assert.ok(!out.includes("\x1b"));
	});
});
