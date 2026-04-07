import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/index.ts";
import {
	buildCliCommand,
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("CLI description newline handling", () => {
	const cliPath = join(process.cwd(), "src", "cli.ts");

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-desc-newlines");
		try {
			await rm(TEST_DIR, { recursive: true, force: true });
		} catch {}
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email "test@example.com"`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Desc Newlines Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {}
	});

	it("should preserve literal newlines when creating proposal", async () => {
		const desc = "First line\nSecond line\n\nThird paragraph";
		execSync(
			`node --experimental-strip-types ${buildCliCommand([cliPath, "proposal", "create", "Multi-line", "--desc", desc])}`,
			{ cwd: TEST_DIR },
		);

		const core = new Core(TEST_DIR);
		const body = await core.getProposalContent("proposal-1");
		assert.ok(body?.includes(desc));
	});

	it("should preserve literal newlines when editing proposal", async () => {
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Edit me",
				status: "Potential",
				assignee: [],
				createdDate: "2025-07-04",
				labels: [],
				dependencies: [],
				description: "Original",
			},
			false,
		);

		const desc = "First line\nSecond line\n\nThird paragraph";
		execSync(
			`node --experimental-strip-types ${buildCliCommand([cliPath, "proposal", "edit", "1", "--desc", desc])}`,
			{ cwd: TEST_DIR },
		);

		const updatedBody = await core.getProposalContent("proposal-1");
		assert.ok(updatedBody?.includes(desc));
	});

	it("should not interpret \\n sequences as newlines", async () => {
		const literal = "First line\\nSecond line";
		execSync(
			`node --experimental-strip-types ${buildCliCommand([cliPath, "proposal", "create", "Literal", "--desc", literal])}`,
			{ cwd: TEST_DIR },
		);

		const core = new Core(TEST_DIR);
		const body = await core.getProposalContent("proposal-1");
		assert.ok(body?.includes("First line\\nSecond line"));
	});
});
