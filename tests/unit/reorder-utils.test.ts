import assert from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	calculateNewOrdinal,
	DEFAULT_ORDINAL_STEP,
	resolveOrdinalConflicts,
} from "../../src/core/proposal/reorder.ts";
import { Core } from "../../src/core/roadmap.ts";
import { serializeProposal } from "../../src/markdown/serializer.ts";
import type { Proposal } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

const item = (id: string, ordinal?: number) => ({ id, ordinal });

let TEST_DIR: string;
let core: Core;

const FIXED_DATE = "2025-01-01 00:00";

const buildProposal = (
	id: string,
	status: string,
	ordinal?: number,
): Proposal => ({
	id,
	title: `Proposal ${id}`,
	status,
	assignee: [],
	createdDate: FIXED_DATE,
	labels: [],
	dependencies: [],
	...(ordinal !== undefined ? { ordinal } : {}),
});

beforeEach(async () => {
	TEST_DIR = createUniqueTestDir("reorder-utils");
	await mkdir(TEST_DIR, { recursive: true });
	execSync(`git init -b main`, { cwd: TEST_DIR });
	execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
	execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
	core = new Core(TEST_DIR);
	await core.initializeProject("Reorder Utilities Test Project");
});

afterEach(async () => {
	await safeCleanup(TEST_DIR);
});

describe("calculateNewOrdinal", () => {
	it("returns default step when no neighbors exist", () => {
		const result = calculateNewOrdinal({});
		assert.strictEqual(result.ordinal, DEFAULT_ORDINAL_STEP);
		assert.strictEqual(result.requiresRebalance, false);
	});

	it("averages ordinals when both neighbors exist", () => {
		const result = calculateNewOrdinal({
			previous: item("a", 1000),
			next: item("b", 3000),
		});
		assert.strictEqual(result.ordinal, 2000);
		assert.strictEqual(result.requiresRebalance, false);
	});

	it("flags rebalance when there is no gap between neighbors", () => {
		const result = calculateNewOrdinal({
			previous: item("a", 2000),
			next: item("b", 2000),
		});
		assert.strictEqual(result.requiresRebalance, true);
	});

	it("appends step when dropping after the last proposal", () => {
		const result = calculateNewOrdinal({
			previous: item("a", 4000),
		});
		assert.strictEqual(result.ordinal, 4000 + DEFAULT_ORDINAL_STEP);
		assert.strictEqual(result.requiresRebalance, false);
	});
});

describe("resolveOrdinalConflicts", () => {
	it("returns empty array when ordinals are already increasing", () => {
		const updates = resolveOrdinalConflicts([
			item("a", 1000),
			item("b", 2000),
			item("c", 3000),
		]);
		assert.strictEqual(updates.length, 0);
	});

	it("reassigns duplicate or descending ordinals", () => {
		const updates = resolveOrdinalConflicts([
			item("a", 1000),
			item("b", 1000),
			item("c", 2000),
		]);
		assert.strictEqual(updates.length, 2);
		assert.deepStrictEqual(updates[0], { id: "b", ordinal: 2000 });
		assert.deepStrictEqual(updates[1], { id: "c", ordinal: 3000 });
	});

	it("fills in missing ordinals with default spacing", () => {
		const updates = resolveOrdinalConflicts([
			item("a"),
			item("b"),
			item("c", 1500),
		]);
		assert.strictEqual(updates.length, 3);
		assert.deepStrictEqual(updates[0], {
			id: "a",
			ordinal: DEFAULT_ORDINAL_STEP,
		});
		assert.deepStrictEqual(updates[1], {
			id: "b",
			ordinal: DEFAULT_ORDINAL_STEP * 2,
		});
		assert.deepStrictEqual(updates[2], {
			id: "c",
			ordinal: DEFAULT_ORDINAL_STEP * 3,
		});
	});

	it("can force sequential reassignment when requested", () => {
		const updates = resolveOrdinalConflicts(
			[item("a", 1000), item("b", 2500), item("c", 4500)],
			{
				forceSequential: true,
			},
		);
		assert.strictEqual(updates.length, 2);
		assert.deepStrictEqual(updates[0], { id: "b", ordinal: 2000 });
		assert.deepStrictEqual(updates[1], { id: "c", ordinal: 3000 });
	});
});

