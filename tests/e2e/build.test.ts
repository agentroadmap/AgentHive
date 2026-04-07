import assert from "node:assert";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("CLI packaging", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-build");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should build and run the local executable wrapper", async () => {
		const OUTFILE = join(
			TEST_DIR,
			process.platform === "win32" ? "roadmap.cmd" : "roadmap",
		);

		const packageJson = await JSON.parse(
			await readFile("package.json", "utf-8"),
		);
		const version = packageJson.version;
		const revision = execSync("git rev-parse --short HEAD").text().trim();

		execSync(`node scripts/build-dist.cjs --outfile "${OUTFILE}"`);
		const runBuilt = (args: string) => execSync(`"${OUTFILE}" ${args}`);

		const builtFile = await stat(OUTFILE);
		assert.ok(builtFile.size > 0);
		if (process.platform !== "win32") {
			assert.ok((builtFile.mode & 0o111) !== 0);
		}

		const helpResult = runBuilt("--help");
		const helpOutput = helpResult.stdout.toString();
		assert.ok(helpOutput.includes("Roadmap.md - Project management CLI"));

		const versionResult = runBuilt("--version");
		const versionOutput = versionResult.stdout.toString().trim();
		assert.strictEqual(versionOutput, `v${version} • rev ${revision}`);

		const splashResult = runBuilt("--plain");
		const splashOutput = splashResult.stdout.toString();
		assert.ok(splashOutput.includes(`rev ${revision}`));
	});
});
