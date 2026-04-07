import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as scout from "../../src/core/dag/scout.ts";

const TEST_DIR = join(process.cwd(), "tmp", "test-scout");
const STATES_DIR = join(TEST_DIR, "roadmap", "proposals");

describe("Scout Module", () => {
	beforeEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
		mkdirSync(STATES_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	it("should parse a proposal file correctly", () => {
		const content = `---
id: 1.0
title: Proposal 1.0
status: Potential
dependencies: []
labels: [tag1, tag2]
directive: m-1
unlocks: [Capability A]
needs_capabilities: [Cap B]
---

## Description

Test description for 1.0
`;
		writeFileSync(join(STATES_DIR, "proposal-1.0.md"), content);
		const proposal = scout.parseProposalFile(
			join(STATES_DIR, "proposal-1.0.md"),
		);

		assert.ok(proposal);
		assert.equal(proposal?.id, "1.0");
		assert.equal(proposal?.directive, "m-1");
		assert.deepEqual(proposal?.labels, ["tag1", "tag2"]);
		assert.deepEqual(proposal?.unlocks, ["Capability A"]);
		assert.deepEqual(proposal?.needs_capabilities, ["Cap B"]);
	});

	it("should find gaps in the roadmap", () => {
		const proposals: scout.ProposalInfo[] = [
			{
				id: "1",
				title: "S1",
				status: "Potential",
				dependencies: [],
				labels: [],
				needs_capabilities: ["Cap X"],
				unlocks: [],
			},
		];
		const gaps = scout.findGaps(proposals);
		assert.equal(gaps.length, 1);
		assert.ok(gaps[0]?.includes("Cap X"));
	});

	it("should suggest directive based on depth", () => {
		const s1: scout.ProposalInfo = {
			id: "1",
			title: "S1",
			status: "Potential",
			dependencies: [],
			labels: [],
			unlocks: [],
		};
		const s2: scout.ProposalInfo = {
			id: "2",
			title: "S2",
			status: "Potential",
			dependencies: ["1"],
			labels: [],
			unlocks: [],
		};
		const s3: scout.ProposalInfo = {
			id: "3",
			title: "S3",
			status: "Potential",
			dependencies: ["2"],
			labels: [],
			unlocks: [],
		};

		const all = [s1, s2, s3];
		assert.equal(scout.suggestDirective(s1, all), "m-1");
		assert.equal(scout.suggestDirective(s2, all), "m-3");
		assert.equal(scout.suggestDirective(s3, all), "m-3"); // depth 2
	});

	it("should generate proposals for unimplemented unlocks", () => {
		const inputProposals: scout.ProposalInfo[] = [
			{
				id: "1",
				title: "S1",
				status: "Complete",
				dependencies: [],
				labels: ["existing"],
				unlocks: ["New Tech"],
				needs_capabilities: [],
			},
		];
		const proposals = scout.generateProposals(inputProposals);
		assert.equal(proposals.length, 1);
		assert.equal(proposals[0]?.title, "Implement New Tech");
		assert.equal(proposals[0]?.type, "proposal");
	});

	it("should detect bottlenecks and generate obstacle proposals", () => {
		const input: scout.ProposalInfo[] = [
			{
				id: "B",
				title: "Bottleneck",
				status: "Potential",
				dependencies: [],
				labels: [],
				unlocks: [],
			},
			{
				id: "1",
				title: "S1",
				status: "Potential",
				dependencies: ["B"],
				labels: [],
				unlocks: [],
			},
			{
				id: "2",
				title: "S2",
				status: "Potential",
				dependencies: ["B"],
				labels: [],
				unlocks: [],
			},
			{
				id: "3",
				title: "S3",
				status: "Potential",
				dependencies: ["B"],
				labels: [],
				unlocks: [],
			},
		];
		const proposals = scout.generateProposals(input);
		const bottleneck = proposals.find((p) => p.type === "obstacle");
		assert.ok(bottleneck);
		assert.ok(bottleneck?.title.includes("Bottleneck"));
	});

	it("should audit the roadmap and find orphans and dead ends", () => {
		const s1: scout.ProposalInfo = {
			id: "proposal-1",
			title: "S1",
			status: "Complete",
			dependencies: [],
			labels: [],
			unlocks: [],
		};
		const s2: scout.ProposalInfo = {
			id: "proposal-2",
			title: "S2",
			status: "Complete",
			dependencies: ["proposal-1"],
			labels: [],
			unlocks: [],
		};
		const sOrphan: scout.ProposalInfo = {
			id: "proposal-99",
			title: "Orphan",
			status: "Potential",
			dependencies: [],
			labels: [],
			unlocks: [],
		};

		const result = scout.auditRoadmap([s1, s2, sOrphan]);
		assert.equal(result.orphans.length, 1);
		assert.equal(result.orphans[0]?.id, "proposal-99");
		assert.equal(result.deadEnds.length, 1);
		assert.equal(result.deadEnds[0]?.id, "proposal-2");
	});

	it("should detect broken dependencies in audit", () => {
		const s1: scout.ProposalInfo = {
			id: "1",
			title: "S1",
			status: "Potential",
			dependencies: ["MISSING"],
			labels: [],
			unlocks: [],
		};
		const result = scout.auditRoadmap([s1]);
		assert.equal(result.brokenDependencies.length, 1);
		assert.equal(result.brokenDependencies[0].missingId, "MISSING");
	});
});
