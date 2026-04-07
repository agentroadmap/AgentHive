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

describe("Proposal References", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-references");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test References Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("Create proposal with references", () => {
		it("should create a proposal with references", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with refs",
				references: [
					"https://github.com/example/issue/123",
					"src/components/Button.tsx",
				],
			});

			assert.deepStrictEqual(proposal.references, [
				"https://github.com/example/issue/123",
				"src/components/Button.tsx",
			]);

			// Verify persistence
			const loaded = await core.loadProposalById(proposal.id);
			assert.deepStrictEqual(loaded?.references, [
				"https://github.com/example/issue/123",
				"src/components/Button.tsx",
			]);
		});

		it("should create a proposal without references", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal without refs",
			});

			assert.deepStrictEqual(proposal.references, []);
		});

		it("should handle empty references array", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with empty refs",
				references: [],
			});

			assert.deepStrictEqual(proposal.references, []);
		});
	});

	describe("Update proposal references", () => {
		it("should set references on existing proposal", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal to update",
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				references: ["https://docs.example.com/api", "README.md"],
			});

			assert.deepStrictEqual(updated.references, [
				"https://docs.example.com/api",
				"README.md",
			]);
		});

		it("should add references to existing proposal", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with initial refs",
				references: ["file1.ts"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				addReferences: ["file2.ts", "file3.ts"],
			});

			assert.deepStrictEqual(updated.references, [
				"file1.ts",
				"file2.ts",
				"file3.ts",
			]);
		});

		it("should not add duplicate references", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with refs",
				references: ["file1.ts", "file2.ts"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				addReferences: ["file2.ts", "file3.ts"],
			});

			assert.deepStrictEqual(updated.references, [
				"file1.ts",
				"file2.ts",
				"file3.ts",
			]);
		});

		it("should remove references from existing proposal", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with refs to remove",
				references: ["file1.ts", "file2.ts", "file3.ts"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				removeReferences: ["file2.ts"],
			});

			assert.deepStrictEqual(updated.references, ["file1.ts", "file3.ts"]);
		});

		it("should replace references when setting directly", async () => {
			const { proposal } = await core.createProposalFromInput({
				title: "Proposal with refs to replace",
				references: ["old1.ts", "old2.ts"],
			});

			const updated = await core.updateProposalFromInput(proposal.id, {
				references: ["new1.ts", "new2.ts"],
			});

			assert.deepStrictEqual(updated.references, ["new1.ts", "new2.ts"]);
		});
	});

	describe("References in markdown", () => {
		it("should persist references in markdown frontmatter", async () => {
			const { filePath } = await core.createProposalFromInput({
				title: "Proposal with markdown refs",
				references: ["https://example.com", "src/index.ts"],
			});

			assert.ok(filePath);

			// Read the file directly to check frontmatter
			const content = await await readFile(filePath as string, "utf-8");
			assert.ok(content.includes("references:"));
			assert.ok(content.includes("https://example.com"));
			assert.ok(content.includes("src/index.ts"));
		});

		it("should not include empty references in frontmatter", async () => {
			const { filePath } = await core.createProposalFromInput({
				title: "Proposal without refs",
			});

			const content = await await readFile(filePath as string, "utf-8");
			assert.ok(!content.includes("references:"));
		});
	});

	describe("Archive cleanup", () => {
		it("removes only exact-ID references from active proposals when archiving", async () => {
			const { proposal: archiveTarget } = await core.createProposalFromInput({
				title: "Archive target",
			});

			const { proposal: activeProposal } = await core.createProposalFromInput({
				title: "Active referencing proposal",
				references: [
					"proposal-1",
					"proposal-1",
					"https://example.com/proposals/proposal-1",
					"docs/proposal-1.md",
					"prefix-proposal-1-suffix",
					"1",
					"JIRA-1",
					"proposal-12",
				],
			});

			const { proposal: completedProposal } =
				await core.createProposalFromInput({
					title: "Completed referencing proposal",
					references: [
						"proposal-1",
						"https://example.com/proposals/proposal-1",
					],
				});
			await core.completeProposal(completedProposal.id, false);

			const archived = await core.archiveProposal(archiveTarget.id, false);
			assert.strictEqual(archived, true);

			const updatedActive = await core.loadProposalById(activeProposal.id);
			const completedProposals = await core.filesystem.listCompletedProposals();
			const updatedCompleted = completedProposals.find(
				(proposal) => proposal.id === completedProposal.id,
			);

			assert.deepStrictEqual(updatedActive?.references, [
				"https://example.com/proposals/proposal-1",
				"docs/proposal-1.md",
				"prefix-proposal-1-suffix",
				"1",
				"JIRA-1",
				"proposal-12",
			]);
			assert.deepStrictEqual(updatedCompleted?.references, [
				"proposal-1",
				"https://example.com/proposals/proposal-1",
			]);
		});
	});
});
