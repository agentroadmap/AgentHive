import assert from "node:assert";
import { globSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ContentStore,
	type ContentStoreEvent,
} from "../../src/core/storage/content-store.ts";
import { FileSystem } from "../../src/file-system/operations.ts";
import type { Decision, Document, Proposal } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	expect,
	getPlatformTimeout,
	safeCleanup,
	sleep,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("ContentStore", () => {
	let filesystem: FileSystem;
	let store: ContentStore;

	const sampleProposal: Proposal = {
		id: "proposal-1",
		title: "Sample Proposal",
		status: "Potential",
		assignee: [],
		createdDate: "2025-09-19 10:00",
		labels: [],
		dependencies: [],
		rawContent: "## Description\nSeed content",
	};

	const sampleDecision: Decision = {
		id: "decision-1",
		title: "Adopt shared cache",
		date: "2025-09-19",
		status: "proposed",
		context: "Context",
		decision: "Decision text",
		consequences: "Consequences",
		rawContent:
			"## Context\nContext\n\n## Decision\nDecision text\n\n## Consequences\nConsequences",
	};

	const sampleDocument: Document = {
		id: "doc-1",
		title: "Architecture Guide",
		type: "guide",
		createdDate: "2025-09-19",
		rawContent: "# Architecture Guide",
	};

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-content-store");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureRoadmapStructure();
		store = new ContentStore(filesystem);
	});

	afterEach(async () => {
		store?.dispose();
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors
		}
	});

	it("loads proposals, documents, and decisions during initialization", async () => {
		await filesystem.saveProposal(sampleProposal);
		await filesystem.saveDecision(sampleDecision);
		await filesystem.saveDocument(sampleDocument);

		const snapshot = await store.ensureInitialized();

		assert.strictEqual(snapshot.proposals.length, 1);
		assert.strictEqual(snapshot.documents.length, 1);
		assert.strictEqual(snapshot.decisions.length, 1);
		expect(snapshot.proposals.map((proposal) => proposal.id)).toContain(
			"proposal-1",
		);
	});

	it("emits proposal updates when underlying files change", async () => {
		await filesystem.saveProposal(sampleProposal);
		await store.ensureInitialized();

		const waitForUpdate = waitForEventWithTimeout(store, (event) => {
			return (
				event.type === "proposals" &&
				event.proposals.some(
					(proposal) => proposal.title === "Updated Proposal",
				)
			);
		});

		await filesystem.saveProposal({
			...sampleProposal,
			title: "Updated Proposal",
		});
		await waitForUpdate;

		const proposals = store.getProposals();
		expect(proposals.map((proposal) => proposal.title)).toContain(
			"Updated Proposal",
		);
	});

	it("updates documents when new files are added", async () => {
		await store.ensureInitialized();

		const waitForDocument = waitForEventWithTimeout(store, (event) => {
			return (
				event.type === "documents" &&
				event.documents.some((doc) => doc.id === "doc-2")
			);
		});

		await filesystem.saveDocument(
			{
				...sampleDocument,
				id: "doc-2",
				title: "Implementation Notes",
				rawContent: "# Implementation Notes",
			},
			"guides",
		);

		await waitForDocument;

		const documents = store.getDocuments();
		expect(documents.some((doc) => doc.id === "doc-2")).toBe(true);
	});

	it("preserves cross-branch proposals from the proposal loader during refresh", async () => {
		await filesystem.saveProposal(sampleProposal);

		const remoteProposal: Proposal = {
			id: "proposal-remote",
			title: "Remote Proposal",
			status: "Active",
			assignee: ["alice"],
			createdDate: "2025-10-01 12:00",
			labels: ["remote"],
			dependencies: [],
			rawContent: "## Description\nRemote content",
			origin: "remote",
		};

		let loaderCalls = 0;
		store.dispose();
		store = new ContentStore(filesystem, async () => {
			loaderCalls += 1;
			const localProposals = await filesystem.listProposals();
			return [...localProposals, remoteProposal];
		});

		await store.ensureInitialized();
		expect(store.getProposals().map((proposal) => proposal.id)).toContain(
			"proposal-remote",
		);

		await (
			store as unknown as { refreshProposalsFromDisk: () => Promise<void> }
		).refreshProposalsFromDisk();

		const refreshedProposals = store.getProposals();
		expect(refreshedProposals.map((proposal) => proposal.id)).toContain(
			"proposal-remote",
		);
		expect(loaderCalls).toBeGreaterThanOrEqual(2);
	});

	it("removes decisions when files are deleted", async () => {
		store.dispose();
		store = new ContentStore(filesystem, undefined, true);
		await filesystem.saveDecision(sampleDecision);
		await store.ensureInitialized();

		const decisionsDir = filesystem.decisionsDir;
		const decisionFiles: string[] = [];
		for await (const file of globSync("decision-*.md", { cwd: decisionsDir })) {
			decisionFiles.push(typeof file === "string" ? file : (file as any).name);
		}
		const decisionFile = decisionFiles.find((file) =>
			file.startsWith("decision-1"),
		);
		if (!decisionFile) {
			throw new Error("Expected decision file was not created");
		}

		const waitForRemoval = waitForEventWithTimeout(store, (event) => {
			return (
				event.type === "decisions" &&
				event.decisions.every((decision) => decision.id !== "decision-1")
			);
		});

		await unlink(join(decisionsDir, decisionFile));
		await waitForRemoval;

		const decisions = store.getDecisions();
		expect(
			decisions.find((decision) => decision.id === "decision-1"),
		).toBeUndefined();
	});
});

function waitForEventWithTimeout(
	store: ContentStore,
	predicate: (event: ContentStoreEvent) => boolean,
	timeout = getPlatformTimeout(),
): Promise<ContentStoreEvent> {
	const eventPromise = new Promise<ContentStoreEvent>((resolve) => {
		const unsubscribe = store.subscribe((event) => {
			if (!predicate(event)) {
				return;
			}
			unsubscribe();
			resolve(event);
		});
	});

	return Promise.race([
		eventPromise,
		sleep(timeout).then(() => {
			throw new Error("Timed out waiting for content store event");
		}),
	]);
}
