import assert from "node:assert";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	migrateDraftPrefixes,
	needsDraftPrefixMigration,
} from "../../src/core/infrastructure/prefix-migration.ts";
import { FileSystem } from "../../src/file-system/operations.ts";
import { serializeProposal } from "../../src/markdown/serializer.ts";
import type { Proposal, RoadmapConfig } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Draft Prefix Migration", () => {
	let filesystem: FileSystem;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-prefix-migration");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureRoadmapStructure();
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("needsDraftPrefixMigration", () => {
		it("should return false when config is null", () => {
			expect(needsDraftPrefixMigration(null)).toBe(false);
		});

		it("should return true when prefixes section is missing", () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
			};
			expect(needsDraftPrefixMigration(config)).toBe(true);
		});

		it("should return false when prefixes section exists", () => {
			const config: RoadmapConfig = {
				projectName: "Test",
				statuses: ["Potential", "Complete"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
				prefixes: {
					proposal: "proposal",
				},
			};
			expect(needsDraftPrefixMigration(config)).toBe(false);
		});
	});

	describe("migrateDraftPrefixes", () => {
		it("should add prefixes section to config when drafts folder is empty", async () => {
			// Create initial config without prefixes
			const initialConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
			};
			await filesystem.saveConfig(initialConfig);

			// Run migration
			await migrateDraftPrefixes(filesystem);

			// Verify config has prefixes section
			const config = await filesystem.loadConfig();
			assert.notStrictEqual(config?.prefixes, undefined);
			assert.strictEqual(config?.prefixes?.proposal, "proposal");
		});

		it("should rename proposal-*.md files in drafts folder to draft-*.md", async () => {
			// Create initial config without prefixes
			const initialConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
			};
			await filesystem.saveConfig(initialConfig);

			// Create proposal-*.md file in drafts folder (old format)
			const draftsDir = await filesystem.getDraftsDir();
			const oldProposal: Proposal = {
				id: "proposal-1",
				title: "Old Draft",
				status: "Draft",
				assignee: [],
				createdDate: "2025-01-01",
				labels: [],
				dependencies: [],
				description: "This is an old draft with proposal- prefix",
			};
			const content = serializeProposal(oldProposal);
			await writeFile(join(draftsDir, "proposal-1 - Old Draft.md"), content);

			// Run migration
			await migrateDraftPrefixes(filesystem);

			// Verify old file is gone
			const files = await readdir(draftsDir);
			expect(files.some((f) => f.startsWith("proposal-1"))).toBe(false);

			// Verify new draft file exists
			expect(files.some((f) => f.startsWith("draft-1"))).toBe(true);

			// Verify draft can be loaded with draft- ID
			const migratedDraft = await filesystem.loadDraft("draft-1");
			assert.strictEqual(migratedDraft?.title, "Old Draft");
			assert.strictEqual(migratedDraft?.id, "draft-1"); // IDs normalized to uppercase
		});

		it("should update IDs inside migrated files", async () => {
			// Create initial config without prefixes
			const initialConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
			};
			await filesystem.saveConfig(initialConfig);

			// Create proposal-*.md file in drafts folder
			const draftsDir = await filesystem.getDraftsDir();
			const oldProposal: Proposal = {
				id: "proposal-5",
				title: "Draft with Proposal ID",
				status: "Draft",
				assignee: ["@developer"],
				createdDate: "2025-01-01",
				labels: ["feature"],
				dependencies: [],
				description: "Test draft",
			};
			const content = serializeProposal(oldProposal);
			await writeFile(
				join(draftsDir, "proposal-5 - Draft with Proposal ID.md"),
				content,
			);

			// Run migration
			await migrateDraftPrefixes(filesystem);

			// Verify ID was updated
			const migratedDraft = await filesystem.loadDraft("draft-1");
			assert.strictEqual(migratedDraft?.id, "draft-1"); // IDs normalized to uppercase
			assert.deepStrictEqual(migratedDraft?.assignee, ["@developer"]);
			assert.deepStrictEqual(migratedDraft?.labels, ["feature"]);
		});

		it("should handle multiple proposal-*.md files", async () => {
			// Create initial config without prefixes
			const initialConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
			};
			await filesystem.saveConfig(initialConfig);

			// Create multiple proposal-*.md files
			const draftsDir = await filesystem.getDraftsDir();
			const proposals = [
				{ id: "proposal-1", title: "First Draft" },
				{ id: "proposal-2", title: "Second Draft" },
				{ id: "proposal-3", title: "Third Draft" },
			];

			for (const t of proposals) {
				const proposal: Proposal = {
					...t,
					status: "Draft",
					assignee: [],
					createdDate: "2025-01-01",
					labels: [],
					dependencies: [],
				};
				const content = serializeProposal(proposal);
				await writeFile(join(draftsDir, `${t.id} - ${t.title}.md`), content);
			}

			// Run migration
			await migrateDraftPrefixes(filesystem);

			// Verify all files were migrated
			const files = await readdir(draftsDir);
			expect(files.filter((f) => f.startsWith("proposal-")).length).toBe(0);
			expect(files.filter((f) => f.startsWith("draft-")).length).toBe(3);

			// Verify drafts can be loaded
			const drafts = await filesystem.listDrafts();
			assert.strictEqual(drafts.length, 3);
		});

		it("should be idempotent - running twice has same result", async () => {
			// Create initial config without prefixes
			const initialConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
			};
			await filesystem.saveConfig(initialConfig);

			// Create proposal-*.md file
			const draftsDir = await filesystem.getDraftsDir();
			const oldProposal: Proposal = {
				id: "proposal-1",
				title: "Draft",
				status: "Draft",
				assignee: [],
				createdDate: "2025-01-01",
				labels: [],
				dependencies: [],
			};
			const content = serializeProposal(oldProposal);
			await writeFile(join(draftsDir, "proposal-1 - Draft.md"), content);

			// Run migration first time
			await migrateDraftPrefixes(filesystem);

			// Get proposal after first migration
			const filesAfterFirst = await readdir(draftsDir);
			const configAfterFirst = await filesystem.loadConfig();

			// Run migration second time
			await migrateDraftPrefixes(filesystem);

			// Verify proposal is the same
			const filesAfterSecond = await readdir(draftsDir);
			const configAfterSecond = await filesystem.loadConfig();

			assert.deepStrictEqual(filesAfterSecond, filesAfterFirst);
			assert.deepStrictEqual(
				configAfterSecond?.prefixes,
				configAfterFirst?.prefixes,
			);
		});

		it("should not affect existing draft-*.md files", async () => {
			// Create initial config without prefixes
			const initialConfig: RoadmapConfig = {
				projectName: "Test Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "YYYY-MM-DD",
			};
			await filesystem.saveConfig(initialConfig);

			// Create an existing draft-*.md file (correct format)
			const existingDraft: Proposal = {
				id: "draft-1",
				title: "Existing Draft",
				status: "Draft",
				assignee: [],
				createdDate: "2025-01-01",
				labels: [],
				dependencies: [],
			};
			await filesystem.saveDraft(existingDraft);

			// Create a proposal-*.md file (old format)
			const draftsDir = await filesystem.getDraftsDir();
			const oldProposal: Proposal = {
				id: "proposal-5",
				title: "Old Format Draft",
				status: "Draft",
				assignee: [],
				createdDate: "2025-01-01",
				labels: [],
				dependencies: [],
			};
			const content = serializeProposal(oldProposal);
			await writeFile(
				join(draftsDir, "proposal-5 - Old Format Draft.md"),
				content,
			);

			// Run migration
			await migrateDraftPrefixes(filesystem);

			// Verify existing draft is unchanged
			const existingLoaded = await filesystem.loadDraft("draft-1");
			assert.strictEqual(existingLoaded?.title, "Existing Draft");

			// Verify new draft was created with next available ID
			const drafts = await filesystem.listDrafts();
			assert.strictEqual(drafts.length, 2);
			expect(drafts.map((d) => d.id).sort()).toEqual(["draft-1", "draft-2"]);
		});
	});
});
