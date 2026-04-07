import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileSystem } from "../../src/file-system/operations.ts";
import { RoadmapServer } from "../../src/server/index.ts";
import type { Decision, Document, Proposal } from "../../src/types/index.ts";
import {
	createUniqueTestDir,
	expect,
	retry,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
let server: RoadmapServer | null = null;
let filesystem: FileSystem;
let serverPort = 0;

const baseProposal: Proposal = {
	id: "proposal-0007",
	title: "Server search proposal",
	status: "Active",
	assignee: ["@codex"],
	reporter: "@codex",
	createdDate: "2025-09-20 10:00",
	updatedDate: "2025-09-20 10:00",
	labels: ["search"],
	dependencies: [],
	description: "Alpha token appears here",
	priority: "high",
};

const baseDoc: Document = {
	id: "doc-9001",
	title: "Search Handbook",
	type: "guide",
	createdDate: "2025-09-20",
	updatedDate: "2025-09-20",
	rawContent: "# Guide\nAlpha document guidance",
};

const baseDecision: Decision = {
	id: "decision-9001",
	title: "Centralize search",
	date: "2025-09-19",
	status: "accepted",
	context: "Need consistent Alpha search coverage",
	decision: "Adopt shared Fuse service",
	consequences: "Shared index",
	rawContent: "## Context\nAlpha adoption",
};

const dependentProposal: Proposal = {
	id: "proposal-0008",
	title: "Follow-up integration",
	status: "Active",
	assignee: ["@codex"],
	reporter: "@codex",
	createdDate: "2025-09-20 10:30",
	updatedDate: "2025-09-20 10:30",
	labels: ["search"],
	dependencies: [baseProposal.id],
	description: "Depends on proposal-0007 for completion",
	priority: "medium",
};

describe("RoadmapServer search endpoint", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("server-search");
		filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureRoadmapStructure();
		await filesystem.saveConfig({
			projectName: "Server Search",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: false,
		});

		await filesystem.saveProposal(baseProposal);
		await filesystem.saveProposal(dependentProposal);
		await filesystem.saveDocument(baseDoc);
		await filesystem.saveDecision(baseDecision);

		server = new RoadmapServer(TEST_DIR);
		await server.start(0, false);
		const port = server.getPort();
		assert.notStrictEqual(port, null);
		serverPort = port ?? 0;
		assert.ok(serverPort > 0);

		await retry(
			async () => {
				const proposals = await fetchJson<Proposal[]>("/api/proposals");
				assert.ok(proposals.length > 0);
				return proposals;
			},
			10,
			100,
		);
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
		await safeCleanup(TEST_DIR);
	});

	it("returns proposals, documents, and decisions from the shared search service", async () => {
		const results = await retry(
			async () => {
				const data = await fetchJson<Array<{ type?: string }>>(
					"/api/search?query=alpha",
				);
				const typeSet = new Set(data.map((item) => item.type));
				if (
					!typeSet.has("proposal") ||
					!typeSet.has("document") ||
					!typeSet.has("decision")
				) {
					throw new Error("Search results not yet indexed for all types");
				}
				return data;
			},
			20,
			100,
		);
		const finalTypes = new Set(results.map((item) => item.type));
		expect(finalTypes.has("proposal")).toBe(true);
		expect(finalTypes.has("document")).toBe(true);
		expect(finalTypes.has("decision")).toBe(true);
	});

	it("filters search results by priority and status", async () => {
		const url =
			"/api/search?type=proposal&status=In%20Progress&priority=high&query=search";
		const results =
			await fetchJson<Array<{ type: string; proposal?: Proposal }>>(url);
		assert.strictEqual(results.length, 1);
		assert.strictEqual(results[0]?.type, "proposal");
		assert.strictEqual(results[0]?.proposal?.id, baseProposal.id);
	});

	it("filters proposal listings by priority via the content store", async () => {
		const proposals = await fetchJson<Proposal[]>(
			"/api/proposals?priority=high",
		);
		assert.strictEqual(proposals.length, 1);
		assert.strictEqual(proposals[0]?.id, baseProposal.id);
	});

	it("rejects unsupported priority filters with 400", async () => {
		await expect(
			fetchJson<Proposal[]>("/api/proposals?priority=urgent"),
		).rejects.toThrow();
	});

	it("supports zero-padded ids and dependency-aware search", async () => {
		const viaLooseId = await fetchJson<Proposal>("/api/proposal/7");
		assert.strictEqual(viaLooseId.id, baseProposal.id);

		const paddedViaSearch = await fetchJson<
			Array<{ type: string; proposal?: Proposal }>
		>("/api/search?type=proposal&query=proposal-7");
		const paddedIds = paddedViaSearch
			.filter((result) => result.type === "proposal")
			.map((result) => result.proposal?.id);
		assert.ok(paddedIds.includes(baseProposal.id));

		const shortQueryResults = await fetchJson<
			Array<{ type: string; proposal?: Proposal }>
		>("/api/search?type=proposal&query=7");
		const shortIds = shortQueryResults
			.filter((result) => result.type === "proposal")
			.map((result) => result.proposal?.id);
		assert.ok(shortIds.includes(baseProposal.id));

		const dependencyMatches = await fetchJson<
			Array<{ type: string; proposal?: Proposal }>
		>("/api/search?type=proposal&query=proposal-0007");
		const dependencyIds = dependencyMatches
			.filter((result) => result.type === "proposal")
			.map((result) => result.proposal?.id)
			.filter((id): id is string => Boolean(id));
		assert.deepStrictEqual(
			dependencyIds,
			expect.arrayContaining([baseProposal.id, dependentProposal.id]),
		);
	});

	it("returns newly created proposals immediately after POST", async () => {
		const createResponse = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Immediate fetch",
					status: "Active",
					description: "Immediate availability",
				}),
			},
		);
		assert.strictEqual(createResponse.ok, true);
		const created = (await createResponse.json()) as Proposal;
		assert.strictEqual(created.title, "Immediate fetch");
		const shortId = created.id.replace(/^proposal-/i, "");
		const fetched = await fetchJson<Proposal>(`/api/proposal/${shortId}`);
		assert.strictEqual(fetched.id, created.id);
		assert.strictEqual(fetched.title, "Immediate fetch");
	});

	it("persists directive when creating proposals via POST", async () => {
		const createResponse = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Directive create",
					status: "Potential",
					directive: "m-2",
				}),
			},
		);
		assert.strictEqual(createResponse.ok, true);
		const created = (await createResponse.json()) as Proposal;
		assert.strictEqual(created.directive, "m-2");

		const shortId = created.id.replace(/^proposal-/i, "");
		const fetched = await fetchJson<Proposal>(`/api/proposal/${shortId}`);
		assert.strictEqual(fetched.directive, "m-2");

		const directiveCreate = await fetch(
			`http://127.0.0.1:${serverPort}/api/directives`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Numeric Alias Directive",
				}),
			},
		);
		assert.strictEqual(directiveCreate.status, 201);
		const createdDirective = (await directiveCreate.json()) as { id: string };
		const numericAlias = createdDirective.id.replace(/^m-/i, "");

		const numericAliasProposalCreate = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Numeric alias proposal",
					status: "Potential",
					directive: numericAlias,
				}),
			},
		);
		assert.strictEqual(numericAliasProposalCreate.status, 201);
		const numericAliasProposal =
			(await numericAliasProposalCreate.json()) as Proposal;
		assert.strictEqual(numericAliasProposal.directive, createdDirective.id);

		const titleAliasDirectiveCreate = await fetch(
			`http://127.0.0.1:${serverPort}/api/directives`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "1",
				}),
			},
		);
		assert.strictEqual(titleAliasDirectiveCreate.status, 201);

		const idPriorityDirectiveCreate = await fetch(
			`http://127.0.0.1:${serverPort}/api/directives`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "ID priority directive",
				}),
			},
		);
		assert.strictEqual(idPriorityDirectiveCreate.status, 201);

		const idPriorityProposalCreate = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "ID priority proposal",
					status: "Potential",
					directive: "1",
				}),
			},
		);
		assert.strictEqual(idPriorityProposalCreate.status, 201);
		const idPriorityProposal =
			(await idPriorityProposalCreate.json()) as Proposal;
		assert.strictEqual(idPriorityProposal.directive, "m-1");
	});

	it("resolves numeric directive aliases to zero-padded legacy directive IDs", async () => {
		writeFileSync(
			join(filesystem.directivesDir, "m-01 - legacy-release.md"),
			`---
id: m-01
title: "Legacy Release"
---

## Description

Directive: Legacy Release
`,
		);

		const createResponse = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Legacy alias proposal",
					status: "Potential",
					directive: "1",
				}),
			},
		);
		assert.strictEqual(createResponse.status, 201);
		const created = (await createResponse.json()) as Proposal;
		assert.strictEqual(created.directive, "m-01");

		const updateResponse = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals/${created.id}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					directive: "m-1",
				}),
			},
		);
		assert.strictEqual(updateResponse.status, 200);
		const updated = (await updateResponse.json()) as Proposal;
		assert.strictEqual(updated.directive, "m-01");
	});

	it("prefers canonical IDs when zero-padded and canonical directive IDs both exist", async () => {
		writeFileSync(
			join(filesystem.directivesDir, "m-1 - canonical-release.md"),
			`---
id: m-1
title: "Canonical Release"
---

## Description

Directive: Canonical Release
`,
		);
		writeFileSync(
			join(filesystem.directivesDir, "m-01 - zero-padded-release.md"),
			`---
id: m-01
title: "Zero-padded Release"
---

## Description

Directive: Zero-padded Release
`,
		);

		const createResponse = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Canonical tie-break proposal",
					status: "Potential",
					directive: "1",
				}),
			},
		);
		assert.strictEqual(createResponse.status, 201);
		const created = (await createResponse.json()) as Proposal;
		assert.strictEqual(created.directive, "m-1");
	});

	it("prefers archived directive IDs over active title matches for ID-shaped proposal inputs", async () => {
		writeFileSync(
			join(filesystem.archiveDirectivesDir, "m-0 - archived-id.md"),
			`---
id: m-0
title: "Archived source"
---

## Description

Directive: Archived source
`,
		);
		writeFileSync(
			join(filesystem.directivesDir, "m-2 - active-id-shaped-title.md"),
			`---
id: m-2
title: "m-0"
---

## Description

Directive: m-0
`,
		);

		const createResponse = await fetch(
			`http://127.0.0.1:${serverPort}/api/proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Archived ID priority proposal",
					status: "Potential",
					directive: "m-0",
				}),
			},
		);
		assert.strictEqual(createResponse.status, 201);
		const created = (await createResponse.json()) as Proposal;
		assert.strictEqual(created.directive, "m-0");
	});

	it("rejects directive titles that collide with existing directive IDs", async () => {
		const firstCreate = await fetch(
			`http://127.0.0.1:${serverPort}/api/directives`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Release Alias",
				}),
			},
		);
		assert.strictEqual(firstCreate.status, 201);
		const created = (await firstCreate.json()) as { id: string };

		const conflictCreate = await fetch(
			`http://127.0.0.1:${serverPort}/api/directives`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: created.id.toUpperCase(),
				}),
			},
		);
		assert.strictEqual(conflictCreate.status, 400);
		const conflictPayload = (await conflictCreate.json()) as { error?: string };
		assert.ok(conflictPayload.error?.includes("already exists"));

		const numericAliasConflict = await fetch(
			`http://127.0.0.1:${serverPort}/api/directives`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: created.id.replace(/^m-/i, ""),
				}),
			},
		);
		assert.strictEqual(numericAliasConflict.status, 400);
	});

	it("rebuilds the Fuse index when markdown content changes", async () => {
		await filesystem.saveDocument({
			...baseDoc,
			rawContent: "# Guide\nReindexed beta token",
		});

		await retry(
			async () => {
				const updated = await fetchJson<Array<{ type?: string }>>(
					"/api/search?query=beta",
				);
				if (!updated.some((item) => item.type === "document")) {
					throw new Error("Document not yet reindexed");
				}
				return updated;
			},
			40,
			125,
		);
	});
});

async function fetchJson<T>(path: string): Promise<T> {
	const response = await fetch(`http://127.0.0.1:${serverPort}${path}`);
	if (!response.ok) {
		throw new Error(`Request failed: ${response.status}`);
	}
	return response.json();
}
