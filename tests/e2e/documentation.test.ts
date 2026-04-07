import assert from "node:assert";
import { mkdir, readFile, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Proposal Documentation", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-documentation");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test Documentation Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("Create proposal with documentation", () => {
		it("should create a proposal with documentation", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with docs",
				documentation: ["https://docs.example.com/api", "docs/architecture.md"],
			});

			assert.deepStrictEqual(proposal.documentation, [
				"https://docs.example.com/api",
				"docs/architecture.md",
			]);

			// Verify persistence
			const loaded = await core.loadProposalById(proposal.id);
			assert.deepStrictEqual(loaded?.documentation, [
				"https://docs.example.com/api",
				"docs/architecture.md",
			]);
		});

		it("should create a proposal without documentation", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal without docs",
			});

			assert.deepStrictEqual(proposal.documentation, []);
		});

		it("should handle empty documentation array", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with empty docs",
				documentation: [],
			});

			assert.deepStrictEqual(proposal.documentation, []);
		});
	});

	describe("Update proposal documentation", () => {
		it("should set documentation on existing proposal", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal to update",
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				documentation: ["https://design-docs.example.com", "README.md"],
			});

			assert.deepStrictEqual(updated.documentation, [
				"https://design-docs.example.com",
				"README.md",
			]);
		});

		it("should add documentation to existing proposal", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with initial docs",
				documentation: ["doc1.md"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				addDocumentation: ["doc2.md", "doc3.md"],
			});

			assert.deepStrictEqual(updated.documentation, [
				"doc1.md",
				"doc2.md",
				"doc3.md",
			]);
		});

		it("should not add duplicate documentation", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with docs",
				documentation: ["doc1.md", "doc2.md"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				addDocumentation: ["doc2.md", "doc3.md"],
			});

			assert.deepStrictEqual(updated.documentation, [
				"doc1.md",
				"doc2.md",
				"doc3.md",
			]);
		});

		it("should remove documentation from existing proposal", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with docs to remove",
				documentation: ["doc1.md", "doc2.md", "doc3.md"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				removeDocumentation: ["doc2.md"],
			});

			assert.deepStrictEqual(updated.documentation, ["doc1.md", "doc3.md"]);
		});

		it("should replace documentation when setting directly", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with docs to replace",
				documentation: ["old1.md", "old2.md"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				documentation: ["new1.md", "new2.md"],
			});

			assert.deepStrictEqual(updated.documentation, ["new1.md", "new2.md"]);
		});
	});

	describe("Documentation in markdown", () => {
		it("should persist documentation in markdown frontmatter", async () => {
			const { filePath } = await core.createProposalFromInput({
				title: "Proposal with markdown docs",
				documentation: ["https://example.com/docs", "src/index.ts"],
			});

			assert.ok(filePath);

			// Read the file directly to check frontmatter
			const content = await await readFile(filePath as string, "utf-8");
			assert.ok(content.includes("documentation:"));
			assert.ok(content.includes("https://example.com/docs"));
			assert.ok(content.includes("src/index.ts"));
		});

		it("should not include empty documentation in frontmatter", async () => {
			const { filePath } = await core.createProposalFromInput({
				title: "Proposal without docs",
			});

			const content = await await readFile(filePath as string, "utf-8");
			assert.ok(!content.includes("documentation:"));
		});
	});
});
