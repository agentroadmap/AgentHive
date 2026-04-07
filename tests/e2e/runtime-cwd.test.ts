import assert from "node:assert";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ROADMAP_CWD_ENV,
	resolveRuntimeCwd,
} from "../../src/utils/runtime-cwd.ts";
import { expect } from "../support/test-utils.ts";

describe("resolveRuntimeCwd", () => {
	let testDir: string;
	let originalCwd: string;
	let originalRoadmapCwd: string | undefined;

	beforeEach(async () => {
		testDir = await mkdtemp(join(tmpdir(), "roadmap-runtime-cwd-"));
		originalCwd = process.cwd();
		originalRoadmapCwd = process.env[ROADMAP_CWD_ENV];
		delete process.env[ROADMAP_CWD_ENV];
		process.chdir(testDir);
	});

	afterEach(async () => {
		process.chdir(originalCwd);
		if (originalRoadmapCwd === undefined) {
			delete process.env[ROADMAP_CWD_ENV];
		} else {
			process.env[ROADMAP_CWD_ENV] = originalRoadmapCwd;
		}
		await rm(testDir, { recursive: true, force: true });
	});

	async function expectCanonicalPath(
		actualPath: string,
		expectedPath: string,
	): Promise<void> {
		const [actualCanonical, expectedCanonical] = await Promise.all([
			realpath(actualPath),
			realpath(expectedPath),
		]);
		assert.strictEqual(actualCanonical, expectedCanonical);
	}

	it("uses process.cwd() when no override is provided", async () => {
		const result = await resolveRuntimeCwd();

		await expectCanonicalPath(result.cwd, testDir);
		assert.strictEqual(result.source, "process");
	});

	it("uses ROADMAP_CWD when environment override is provided", async () => {
		const nestedDir = join(testDir, "workspace", "project");
		await mkdir(nestedDir, { recursive: true });
		process.env[ROADMAP_CWD_ENV] = nestedDir;

		const result = await resolveRuntimeCwd();

		await expectCanonicalPath(result.cwd, nestedDir);
		assert.strictEqual(result.source, "env");
		assert.strictEqual(result.sourceLabel, ROADMAP_CWD_ENV);
	});

	it("gives --cwd option precedence over ROADMAP_CWD", async () => {
		const envDir = join(testDir, "env-dir");
		const optionDir = join(testDir, "option-dir");
		await mkdir(envDir, { recursive: true });
		await mkdir(optionDir, { recursive: true });
		process.env[ROADMAP_CWD_ENV] = envDir;

		const result = await resolveRuntimeCwd({ cwd: optionDir });

		await expectCanonicalPath(result.cwd, optionDir);
		assert.strictEqual(result.source, "option");
		assert.strictEqual(result.sourceLabel, "--cwd");
	});

	it("supports relative override paths", async () => {
		await mkdir(join(testDir, "relative", "path"), { recursive: true });

		const result = await resolveRuntimeCwd({ cwd: "./relative/path" });

		await expectCanonicalPath(result.cwd, join(testDir, "relative", "path"));
		assert.strictEqual(result.source, "option");
	});

	it("throws when override path is invalid", async () => {
		process.env[ROADMAP_CWD_ENV] = join(testDir, "missing");

		await expect(resolveRuntimeCwd()).rejects.toThrow(
			`Invalid directory from ${ROADMAP_CWD_ENV}`,
		);
	});
});
