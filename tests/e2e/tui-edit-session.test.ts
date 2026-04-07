import assert from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import type { Proposal, RoadmapConfig } from "../../src/types/index.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

function createMockScreen(): Parameters<Core["editProposalInTui"]>[1] {
	return {
		program: {
			disableMouse: () => {},
			enableMouse: () => {},
			hideCursor: () => {},
			showCursor: () => {},
			input: process.stdin,
			pause: () => () => {},
			flush: () => {},
			put: {
				keypad_local: () => {},
				keypad_xmit: () => {},
			},
		},
		leave: () => {},
		enter: () => {},
		render: () => {},
		clearRegion: () => {},
		width: 120,
		height: 40,
		emit: () => {},
	};
}

describe("Core.editProposalInTui", () => {
	let testDir: string;
	let core: Core;
	let proposalId: string;
	let originalEditor: string | undefined;
	const screen = createMockScreen();

	const setEditor = async (editorCommand: string) => {
		const config = await core.filesystem.loadConfig();
		if (!config) {
			throw new Error("Expected config to be initialized");
		}
		const updated: RoadmapConfig = {
			...config,
			defaultEditor: editorCommand,
		};
		await core.filesystem.saveConfig(updated);
	};

	const createEditorScript = async (
		name: string,
		source: string,
	): Promise<string> => {
		const scriptPath = join(testDir, name);
		await writeFile(scriptPath, source);
		return scriptPath;
	};

	beforeEach(async () => {
		originalEditor = process.env.EDITOR;
		delete process.env.EDITOR;

		testDir = createUniqueTestDir("test-tui-edit-session");
		await mkdir(testDir, { recursive: true });
		core = new Core(testDir, { enableWatchers: true });
		await core.initializeProject("TUI Edit Session Test");

		const proposal: Proposal = {
			id: "proposal-1",
			title: "Editor Flow Proposal",
			status: "Potential",
			assignee: [],
			createdDate: "2026-02-11 20:00",
			labels: [],
			dependencies: [],
			rawContent: "## Description\n\nOriginal body",
		};
		await core.createProposal(proposal, false);
		proposalId = proposal.id;
	});

	afterEach(async () => {
		if (originalEditor !== undefined) {
			process.env.EDITOR = originalEditor;
		} else {
			delete process.env.EDITOR;
		}
		await safeCleanup(testDir);
	});

	it("returns unchanged result when editor makes no file modifications", async () => {
		const noopScript = await createEditorScript(
			"noop-editor.js",
			"process.exit(0);\n",
		);
		await setEditor(`node ${noopScript}`);

		const result = await core.editProposalInTui(proposalId, screen);
		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.reason, undefined);

		const reloaded = await core.filesystem.loadProposal(proposalId);
		assert.strictEqual(reloaded?.updatedDate, undefined);
	});

	it("updates updated_date when editor changes proposal content", async () => {
		const editScript = await createEditorScript(
			"append-editor.js",
			`import { appendFileSync } from "node:fs";
const filePath = process.argv[2];
if (filePath) {
	appendFileSync(filePath, "\\nEdited from test\\n");
}
process.exit(0);
`,
		);
		await setEditor(`node ${editScript}`);

		const result = await core.editProposalInTui(proposalId, screen);
		assert.strictEqual(result.changed, true);
		assert.strictEqual(result.reason, undefined);
		assert.ok(result.proposal);
		assert.ok(result.proposal?.updatedDate);

		const proposalContent = await core.getProposalContent(proposalId);
		assert.ok(proposalContent?.includes("updated_date:"));
		assert.ok(proposalContent?.includes("Edited from test"));
	});

	it("returns editor_failed without mutating metadata when editor exits non-zero", async () => {
		const failScript = await createEditorScript(
			"fail-editor.js",
			"process.exit(2);\n",
		);
		await setEditor(`node ${failScript}`);

		const beforeContent = await core.getProposalContent(proposalId);
		const result = await core.editProposalInTui(proposalId, screen);
		const afterContent = await core.getProposalContent(proposalId);

		assert.strictEqual(result.changed, false);
		assert.strictEqual(result.reason, "editor_failed");
		assert.strictEqual(afterContent, beforeContent);

		const reloaded = await core.filesystem.loadProposal(proposalId);
		assert.strictEqual(reloaded?.updatedDate, undefined);
	});
});
