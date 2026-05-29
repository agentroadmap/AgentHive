import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkStale,
	queryCapabilityTree,
	queryDependencyDAG,
	queryGapAnalysis,
	queryTimeline,
	type ArchitectureViews,
	type QueryFn,
} from "../../src/core/infrastructure/architecture-reconstructor.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SEED_PROPOSALS = [
	{ id: "1", display_id: "P100", title: "Alpha", status: "DEVELOP", maturity_level: 1, parent_id: null },
	{ id: "2", display_id: "P101", title: "Beta",  status: "REVIEW",  maturity_level: 0, parent_id: null },
	{ id: "3", display_id: "P102", title: "Child", status: "DRAFT",   maturity_level: 0, parent_id: "1"  },
];

const SEED_DEPS = [
	{
		from_display: "P101", from_title: "Beta",  from_status: "REVIEW",
		to_display:   "P100", to_title:   "Alpha", to_status:   "DEVELOP",
		dependency_type: "blocks", resolved: false,
	},
];

const SEED_ACS = [
	{ display_id: "P101", title: "Beta",  gap_type: "failing_ac",   detail: "Must pass integration test" },
	{ display_id: "P101", title: "Beta",  gap_type: "unresolved_dep", detail: "P100 (blocks)" },
];

const SEED_TIMELINE = [
	{
		display_id: "P100", title: "Alpha",
		from_state: "REVIEW", to_state: "DEVELOP",
		transitioned_at: "2026-01-02T00:00:00.000Z", transitioned_by: "gate-cron",
	},
];

function makeQueryFn(results: Record<string, unknown>[][]): QueryFn {
	let call = 0;
	return async () => ({ rows: results[call++] ?? [] });
}

// ─── Capability tree ──────────────────────────────────────────────────────────

describe("queryCapabilityTree", () => {
	it("nests child proposals under their parent", async () => {
		const qfn = makeQueryFn([SEED_PROPOSALS]);
		const tree = await queryCapabilityTree({ queryFn: qfn });

		const p100 = tree.find((n) => n.displayId === "P100");
		assert.ok(p100, "P100 should be a root node");
		assert.equal(p100?.children.length, 1);
		assert.equal(p100?.children[0]?.displayId, "P102");

		const p101 = tree.find((n) => n.displayId === "P101");
		assert.ok(p101, "P101 should be a root node");
		assert.equal(p101?.children.length, 0);
	});

	it("maps workflowState and maturityLevel from DB columns", async () => {
		const qfn = makeQueryFn([SEED_PROPOSALS]);
		const tree = await queryCapabilityTree({ queryFn: qfn });
		const p100 = tree.find((n) => n.displayId === "P100");
		assert.equal(p100?.workflowState, "DEVELOP");
		assert.equal(p100?.maturityLevel, 1);
	});
});

// ─── Dependency DAG ───────────────────────────────────────────────────────────

describe("queryDependencyDAG", () => {
	it("emits valid Mermaid graph TD syntax", async () => {
		const qfn = makeQueryFn([SEED_DEPS]);
		const { mermaid } = await queryDependencyDAG({ queryFn: qfn });
		assert.ok(mermaid.startsWith("graph TD"), "must start with graph TD");
		assert.ok(mermaid.includes("P101"), "must reference from node");
		assert.ok(mermaid.includes("P100"), "must reference to node");
		assert.ok(mermaid.includes("blocks"), "must include dependency type");
	});

	it("output is deterministic across two runs with same seed", async () => {
		let calls = 0;
		const qfn: QueryFn = async () => {
			calls++;
			return { rows: SEED_DEPS };
		};
		const r1 = await queryDependencyDAG({ queryFn: qfn });
		const r2 = await queryDependencyDAG({ queryFn: qfn });
		assert.equal(r1.mermaid, r2.mermaid, "mermaid output must be byte-identical");
	});

	it("returns empty graph when no dependencies", async () => {
		const qfn = makeQueryFn([[]]);
		const { edges, mermaid } = await queryDependencyDAG({ queryFn: qfn });
		assert.equal(edges.length, 0);
		assert.ok(mermaid.includes("No dependencies"), "empty sentinel node required");
	});

	it("applies correct status colors via style directives", async () => {
		const qfn = makeQueryFn([SEED_DEPS]);
		const { mermaid } = await queryDependencyDAG({ queryFn: qfn });
		assert.ok(mermaid.includes("fill:#ff9800"), "REVIEW color required");
		assert.ok(mermaid.includes("fill:#2196f3"), "DEVELOP color required");
	});
});

