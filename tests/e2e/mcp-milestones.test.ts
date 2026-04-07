import assert from "node:assert";
import { globSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { McpServer } from "../../src/mcp/server.ts";
import { registerMilestoneTools } from "../../src/mcp/tools/milestones/index.ts";
import { registerProposalTools } from "../../src/mcp/tools/proposals/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

const getText = (content: unknown[] | undefined, index = 0): string => {
	const item = content?.[index] as { text?: string } | undefined;
	return item?.text ?? "";
};

let TEST_DIR: string;
let server: McpServer;

async function loadConfigOrThrow(mcpServer: McpServer) {
	const config = await mcpServer.filesystem.loadConfig();
	if (!config) {
		throw new Error("Failed to load config");
	}
	return config;
}

async function writeLegacyDirectiveFile(
	mcpServer: McpServer,
	id: string,
	title: string,
	description = `Directive: ${title}`,
): Promise<void> {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const filename = `${id} - ${slug || "directive"}.md`;
	const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const content = `---
id: ${id}
title: "${escapedTitle}"
---

## Description

${description}
`;
	await writeFile(join(mcpServer.filesystem.directivesDir, filename), content);
}

describe("MCP directive tools", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-directives");
		server = new McpServer(TEST_DIR, "Test instructions");
		await server.filesystem.ensureRoadmapStructure();

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		await server.initializeProject("Test Project");

		const config = await loadConfigOrThrow(server);
		registerProposalTools(server, config);
		registerMilestoneTools(server);
	});

	afterEach(async () => {
		try {
			await server.stop();
		} catch {
			// ignore
		}
		await safeCleanup(TEST_DIR);
	});

	it("supports setting and clearing directive via proposal_create/proposal_edit", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 2.0" } },
		});

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Directive proposal",
					directive: "Release 1.0",
				},
			},
		});

		const created = await server.getProposal("proposal-1");
		assert.strictEqual(created?.directive, "m-0");

		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "proposal-1",
					directive: "Release 2.0",
				},
			},
		});

		const updated = await server.getProposal("proposal-1");
		assert.strictEqual(updated?.directive, "m-1");

		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "proposal-1",
					directive: "m-0",
				},
			},
		});

		const updatedById = await server.getProposal("proposal-1");
		assert.strictEqual(updatedById?.directive, "m-0");

		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "proposal-1",
					directive: null,
				},
			},
		});

		const cleared = await server.getProposal("proposal-1");
		assert.strictEqual(cleared?.directive, undefined);

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Directive proposal by id",
					directive: "m-1",
				},
			},
		});
		const createdById = await server.getProposal("proposal-2");
		assert.strictEqual(createdById?.directive, "m-1");

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Unconfigured directive proposal",
					directive: "Planned Later",
				},
			},
		});
		const createdWithUnconfiguredDirective =
			await server.getProposal("proposal-3");
		assert.strictEqual(
			createdWithUnconfiguredDirective?.directive,
			"Planned Later",
		);
	});

	it("supports numeric directive aliases for ID-based operations", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 2.0" } },
		});

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Numeric alias create",
					directive: "1",
				},
			},
		});
		const created = await server.getProposal("proposal-1");
		assert.strictEqual(created?.directive, "m-1");

		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "proposal-1",
					directive: "0",
				},
			},
		});
		const edited = await server.getProposal("proposal-1");
		assert.strictEqual(edited?.directive, "m-0");

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "1", to: "Release 2.1" },
			},
		});
		expect(getText(rename.content)).toContain(
			'Renamed directive "Release 2.0" (m-1)',
		);
		expect(getText(rename.content)).toContain('"Release 2.1"');

		const remove = await server.testInterface.callTool({
			params: { name: "directive_remove", arguments: { name: "1" } },
		});
		expect(getText(remove.content)).toContain("(m-1)");
	});

	it("resolves zero-padded legacy directive IDs for numeric aliases", async () => {
		await writeLegacyDirectiveFile(server, "m-01", "Legacy Release");

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Legacy alias proposal",
					directive: "1",
				},
			},
		});
		const created = await server.getProposal("proposal-1");
		assert.strictEqual(created?.directive, "m-01");

		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: {
					id: "proposal-1",
					directive: "m-1",
				},
			},
		});
		const updated = await server.getProposal("proposal-1");
		assert.strictEqual(updated?.directive, "m-01");

		const renamed = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "1", to: "Legacy Release Prime" },
			},
		});
		expect(getText(renamed.content)).toContain("(m-01)");
		expect(getText(renamed.content)).toContain('"Legacy Release Prime"');
		expect(getText(renamed.content)).toContain("Updated 1 local proposal");

		const removed = await server.testInterface.callTool({
			params: { name: "directive_remove", arguments: { name: "m-1" } },
		});
		expect(getText(removed.content)).toContain("(m-01)");
		expect(getText(removed.content)).toContain(
			"Cleared directive for 1 local proposal",
		);
		const cleared = await server.getProposal("proposal-1");
		assert.strictEqual(cleared?.directive, undefined);
	});

	it("adds directives as files with validation", async () => {
		const add = await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: "Release 1.0" },
			},
		});
		expect(getText(add.content)).toContain('Created directive "Release 1.0"');
		expect(getText(add.content)).toContain("(m-0)");

		// Check that directive file was created
		const directives = await server.filesystem.listDirectives();
		assert.strictEqual(directives.length, 1);
		assert.strictEqual(directives[0]?.title, "Release 1.0");
		assert.strictEqual(directives[0]?.id, "m-0");

		// Duplicate should fail (case-insensitive)
		const duplicate = await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: " release 1.0 " },
			},
		});
		assert.strictEqual(duplicate.isError, true);
		expect(getText(duplicate.content)).toContain("Directive alias conflict");
	});

	it("lists file-based and proposal-only directives", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Unconfigured directive proposal",
					directive: "Unconfigured",
				},
			},
		});

		const list = await server.testInterface.callTool({
			params: { name: "directive_list", arguments: {} },
		});
		const text = getText(list.content);
		assert.ok(text.includes("Directives (1):"));
		assert.ok(text.includes("m-0: Release 1.0"));
		assert.ok(
			text.includes("Directives found on proposals without files (1):"),
		);
		assert.ok(text.includes("- Unconfigured"));
	});

	it("archives directives and hides them from lists", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Archived directive proposal",
					directive: "Release 1.0",
				},
			},
		});

		const archived = await server.testInterface.callTool({
			params: { name: "directive_archive", arguments: { name: "Release 1.0" } },
		});
		expect(getText(archived.content)).toContain(
			'Archived directive "Release 1.0"',
		);

		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: { id: "proposal-1", directive: "Release 1.0" },
			},
		});
		const archivedTitleResolved = await server.getProposal("proposal-1");
		assert.strictEqual(archivedTitleResolved?.directive, "m-0");

		const active = await server.filesystem.listDirectives();
		const archivedList = await server.filesystem.listArchivedDirectives();
		assert.strictEqual(active.length, 0);
		assert.strictEqual(archivedList.length, 1);

		const list = await server.testInterface.callTool({
			params: { name: "directive_list", arguments: {} },
		});
		const text = getText(list.content);
		assert.ok(text.includes("Directives (0):"));
		assert.ok(
			text.includes("Directives found on proposals without files (0):"),
		);
		assert.ok(
			text.includes("Archived directive values still on proposals (1):"),
		);
		assert.ok(text.includes("- m-0"));
		assert.ok(!text.includes("Release 1.0"));
	});

	it("does not reuse archived directive IDs when adding new directives", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_archive", arguments: { name: "Release 1.0" } },
		});

		const added = await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 2.0" } },
		});
		expect(getText(added.content)).toContain("(m-1)");

		const activeDirectives = await server.filesystem.listDirectives();
		const archivedDirectives = await server.filesystem.listArchivedDirectives();
		assert.strictEqual(activeDirectives[0]?.id, "m-1");
		assert.strictEqual(archivedDirectives[0]?.id, "m-0");
	});

	it("renames directives and updates local proposals by default", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "A", directive: "Release 1.0" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "B", directive: "Release 1.0" },
			},
		});

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "Release 1.0", to: "Release 2.0" },
			},
		});
		expect(getText(rename.content)).toContain(
			'Renamed directive "Release 1.0" (m-0) → "Release 2.0" (m-0).',
		);
		expect(getText(rename.content)).toContain("Updated 2 local proposals");
		expect(getText(rename.content)).toContain("Renamed directive file:");

		const proposal1 = await server.getProposal("proposal-1");
		const proposal2 = await server.getProposal("proposal-2");
		assert.strictEqual(proposal1?.directive, "m-0");
		assert.strictEqual(proposal2?.directive, "m-0");

		const directives = await server.filesystem.listDirectives();
		assert.strictEqual(directives[0]?.title, "Release 2.0");

		const directiveFiles = await Array.fromAsync(
			globSync("m-*.md", { cwd: server.filesystem.directivesDir }),
		);
		const fileNames = directiveFiles.map((d: any) =>
			typeof d === "string" ? d : d.name,
		);
		assert.ok(fileNames.includes("m-0 - release-2.0.md"));
		assert.ok(!fileNames.includes("m-0 - release-1.0.md"));
	});

	it("keeps git clean when renaming directives with autoCommit enabled", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		const config = await loadConfigOrThrow(server);
		config.autoCommit = true;
		await server.filesystem.saveConfig(config);
		await server.ensureConfigLoaded();

		execSync(`git add .`, { cwd: TEST_DIR });
		execSync(`git commit -m "baseline"`, { cwd: TEST_DIR });

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: {
					from: "Release 1.0",
					to: "Release 2.0",
					updateProposals: false,
				},
			},
		});
		expect(getText(rename.content)).toContain(
			'Renamed directive "Release 1.0" (m-0) → "Release 2.0" (m-0).',
		);

		const status = await server.git.getStatus();
		expect(status.trim()).toBe("");
		const lastCommit = await server.git.getLastCommitMessage();
		assert.ok(lastCommit.includes("roadmap: Rename directive m-0"));
	});

	it("only rewrites the default description section when renaming directives", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});

		const directiveFilesBefore = await Array.fromAsync(
			globSync("m-*.md", { cwd: server.filesystem.directivesDir }),
		);
		const fileNamesBefore = directiveFilesBefore.map((d: any) =>
			typeof d === "string" ? d : d.name,
		);
		assert.strictEqual(fileNamesBefore.length, 1);
		const sourcePath = join(
			server.filesystem.directivesDir,
			fileNamesBefore[0]!,
		);
		const originalContent = await await readFile(sourcePath, "utf-8");
		const notesLine = "Keep reference Directive: Release 1.0 in notes";
		await writeFile(
			sourcePath,
			`${originalContent.trimEnd()}\n\n## Notes\n\n${notesLine}\n`,
		);

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: {
					from: "Release 1.0",
					to: "Release 2.0",
					updateProposals: false,
				},
			},
		});
		expect(getText(rename.content)).toContain(
			'Renamed directive "Release 1.0" (m-0) → "Release 2.0" (m-0).',
		);

		const renamedPath = join(
			server.filesystem.directivesDir,
			"m-0 - release-2.0.md",
		);
		const updatedContent = await await readFile(renamedPath, "utf-8");
		assert.ok(
			updatedContent.includes("## Description\n\nDirective: Release 2.0"),
		);
		assert.ok(updatedContent.includes(`## Notes\n\n${notesLine}`));
		assert.ok(
			!updatedContent.includes(
				"## Notes\n\nKeep reference Directive: Release 2.0 in notes",
			),
		);
	});

	it("treats no-op directive renames as successful without creating commits", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		const config = await loadConfigOrThrow(server);
		config.autoCommit = true;
		await server.filesystem.saveConfig(config);
		await server.ensureConfigLoaded();

		execSync(`git add .`, { cwd: TEST_DIR });
		execSync(`git commit -m "baseline"`, { cwd: TEST_DIR });

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: {
					from: "Release 1.0",
					to: "Release 1.0",
					updateProposals: false,
				},
			},
		});
		expect(getText(rename.content)).toContain("No changes made");

		const status = await server.git.getStatus();
		expect(status.trim()).toBe("");
		const lastCommit = await server.git.getLastCommitMessage();
		assert.strictEqual(lastCommit, "baseline");
	});

	it("does not include unrelated staged files in directive auto-commits", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		const config = await loadConfigOrThrow(server);
		config.autoCommit = true;
		await server.filesystem.saveConfig(config);
		await server.ensureConfigLoaded();

		execSync(`git add .`, { cwd: TEST_DIR });
		execSync(`git commit -m "baseline"`, { cwd: TEST_DIR });

		await writeFile(join(TEST_DIR, "UNRELATED.txt"), "keep staged\n");
		execSync(`git add UNRELATED.txt`, { cwd: TEST_DIR });

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: {
					from: "Release 1.0",
					to: "Release 2.0",
					updateProposals: false,
				},
			},
		});
		expect(getText(rename.content)).toContain(
			'Renamed directive "Release 1.0" (m-0) → "Release 2.0" (m-0).',
		);

		const lastCommit = await server.git.getLastCommitMessage();
		assert.ok(lastCommit.includes("roadmap: Rename directive m-0"));

		const { stdout: committedFiles } = execSync(
			`git show --name-only --pretty=format:`,
			{ cwd: TEST_DIR },
		);
		assert.ok(!committedFiles.includes("UNRELATED.txt"));
		const status = await server.git.getStatus();
		assert.ok(status.includes("A  UNRELATED.txt"));
	});

	it("does not include unrelated staged files in directive archive auto-commits", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		const config = await loadConfigOrThrow(server);
		config.autoCommit = true;
		await server.filesystem.saveConfig(config);
		await server.ensureConfigLoaded();

		execSync(`git add .`, { cwd: TEST_DIR });
		execSync(`git commit -m "baseline"`, { cwd: TEST_DIR });

		await writeFile(join(TEST_DIR, "UNRELATED.txt"), "keep staged\n");
		execSync(`git add UNRELATED.txt`, { cwd: TEST_DIR });

		const archived = await server.testInterface.callTool({
			params: { name: "directive_archive", arguments: { name: "Release 1.0" } },
		});
		expect(getText(archived.content)).toContain(
			'Archived directive "Release 1.0"',
		);

		const lastCommit = await server.git.getLastCommitMessage();
		assert.ok(lastCommit.includes("roadmap: Archive directive m-0"));

		const { stdout: committedFiles } = execSync(
			`git show --name-only --pretty=format:`,
			{ cwd: TEST_DIR },
		);
		assert.ok(!committedFiles.includes("UNRELATED.txt"));
		const status = await server.git.getStatus();
		assert.ok(status.includes("A  UNRELATED.txt"));
	});

	it("prefers directive ID matches over title collisions", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "m-1" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release B" } },
		});

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Collision proposal",
					directive: "m-1",
				},
			},
		});

		const proposal = await server.getProposal("proposal-1");
		assert.strictEqual(proposal?.directive, "m-1");
	});

	it("supports renaming directive files without proposal rewrites when updateProposals=false", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release 1.0" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Legacy proposal", directive: "Release 1.0" },
			},
		});
		await server.editProposal("proposal-1", { directive: "Release 1.0" });

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: {
					from: "Release 1.0",
					to: "Release 2.0",
					updateProposals: false,
				},
			},
		});
		expect(getText(rename.content)).toContain(
			"Skipped updating proposals (updateProposals=false).",
		);

		const proposal = await server.getProposal("proposal-1");
		assert.strictEqual(proposal?.directive, "Release 1.0");

		const directives = await server.filesystem.listDirectives();
		assert.strictEqual(directives[0]?.title, "Release 2.0");
	});

	it("rejects rename targets that collide with another directive alias", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release A" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release B" } },
		});

		const rename = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "Release A", to: "m-1" },
			},
		});
		assert.strictEqual(rename.isError, true);
		expect(getText(rename.content)).toContain("Directive alias conflict");
	});

	it("rejects add/rename alias collisions when an existing ID is zero-padded", async () => {
		await writeLegacyDirectiveFile(server, "m-01", "Legacy Release");

		const addCollision = await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "1" } },
		});
		assert.strictEqual(addCollision.isError, true);
		expect(getText(addCollision.content)).toContain("Directive alias conflict");

		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release B" } },
		});
		const renameCollision = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "Release B", to: "m-1" },
			},
		});
		assert.strictEqual(renameCollision.isError, true);
		expect(getText(renameCollision.content)).toContain(
			"Directive alias conflict",
		);
	});

	it("supports directive ID inputs for rename/remove", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release A" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release B" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Proposal A", directive: "Release A" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Proposal B", directive: "Release B" },
			},
		});

		const renamed = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "m-0", to: "Release A Prime" },
			},
		});
		expect(getText(renamed.content)).toContain(
			'Renamed directive "Release A" (m-0) → "Release A Prime" (m-0).',
		);
		expect(getText(renamed.content)).toContain("Updated 1 local proposal");

		const afterRename = await server.getProposal("proposal-1");
		assert.strictEqual(afterRename?.directive, "m-0");

		const removed = await server.testInterface.callTool({
			params: { name: "directive_remove", arguments: { name: "m-1" } },
		});
		expect(getText(removed.content)).toContain(
			'Removed directive "Release B" (m-1).',
		);
		expect(getText(removed.content)).toContain(
			"Cleared directive for 1 local proposal",
		);

		const afterRemove = await server.getProposal("proposal-2");
		assert.strictEqual(afterRemove?.directive, undefined);

		const activeDirectives = await server.filesystem.listDirectives();
		const archivedDirectives = await server.filesystem.listArchivedDirectives();
		expect(activeDirectives.map((directive) => directive.id)).toEqual(["m-0"]);
		expect(archivedDirectives.map((directive) => directive.id)).toContain(
			"m-1",
		);
	});

	it("updates title-based proposal directive values when renaming by directive ID", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release A" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Proposal A", directive: "Release A" },
			},
		});
		await server.editProposal("proposal-1", { directive: "Release A" });

		await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "m-0", to: "Release A Prime" },
			},
		});

		const updatedProposal = await server.getProposal("proposal-1");
		assert.strictEqual(updatedProposal?.directive, "m-0");
	});

	it("updates numeric alias proposal directive values when renaming by title", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release A" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Proposal A", directive: "Release A" },
			},
		});
		await server.editProposal("proposal-1", { directive: "0" });

		await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "Release A", to: "Release A Prime" },
			},
		});

		const updatedProposal = await server.getProposal("proposal-1");
		assert.strictEqual(updatedProposal?.directive, "m-0");
	});

	it("does not cross-match reused titles when removing by directive ID", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Shared" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: "Keep ID occupied" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Old proposal", directive: "Shared" },
			},
		});
		await server.editProposal("proposal-1", { directive: "Shared" });
		await server.testInterface.callTool({
			params: { name: "directive_archive", arguments: { name: "Shared" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Shared" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "New proposal", directive: "Shared" },
			},
		});

		const removeById = await server.testInterface.callTool({
			params: { name: "directive_remove", arguments: { name: "m-2" } },
		});
		expect(getText(removeById.content)).toContain(
			'Removed directive "Shared" (m-2).',
		);
		expect(getText(removeById.content)).toContain(
			"Cleared directive for 1 local proposal",
		);

		const oldProposal = await server.getProposal("proposal-1");
		const newProposal = await server.getProposal("proposal-2");
		assert.strictEqual(oldProposal?.directive, "Shared");
		assert.strictEqual(newProposal?.directive, undefined);
	});

	it("does not cross-match archived directive IDs when removing a title that looks like an ID", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Archived source" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Archived proposal", directive: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_archive",
				arguments: { name: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: "Keep ID occupied" },
			},
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "m-0" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Active title proposal", directive: "m-2" },
			},
		});
		await server.editProposal("proposal-1", { directive: "0" });

		const removeByTitle = await server.testInterface.callTool({
			params: { name: "directive_remove", arguments: { name: "m-0" } },
		});
		expect(getText(removeByTitle.content)).toContain(
			"Cleared directive for 1 local proposal",
		);

		const archivedProposal = await server.getProposal("proposal-1");
		const activeProposal = await server.getProposal("proposal-2");
		assert.strictEqual(archivedProposal?.directive, "0");
		assert.strictEqual(activeProposal?.directive, undefined);
	});

	it("does not cross-match archived directive IDs when renaming a title that looks like an ID", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Archived source" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Archived proposal", directive: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_archive",
				arguments: { name: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: "Keep ID occupied" },
			},
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "m-0" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Active title proposal", directive: "m-2" },
			},
		});
		await server.editProposal("proposal-1", { directive: "0" });

		const renameByTitle = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "m-0", to: "ID-like title renamed" },
			},
		});
		expect(getText(renameByTitle.content)).toContain(
			"Updated 1 local proposal",
		);

		const archivedProposal = await server.getProposal("proposal-1");
		const activeProposal = await server.getProposal("proposal-2");
		assert.strictEqual(archivedProposal?.directive, "0");
		assert.strictEqual(activeProposal?.directive, "m-2");
	});

	it("prefers canonical IDs when zero-padded and canonical ID files both exist", async () => {
		await writeLegacyDirectiveFile(server, "m-1", "Canonical ID");
		await writeLegacyDirectiveFile(server, "m-01", "Zero-padded ID");

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: {
					title: "Alias tie-break proposal",
					directive: "1",
				},
			},
		});
		const created = await server.getProposal("proposal-1");
		assert.strictEqual(created?.directive, "m-1");

		const renamed = await server.testInterface.callTool({
			params: {
				name: "directive_rename",
				arguments: { from: "1", to: "Canonical ID Prime" },
			},
		});
		expect(getText(renamed.content)).toContain("(m-1)");
	});

	it("prefers archived directive IDs over active title matches for ID-like proposal edits", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Archived source" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Proposal", directive: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_archive",
				arguments: { name: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: "Keep ID occupied" },
			},
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "m-0" } },
		});

		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: { id: "proposal-1", directive: "m-0" },
			},
		});
		const updated = await server.getProposal("proposal-1");
		assert.strictEqual(updated?.directive, "m-0");
	});

	it("reports archived directive proposal values when active titles look like archived IDs", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Archived source" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Proposal", directive: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_archive",
				arguments: { name: "Archived source" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: "Keep ID occupied" },
			},
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "m-0" } },
		});
		await server.editProposal("proposal-1", { directive: "m-0" });

		const listed = await server.testInterface.callTool({
			params: { name: "directive_list", arguments: {} },
		});
		const text = getText(listed.content);
		assert.ok(
			text.includes("Archived directive values still on proposals (1):"),
		);
		assert.ok(text.includes("- m-0"));
	});

	it("treats duplicate active titles as unresolved in directive_list reporting", async () => {
		await writeLegacyDirectiveFile(server, "m-0", "Shared");
		await writeLegacyDirectiveFile(server, "m-1", "Shared");
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Ambiguous title proposal", directive: "Shared" },
			},
		});

		const listed = await server.testInterface.callTool({
			params: { name: "directive_list", arguments: {} },
		});
		const text = getText(listed.content);
		assert.ok(
			text.includes("Directives found on proposals without files (1):"),
		);
		assert.ok(text.includes("- Shared"));
	});

	it("allocates new directive IDs from directive frontmatter IDs before filename IDs", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(
				server.filesystem.directivesDir,
				"m-0 - mismatched-frontmatter-id.md",
			),
			`---
id: m-7
title: "Legacy frontmatter ID"
---

## Description

Directive: Legacy frontmatter ID
`,
		);

		const add = await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Next release" } },
		});
		expect(getText(add.content)).toContain("(m-8)");
	});

	it("treats reused title input as the active directive", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Shared" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "directive_add",
				arguments: { name: "Keep ID occupied" },
			},
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Archived proposal", directive: "Shared" },
			},
		});
		await server.testInterface.callTool({
			params: { name: "directive_archive", arguments: { name: "Shared" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Shared" } },
		});

		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Active proposal", directive: "Shared" },
			},
		});
		const activeProposalBeforeRemove = await server.getProposal("proposal-2");
		assert.strictEqual(activeProposalBeforeRemove?.directive, "m-2");

		await server.testInterface.callTool({
			params: { name: "directive_remove", arguments: { name: "Shared" } },
		});

		const archivedProposal = await server.getProposal("proposal-1");
		const activeProposal = await server.getProposal("proposal-2");
		assert.strictEqual(archivedProposal?.directive, "m-0");
		assert.strictEqual(activeProposal?.directive, undefined);
	});

	it("removes directives and clears or reassigns local proposals", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release A" } },
		});
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Release B" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "A", directive: "Release A" },
			},
		});

		const reassign = await server.testInterface.callTool({
			params: {
				name: "directive_remove",
				arguments: {
					name: "Release A",
					proposalHandling: "reassign",
					reassignTo: "Release B",
				},
			},
		});
		expect(getText(reassign.content)).toContain(
			'Removed directive "Release A" (m-0).',
		);
		expect(getText(reassign.content)).toContain("Reassigned 1 local proposal");

		const proposal1 = await server.getProposal("proposal-1");
		assert.strictEqual(proposal1?.directive, "m-1");

		// Now test clear behavior
		await server.testInterface.callTool({
			params: {
				name: "proposal_edit",
				arguments: { id: "proposal-1", directive: "Release B" },
			},
		});

		const clear = await server.testInterface.callTool({
			params: { name: "directive_remove", arguments: { name: "Release B" } },
		});
		expect(getText(clear.content)).toContain(
			'Removed directive "Release B" (m-1).',
		);
		expect(getText(clear.content)).toContain(
			"Cleared directive for 1 local proposal",
		);

		const cleared = await server.getProposal("proposal-1");
		assert.strictEqual(cleared?.directive, undefined);
	});

	it("can remove a directive file while keeping proposal directive values", async () => {
		await server.testInterface.callTool({
			params: { name: "directive_add", arguments: { name: "Keep Value" } },
		});
		await server.testInterface.callTool({
			params: {
				name: "proposal_create",
				arguments: { title: "Proposal", directive: "Keep Value" },
			},
		});

		const removeKeep = await server.testInterface.callTool({
			params: {
				name: "directive_remove",
				arguments: { name: "Keep Value", proposalHandling: "keep" },
			},
		});
		expect(getText(removeKeep.content)).toContain(
			'Removed directive "Keep Value" (m-0).',
		);
		expect(getText(removeKeep.content)).toContain(
			"Kept proposal directive values unchanged (proposalHandling=keep).",
		);

		const proposal = await server.getProposal("proposal-1");
		assert.strictEqual(proposal?.directive, "m-0");

		const activeDirectives = await server.filesystem.listDirectives();
		const archivedDirectives = await server.filesystem.listArchivedDirectives();
		assert.strictEqual(activeDirectives.length, 0);
		assert.strictEqual(archivedDirectives.length, 1);

		const list = await server.testInterface.callTool({
			params: { name: "directive_list", arguments: {} },
		});
		const text = getText(list.content);
		assert.ok(
			text.includes("Directives found on proposals without files (0):"),
		);
		assert.ok(
			text.includes("Archived directive values still on proposals (1):"),
		);
		assert.ok(text.includes("- m-0"));
	});
});
