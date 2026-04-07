import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { extractStructuredSection } from "../../src/markdown/structured-sections.ts";
import {
	buildCliCommand,
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Append Implementation Notes via proposal edit --append-notes", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-append-notes");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		execSync(`git init -b main`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email "test@example.com"`, { cwd: TEST_DIR });

		const core = new Core(TEST_DIR);
		await core.initializeProject("Append Notes Test Project");
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// ignore
		}
	});

	it("appends to existing Implementation Notes with single blank line separation", async () => {
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-1",
				title: "Existing notes",
				status: "Potential",
				assignee: [],
				createdDate: "2025-09-10 00:00",
				labels: [],
				dependencies: [],
				description: "Test description",
				implementationNotes: "Original notes",
			},
			false,
		);

		// Append twice in one call and once again afterwards
		let res = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal edit 1 --append-notes "First addition" --append-notes "Second addition"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		res = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal edit 1 --append-notes "Third addition"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		const updatedBody = await core.getProposalContent("proposal-1");
		assert.notStrictEqual(updatedBody, null);

		const body =
			extractStructuredSection(updatedBody ?? "", "implementationNotes") || "";
		assert.strictEqual(
			body,
			"Original notes\n\nFirst addition\n\nSecond addition\n\nThird addition",
		);
	});

	it("creates Implementation Notes at correct position when missing (after Plan)", async () => {
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-2",
				title: "No notes yet",
				status: "Potential",
				assignee: [],
				createdDate: "2025-09-10 00:00",
				labels: [],
				dependencies: [],
				description: "Desc here",
				acceptanceCriteriaItems: [{ index: 1, text: "Do X", checked: false }],
				implementationPlan: "1. A\n2. B",
			},
			false,
		);

		const res = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal edit 2 --append-notes "Notes after plan"`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		const content = (await core.getProposalContent("proposal-2")) ?? "";
		const notesContent =
			extractStructuredSection(content, "implementationNotes") || "";
		assert.strictEqual(notesContent, "Notes after plan");
		const planMarker = "<!-- SECTION:PLAN:BEGIN -->";
		const notesMarker = "<!-- SECTION:NOTES:BEGIN -->";
		expect(content.indexOf(planMarker)).toBeGreaterThan(-1);
		expect(content.indexOf(notesMarker)).toBeGreaterThan(
			content.indexOf(planMarker),
		);
	});

	it("supports multi-line appended content and preserves literal newlines", async () => {
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-3",
				title: "Multiline append",
				status: "Potential",
				assignee: [],
				createdDate: "2025-09-10 00:00",
				labels: [],
				dependencies: [],
				description: "Simple description",
			},
			false,
		);

		// Pass a JS string containing real newlines as an argument
		const multiline = "Line1\nLine2\n\nPara2";
		const res = execSync(
			`node --experimental-strip-types ${buildCliCommand([CLI_PATH, "proposal", "edit", "3", "--append-notes", multiline])}`,
			{ cwd: TEST_DIR },
		);
		assert.strictEqual(res.exitCode, 0);

		const updatedBody = await core.getProposalContent("proposal-3");
		const body =
			extractStructuredSection(updatedBody ?? "", "implementationNotes") || "";
		assert.ok(body.includes("Line1\nLine2\n\nPara2"));
	});

	it("allows combining --notes (replace) with --append-notes (append)", async () => {
		const core = new Core(TEST_DIR);
		await core.createProposal(
			{
				id: "proposal-4",
				title: "Mix flags",
				status: "Potential",
				assignee: [],
				createdDate: "2025-09-10 00:00",
				labels: [],
				dependencies: [],
				description: "Description only",
			},
			false,
		);

		const res = execSync(
			`node --experimental-strip-types ${CLI_PATH} proposal edit 4 --notes "Replace" --append-notes "Append"`,
			{ cwd: TEST_DIR },
		);

		// Should succeed: --notes replaces existing, then --append-notes appends
		assert.strictEqual(res.exitCode, 0);
		const updatedBody = await core.getProposalContent("proposal-4");
		const body =
			extractStructuredSection(updatedBody ?? "", "implementationNotes") || "";
		assert.strictEqual(body, "Replace\n\nAppend");
	});
});
