import assert from "node:assert";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { execSync } from "../support/test-utils.ts";

const CLI_PATH = join(process.cwd(), "src", "cli.ts");

let TEST_DIR: string;

describe("init Claude agent default", () => {
	beforeEach(async () => {
		TEST_DIR = join(
			process.cwd(),
			`.tmp-test-init-claude-${Math.random().toString(36).slice(2)}`,
		);
		await rm(TEST_DIR, { recursive: true, force: true });
		await mkdir(TEST_DIR, { recursive: true });
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	it("does not install Claude agent by default in non-interactive mode", async () => {
		// Use defaults, do not pass --install-claude-agent
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} init MyProj --defaults`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		// Verify that agent file was not created
		const agentExists = stat(
			join(TEST_DIR, ".claude", "agents", "project-manager-roadmap.md"),
		)
			.then(() => true)
			.catch(() => false);
		assert.strictEqual(agentExists, false);
	});

	it("installs Claude agent when flag is true", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} init MyProj --defaults --install-claude-agent true`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(result.exitCode, 0);

		const agentExists = stat(
			join(TEST_DIR, ".claude", "agents", "project-manager-roadmap.md"),
		)
			.then(() => true)
			.catch(() => false);
		assert.strictEqual(agentExists, true);
	});
});
