/**
 * P405 AC-28: snapshot tests — seed from fixture, assert deterministic output.
 *
 * To regenerate the fixture after an intentional schema change:
 *   UPDATE_SNAPSHOTS=1 node --import jiti/register --test tests/unit/arch-reconstructor.snapshot.test.ts
 */

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	queryCapabilityTree,
	queryDependencyDAG,
	queryGapAnalysis,
} from "../../src/core/infrastructure/architecture-reconstructor.ts";
import type { QueryFn } from "../../src/core/infrastructure/architecture-reconstructor.ts";

const FIXTURE_PATH = join(
	import.meta.dirname,
	"../fixtures/arch-views-snapshot.json",
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fixture = JSON.parse(
	(await import("node:fs")).readFileSync(FIXTURE_PATH, "utf-8"),
) as {
	seed: {
		proposals: unknown[];
		dependencies: unknown[];
		gap_rows: unknown[];
	};
	expected: {
		capabilityTree: unknown;
		dependencyDAG: { edges: unknown[]; mermaid: string };
		gapAnalysis: unknown[];
	};
};

function makeSingleFn(rows: unknown[]): QueryFn {
	return async () => ({ rows });
}

describe("P405 arch-reconstructor snapshot", () => {
	it("capability tree matches fixture", async () => {
		const tree = await queryCapabilityTree(
			makeSingleFn(fixture.seed.proposals),
		);
		assert.deepEqual(tree, fixture.expected.capabilityTree);
	});

	it("dependency DAG edges match fixture", async () => {
		const { edges } = await queryDependencyDAG(
			makeSingleFn(fixture.seed.dependencies),
		);
		assert.deepEqual(edges, fixture.expected.dependencyDAG.edges);
	});

	it("dependency DAG mermaid is deterministic across two runs", async () => {
		const fn1 = makeSingleFn(fixture.seed.dependencies);
		const fn2 = makeSingleFn(fixture.seed.dependencies);
		const r1 = await queryDependencyDAG(fn1);
		const r2 = await queryDependencyDAG(fn2);
		assert.equal(r1.mermaid, r2.mermaid, "mermaid output must be byte-identical");
	});

	it("gap analysis matches fixture", async () => {
		const gaps = await queryGapAnalysis(makeSingleFn(fixture.seed.gap_rows));
		assert.deepEqual(gaps, fixture.expected.gapAnalysis);
	});
});

// When UPDATE_SNAPSHOTS=1, regenerate fixture from current output
if (process.env.UPDATE_SNAPSHOTS === "1") {
	const tree = await queryCapabilityTree(makeSingleFn(fixture.seed.proposals));
	const dag  = await queryDependencyDAG(makeSingleFn(fixture.seed.dependencies));
	const gaps = await queryGapAnalysis(makeSingleFn(fixture.seed.gap_rows));

	fixture.expected.capabilityTree = tree;
	fixture.expected.dependencyDAG  = dag;
	fixture.expected.gapAnalysis    = gaps;

	writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n");
	console.error("[arch-snapshot] fixture regenerated");
}
