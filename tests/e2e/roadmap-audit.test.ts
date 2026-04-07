import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { auditRoadmap, type ProposalInfo } from "../../src/core/dag/scout.ts";

describe("Roadmap Audit", () => {
	test("identifies orphan proposals", () => {
		const proposals: ProposalInfo[] = [
			{
				id: "proposal-0",
				title: "Vision",
				status: "Complete",
				dependencies: [],
				labels: ["vision"],
			},
			{
				id: "proposal-1",
				title: "Orphan",
				status: "Potential",
				dependencies: [],
				labels: [],
			},
			{
				id: "proposal-2",
				title: "Connected",
				status: "Potential",
				dependencies: ["proposal-0"],
				labels: [],
			},
		];

		const result = auditRoadmap(proposals);
		assert.equal(result.orphans.length, 1);
		assert.equal(result.orphans[0]?.id, "proposal-1");
	});

	test("identifies dead ends", () => {
		const proposals: ProposalInfo[] = [
			{
				id: "proposal-0",
				title: "Vision",
				status: "Complete",
				dependencies: [],
				labels: ["vision"],
			},
			{
				id: "proposal-1",
				title: "Dead End",
				status: "Complete",
				dependencies: ["proposal-0"],
				labels: [],
			},
			{
				id: "proposal-2",
				title: "Terminal",
				status: "Complete",
				dependencies: ["proposal-0"],
				labels: ["terminal"],
			},
		];

		const result = auditRoadmap(proposals);
		// proposal-1 is complete but has no descendants and isn't terminal
		assert.equal(result.deadEnds.length, 1);
		assert.equal(result.deadEnds[0]?.id, "proposal-1");
	});

	test("identifies broken dependencies", () => {
		const proposals: ProposalInfo[] = [
			{
				id: "proposal-1",
				title: "Broken",
				status: "Potential",
				dependencies: ["MISSING-404"],
				labels: [],
			},
		];

		const result = auditRoadmap(proposals);
		assert.equal(result.brokenDependencies.length, 1);
		assert.equal(result.brokenDependencies[0].missingId, "MISSING-404");
	});

	test("reports clean roadmap correctly", () => {
		const proposals: ProposalInfo[] = [
			{
				id: "proposal-0",
				title: "Seed",
				status: "Complete",
				dependencies: [],
				labels: ["vision"],
			},
			{
				id: "proposal-1",
				title: "Step 1",
				status: "Complete",
				dependencies: ["proposal-0"],
				labels: [],
			},
			{
				id: "proposal-2",
				title: "Terminal",
				status: "Potential",
				dependencies: ["proposal-1"],
				labels: ["terminal"],
			},
		];

		const result = auditRoadmap(proposals);
		assert.equal(result.orphans.length, 0);
		assert.equal(result.deadEnds.length, 0);
		assert.equal(result.brokenDependencies.length, 0);
		assert.ok(result.summary.includes("✅"));
	});
});
