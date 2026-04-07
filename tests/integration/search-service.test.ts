import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SearchService } from "../../src/core/infrastructure/search-service.ts";
import { ContentStore } from "../../src/core/storage/content-store.ts";
import { FileSystem } from "../../src/file-system/operations.ts";
import type {
	Decision,
	DecisionSearchResult,
	Document,
	DocumentSearchResult,
	Proposal,
	ProposalSearchResult,
	SearchResult,
} from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	expect,
	getPlatformTimeout,
	safeCleanup,
	sleep,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("SearchService", () => {
	let filesystem: FileSystem;
	let store: ContentStore;
	let search: SearchService;

	const baseProposal: Proposal = {
		id: "proposal-1",
		title: "Centralized search proposal",
		status: "Active",
		assignee: ["@codex"],
		reporter: "@codex",
		createdDate: "2025-09-19 09:00",
		updatedDate: "2025-09-19 09:10",
		labels: ["search"],
		dependencies: [],
		rawContent: "## Description\nImplements Fuse based service",
		priority: "high",
	};

	const baseDoc: Document = {
		id: "doc-1",
		title: "Search Architecture",
		type: "guide",
		createdDate: "2025-09-19",
		rawContent: "# Search Architecture\nCentralized description",
	};

	const baseDecision: Decision = {
		id: "decision-1",
		title: "Adopt Fuse.js",
		date: "2025-09-18",
		status: "accepted",
		context: "Need consistent search",
		decision: "Use Fuse.js with centralized store",
		consequences: "Shared search path",
		rawContent:
			"## Context\nNeed consistent search\n\n## Decision\nUse Fuse.js with centralized store",
	};

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("search-service");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureRoadmapStructure();
		store = new ContentStore(filesystem);
		search = new SearchService(store);
	});

	afterEach(async () => {
		search?.dispose();
		store?.dispose();
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// ignore cleanup errors between tests
		}
	});

	it("indexes proposals, documents, and decisions and returns combined results", async () => {
		await filesystem.saveProposal(baseProposal);
		await filesystem.saveDocument(baseDoc);
		await filesystem.saveDecision(baseDecision);

		await search.ensureInitialized();

		const results = search.search({ query: "centralized" });
		assert.strictEqual(results.length, 3);

		const proposalResult = results.find(isProposalResult);
		assert.notStrictEqual(proposalResult, undefined);
		assert.strictEqual(proposalResult?.proposal.id, "proposal-1");
		assert.notStrictEqual(proposalResult?.score, null);

		const docResult = results.find(isDocumentResult);
		assert.strictEqual(docResult?.document.id, "doc-1");
		const decisionResult = results.find(isDecisionResult);
		assert.strictEqual(decisionResult?.decision.id, "decision-1");
	});

	it("applies status and priority filters without running a text query", async () => {
		const secondProposal: Proposal = {
			...baseProposal,
			id: "proposal-2",
			title: "Another proposal",
			status: "Potential",
			priority: "low",
			rawContent: "## Description\nSecondary",
		};

		const thirdProposal: Proposal = {
			...baseProposal,
			id: "proposal-3",
			title: "active medium",
			priority: "medium",
			rawContent: "## Description\nMedium priority",
		};

		await filesystem.saveProposal(baseProposal);
		await filesystem.saveProposal(secondProposal);
		await filesystem.saveProposal(thirdProposal);

		await search.ensureInitialized();

		const statusFiltered = search
			.search({
				types: ["proposal"],
				filters: { status: "Active" },
			})
			.filter(isProposalResult);
		expect(statusFiltered.map((result) => result.proposal.id)).toStrictEqual([
			"proposal-1",
			"proposal-3",
		]);

		const priorityFiltered = search
			.search({
				types: ["proposal"],
				filters: { priority: "high" },
			})
			.filter(isProposalResult);
		assert.strictEqual(priorityFiltered.length, 1);
		assert.strictEqual(priorityFiltered[0]?.proposal.id, "proposal-1");

		const combinedFiltered = search
			.search({
				types: ["proposal"],
				filters: { status: ["Active"], priority: ["medium"] },
			})
			.filter(isProposalResult);
		expect(combinedFiltered.map((result) => result.proposal.id)).toStrictEqual([
			"proposal-3",
		]);
	});

	it("filters proposals by labels (requiring all selected labels)", async () => {
		const uiProposal: Proposal = {
			...baseProposal,
			id: "proposal-2",
			title: "UI polish",
			status: "Potential",
			labels: ["ui", "frontend"],
			rawContent: "## Description\nUI work",
		};

		const docsProposal: Proposal = {
			...baseProposal,
			id: "proposal-3",
			title: "Docs update",
			status: "Complete",
			labels: ["docs"],
			rawContent: "## Description\nDocs",
		};

		await filesystem.saveProposal(baseProposal);
		await filesystem.saveProposal(uiProposal);
		await filesystem.saveProposal(docsProposal);

		await search.ensureInitialized();

		const uiFiltered = search
			.search({
				types: ["proposal"],
				filters: { labels: ["ui"] },
			})
			.filter(isProposalResult);
		expect(uiFiltered.map((result) => result.proposal.id)).toStrictEqual([
			"proposal-2",
		]);

		const anyFiltered = search
			.search({
				types: ["proposal"],
				filters: { labels: ["ui", "frontend"] },
			})
			.filter(isProposalResult);
		expect(anyFiltered.map((result) => result.proposal.id)).toStrictEqual([
			"proposal-2",
		]);
	});

	it("refreshes the index when content changes", async () => {
		await filesystem.saveProposal(baseProposal);
		await search.ensureInitialized();

		const initialResults = search
			.search({ query: "Fuse", types: ["proposal"] })
			.filter(isProposalResult);
		assert.strictEqual(initialResults.length, 1);

		await filesystem.saveProposal({
			...baseProposal,
			rawContent: "## Description\nReindexed to new term",
			title: "Centralized service updated",
		});

		await waitForSearch(
			async () =>
				search
					.search({ query: "Reindexed", types: ["proposal"] })
					.filter(isProposalResult),
			(results) => {
				return (
					results.length === 1 &&
					results[0]?.proposal.title === "Centralized service updated"
				);
			},
		);

		const staleResults = search
			.search({ query: "Fuse", types: ["proposal"] })
			.filter(isProposalResult);
		assert.strictEqual(staleResults.length, 0);
	});
});

function isProposalResult(
	result: SearchResult,
): result is ProposalSearchResult {
	return result.type === "proposal";
}

function isDocumentResult(
	result: SearchResult,
): result is DocumentSearchResult {
	return result.type === "document";
}

function isDecisionResult(
	result: SearchResult,
): result is DecisionSearchResult {
	return result.type === "decision";
}

async function waitForSearch<T>(
	operation: () => Promise<T> | T,
	predicate: (value: T) => boolean,
	timeout = getPlatformTimeout(),
	interval = 50,
): Promise<T> {
	const deadline = Date.now() + timeout;
	let lastValue: T;
	while (Date.now() < deadline) {
		lastValue = await operation();
		if (predicate(lastValue)) {
			return lastValue;
		}
		await sleep(interval);
	}

	lastValue = await operation();
	if (predicate(lastValue)) {
		return lastValue;
	}

	throw new Error("Timed out waiting for search results to satisfy predicate");
}
