import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildKanbanStatusGroups,
	exportKanbanBoardToFile,
	generateDirectiveGroupedBoard,
} from "../../src/board.ts";
import type { Directive, Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

describe("exportKanbanBoardToFile", () => {
	it("creates file and overwrites board content", async () => {
		const dir = await mkdtemp(join(tmpdir(), "board-export-"));
		const file = join(dir, "README.md");
		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "First",
				status: "Potential",
				assignee: [],
				createdDate: "",
				labels: [],
				dependencies: [],
			},
		];

		await exportKanbanBoardToFile(
			proposals,
			["Potential"],
			file,
			"TestProject",
		);
		const initial = await await readFile(file, "utf-8");
		assert.ok(initial.includes("proposal-1"));
		assert.ok(
			initial.includes("# Kanban Board Export (powered by Roadmap.md)"),
		);
		assert.ok(initial.includes("Project: TestProject"));

		await exportKanbanBoardToFile(
			proposals,
			["Potential"],
			file,
			"TestProject",
		);
		const second = await await readFile(file, "utf-8");
		const occurrences = second.split("proposal-1").length - 1;
		assert.strictEqual(occurrences, 1); // Should overwrite, not append

		await rm(dir, { recursive: true, force: true });
	});

	it("sorts all columns by updatedDate descending, then by ID", async () => {
		const dir = await mkdtemp(join(tmpdir(), "board-export-"));
		const file = join(dir, "README.md");
		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "First",
				status: "Potential",
				assignee: [],
				createdDate: "2025-01-01",
				updatedDate: "2025-01-08 10:00",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-3",
				title: "Third",
				status: "Potential",
				assignee: [],
				createdDate: "2025-01-03",
				updatedDate: "2025-01-09 10:00",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-2",
				title: "Second",
				status: "Complete",
				assignee: [],
				createdDate: "2025-01-02",
				updatedDate: "2025-01-10 12:00",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-4",
				title: "Fourth",
				status: "Complete",
				assignee: [],
				createdDate: "2025-01-04",
				updatedDate: "2025-01-05 10:00",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-5",
				title: "Fifth",
				status: "Complete",
				assignee: [],
				createdDate: "2025-01-05",
				updatedDate: "2025-01-10 14:00",
				labels: [],
				dependencies: [],
			},
		];

		await exportKanbanBoardToFile(
			proposals,
			["Potential", "Complete"],
			file,
			"TestProject",
		);
		const content = await await readFile(file, "utf-8");

		// Split content into lines for easier testing
		const lines = content.split("\n");

		// Find rows containing our proposals (updated to match uppercase format)
		const proposal1Row = lines.find((line) => line.includes("proposal-1"));
		const proposal3Row = lines.find((line) => line.includes("proposal-3"));
		const proposal2Row = lines.find((line) => line.includes("proposal-2"));
		const proposal4Row = lines.find((line) => line.includes("proposal-4"));
		const proposal5Row = lines.find((line) => line.includes("proposal-5"));

		if (
			!proposal1Row ||
			!proposal2Row ||
			!proposal3Row ||
			!proposal4Row ||
			!proposal5Row
		) {
			throw new Error(
				"Expected proposal rows not found in exported board content",
			);
		}

		// Check that Potential proposals are ordered by updatedDate (proposal-3 has newer date than proposal-1)
		const proposal3Index = lines.indexOf(proposal3Row);
		const proposal1Index = lines.indexOf(proposal1Row);
		assert.ok(proposal3Index < proposal1Index);

		// Check that Complete proposals are ordered by updatedDate
		const proposal5Index = lines.indexOf(proposal5Row);
		const proposal2Index = lines.indexOf(proposal2Row);
		const proposal4Index = lines.indexOf(proposal4Row);
		assert.ok(proposal5Index < proposal2Index); // proposal-5 before proposal-2
		assert.ok(proposal2Index < proposal4Index); // proposal-2 before proposal-4

		await rm(dir, { recursive: true, force: true });
	});

	it("formats proposals with new styling rules", async () => {
		const dir = await mkdtemp(join(tmpdir(), "board-export-"));
		const file = join(dir, "README.md");
		const proposals: Proposal[] = [
			{
				id: "proposal-204",
				title: "Test Proposal",
				status: "Potential",
				assignee: ["alice", "bob"],
				createdDate: "2025-01-01",
				labels: ["enhancement", "ui"],
				dependencies: [],
			},
			{
				id: "proposal-205",
				title: "Subproposal Example",
				status: "Potential",
				assignee: [],
				createdDate: "2025-01-02",
				labels: [],
				dependencies: [],
				parentProposalId: "proposal-204",
			},
		];

		await exportKanbanBoardToFile(
			proposals,
			["Potential"],
			file,
			"TestProject",
		);
		const content = await await readFile(file, "utf-8");

		// Check uppercase proposal IDs
		assert.ok(content.includes("**proposal-204**"));
		assert.ok(content.includes("└─ **proposal-205**"));

		// Check assignee formatting with @ prefix
		assert.ok(content.includes("[@alice, @bob]"));

		// Check label formatting with # prefix and italics
		assert.ok(content.includes("*#enhancement #ui*"));

		// Check that proposals without assignees/labels don't have empty brackets
		assert.ok(!content.includes("[]"));
		assert.ok(!content.includes("**proposal-205** - Subproposal Example<br>"));

		await rm(dir, { recursive: true, force: true });
	});

	it("handles assignees with existing @ symbols correctly", async () => {
		const dir = await mkdtemp(join(tmpdir(), "board-export-"));
		const file = join(dir, "README.md");
		const proposals: Proposal[] = [
			{
				id: "proposal-100",
				title: "Test @ Handling",
				status: "Potential",
				assignee: ["@claude", "alice", "@bob"],
				createdDate: "2025-01-01",
				labels: [],
				dependencies: [],
			},
		];

		await exportKanbanBoardToFile(
			proposals,
			["Potential"],
			file,
			"TestProject",
		);
		const content = await await readFile(file, "utf-8");

		// Check that we don't get double @ symbols
		assert.ok(content.includes("[@claude, @alice, @bob]"));
		assert.ok(!content.includes("@@claude"));
		assert.ok(!content.includes("@@bob"));

		await rm(dir, { recursive: true, force: true });
	});
});

