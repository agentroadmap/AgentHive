import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Proposal } from "../hooks/useWebSocket";
import {
	buildLanes,
	DEFAULT_LANE_KEY,
	groupProposalsByLaneAndStatus,
	laneKeyFromDomain,
	laneKeyFromType,
	sortProposals,
} from "./lanes";

const makeProposal = (overrides: Partial<Proposal> = {}): Proposal => ({
	id: "proposal-1",
	displayId: "P-1",
	parentId: null,
	proposalType: "Feature",
	category: "core",
	domainId: "default",
	title: "Proposal",
	status: "Potential",
	priority: "Medium",
	bodyMarkdown: null,
	processLogic: null,
	maturityLevel: null,
	repositoryPath: null,
	budgetLimitUsd: 0,
	tags: null,
	createdAt: "2024-01-01T00:00:00Z",
	updatedAt: "2024-01-01T00:00:00Z",
	...overrides,
});

describe("buildLanes", () => {
	it("creates type lanes including discovered proposal types", () => {
		const proposals = [
			makeProposal({ id: "proposal-1", proposalType: "Feature" }),
			makeProposal({ id: "proposal-2", proposalType: "Bug" }),
			makeProposal({ id: "proposal-3", proposalType: "Feature" }),
		];
		const lanes = buildLanes("type", proposals);
		assert.deepEqual(
			lanes.map((lane) => lane.label),
			["Bug", "Feature"],
		);
	});

	it("falls back to a single lane when mode is none", () => {
		const lanes = buildLanes("none", [], ["Feature"]);
		assert.equal(lanes.length, 1);
		assert.equal(lanes[0]?.key, DEFAULT_LANE_KEY);
	});

	it("creates domain lanes from proposals", () => {
		const proposals = [
			makeProposal({ id: "proposal-1", domainId: "frontend" }),
			makeProposal({ id: "proposal-2", domainId: "backend" }),
		];
		const lanes = buildLanes("domain", proposals);
		assert.deepEqual(
			lanes.map((lane) => lane.label),
			["backend", "frontend"],
		);
	});

	it("deduplicates proposal types", () => {
		const proposals = [
			makeProposal({ id: "proposal-1", proposalType: "Feature" }),
			makeProposal({ id: "proposal-2", proposalType: "Feature" }),
			makeProposal({ id: "proposal-3", proposalType: "Bug" }),
		];
		const lanes = buildLanes("type", proposals);
		assert.equal(lanes.length, 2);
	});
});

describe("groupProposalsByLaneAndStatus", () => {
	const proposals = [
		makeProposal({
			id: "proposal-1",
			status: "Potential",
			proposalType: "Feature",
		}),
		makeProposal({ id: "proposal-2", status: "Active", proposalType: "Bug" }),
		makeProposal({
			id: "proposal-3",
			status: "Potential",
			proposalType: "Feature",
		}),
	];

	it("groups proposals under their type lanes", () => {
		const lanes = buildLanes("type", proposals);
		const grouped = groupProposalsByLaneAndStatus(
			"type",
			lanes,
			["Potential", "Active"],
			proposals,
		);

		const featureLane = grouped.get(laneKeyFromType("Feature"));
		const bugLane = grouped.get(laneKeyFromType("Bug"));

		assert.deepEqual(
			(featureLane?.get("Potential") ?? []).map((t) => t.id),
			["proposal-1", "proposal-3"],
		);
		assert.deepEqual(
			(bugLane?.get("Active") ?? []).map((t) => t.id),
			["proposal-2"],
		);
	});

	it("places all proposals into the default lane when lane mode is none", () => {
		const lanes = buildLanes("none", proposals);
		const grouped = groupProposalsByLaneAndStatus(
			"none",
			lanes,
			["Potential", "Active"],
			proposals,
		);
		const defaultLaneProposals = grouped.get(DEFAULT_LANE_KEY);

		assert.ok(defaultLaneProposals);
		assert.equal(defaultLaneProposals.get("Potential")?.length, 2);
		assert.equal(defaultLaneProposals.get("Active")?.length, 1);
	});

	it("groups proposals by domain lanes", () => {
		const domainProposals = [
			makeProposal({
				id: "proposal-1",
				status: "Potential",
				domainId: "frontend",
			}),
			makeProposal({ id: "proposal-2", status: "Active", domainId: "backend" }),
		];
		const lanes = buildLanes("domain", domainProposals);
		const grouped = groupProposalsByLaneAndStatus(
			"domain",
			lanes,
			["Potential", "Active"],
			domainProposals,
		);

		const frontendLane = grouped.get(laneKeyFromDomain("frontend"));
		assert.deepEqual(
			(frontendLane?.get("Potential") ?? []).map((t) => t.id),
			["proposal-1"],
		);
	});
});

describe("sortProposals", () => {
	it("sorts by priority and falls back to updatedAt", () => {
		const proposals = [
			makeProposal({
				id: "proposal-1",
				priority: "Low",
				updatedAt: "2024-01-03T00:00:00Z",
			}),
			makeProposal({
				id: "proposal-2",
				priority: "High",
				updatedAt: "2024-01-01T00:00:00Z",
			}),
			makeProposal({
				id: "proposal-3",
				priority: "High",
				updatedAt: "2024-01-02T00:00:00Z",
			}),
		];

		const sorted = sortProposals(proposals).map((t) => t.id);
		assert.deepEqual(sorted, ["proposal-3", "proposal-2", "proposal-1"]);
	});

	it("handles empty array", () => {
		assert.deepEqual(sortProposals([]), []);
	});
});

describe("laneKeyFromType", () => {
	it("returns none key for null/undefined", () => {
		assert.equal(laneKeyFromType(null), "lane:type:__none");
		assert.equal(laneKeyFromType(undefined), "lane:type:__none");
	});

	it("returns typed key for valid type", () => {
		assert.equal(laneKeyFromType("Feature"), "lane:type:Feature");
	});
});

describe("laneKeyFromDomain", () => {
	it("returns none key for null/undefined", () => {
		assert.equal(laneKeyFromDomain(null), "lane:domain:__none");
		assert.equal(laneKeyFromDomain(undefined), "lane:domain:__none");
	});

	it("returns domain key for valid domain", () => {
		assert.equal(laneKeyFromDomain("frontend"), "lane:domain:frontend");
	});
});