describe("Core.reorderProposal", () => {
	const createProposals = async (
		proposals: Array<[string, string, number?]>,
	) => {
		for (const [id, status, ordinal] of proposals) {
			await core.createProposal(buildProposal(id, status, ordinal), false);
		}
	};

	it("reorders within a column without touching unaffected proposals", async () => {
		await createProposals([
			["proposal-1", "Potential", 1000],
			["proposal-2", "Potential", 2000],
			["proposal-3", "Potential", 3000],
		]);

		const result = await core.reorderProposal({
			proposalId: "proposal-3",
			targetStatus: "Potential",
			orderedProposalIds: ["proposal-1", "proposal-3", "proposal-2"],
		});

		assert.strictEqual(result.updatedProposal.id, "proposal-3");
		assert.ok((result.updatedProposal.ordinal ?? 0) > 1000);
		assert.ok((result.updatedProposal.ordinal ?? 0) < 2000);
		expect(result.changedProposals.map((proposal) => proposal.id)).toEqual([
			"proposal-3",
		]);

		const proposal2 = await core.filesystem.loadProposal("proposal-2");
		assert.strictEqual(proposal2?.ordinal, 2000);
	});

	it("rebalances ordinals when collisions exist", async () => {
		await createProposals([
			["proposal-1", "Potential", 1000],
			["proposal-2", "Potential", 1000],
			["proposal-3", "Potential", 1000],
		]);

		const result = await core.reorderProposal({
			proposalId: "proposal-3",
			targetStatus: "Potential",
			orderedProposalIds: ["proposal-1", "proposal-3", "proposal-2"],
		});

		expect(
			result.changedProposals.map((proposal) => proposal.id).sort(),
		).toEqual(["proposal-2", "proposal-3"]);

		const proposal1 = await core.filesystem.loadProposal("proposal-1");
		const proposal2 = await core.filesystem.loadProposal("proposal-2");
		const proposal3 = await core.filesystem.loadProposal("proposal-3");
		assert.strictEqual(proposal1?.ordinal, 1000);
		assert.strictEqual(proposal2?.ordinal, 3000);
		assert.strictEqual(proposal3?.ordinal, 2000);
	});

	it("updates status and ordinal when moving across columns", async () => {
		await createProposals([
			["proposal-1", "Potential", 1000],
			["proposal-2", "Active", 1000],
			["proposal-3", "Active", 2000],
		]);

		const result = await core.reorderProposal({
			proposalId: "proposal-1",
			targetStatus: "Active",
			orderedProposalIds: ["proposal-1", "proposal-2", "proposal-3"],
		});

		assert.strictEqual(result.updatedProposal.status, "Active");
		assert.ok((result.updatedProposal.ordinal ?? 0) > 0);
		expect(result.changedProposals.map((proposal) => proposal.id)).toContain(
			"proposal-1",
		);

		const proposal2 = await core.filesystem.loadProposal("proposal-2");
		const proposal3 = await core.filesystem.loadProposal("proposal-3");
		assert.strictEqual(proposal2?.ordinal, 1000);
		assert.strictEqual(proposal3?.ordinal, 2000);
	});

	it("reorders proposals with legacy lowercase IDs", async () => {
		await createProposals([
			["proposal-1", "Potential", 1000],
			["proposal-2", "Potential", 2000],
		]);

		const legacyProposal = buildProposal("proposal-3", "Potential", 3000);
		const legacyPath = join(
			core.filesystem.proposalsDir,
			"proposal-3 - Legacy Proposal.md",
		);
		await writeFile(legacyPath, serializeProposal(legacyProposal));

		const result = await core.reorderProposal({
			proposalId: "proposal-3",
			targetStatus: "Potential",
			orderedProposalIds: ["proposal-1", "proposal-3", "proposal-2"],
		});

		assert.strictEqual(result.updatedProposal.id, "proposal-3");
	});
});
