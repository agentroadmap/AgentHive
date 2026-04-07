import assert from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import { execSync } from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("CLI Splash (bare run)", () => {
	beforeEach(async () => {
		TEST_DIR = await mkdtemp(join(tmpdir(), "roadmap-splash-"));
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
	});

	it("prints minimal splash in non-initialized repo (non-TTY)", async () => {
		const result = execSync(`node --experimental-strip-types ${CLI_PATH}`, {
			cwd: TEST_DIR,
		});
		const out = result.stdout.toString();
		assert.strictEqual(result.exitCode, 0);
		assert.ok(out.includes("Roadmap.md v"));
		assert.ok(out.includes("Docs: https://roadmap.md"));
		assert.ok(out.includes("roadmap init"));
	});

	it("prints quickstart (initialized repo)", async () => {
		// Initialize Git + project via Core
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name Test`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		const core = new Core(TEST_DIR);
		await core.initializeProject("Splash Test");

		const result = execSync(`node --experimental-strip-types ${CLI_PATH}`, {
			cwd: TEST_DIR,
		});
		const out = result.stdout.toString();
		assert.strictEqual(result.exitCode, 0);
		assert.ok(out.includes("Quickstart"));
		assert.ok(out.includes("roadmap proposal create"));
		assert.ok(out.includes("roadmap board"));
		assert.ok(!out.includes("roadmap init"));
	});

	it("--help shows commander help, not splash", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} --help`,
			{ cwd: TEST_DIR },
		);
		const out = result.stdout.toString();
		assert.strictEqual(result.exitCode, 0);
		assert.ok(/Usage: .*roadmap/.test(out));
	});

	it("--plain forces minimal splash", async () => {
		const result = execSync(
			`node --experimental-strip-types ${CLI_PATH} --plain`,
			{ cwd: TEST_DIR },
		);
		const out = result.stdout.toString();
		assert.strictEqual(result.exitCode, 0);
		assert.ok(out.includes("Roadmap.md v"));
		assert.ok(out.includes("Docs: https://roadmap.md"));
	});
});
