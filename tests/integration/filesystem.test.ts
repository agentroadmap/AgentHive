import assert from "node:assert";
import { globSync } from "node:fs";
import { mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileSystem } from "../../src/file-system/operations.ts";
import { serializeProposal } from "../../src/markdown/serializer.ts";
import type {
	Decision,
	Document,
	Proposal,
	RoadmapConfig,
} from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("FileSystem", () => {
	let filesystem: FileSystem;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-roadmap");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureRoadmapStructure();
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("ensureRoadmapStructure", () => {
		it("should create all required directories", async () => {
			const expectedDirs = [
				join(TEST_DIR, "roadmap"),
				join(TEST_DIR, "roadmap", "proposals"),
				join(TEST_DIR, "roadmap", "drafts"),
				join(TEST_DIR, "roadmap", "archive", "proposals"),
				join(TEST_DIR, "roadmap", "archive", "drafts"),
				join(TEST_DIR, "docs"),
				join(TEST_DIR, "roadmap", "decisions"),
			];

			for (const dir of expectedDirs) {
				const stats = await stat(dir);
				expect(stats.isDirectory()).toBe(true);
			}
		});
	});

	describe("proposal operations", () => {
		const sampleProposal: Proposal = {
			id: "proposal-1",
			title: "Test Proposal",
			status: "Potential",
			assignee: ["@developer"],
			reporter: "@manager",
			createdDate: "2025-06-03",
			labels: ["test"],
			directive: "v1.0",
			dependencies: [],
			description: "This is a test proposal",
		};

		it("should save and load a proposal", async () => {
			await filesystem.saveProposal(sampleProposal);

			const loadedProposal = await filesystem.loadProposal("proposal-1");
			assert.strictEqual(loadedProposal?.id, "proposal-1"); // IDs are normalized to uppercase
			assert.strictEqual(loadedProposal?.title, sampleProposal.title);
			assert.strictEqual(loadedProposal?.status, sampleProposal.status);
			assert.strictEqual(
				loadedProposal?.description,
				sampleProposal.description,
			);
		});

		it("should return null for non-existent proposal", async () => {
			const proposal = await filesystem.loadProposal("non-existent");
			assert.strictEqual(proposal, null);
		});

		it("should list all proposals", async () => {
			await filesystem.saveProposal(sampleProposal);
			await filesystem.saveProposal({
				...sampleProposal,
				id: "proposal-2",
				title: "Second Proposal",
			});

			const proposals = await filesystem.listProposals();
			assert.strictEqual(proposals.length, 2);
			expect(proposals.map((t) => t.id)).toEqual(["proposal-1", "proposal-2"]); // IDs are normalized to uppercase
		});

		it("should list proposals even when one file has invalid frontmatter", async () => {
			await filesystem.saveProposal(sampleProposal);
			await filesystem.saveProposal({
				...sampleProposal,
				id: "proposal-2",
				title: "Second Proposal",
			});

			const invalidPath = join(
				filesystem.proposalsDir,
				"proposal-99 - invalid.md",
			);
			await writeFile(
				invalidPath,
				`---
id: proposal-99
assignee: [@broken
status: Potential
title: Broken Proposal
---

Invalid content`,
			);

			const proposals = await filesystem.listProposals();
			expect(proposals.map((t) => t.id)).toEqual(["proposal-1", "proposal-2"]); // IDs normalized to uppercase
		});

		it("should include RFC-style proposal files and ignore non-proposal markdown", async () => {
			await filesystem.saveProposal(sampleProposal);

			await writeFile(
				join(filesystem.proposalsDir, "RFC-20260401-MESSAGING.md"),
				`---
id: RFC-20260401-MESSAGING
title: Messaging
status: Draft
assignee: []
created_date: 2026-04-01 20:21
labels: []
dependencies: []
---

## Description

RFC backlog item`,
			);

			await writeFile(
				join(filesystem.proposalsDir, "CHILD-RFCS-CREATED.md"),
				"# Child RFCs Created\n\nThis is a generated note, not a proposal.",
			);

			const proposals = await filesystem.listProposals();
			expect(proposals.map((t) => t.id)).toEqual([
				"proposal-1",
				"rfc-20260401-messaging",
			]);
		});

		it("should sort proposals numerically by ID", async () => {
			// Create proposals with IDs that would sort incorrectly with string comparison
			const proposalIds = [
				"proposal-2",
				"proposal-10",
				"proposal-1",
				"proposal-20",
				"proposal-3",
			];
			for (const id of proposalIds) {
				await filesystem.saveProposal({
					...sampleProposal,
					id,
					title: `Proposal ${id}`,
				});
			}

			const proposals = await filesystem.listProposals();
			expect(proposals.map((t) => t.id)).toEqual([
				"proposal-1",
				"proposal-2",
				"proposal-3",
				"proposal-10",
				"proposal-20",
			]); // IDs normalized to uppercase
		});

		it("should sort proposals with decimal IDs correctly", async () => {
			// Create proposals with decimal IDs
			const proposalIds = [
				"proposal-2.10",
				"proposal-2.2",
				"proposal-2",
				"proposal-1",
				"proposal-2.1",
			];
			for (const id of proposalIds) {
				await filesystem.saveProposal({
					...sampleProposal,
					id,
					title: `Proposal ${id}`,
				});
			}

			const proposals = await filesystem.listProposals();
			expect(proposals.map((t) => t.id)).toEqual([
				"proposal-1",
				"proposal-2",
				"proposal-2.1",
				"proposal-2.2",
				"proposal-2.10",
			]); // IDs normalized to uppercase
		});

		it("should filter proposals by status and assignee", async () => {
			await filesystem.saveProposal({
				...sampleProposal,
				id: "proposal-1",
				status: "Potential",
				assignee: ["alice"],
				title: "Proposal 1",
			});
			await filesystem.saveProposal({
				...sampleProposal,
				id: "proposal-2",
				status: "Complete",
				assignee: ["bob"],
				title: "Proposal 2",
			});
			await filesystem.saveProposal({
				...sampleProposal,
				id: "proposal-3",
				status: "Potential",
				assignee: ["bob"],
				title: "Proposal 3",
			});

			const statusFiltered = await filesystem.listProposals({
				status: "potential",
			});
			expect(statusFiltered.map((t) => t.id)).toEqual([
				"proposal-1",
				"proposal-3",
			]); // IDs normalized to uppercase

			const assigneeFiltered = await filesystem.listProposals({
				assignee: "bob",
			});
			expect(assigneeFiltered.map((t) => t.id)).toEqual([
				"proposal-2",
				"proposal-3",
			]); // IDs normalized to uppercase

			const combinedFiltered = await filesystem.listProposals({
				status: "potential",
				assignee: "bob",
			});
			expect(combinedFiltered.map((t) => t.id)).toEqual(["proposal-3"]); // IDs normalized to uppercase
		});

		it("should archive a proposal", async () => {
			await filesystem.saveProposal(sampleProposal);

			const archived = await filesystem.archiveProposal("proposal-1");
			assert.strictEqual(archived, true);

			const proposal = await filesystem.loadProposal("proposal-1");
			assert.strictEqual(proposal, null);

			// Check that file exists in archive
			const archiveFiles = await readdir(
				join(TEST_DIR, "roadmap", "archive", "proposals"),
			);
			expect(archiveFiles.some((f) => f.startsWith("proposal-1"))).toBe(true);
		});

		it("should archive RFC-style proposals without title suffix filenames", async () => {
			await writeFile(
				join(filesystem.proposalsDir, "RFC-20260401-MESSAGING.md"),
				`---
id: RFC-20260401-MESSAGING
title: Messaging
status: Draft
assignee: []
created_date: 2026-04-01 20:21
labels: []
dependencies: []
---

## Description

RFC backlog item`,
			);

			const archived = await filesystem.archiveProposal(
				"RFC-20260401-MESSAGING",
			);
			assert.strictEqual(archived, true);

			const archiveFiles = await readdir(
				join(TEST_DIR, "roadmap", "archive", "proposals"),
			);
			expect(archiveFiles.includes("RFC-20260401-MESSAGING.md")).toBe(true);
		});

		it("should demote a proposal to drafts with new draft- ID", async () => {
			await filesystem.saveProposal(sampleProposal);

			const demoted = await filesystem.demoteProposal("proposal-1");
			assert.strictEqual(demoted, true);

			// Proposal should be removed from proposals directory
			const proposalsFiles = await readdir(
				join(TEST_DIR, "roadmap", "proposals"),
			);
			expect(proposalsFiles.some((f) => f.startsWith("proposal-1"))).toBe(
				false,
			);

			// Draft should exist with new draft- ID
			const draftsFiles = await readdir(join(TEST_DIR, "roadmap", "drafts"));
			expect(draftsFiles.some((f) => f.startsWith("draft-1"))).toBe(true);

			// Verify the demoted draft can be loaded and has correct ID
			const demotedDraft = await filesystem.loadDraft("draft-1");
			assert.strictEqual(demotedDraft?.id, "draft-1");
			assert.strictEqual(demotedDraft?.title, sampleProposal.title);
		});
	});

	describe("draft operations", () => {
		// Drafts now use draft-X id format and draft-x filename prefix
		const sampleDraft: Proposal = {
			id: "draft-1",
			title: "Draft Proposal",
			status: "Draft",
			assignee: [],
			createdDate: "2025-06-07",
			labels: [],
			dependencies: [],
			description: "Draft description",
		};

		it("should save and load a draft", async () => {
			await filesystem.saveDraft(sampleDraft);

			const loaded = await filesystem.loadDraft("draft-1");
			assert.strictEqual(loaded?.id, "draft-1"); // IDs are normalized to uppercase
			assert.strictEqual(loaded?.title, sampleDraft.title);
		});

		it("should list all drafts", async () => {
			await filesystem.saveDraft(sampleDraft);
			await filesystem.saveDraft({
				...sampleDraft,
				id: "draft-2",
				title: "Second",
			});

			const drafts = await filesystem.listDrafts();
			expect(drafts.map((d) => d.id).sort()).toEqual(["draft-1", "draft-2"]);
		});

		it("should promote a draft to proposals with new proposal- ID", async () => {
			await filesystem.saveDraft(sampleDraft);

			const promoted = await filesystem.promoteDraft("draft-1");
			assert.strictEqual(promoted, true);

			// Draft should be removed from drafts directory
			const draftsFiles = await readdir(join(TEST_DIR, "roadmap", "drafts"));
			expect(draftsFiles.some((f) => f.startsWith("draft-1"))).toBe(false);

			// Proposal should exist with new proposal- ID
			const proposalsFiles = await readdir(
				join(TEST_DIR, "roadmap", "proposals"),
			);
			expect(proposalsFiles.some((f) => f.startsWith("proposal-1"))).toBe(true);

			// Verify the promoted proposal can be loaded and has correct ID
			const promotedProposal = await filesystem.loadProposal("proposal-1");
			assert.strictEqual(promotedProposal?.id, "proposal-1");
			assert.strictEqual(promotedProposal?.title, sampleDraft.title);
		});

		it("should promote draft with custom proposal prefix", async () => {
			// Configure custom proposal prefix
			const customConfig: RoadmapConfig = {
				projectName: "Custom Prefix Project",
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: [],
				directives: [],
				dateFormat: "yyyy-MM-dd",
				prefixes: {
					proposal: "JIRA",
				},
			};
			await filesystem.saveConfig(customConfig);
			await filesystem.saveDraft(sampleDraft);

			const promoted = await filesystem.promoteDraft("draft-1");
			assert.strictEqual(promoted, true);

			// Draft should be removed
			const draftsFiles = await readdir(join(TEST_DIR, "roadmap", "drafts"));
			expect(draftsFiles.some((f) => f.startsWith("draft-1"))).toBe(false);

			// Proposal should exist with custom JIRA- prefix
			const proposalsFiles = await readdir(
				join(TEST_DIR, "roadmap", "proposals"),
			);
			expect(proposalsFiles.some((f) => f.startsWith("jira-1"))).toBe(true);

			// Verify the promoted proposal can be loaded with the custom prefix
			const promotedProposal = await filesystem.loadProposal("jira-1");
			assert.strictEqual(promotedProposal?.id, "JIRA-1");
			assert.strictEqual(promotedProposal?.title, sampleDraft.title);
		});

		it("should not reuse completed proposal IDs when promoting draft", async () => {
			// Create a completed proposal directly in the completed directory
			// This simulates a proposal that was created and completed before the draft
			const completedDir = join(TEST_DIR, "roadmap", "completed");
			await mkdir(completedDir, { recursive: true });

			const completedProposal: Proposal = {
				id: "proposal-1",
				title: "Completed Proposal",
				status: "Complete",
				assignee: [],
				createdDate: "2025-01-01",
				labels: [],
				dependencies: [],
			};
			const content = serializeProposal(completedProposal);
			await writeFile(
				join(completedDir, "proposal-1 - Completed Proposal.md"),
				content,
			);

			// Verify no active proposals exist
			const activeProposals = await filesystem.listProposals();
			assert.strictEqual(activeProposals.length, 0);

			// Verify completed proposal exists
			const completedProposals = await filesystem.listCompletedProposals();
			assert.strictEqual(completedProposals.length, 1);
			assert.strictEqual(completedProposals[0]?.id, "proposal-1");

			// Create and promote a draft
			await filesystem.saveDraft(sampleDraft);
			const promoted = await filesystem.promoteDraft("draft-1");
			assert.strictEqual(promoted, true);

			// BUG: Currently returns proposal-1 because promoteDraft only checks active proposals
			// Expected: Should return proposal-2 to avoid collision with completed proposal
			const promotedProposal = await filesystem.loadProposal("proposal-2");
			assert.strictEqual(promotedProposal?.id, "proposal-2");
			assert.strictEqual(promotedProposal?.title, sampleDraft.title);
		});

		it("should archive a draft", async () => {
			await filesystem.saveDraft(sampleDraft);

			const archived = await filesystem.archiveDraft("draft-1");
			assert.strictEqual(archived, true);

			const draft = await filesystem.loadDraft("draft-1");
			assert.strictEqual(draft, null);

			const files = await readdir(
				join(TEST_DIR, "roadmap", "archive", "drafts"),
			);
			expect(files.some((f) => f.startsWith("draft-1"))).toBe(true);
		});
	});

	describe("config operations", () => {
		const sampleConfig: RoadmapConfig = {
			projectName: "Test Project",
			defaultAssignee: "@admin",
			defaultReporter: undefined,
			defaultStatus: "Potential",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: ["bug", "feature"],
			dateFormat: "yyyy-mm-dd",
		};

		it("should save and load config", async () => {
			await filesystem.saveConfig(sampleConfig);

			const loadedConfig = await filesystem.loadConfig();
			assert.deepStrictEqual(loadedConfig, sampleConfig);
		});

		it("should return null for missing config", async () => {
			// Create a fresh filesystem without any config
			const freshFilesystem = new FileSystem(join(TEST_DIR, "fresh"));
			await freshFilesystem.ensureRoadmapStructure();

			const config = await freshFilesystem.loadConfig();
			assert.strictEqual(config, null);
		});

		it("should handle defaultReporter field", async () => {
			const cfg: RoadmapConfig = {
				projectName: "Reporter",
				defaultReporter: "@author",
				statuses: ["Potential"],
				labels: [],
				dateFormat: "yyyy-mm-dd",
			};

			await filesystem.saveConfig(cfg);
			const loaded = await filesystem.loadConfig();
			assert.strictEqual(loaded?.defaultReporter, "@author");
		});
	});

	describe("user config operations", () => {
		it("should save and load local and global user settings", async () => {
			await filesystem.setUserSetting("reporter", "local", false);
			await filesystem.setUserSetting("reporter", "global", true);

			const local = await filesystem.getUserSetting("reporter", false);
			const global = await filesystem.getUserSetting("reporter", true);

			assert.strictEqual(local, "local");
			assert.strictEqual(global, "global");
		});
	});

	describe("directory accessors", () => {
		it("should provide correct directory paths", () => {
			assert.strictEqual(
				filesystem.proposalsDir,
				join(TEST_DIR, "roadmap", "proposals"),
			);
			assert.strictEqual(
				filesystem.archiveProposalsDir,
				join(TEST_DIR, "roadmap", "archive", "proposals"),
			);
			assert.strictEqual(
				filesystem.decisionsDir,
				join(TEST_DIR, "roadmap", "decisions"),
			);
			assert.strictEqual(filesystem.docsDir, join(TEST_DIR, "docs"));
		});
	});

	describe("decision log operations", () => {
		const sampleDecision: Decision = {
			id: "decision-1",
			title: "Use TypeScript",
			date: "2025-06-07",
			status: "accepted",
			context: "Need type safety",
			decision: "Use TypeScript",
			consequences: "Better DX",
			rawContent: "",
		};

		it("should save and load a decision log", async () => {
			await filesystem.saveDecision(sampleDecision);

			const loadedDecision = await filesystem.loadDecision("decision-1");
			assert.strictEqual(loadedDecision?.id, sampleDecision.id);
			assert.strictEqual(loadedDecision?.title, sampleDecision.title);
			assert.strictEqual(loadedDecision?.status, sampleDecision.status);
			assert.strictEqual(loadedDecision?.context, sampleDecision.context);
		});

		it("should return null for non-existent decision log", async () => {
			const decision = await filesystem.loadDecision("non-existent");
			assert.strictEqual(decision, null);
		});

		it("should sanitize decision filenames", async () => {
			await filesystem.saveDecision({
				...sampleDecision,
				id: "decision-3",
				title: "Use OAuth (v2)!",
			});

			const decisionFiles = await readdir(filesystem.decisionsDir);
			assert.ok(decisionFiles.includes("decision-3 - Use-OAuth-v2.md"));
		});

		it("should save decision log with alternatives", async () => {
			const decisionWithAlternatives: Decision = {
				...sampleDecision,
				id: "decision-2",
				alternatives: "Considered JavaScript",
			};

			await filesystem.saveDecision(decisionWithAlternatives);
			const loaded = await filesystem.loadDecision("decision-2");

			assert.strictEqual(loaded?.alternatives, "Considered JavaScript");
		});

		it("should remove legacy decision filenames when resaving", async () => {
			const legacyDecision: Decision = {
				...sampleDecision,
				id: "decision-legacy",
				title: "Legacy Decision (OAuth)!",
				decision: "First draft",
			};

			await filesystem.saveDecision(legacyDecision);

			const files = await readdir(filesystem.decisionsDir);
			const sanitized = files.find((f) => f.startsWith("decision-legacy -"));
			assert.strictEqual(
				sanitized,
				"decision-legacy - Legacy-Decision-OAuth.md",
			);

			const legacyFilename = "decision-legacy - Legacy-Decision-(OAuth)!.md";
			await rename(
				join(filesystem.decisionsDir, sanitized as string),
				join(filesystem.decisionsDir, legacyFilename),
			);

			await filesystem.saveDecision({
				...legacyDecision,
				decision: "Updated decision",
			});

			const finalFiles = await readdir(filesystem.decisionsDir);
			assert.deepStrictEqual(finalFiles, [
				"decision-legacy - Legacy-Decision-OAuth.md",
			]);

			const loaded = await filesystem.loadDecision("decision-legacy");
			assert.strictEqual(loaded?.decision, "Updated decision");
		});

		it("should list decision logs", async () => {
			await filesystem.saveDecision(sampleDecision);
			const list = await filesystem.listDecisions();
			assert.strictEqual(list.length, 1);
			assert.strictEqual(list[0]?.id, sampleDecision.id);
		});
	});

	describe("document operations", () => {
		const sampleDocument: Document = {
			id: "doc-1",
			title: "API Guide",
			type: "guide",
			createdDate: "2025-06-07",
			updatedDate: "2025-06-08",
			rawContent: "This is the API guide content.",
			tags: ["api", "guide"],
		};

		it("should save a document", async () => {
			await filesystem.saveDocument(sampleDocument);

			// Check that file was created
			const docsFiles = await readdir(filesystem.docsDir);
			expect(docsFiles.some((f) => f.includes("API-Guide"))).toBe(true);
		});

		it("should save document without optional fields", async () => {
			const minimalDoc: Document = {
				id: "doc-2",
				title: "Simple Doc",
				type: "readme",
				createdDate: "2025-06-07",
				rawContent: "Simple content.",
			};

			await filesystem.saveDocument(minimalDoc);

			const docsFiles = await readdir(filesystem.docsDir);
			expect(docsFiles.some((f) => f.includes("Simple-Doc"))).toBe(true);
		});

		it("should sanitize document filenames", async () => {
			await filesystem.saveDocument({
				...sampleDocument,
				id: "doc-9",
				title: "Docs (Guide)! #1",
			});

			const docsFiles = await readdir(filesystem.docsDir);
			assert.ok(docsFiles.includes("doc-9 - Docs-Guide-1.md"));
		});

		it("removes the previous document file when the title changes", async () => {
			await filesystem.saveDocument(sampleDocument);

			await filesystem.saveDocument({
				...sampleDocument,
				title: "API Guide Updated",
				rawContent: "Updated content",
			});

			const docFiles = await Array.fromAsync(
				globSync("doc-*.md", { cwd: filesystem.docsDir }),
			);
			assert.strictEqual(docFiles.length, 1);
			assert.strictEqual(docFiles[0], "doc-1 - API-Guide-Updated.md");
		});

		it("should list documents", async () => {
			await filesystem.saveDocument(sampleDocument);
			const list = await filesystem.listDocuments();
			expect(list.some((d) => d.id === sampleDocument.id)).toBe(true);
		});

		it("should include relative path metadata when listing documents", async () => {
			await filesystem.saveDocument(
				{
					...sampleDocument,
					id: "doc-3",
					title: "Nested Guide",
				},
				"guides",
			);

			const docs = await filesystem.listDocuments();
			const nested = docs.find((doc) => doc.id === "doc-3");
			const actualPath = nested?.relativeFilePath?.replace(/\\/g, "/");
			const expectedPath = join("guides", "doc-3 - Nested-Guide.md").replace(
				/\\/g,
				"/",
			);
			assert.strictEqual(actualPath, expectedPath);
		});

		it("should load documents using flexible ID formats", async () => {
			await filesystem.saveDocument({
				...sampleDocument,
				id: "doc-7",
				title: "Operations Reference",
				rawContent: "Ops content",
			});

			const uppercase = await filesystem.loadDocument("DOC-7");
			assert.strictEqual(uppercase.id, "doc-7");

			const zeroPadded = await filesystem.loadDocument("0007");
			assert.strictEqual(zeroPadded.id, "doc-7");

			await filesystem.saveDocument({
				...sampleDocument,
				id: "DOC-0009",
				title: "Padded Uppercase",
				rawContent: "Content",
			});

			const canonicalFiles = await Array.fromAsync(
				globSync("doc-*.md", { cwd: filesystem.docsDir }),
			);
			const fileNames = canonicalFiles.map((d: any) =>
				typeof d === "string" ? d : d.name,
			);
			expect(
				fileNames.some((file: string) => file.startsWith("doc-0009")),
			).toBe(true);
		});
	});

	describe("edge cases", () => {
		it("should handle proposal with proposal- prefix in id", async () => {
			const proposalWithPrefix: Proposal = {
				id: "proposal-prefixed",
				title: "Already Prefixed",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal with proposal- prefix",
			};

			await filesystem.saveProposal(proposalWithPrefix);
			const loaded = await filesystem.loadProposal("proposal-prefixed");

			assert.strictEqual(loaded?.id, "proposal-prefixed"); // IDs normalized to lowercase
		});

		it("should handle proposal without proposal- prefix in id", async () => {
			// ID without any prefix pattern (no letters-dash)
			const proposalWithoutPrefix: Proposal = {
				id: "123",
				title: "No Prefix",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal without prefix",
			};

			await filesystem.saveProposal(proposalWithoutPrefix);
			const loaded = await filesystem.loadProposal("proposal-123");

			// IDs without prefix get the configured (or default) proposal prefix
			assert.strictEqual(loaded?.id, "proposal-123");
		});

		it("should preserve custom prefix in id", async () => {
			// ID with a custom prefix pattern (letters-something)
			const proposalWithCustomPrefix: Proposal = {
				id: "JIRA-456",
				title: "Custom Prefix",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal with custom prefix",
			};

			await filesystem.saveProposal(proposalWithCustomPrefix);
			const loaded = await filesystem.loadProposal("jira-456");

			// IDs with existing prefix are preserved (normalized to uppercase)
			assert.strictEqual(loaded?.id, "JIRA-456");
		});

		it("should return empty array when listing proposals in empty directory", async () => {
			const proposals = await filesystem.listProposals();
			assert.deepStrictEqual(proposals, []);
		});

		it("should return false when archiving non-existent proposal", async () => {
			const result = await filesystem.archiveProposal("non-existent");
			assert.strictEqual(result, false);
		});

		it("should handle config with all optional fields", async () => {
			const fullConfig: RoadmapConfig = {
				projectName: "Full Project",
				defaultAssignee: "@admin",
				defaultStatus: "Potential",
				defaultReporter: undefined,
				statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
				labels: ["bug", "feature", "enhancement"],
				dateFormat: "yyyy-mm-dd",
				database: {
					provider: "Postgres",
					host: "127.0.0.1",
					port: 5432,
					user: "admin",
					password: "secret",
					name: "agenthive",
					schema: "roadmap",
				},
			};

			await filesystem.saveConfig(fullConfig);
			const loaded = await filesystem.loadConfig();

			assert.deepStrictEqual(loaded, fullConfig);
		});

		it("should handle config with minimal fields", async () => {
			const minimalConfig: RoadmapConfig = {
				projectName: "Minimal Project",
				statuses: ["Potential", "Complete"],
				labels: [],
				dateFormat: "yyyy-mm-dd",
			};

			await filesystem.saveConfig(minimalConfig);
			const loaded = await filesystem.loadConfig();

			assert.strictEqual(loaded?.projectName, "Minimal Project");
			assert.strictEqual(loaded?.defaultAssignee, undefined);
			assert.strictEqual(loaded?.defaultStatus, undefined);
		});

		it("should sanitize filenames correctly", async () => {
			const proposalWithSpecialChars: Proposal = {
				id: "proposal-special",
				title: "Proposal/with\\special:chars?",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal with special characters in title",
			};

			await filesystem.saveProposal(proposalWithSpecialChars);
			const loaded = await filesystem.loadProposal("proposal-special");

			assert.strictEqual(loaded?.title, "Proposal/with\\special:chars?");
		});

		it("should preserve case in filenames", async () => {
			const proposalWithMixedCase: Proposal = {
				id: "proposal-mixed",
				title: "Fix Proposal List Ordering",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal with mixed case title",
			};

			await filesystem.saveProposal(proposalWithMixedCase);

			// Check that the file exists with preserved case
			const files = await readdir(filesystem.proposalsDir);
			const proposalFile = files.find((f) => f.startsWith("proposal-mixed -"));
			assert.strictEqual(
				proposalFile,
				"proposal-mixed - Fix-Proposal-List-Ordering.md",
			);

			// Verify the proposal can be loaded
			const loaded = await filesystem.loadProposal("proposal-mixed");
			assert.strictEqual(loaded?.title, "Fix Proposal List Ordering");
		});

		it("should strip punctuation from filenames", async () => {
			const proposalWithPunctuation: Proposal = {
				id: "proposal-punct",
				title: "Fix the user's login (OAuth)! #1",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal with punctuation in the title",
			};

			await filesystem.saveProposal(proposalWithPunctuation);

			const files = await readdir(filesystem.proposalsDir);
			const filename = files.find((f) => f.startsWith("proposal-punct -"));
			assert.strictEqual(
				filename,
				"proposal-punct - Fix-the-users-login-OAuth-1.md",
			);
		});

		it("should load proposals with legacy filenames containing punctuation", async () => {
			const legacyProposal: Proposal = {
				id: "proposal-legacy",
				title: "Legacy user's login (OAuth)",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Legacy punctuation proposal",
			};

			await filesystem.saveProposal(legacyProposal);

			const files = await readdir(filesystem.proposalsDir);
			const originalFilename = files.find((f) =>
				f.startsWith("proposal-legacy -"),
			);
			assert.notStrictEqual(originalFilename, undefined);

			const legacyFilename = "proposal-legacy - Legacy-user's-login-(OAuth).md";
			await rename(
				join(filesystem.proposalsDir, originalFilename as string),
				join(filesystem.proposalsDir, legacyFilename),
			);

			const loaded = await filesystem.loadProposal("proposal-legacy");
			assert.strictEqual(loaded?.title, "Legacy user's login (OAuth)");
		});

		it("should sanitize a variety of problematic proposal titles", async () => {
			const cases: Array<{ id: string; title: string; expected: string }> = [
				{
					id: "proposal-bad-1",
					title: "Fix the user's login (OAuth)! #1",
					expected: "Fix-the-users-login-OAuth-1",
				},
				{
					id: "proposal-bad-2",
					title: "Crazy!@#$%^&*()Name",
					expected: "Crazy-Name",
				},
				{
					id: "proposal-bad-3",
					title: "File with <bad> |chars| and /slashes\\",
					expected: "File-with-bad-chars-and-slashes",
				},
				{
					id: "proposal-bad-4",
					title: "Tabs\tand\nnewlines",
					expected: "Tabs-and-newlines",
				},
				{
					id: "proposal-bad-5",
					title: "Edge -- dashes ???",
					expected: "Edge-dashes",
				},
			];

			for (const { id, title, expected } of cases) {
				await filesystem.saveProposal({
					id,
					title,
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-07",
					labels: [],
					dependencies: [],
					description: "Sanitization test",
				});

				const files = await readdir(filesystem.proposalsDir);
				assert.ok(files.includes(`${id} - ${expected}.md`));
			}
		});

		it("should avoid double dashes in filenames", async () => {
			const weirdProposal: Proposal = {
				id: "proposal-dashes",
				title: "Proposal -- with  -- multiple   dashes",
				status: "Potential",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Check double dashes",
			};

			await filesystem.saveProposal(weirdProposal);
			const files = await readdir(filesystem.proposalsDir);
			const filename = files.find((f) => f.startsWith("proposal-dashes -"));
			assert.notStrictEqual(filename, undefined);
			expect(filename?.includes("--")).toBe(false);
		});
	});
});
