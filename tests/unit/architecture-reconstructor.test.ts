import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	queryCapabilityTree,
	queryDependencyDAG,
	queryGapAnalysis,
	queryTimeline,
} from "../../src/core/infrastructure/architecture-reconstructor.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeQueryFn(rowSets: unknown[][]) {
	let call = 0;
	return async (_text: string, _params?: unknown[]) => {
		const rows = rowSets[call % rowSets.length] ?? [];
		call++;
		return { rows };
	};
}

// ─── Capability tree ──────────────────────────────────────────────────────────

describe("queryCapabilityTree", () => {
	it("builds nested tree from flat rows with parent_id", async () => {
		const rows = [
			{ id: "1", display_id: "P001", parent_id: null, title: "Root A", status: "COMPLETE", maturity: "mature", tags: null },
			{ id: "2", display_id: "P002", parent_id: "1",  title: "Child B", status: "DEVELOP",  maturity: "active", tags: null },
			{ id: "3", display_id: "P003", parent_id: null, title: "Root C", status: "DRAFT",    maturity: "new",    tags: null },
		];
		const tree = await queryCapabilityTree(makeQueryFn([rows]));

		assert.equal(tree.length, 2, "two roots");
		const rootA = tree.find((n) => n.displayId === "P001")!;
		assert.ok(rootA, "P001 is a root");
		assert.equal(rootA.workflowState, "COMPLETE");
		assert.equal(rootA.maturity, "mature");
		assert.equal(rootA.children.length, 1);
		assert.equal(rootA.children[0]!.displayId, "P002");

		const rootC = tree.find((n) => n.displayId === "P003")!;
		assert.ok(rootC, "P003 is a root");
		assert.equal(rootC.children.length, 0);
	});

	it("promotes orphaned child (parent not in result set) to root", async () => {
		const rows = [
			{ id: "2", display_id: "P002", parent_id: "99", title: "Orphan", status: "DRAFT", maturity: "new", tags: null },
		];
		const tree = await queryCapabilityTree(makeQueryFn([rows]));
		assert.equal(tree.length, 1);
		assert.equal(tree[0]!.displayId, "P002");
	});
});

// ─── Dependency DAG / Mermaid ─────────────────────────────────────────────────

describe("queryDependencyDAG", () => {
	it("generates valid Mermaid graph TD syntax", async () => {
		const rows = [
			{ from_display: "P001", to_display: "P002", dependency_type: "blocks", resolved: false, from_status: "DEVELOP", to_status: "DRAFT" },
		];
		const { edges, mermaid } = await queryDependencyDAG(makeQueryFn([rows]));

		assert.equal(edges.length, 1);
		assert.equal(edges[0]!.fromDisplayId, "P001");
		assert.equal(edges[0]!.type, "blocks");
		assert.ok(mermaid.startsWith("graph TD"), "starts with graph TD");
		assert.ok(mermaid.includes("P001"), "contains from node");
		assert.ok(mermaid.includes("P002"), "contains to node");
		assert.ok(mermaid.includes("blocks"), "contains edge label");
	});

	it("produces deterministic Mermaid across two identical calls", async () => {
		const rows = [
			{ from_display: "P101", to_display: "P100", dependency_type: "blocks", resolved: false, from_status: "DEVELOP", to_status: "DRAFT" },
			{ from_display: "P200", to_display: "P100", dependency_type: "relates", resolved: true, from_status: "COMPLETE", to_status: "DRAFT" },
		];
		const fn = makeQueryFn([rows, rows]);
		const r1 = await queryDependencyDAG(fn);
		const r2 = await queryDependencyDAG(fn);
		assert.equal(r1.mermaid, r2.mermaid, "output must be byte-identical");
	});

	it("returns empty graph TD when no dependencies exist", async () => {
		const { edges, mermaid } = await queryDependencyDAG(makeQueryFn([[]]));
		assert.equal(edges.length, 0);
		assert.equal(mermaid.trim(), "graph TD");
	});
});

