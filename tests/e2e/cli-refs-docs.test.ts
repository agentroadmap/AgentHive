import assert from "node:assert";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("CLI --ref and --doc flags", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-cli-refs-docs");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {}
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("CLI Refs Docs Test");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {}
	});

	describe("proposal create with --ref flag", () => {
		it("creates proposal with single reference", async () => {
			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --ref https://github.com/issue/123 --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("References: https://github.com/issue/123"));
		});

		it("creates proposal with multiple references", async () => {
			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --ref https://github.com/issue/123 --ref src/api.ts --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(
				out.includes("References: https://github.com/issue/123, src/api.ts"),
			);
		});

		it("creates proposal with comma-separated references", async () => {
			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --ref "file1.ts,file2.ts" --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("References: file1.ts, file2.ts"));
		});
	});

	describe("proposal create with --doc flag", () => {
		it("creates proposal with single documentation", async () => {
			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --doc https://design-docs.example.com --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("Documentation: https://design-docs.example.com"));
		});

		it("creates proposal with multiple documentation entries", async () => {
			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --doc https://design-docs.example.com --doc docs/spec.md --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(
				out.includes(
					"Documentation: https://design-docs.example.com, docs/spec.md",
				),
			);
		});

		it("creates proposal with comma-separated documentation", async () => {
			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --doc "doc1.md,doc2.md" --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("Documentation: doc1.md, doc2.md"));
		});
	});

	describe("proposal create with both --ref and --doc flags", () => {
		it("creates proposal with both references and documentation", async () => {
			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --ref src/api.ts --doc https://design-docs.example.com --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("References: src/api.ts"));
			assert.ok(out.includes("Documentation: https://design-docs.example.com"));
		});
	});

	describe("proposal edit with --ref flag", () => {
		it("sets references on existing proposal", async () => {
			execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature"`,
				{ cwd: TEST_DIR },
			);

			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal edit 1 --ref https://github.com/issue/456 --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("References: https://github.com/issue/456"));
		});

		it("sets multiple references on existing proposal", async () => {
			execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature"`,
				{ cwd: TEST_DIR },
			);

			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal edit 1 --ref file1.ts --ref file2.ts --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("References: file1.ts, file2.ts"));
		});
	});

	describe("proposal edit with --doc flag", () => {
		it("sets documentation on existing proposal", async () => {
			execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature"`,
				{ cwd: TEST_DIR },
			);

			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal edit 1 --doc https://api-docs.example.com --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("Documentation: https://api-docs.example.com"));
		});

		it("sets multiple documentation entries on existing proposal", async () => {
			execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature"`,
				{ cwd: TEST_DIR },
			);

			const result = execSync(
				`node --experimental-strip-types ${cliPath} proposal edit 1 --doc doc1.md --doc doc2.md --plain`,
				{ cwd: TEST_DIR },
			);

			assert.strictEqual(result.exitCode, 0);
			const out = result.stdout.toString();
			assert.ok(out.includes("Documentation: doc1.md, doc2.md"));
		});
	});

	describe("persistence in markdown files", () => {
		it("persists references in proposal markdown file", async () => {
			execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --ref https://example.com --ref src/index.ts`,
				{ cwd: TEST_DIR },
			);

			const proposalFile = await await readFile(
				join(TEST_DIR, "roadmap/proposals/proposal-1 - Feature.md"),
				"utf-8",
			);
			assert.ok(proposalFile.includes("references:"));
			assert.ok(proposalFile.includes("https://example.com"));
			assert.ok(proposalFile.includes("src/index.ts"));
		});

		it("persists documentation in proposal markdown file", async () => {
			execSync(
				`node --experimental-strip-types ${cliPath} proposal create "Feature" --doc https://docs.example.com --doc spec.md`,
				{ cwd: TEST_DIR },
			);

			const proposalFile = await await readFile(
				join(TEST_DIR, "roadmap/proposals/proposal-1 - Feature.md"),
				"utf-8",
			);
			assert.ok(proposalFile.includes("documentation:"));
			assert.ok(proposalFile.includes("https://docs.example.com"));
			assert.ok(proposalFile.includes("spec.md"));
		});
	});
});
