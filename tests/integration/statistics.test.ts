import assert from "node:assert";
import { describe, test } from "node:test";
import { getProposalStatistics } from "../../src/core/infrastructure/statistics.ts";
import type { Proposal } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

describe("getProposalStatistics", () => {
	const statuses = ["Potential", "Active", "Accepted", "Complete", "Abandoned"];

	// Helper to create test proposals with required fields
	const createProposal = (partial: Partial<Proposal>): Proposal => ({
		id: "proposal-1",
		title: "Test Proposal",
		status: "Potential",
		assignee: [],
		labels: [],
		dependencies: [],
		createdDate: "2024-01-01",
		rawContent: "",
		...partial,
	});

	test("handles empty proposal list", () => {
		const stats = getProposalStatistics([], [], statuses);

		assert.strictEqual(stats.totalProposals, 0);
		assert.strictEqual(stats.completedProposals, 0);
		assert.strictEqual(stats.completionPercentage, 0);
		assert.strictEqual(stats.draftCount, 0);
		expect(stats.statusCounts.get("Potential")).toBe(0);
		expect(stats.statusCounts.get("Active")).toBe(0);
		expect(stats.statusCounts.get("Complete")).toBe(0);
	});

	test("counts proposals by status correctly", () => {
		const proposals: Proposal[] = [
			createProposal({
				id: "proposal-1",
				title: "Proposal 1",
				status: "Potential",
			}),
			createProposal({
				id: "proposal-2",
				title: "Proposal 2",
				status: "Potential",
			}),
			createProposal({
				id: "proposal-3",
				title: "Proposal 3",
				status: "Active",
			}),
			createProposal({
				id: "proposal-4",
				title: "Proposal 4",
				status: "Complete",
			}),
			createProposal({
				id: "proposal-5",
				title: "Proposal 5",
				status: "Complete",
			}),
		];

		const stats = getProposalStatistics(proposals, [], statuses);

		assert.strictEqual(stats.totalProposals, 5);
		assert.strictEqual(stats.completedProposals, 2);
		assert.strictEqual(stats.completionPercentage, 40);
		expect(stats.statusCounts.get("Potential")).toBe(2);
		expect(stats.statusCounts.get("Active")).toBe(1);
		expect(stats.statusCounts.get("Complete")).toBe(2);
	});

	test("counts proposals by priority correctly", () => {
		const proposals: Proposal[] = [
			createProposal({
				id: "proposal-1",
				title: "Proposal 1",
				status: "Potential",
				priority: "high",
			}),
			createProposal({
				id: "proposal-2",
				title: "Proposal 2",
				status: "Potential",
				priority: "high",
			}),
			createProposal({
				id: "proposal-3",
				title: "Proposal 3",
				status: "Active",
				priority: "medium",
			}),
			createProposal({
				id: "proposal-4",
				title: "Proposal 4",
				status: "Complete",
				priority: "low",
			}),
			createProposal({
				id: "proposal-5",
				title: "Proposal 5",
				status: "Complete",
			}), // No priority
		];

		const stats = getProposalStatistics(proposals, [], statuses);

		expect(stats.priorityCounts.get("high")).toBe(2);
		expect(stats.priorityCounts.get("medium")).toBe(1);
		expect(stats.priorityCounts.get("low")).toBe(1);
		expect(stats.priorityCounts.get("none")).toBe(1);
	});

	test("counts drafts correctly", () => {
		const proposals: Proposal[] = [
			createProposal({
				id: "proposal-1",
				title: "Proposal 1",
				status: "Potential",
			}),
		];
		const drafts: Proposal[] = [
			createProposal({ id: "proposal-2", title: "Draft 1", status: "" }),
			createProposal({ id: "proposal-3", title: "Draft 2", status: "" }),
		];

		const stats = getProposalStatistics(proposals, drafts, statuses);

		assert.strictEqual(stats.totalProposals, 1);
		assert.strictEqual(stats.draftCount, 2);
	});

	test("identifies recent activity correctly", () => {
		const now = new Date();
		const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
		const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "Recent Proposal",
				status: "Potential",
				createdDate: fiveDaysAgo.toISOString().split("T")[0] as string,
				assignee: [],
				labels: [],
				dependencies: [],
				rawContent: "",
			},
			{
				id: "proposal-2",
				title: "Old Proposal",
				status: "Potential",
				createdDate: tenDaysAgo.toISOString().split("T")[0] as string,
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-3",
				title: "Updated Proposal",
				status: "Active",
				createdDate: tenDaysAgo.toISOString().split("T")[0] as string,
				updatedDate: fiveDaysAgo.toISOString().split("T")[0] as string,
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
		];

		const stats = getProposalStatistics(proposals, [], statuses);

		assert.strictEqual(stats.recentActivity.created.length, 1);
		assert.strictEqual(stats.recentActivity.created[0]?.id, "proposal-1");
		assert.strictEqual(stats.recentActivity.updated.length, 1);
		assert.strictEqual(stats.recentActivity.updated[0]?.id, "proposal-3");
	});

	test("identifies stale proposals correctly", () => {
		const now = new Date();
		const twoMonthsAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
		const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "Stale Proposal",
				status: "Potential",
				createdDate: twoMonthsAgo.toISOString().split("T")[0] as string,
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-2",
				title: "Recent Proposal",
				status: "Potential",
				createdDate: oneWeekAgo.toISOString().split("T")[0] as string,
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-3",
				title: "Old but Complete",
				status: "Complete",
				createdDate: twoMonthsAgo.toISOString().split("T")[0] as string,
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
		];

		const stats = getProposalStatistics(proposals, [], statuses);

		assert.strictEqual(stats.projectHealth.staleProposals.length, 1);
		assert.strictEqual(stats.projectHealth.staleProposals[0]?.id, "proposal-1");
	});

	test("identifies blocked proposals correctly", () => {
		const proposals: Proposal[] = [
			createProposal({
				id: "proposal-1",
				title: "Blocking Proposal",
				status: "Active",
			}),
			createProposal({
				id: "proposal-2",
				title: "Blocked Proposal",
				status: "Potential",
				dependencies: ["proposal-1"],
			}), // Depends on proposal-1 which is not complete
			createProposal({
				id: "proposal-3",
				title: "Not Blocked",
				status: "Potential",
				dependencies: ["proposal-4"],
			}), // Depends on proposal-4 which is complete
			createProposal({
				id: "proposal-4",
				title: "Complete Proposal",
				status: "Complete",
			}),
		];

		const stats = getProposalStatistics(proposals, [], statuses);

		assert.strictEqual(stats.projectHealth.blockedProposals.length, 1);
		assert.strictEqual(
			stats.projectHealth.blockedProposals[0]?.id,
			"proposal-2",
		);
	});

	test("calculates average proposal age correctly", () => {
		const now = new Date();
		const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
		const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
		const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
		const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

		const proposals: Proposal[] = [
			{
				id: "proposal-1",
				title: "Active Proposal",
				status: "Potential",
				createdDate: tenDaysAgo.toISOString().split("T")[0] as string,
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-2",
				title: "Completed Proposal",
				status: "Complete",
				createdDate: twentyDaysAgo.toISOString().split("T")[0] as string,
				updatedDate: fifteenDaysAgo.toISOString().split("T")[0] as string, // Completed after 5 days
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
			{
				id: "proposal-3",
				title: "Recently Completed",
				status: "Complete",
				createdDate: tenDaysAgo.toISOString().split("T")[0] as string,
				updatedDate: fiveDaysAgo.toISOString().split("T")[0] as string, // Completed after 5 days
				assignee: [],
				rawContent: "",
				labels: [],
				dependencies: [],
			},
		];

		const stats = getProposalStatistics(proposals, [], statuses);

		// Proposal 1: 10 days (active, so uses current age)
		// Proposal 2: 5 days (completed, so uses creation to completion time)
		// Proposal 3: 5 days (completed, so uses creation to completion time)
		// Average: (10 + 5 + 5) / 3 = 6.67, rounded to 7
		assert.strictEqual(stats.projectHealth.averageProposalAge, 7);
	});

	test("handles 100% completion correctly", () => {
		const proposals: Proposal[] = [
			createProposal({
				id: "proposal-1",
				title: "Proposal 1",
				status: "Complete",
			}),
			createProposal({
				id: "proposal-2",
				title: "Proposal 2",
				status: "Complete",
			}),
			createProposal({
				id: "proposal-3",
				title: "Proposal 3",
				status: "Complete",
			}),
		];

		const stats = getProposalStatistics(proposals, [], statuses);

		assert.strictEqual(stats.completionPercentage, 100);
		assert.strictEqual(stats.completedProposals, 3);
		assert.strictEqual(stats.totalProposals, 3);
	});
});