describe("buildKanbanStatusGroups", () => {
	it("returns configured statuses even when there are no proposals", () => {
		const { orderedStatuses, groupedProposals } = buildKanbanStatusGroups(
			[],
			["Potential", "Active", "Accepted", "Complete", "Abandoned"],
		);
		assert.deepStrictEqual(orderedStatuses, [
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		]);
		assert.deepStrictEqual(groupedProposals.get("Potential"), []);
		assert.deepStrictEqual(groupedProposals.get("Active"), []);
		assert.deepStrictEqual(groupedProposals.get("Complete"), []);
	});

	it("appends unknown statuses from proposals after configured ones", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "Blocked Proposal",
				status: "Blocked",
				assignee: [],
				createdDate: "2025-01-02",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-2",
				title: "Lowercase todo",
				status: "potential",
				assignee: [],
				createdDate: "2025-01-03",
				labels: [],
				dependencies: [],
			},
		];

		const { orderedStatuses, groupedProposals } = buildKanbanStatusGroups(
			proposals,
			["Potential"],
		);
		assert.deepStrictEqual(orderedStatuses, ["Potential", "Blocked"]);
		expect(groupedProposals.get("Potential")?.map((t) => t.id)).toEqual([
			"proposal-2",
		]);
		expect(groupedProposals.get("Blocked")?.map((t) => t.id)).toEqual([
			"proposal-1",
		]);
	});
});

describe("generateDirectiveGroupedBoard", () => {
	it("groups directive ID and title aliases into one section using file title", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "By ID",
				status: "Potential",
				assignee: [],
				createdDate: "2026-01-01",
				labels: [],
				dependencies: [],
				directive: "m-0",
			},
			{
				id: "proposal-2",
				title: "By title",
				status: "Potential",
				assignee: [],
				createdDate: "2026-01-01",
				labels: [],
				dependencies: [],
				directive: "Release 1.0",
			},
		];
		const directives: Directive[] = [
			{
				id: "m-0",
				title: "Release 1.0",
				description: "Directive: Release 1.0",
				rawContent: "## Description\n\nDirective: Release 1.0",
			},
		];

		const board = generateDirectiveGroupedBoard(
			proposals,
			["Potential"],
			directives,
			"Test Project",
		);
		expect(board.match(/## Release 1\.0 \(\d+ proposals\)/g)?.length).toBe(1);
		assert.ok(board.includes("**proposal-1** - By ID"));
		assert.ok(board.includes("**proposal-2** - By title"));
	});

	it("keeps ambiguous reused directive titles as separate sections", () => {
		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "Active by ID",
				status: "Potential",
				assignee: [],
				createdDate: "2026-01-01",
				labels: [],
				dependencies: [],
				directive: "m-2",
			},
			{
				id: "proposal-2",
				title: "Title alias",
				status: "Potential",
				assignee: [],
				createdDate: "2026-01-01",
				labels: [],
				dependencies: [],
				directive: "Shared",
			},
		];
		const directives: Directive[] = [
			{
				id: "m-2",
				title: "Shared",
				description: "Directive: Shared",
				rawContent: "## Description\n\nDirective: Shared",
			},
			{
				id: "m-0",
				title: "Shared",
				description: "Directive: Shared (archived)",
				rawContent: "## Description\n\nDirective: Shared (archived)",
			},
		];

		const board = generateDirectiveGroupedBoard(
			proposals,
			["Potential"],
			directives,
			"Test Project",
		);
		expect(board.match(/## Shared \(\d+ proposals\)/g)?.length).toBe(2);
	});
});
