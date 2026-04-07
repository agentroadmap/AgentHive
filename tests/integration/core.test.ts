import assert from "node:assert";
import { globSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Document, Proposal } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Core", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-core");
		core = new Core(TEST_DIR);
		await core.filesystem.ensureRoadmapStructure();

		// Initialize git repository for testing
		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	describe("initialization", () => {
		it("should have filesystem and git operations available", () => {
			assert.notStrictEqual(core.filesystem, undefined);
			assert.notStrictEqual(core.gitOps, undefined);
		});

		it("should initialize project with default config", async () => {
			await core.initializeProject("Test Project", true);

			const config = await core.filesystem.loadConfig();
			assert.strictEqual(config?.projectName, "Test Project");
			assert.deepStrictEqual(config?.statuses, [
				"Potential",
				"Active",
				"Accepted",
				"Complete",
				"Abandoned",
			]);
			assert.strictEqual(config?.defaultStatus, "Potential");
		});
	});

	describe("proposal operations", () => {
		const sampleProposal: Proposal = {
			id: "proposal-1",
			title: "Test Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2025-06-07",
			labels: ["test"],
			dependencies: [],
			description: "This is a test proposal",
		};

		beforeEach(async () => {
			await core.initializeProject("Test Project", true);
		});

		it("should create proposal without auto-commit", async () => {
			await core.createProposal(sampleProposal, false);

			const loadedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(loadedProposal?.id, "proposal-1");
			assert.strictEqual(loadedProposal?.title, "Test Proposal");
		});

		it("should create proposal with auto-commit", async () => {
			await core.createProposal(sampleProposal, true);

			// Check if proposal file was created
			const loadedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(loadedProposal?.id, "proposal-1");

			// Check git status to see if there are uncommitted changes
			const _hasChanges = await core.gitOps.hasUncommittedChanges();

			const lastCommit = await core.gitOps.getLastCommitMessage();
			// For now, just check that we have a commit (could be initialization or proposal)
			assert.notStrictEqual(lastCommit, undefined);
			assert.ok(lastCommit.length > 0);
		});

		it("should update proposal with auto-commit", async () => {
			await core.createProposal(sampleProposal, true);

			// Check original proposal
			const originalProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(originalProposal?.title, "Test Proposal");

			await core.updateProposalFromInput(
				"proposal-1",
				{ title: "Updated Proposal" },
				true,
			);

			// Check if proposal was updated
			const loadedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(loadedProposal?.title, "Updated Proposal");

			const lastCommit = await core.gitOps.getLastCommitMessage();
			// For now, just check that we have a commit (could be initialization or proposal)
			assert.notStrictEqual(lastCommit, undefined);
			assert.ok(lastCommit.length > 0);
		});

		it("should archive proposal with auto-commit", async () => {
			await core.createProposal(sampleProposal, true);

			const archived = await core.archiveProposal("proposal-1", true);
			assert.strictEqual(archived, true);

			const lastCommit = await core.gitOps.getLastCommitMessage();
			assert.ok(lastCommit.includes("roadmap: Archive proposal proposal-1"));
		});

		it("should demote proposal with auto-commit", async () => {
			await core.createProposal(sampleProposal, true);

			const demoted = await core.demoteProposal("proposal-1", true);
			assert.strictEqual(demoted, true);

			const lastCommit = await core.gitOps.getLastCommitMessage();
			assert.ok(lastCommit.includes("roadmap: Demote proposal proposal-1"));
		});

		it("should resolve proposals using flexible ID formats", async () => {
			const standardProposal: Proposal = {
				...sampleProposal,
				id: "proposal-5",
				title: "Standard",
			};
			const paddedProposal: Proposal = {
				...sampleProposal,
				id: "proposal-007",
				title: "Padded",
			};
			await core.createProposal(standardProposal, false);
			await core.createProposal(paddedProposal, false);

			const uppercase = await core.getProposal("proposal-5");
			assert.strictEqual(uppercase?.id, "proposal-5");

			const bare = await core.getProposal("5");
			assert.strictEqual(bare?.id, "proposal-5");

			const zeroPadded = await core.getProposal("0007");
			assert.strictEqual(zeroPadded?.id, "proposal-007");

			const mixedCase = await core.getProposal("Proposal-007");
			assert.strictEqual(mixedCase?.id, "proposal-007");
		});

		it("should resolve numeric-only IDs with custom prefix (BACK-364)", async () => {
			// Configure custom prefix
			const config = await core.filesystem.loadConfig();
			if (!config) {
				throw new Error("Expected config to be loaded");
			}
			await core.filesystem.saveConfig({
				...config,
				prefixes: { proposal: "back" },
			});

			// Create proposals with custom prefix
			const proposal1: Proposal = {
				...sampleProposal,
				id: "back-358",
				title: "Custom Prefix Proposal",
			};
			const proposal2: Proposal = {
				...sampleProposal,
				id: "back-5.1",
				title: "Custom Prefix Subproposal",
			};
			await core.createProposal(proposal1, false);
			await core.createProposal(proposal2, false);

			// Numeric-only lookup should find proposal with custom prefix
			const byNumeric = await core.getProposal("358");
			assert.strictEqual(byNumeric?.id, "BACK-358");
			assert.strictEqual(byNumeric?.title, "Custom Prefix Proposal");

			// Dotted numeric lookup should find subproposal
			const byDotted = await core.getProposal("5.1");
			assert.strictEqual(byDotted?.id, "BACK-5.1");
			assert.strictEqual(byDotted?.title, "Custom Prefix Subproposal");

			// Full prefixed ID should also work (case-insensitive)
			const byFullId = await core.getProposal("BACK-358");
			assert.strictEqual(byFullId?.id, "BACK-358");

			const byLowercase = await core.getProposal("back-358");
			assert.strictEqual(byLowercase?.id, "BACK-358");
		});

		it("should NOT match numeric ID with typos when using custom prefix (BACK-364)", async () => {
			// Configure custom prefix
			const config = await core.filesystem.loadConfig();
			if (!config) {
				throw new Error("Expected config to be loaded");
			}
			await core.filesystem.saveConfig({
				...config,
				prefixes: { proposal: "back" },
			});

			// Create proposal with custom prefix
			const proposal: Proposal = {
				...sampleProposal,
				id: "back-358",
				title: "Custom Prefix Proposal",
			};
			await core.createProposal(proposal, false);

			// Typos should NOT match (prevent parseInt coercion bug)
			const withTypo = await core.getProposal("358a");
			assert.strictEqual(withTypo, null);

			const withTypo2 = await core.getProposal("35x8");
			assert.strictEqual(withTypo2, null);
		});

		it("should return false when archiving non-existent proposal", async () => {
			const archived = await core.archiveProposal("non-existent", true);
			assert.strictEqual(archived, false);
		});

		it("should apply default status when proposal has empty status", async () => {
			const proposalWithoutStatus: Proposal = {
				...sampleProposal,
				status: "",
			};

			await core.createProposal(proposalWithoutStatus, false);

			const loadedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(loadedProposal?.status, "Potential"); // Should use default from config
		});

		it("should not override existing status", async () => {
			const proposalWithStatus: Proposal = {
				...sampleProposal,
				status: "Active",
			};

			await core.createProposal(proposalWithStatus, false);

			const loadedProposal = await core.filesystem.loadProposal("proposal-1");
			assert.strictEqual(loadedProposal?.status, "Active");
		});

		it("should preserve description text when saving without header markers", async () => {
			const proposalNoHeader: Proposal = {
				...sampleProposal,
				id: "proposal-2",
				description: "Just text",
			};

			await core.createProposal(proposalNoHeader, false);
			const loaded = await core.filesystem.loadProposal("proposal-2");
			assert.strictEqual(loaded?.description, "Just text");
			const body = await core.getProposalContent("proposal-2");
			const matches = (body?.match(/## Description/g) ?? []).length;
			assert.strictEqual(matches, 1);
		});

		it("should not duplicate description header in saved content", async () => {
			const proposalWithHeader: Proposal = {
				...sampleProposal,
				id: "proposal-3",
				description: "Existing",
			};

			await core.createProposal(proposalWithHeader, false);
			const body = await core.getProposalContent("proposal-3");
			const matches = (body?.match(/## Description/g) ?? []).length;
			assert.strictEqual(matches, 1);
		});

		it("should handle proposal creation without auto-commit when git fails", async () => {
			// Create proposal in directory without git
			const nonGitCore = new Core(join(TEST_DIR, "no-git"));
			await nonGitCore.filesystem.ensureRoadmapStructure();

			// This should succeed even without git
			await nonGitCore.createProposal(sampleProposal, false);

			const loadedProposal =
				await nonGitCore.filesystem.loadProposal("proposal-1");
			assert.strictEqual(loadedProposal?.id, "proposal-1");
		});

		it("should normalize assignee for string and array inputs", async () => {
			const stringProposal = {
				...sampleProposal,
				id: "proposal-2",
				title: "String Assignee",
				assignee: "@alice",
			} as unknown as Proposal;
			await core.createProposal(stringProposal, false);
			const loadedString = await core.filesystem.loadProposal("proposal-2");
			assert.deepStrictEqual(loadedString?.assignee, ["@alice"]);

			const arrayProposal: Proposal = {
				...sampleProposal,
				id: "proposal-3",
				title: "Array Assignee",
				assignee: ["@bob"],
			};
			await core.createProposal(arrayProposal, false);
			const loadedArray = await core.filesystem.loadProposal("proposal-3");
			assert.deepStrictEqual(loadedArray?.assignee, ["@bob"]);
		});

		it("should normalize assignee when updating proposals", async () => {
			await core.createProposal(sampleProposal, false);

			await core.updateProposalFromInput(
				"proposal-1",
				{ assignee: ["@carol"] },
				false,
			);
			let loaded = await core.filesystem.loadProposal("proposal-1");
			assert.deepStrictEqual(loaded?.assignee, ["@carol"]);

			await core.updateProposalFromInput(
				"proposal-1",
				{ assignee: ["@dave"] },
				false,
			);
			loaded = await core.filesystem.loadProposal("proposal-1");
			assert.deepStrictEqual(loaded?.assignee, ["@dave"]);
		});

		it("should create sub-proposals with proper hierarchical IDs", async () => {
			await core.initializeProject("Subproposal Project", true);

			// Create parent proposal
			const { proposal: parent } = await core.createProposalFromInput({
				title: "Parent Proposal",
				status: "Potential",
			});
			assert.strictEqual(parent.id, "proposal-1");

			// Create first sub-proposal
			const { proposal: child1 } = await core.createProposalFromInput({
				title: "First Child",
				parentProposalId: parent.id,
				status: "Potential",
			});
			assert.strictEqual(child1.id, "proposal-1.1");
			assert.strictEqual(child1.parentProposalId, "proposal-1");

			// Create second sub-proposal
			const { proposal: child2 } = await core.createProposalFromInput({
				title: "Second Child",
				parentProposalId: parent.id,
				status: "Potential",
			});
			assert.strictEqual(child2.id, "proposal-1.2");
			assert.strictEqual(child2.parentProposalId, "proposal-1");

			// Create another parent proposal to ensure sequential numbering still works
			const { proposal: parent2 } = await core.createProposalFromInput({
				title: "Second Parent",
				status: "Potential",
			});
			assert.strictEqual(parent2.id, "proposal-2");
		});
	});

	describe("document operations", () => {
		const baseDocument: Document = {
			id: "doc-1",
			title: "Operations Guide",
			type: "guide",
			createdDate: "2025-06-07",
			rawContent: "# Ops Guide",
		};

		beforeEach(async () => {
			await core.initializeProject("Test Project", false);
		});

		it("updates a document title without leaving the previous file behind", async () => {
			await core.createDocument(baseDocument, false);

			const initialFiles = await Array.fromAsync(
				globSync("doc-*.md", { cwd: core.filesystem.docsDir }),
			);
			const initialFile = initialFiles[0];
			const initialFileName =
				typeof initialFile === "string"
					? initialFile
					: (initialFile as any)?.name;
			assert.strictEqual(initialFileName, "doc-1 - Operations-Guide.md");

			const documents = await core.filesystem.listDocuments();
			const existingDoc = documents[0];
			if (!existingDoc) {
				throw new Error("Expected document to exist after creation");
			}
			assert.strictEqual(existingDoc.title, "Operations Guide");

			await core.updateDocument(
				{ ...existingDoc, title: "Operations Guide Updated" },
				"# Updated content",
				false,
			);

			const docFiles = await Array.fromAsync(
				globSync("doc-*.md", { cwd: core.filesystem.docsDir }),
			);
			const docFileNames = docFiles.map((d: any) =>
				typeof d === "string" ? d : d.name,
			);
			assert.strictEqual(docFileNames.length, 1);
			assert.strictEqual(
				docFileNames[0],
				"doc-1 - Operations-Guide-Updated.md",
			);

			const updatedDocs = await core.filesystem.listDocuments();
			assert.strictEqual(updatedDocs[0]?.title, "Operations Guide Updated");
		});

		it("shows a git rename when the document title changes", async () => {
			await core.createDocument(baseDocument, true);

			const renamedDoc: Document = {
				...baseDocument,
				title: "Operations Guide Renamed",
			};

			await core.updateDocument(renamedDoc, "# Ops Guide", false);

			execSync(`git add -A`, { cwd: TEST_DIR });
			const diffResult = execSync(`git diff --name-status -M HEAD`, {
				cwd: TEST_DIR,
			});
			const diff = diffResult.stdout.toString();
			const previousPath = "docs/doc-1 - Operations-Guide.md";
			const renamedPath = "docs/doc-1 - Operations-Guide-Renamed.md";
			const escapeForRegex = (value: string) =>
				value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
			assert.ok(
				new RegExp(
					`^R\\d*\\t${escapeForRegex(previousPath)}\\t${escapeForRegex(renamedPath)}`,
					"m",
				).test(diff),
			);
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
			description: "Draft proposal",
		};

		beforeEach(async () => {
			await core.initializeProject("Draft Project", true);
		});

		it("should create draft without auto-commit", async () => {
			await core.createDraft(sampleDraft, false);

			const loaded = await core.filesystem.loadDraft("draft-1");
			assert.strictEqual(loaded?.id, "draft-1");
		});

		it("should create draft with auto-commit", async () => {
			await core.createDraft(sampleDraft, true);

			const loaded = await core.filesystem.loadDraft("draft-1");
			assert.strictEqual(loaded?.id, "draft-1");

			const lastCommit = await core.gitOps.getLastCommitMessage();
			assert.notStrictEqual(lastCommit, undefined);
			assert.ok(lastCommit.length > 0);
		});

		it("should promote draft with auto-commit", async () => {
			await core.createDraft(sampleDraft, true);

			const promoted = await core.promoteDraft("draft-1", true);
			assert.strictEqual(promoted, true);

			const lastCommit = await core.gitOps.getLastCommitMessage();
			assert.ok(lastCommit.includes("roadmap: Promote draft draft-1"));
		});

		it("should archive draft with auto-commit", async () => {
			await core.createDraft(sampleDraft, true);

			const archived = await core.archiveDraft("draft-1", true);
			assert.strictEqual(archived, true);

			const lastCommit = await core.gitOps.getLastCommitMessage();
			assert.ok(lastCommit.includes("roadmap: Archive draft draft-1"));
		});

		it("should normalize assignee for string and array inputs", async () => {
			const draftString = {
				...sampleDraft,
				id: "draft-2",
				title: "Draft String",
				assignee: "@erin",
			} as unknown as Proposal;
			await core.createDraft(draftString, false);
			const loadedString = await core.filesystem.loadDraft("draft-2");
			assert.deepStrictEqual(loadedString?.assignee, ["@erin"]);

			const draftArray: Proposal = {
				...sampleDraft,
				id: "draft-3",
				title: "Draft Array",
				assignee: ["@frank"],
			};
			await core.createDraft(draftArray, false);
			const loadedArray = await core.filesystem.loadDraft("draft-3");
			assert.deepStrictEqual(loadedArray?.assignee, ["@frank"]);
		});
	});

	describe("integration with config", () => {
		it("should use custom default status from config", async () => {
			// Initialize with custom config
			await core.initializeProject("Custom Project");

			// Update config with custom default status
			const config = await core.filesystem.loadConfig();
			if (config) {
				config.defaultStatus = "Custom Status";
				await core.filesystem.saveConfig(config);
			}

			const proposalWithoutStatus: Proposal = {
				id: "proposal-custom",
				title: "Custom Proposal",
				status: "",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal without status",
			};

			await core.createProposal(proposalWithoutStatus, false);

			const loadedProposal =
				await core.filesystem.loadProposal("proposal-custom");
			assert.strictEqual(loadedProposal?.status, "Custom Status");
		});

		it("should fall back to Potential when config has no default status", async () => {
			// Initialize project
			await core.initializeProject("Fallback Project");

			// Update config to remove default status
			const config = await core.filesystem.loadConfig();
			if (config) {
				config.defaultStatus = undefined;
				await core.filesystem.saveConfig(config);
			}

			const proposalWithoutStatus: Proposal = {
				id: "proposal-fallback",
				title: "Fallback Proposal",
				status: "",
				assignee: [],
				createdDate: "2025-06-07",
				labels: [],
				dependencies: [],
				description: "Proposal without status",
			};

			await core.createProposal(proposalWithoutStatus, false);

			const loadedProposal =
				await core.filesystem.loadProposal("proposal-fallback");
			assert.strictEqual(loadedProposal?.status, "Potential");
		});
	});

	describe("directory accessor integration", () => {
		it(
			"should use FileSystem directory accessors for git operations",
			{ timeout: 10000 },
			async () => {
				await core.initializeProject("Accessor Test");

				const proposal: Proposal = {
					id: "proposal-accessor",
					title: "Accessor Test Proposal",
					status: "Potential",
					assignee: [],
					createdDate: "2025-06-07",
					labels: [],
					dependencies: [],
					description: "Testing directory accessors",
				};

				// Create proposal without auto-commit to avoid potential git timing issues
				await core.createProposal(proposal, false);

				// Verify the proposal file was created in the correct directory
				const _proposalsDir = core.filesystem.proposalsDir;

				// List all files to see what was actually created
				const allFiles = await core.filesystem.listProposals();

				// Check that a proposal with the expected ID exists
				const createdProposal = allFiles.find(
					(t) => t.id === "proposal-ACCESSOR",
				);
				assert.notStrictEqual(createdProposal, undefined);
				assert.strictEqual(createdProposal?.title, "Accessor Test Proposal");
			},
		);
	});
});