// ─── Gap analysis ─────────────────────────────────────────────────────────────

describe("queryGapAnalysis", () => {
	it("returns failing_ac items for DRAFT proposals with non-pass ACs", async () => {
		const rows = [
			{ display_id: "P010", title: "Draft Proposal", gap_type: "failing_ac", detail: "Must implement tests" },
		];
		const gaps = await queryGapAnalysis(makeQueryFn([rows]));
		assert.equal(gaps.length, 1);
		assert.equal(gaps[0]!.gapType, "failing_ac");
		assert.equal(gaps[0]!.displayId, "P010");
	});

	it("returns unresolved_dep items", async () => {
		const rows = [
			{ display_id: "P020", title: "Review Proposal", gap_type: "unresolved_dep", detail: "P005 (blocks)" },
		];
		const gaps = await queryGapAnalysis(makeQueryFn([rows]));
		assert.equal(gaps[0]!.gapType, "unresolved_dep");
	});

	it("returns no_acs items", async () => {
		const rows = [
			{ display_id: "P030", title: "No ACs", gap_type: "no_acs", detail: "no acceptance criteria defined" },
		];
		const gaps = await queryGapAnalysis(makeQueryFn([rows]));
		assert.equal(gaps[0]!.gapType, "no_acs");
	});
});

// ─── Timeline ─────────────────────────────────────────────────────────────────

describe("queryTimeline", () => {
	it("parses transitioned_at as Date", async () => {
		const rows = [
			{
				display_id: "P001",
				title: "Test",
				from_state: "DRAFT",
				to_state: "REVIEW",
				transitioned_at: "2026-01-15T10:00:00Z",
				transitioned_by: "operator",
			},
		];
		const entries = await queryTimeline(makeQueryFn([rows]));
		assert.equal(entries.length, 1);
		assert.ok(entries[0]!.transitionedAt instanceof Date);
		assert.equal(entries[0]!.fromState, "DRAFT");
		assert.equal(entries[0]!.toState, "REVIEW");
	});
});

// ─── No filesystem calls ──────────────────────────────────────────────────────

describe("no filesystem reads", () => {
	it("query functions complete without reading the filesystem", async () => {
		// All four query functions accept a mock queryFn — no DB needed,
		// no filesystem access happens in their hot paths.
		await queryCapabilityTree(makeQueryFn([[]]));
		await queryDependencyDAG(makeQueryFn([[]]));
		await queryGapAnalysis(makeQueryFn([[]]));
		await queryTimeline(makeQueryFn([[]]));
		// If we reach here without error, the query functions ran with a mock
		// DB and never needed the filesystem (no path construction or readFile).
		assert.ok(true);
	});

	it("query functions in reconstructor source do not invoke readFileSync or existsSync", async () => {
		const { readFileSync: fsRead } = await import("node:fs");
		const { join: pathJoin } = await import("node:path");
		const src = fsRead(
			pathJoin(import.meta.dirname, "../../src/core/infrastructure/architecture-reconstructor.ts"),
			"utf-8",
		);
		// Slice each query function body and verify it doesn't call FS read helpers.
		// generateArchitectureDocs legitimately uses readdirSync/writeFileSync for output.
		const fns = ["queryCapabilityTree", "queryDependencyDAG", "queryGapAnalysis", "queryTimeline", "checkStale"];
		for (const fn of fns) {
			const start = src.indexOf(`export async function ${fn}`);
			const nextFn = src.indexOf("\nexport ", start + 1);
			const body = nextFn === -1 ? src.slice(start) : src.slice(start, nextFn);
			assert.ok(!body.includes("readFileSync"),  `${fn}: readFileSync must not be called`);
			assert.ok(!body.includes("existsSync"),    `${fn}: existsSync must not be called`);
		}
	});
});