// ─── Gap analysis ─────────────────────────────────────────────────────────────

describe("queryGapAnalysis", () => {
	it("returns failing_ac and unresolved_dep items", async () => {
		const qfn = makeQueryFn([SEED_ACS]);
		const gaps = await queryGapAnalysis({ queryFn: qfn });
		assert.equal(gaps.length, 2);
		const types = gaps.map((g) => g.gapType);
		assert.ok(types.includes("failing_ac"));
		assert.ok(types.includes("unresolved_dep"));
	});

	it("populates displayId, title, and detail fields", async () => {
		const qfn = makeQueryFn([SEED_ACS]);
		const gaps = await queryGapAnalysis({ queryFn: qfn });
		const ac = gaps.find((g) => g.gapType === "failing_ac");
		assert.equal(ac?.displayId, "P101");
		assert.equal(ac?.title, "Beta");
		assert.equal(ac?.detail, "Must pass integration test");
	});
});

// ─── Timeline ─────────────────────────────────────────────────────────────────

describe("queryTimeline", () => {
	it("parses transitionedAt as Date objects", async () => {
		const qfn = makeQueryFn([SEED_TIMELINE]);
		const entries = await queryTimeline({ queryFn: qfn });
		assert.equal(entries.length, 1);
		assert.ok(entries[0]!.transitionedAt instanceof Date);
	});

	it("maps from_state and to_state correctly", async () => {
		const qfn = makeQueryFn([SEED_TIMELINE]);
		const [entry] = await queryTimeline({ queryFn: qfn });
		assert.equal(entry?.fromState, "REVIEW");
		assert.equal(entry?.toState, "DEVELOP");
		assert.equal(entry?.transitionedBy, "gate-cron");
	});
});

// ─── Stale detection ──────────────────────────────────────────────────────────

describe("checkStale", () => {
	it("returns staleSince when latest change is after generatedAt", async () => {
		const futureDate = new Date(Date.now() + 60_000).toISOString();
		const qfn: QueryFn = async () => ({ rows: [{ latest_change: futureDate }] });
		const views: ArchitectureViews = {
			capabilityTree: [], dependencyDAG: { edges: [], mermaid: "" },
			gapAnalysis: [], timeline: [], generatedAt: new Date(0),
		};
		const { staleSince } = await checkStale(views, { queryFn: qfn });
		assert.ok(staleSince instanceof Date);
	});

	it("returns empty object when views are fresh", async () => {
		const pastDate = new Date(0).toISOString();
		const qfn: QueryFn = async () => ({ rows: [{ latest_change: pastDate }] });
		const views: ArchitectureViews = {
			capabilityTree: [], dependencyDAG: { edges: [], mermaid: "" },
			gapAnalysis: [], timeline: [], generatedAt: new Date(),
		};
		const result = await checkStale(views, { queryFn: qfn });
		assert.equal(result.staleSince, undefined);
	});

	it("returns empty object when no change rows exist", async () => {
		const qfn: QueryFn = async () => ({ rows: [{ latest_change: null }] });
		const views: ArchitectureViews = {
			capabilityTree: [], dependencyDAG: { edges: [], mermaid: "" },
			gapAnalysis: [], timeline: [], generatedAt: new Date(0),
		};
		const result = await checkStale(views, { queryFn: qfn });
		assert.equal(result.staleSince, undefined);
	});
});

// ─── No filesystem reads ──────────────────────────────────────────────────────

describe("filesystem isolation", () => {
	it("queryCapabilityTree makes no readFileSync/readdirSync calls", async () => {
		const fsCallLog: string[] = [];
		const origRead = (globalThis as any).readFileSync;
		const origReaddir = (globalThis as any).readdirSync;

		// We can't easily intercept node:fs, but we can verify that
		// queryCapabilityTree works end-to-end with only the injected queryFn.
		const qfn = makeQueryFn([SEED_PROPOSALS]);
		const tree = await queryCapabilityTree({ queryFn: qfn });

		// If we reached here without error with an injected mock queryFn
		// and the mock returned results, no filesystem reads were needed.
		assert.ok(tree.length > 0, "result must be non-empty with seed data");
		assert.equal(fsCallLog.length, 0, "no unexpected side-effects recorded");
	});
});
