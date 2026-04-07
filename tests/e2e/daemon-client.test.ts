import { strict as assert } from "node:assert";
import { after, before, describe, it, mock } from "node:test";
import {
	DaemonClient,
	resolveDaemonUrl,
} from "../../src/core/infrastructure/daemon-client.ts";
import type {
	Proposal,
	ProposalCreateInput,
	ProposalUpdateInput,
} from "../../src/types/index.ts";

// Mock fetch for testing
const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock.fn>;

function setupMockFetch(
	handler: (
		url: string | URL | Request,
		init?: RequestInit,
	) => Promise<Response>,
) {
	mockFetch = mock.fn(handler);
	globalThis.fetch = mockFetch as unknown as typeof fetch;
}

function restoreFetch() {
	globalThis.fetch = originalFetch;
}

describe("DaemonClient", () => {
	before(() => {
		// Mock fetch before tests
		setupMockFetch(
			async () => new Response(JSON.stringify({}), { status: 200 }),
		);
	});

	after(() => {
		restoreFetch();
	});

	describe("healthCheck", () => {
		it("returns health status when daemon is available", async () => {
			setupMockFetch(async () =>
				Response.json({ initialized: true, projectPath: "/test/path" }),
			);

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const result = await client.healthCheck();

			assert.equal(result?.initialized, true);
			assert.equal(result?.projectPath, "/test/path");
		});

		it("returns null when daemon is unavailable", async () => {
			setupMockFetch(async () => {
				throw new Error("ECONNREFUSED");
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const result = await client.healthCheck();

			assert.equal(result, null);
		});
	});

	describe("isAvailable", () => {
		it("returns true when daemon responds", async () => {
			setupMockFetch(async () =>
				Response.json({ initialized: true, projectPath: "/test" }),
			);

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			assert.equal(await client.isAvailable(), true);
		});

		it("returns false when daemon does not respond", async () => {
			setupMockFetch(async () => {
				throw new Error("timeout");
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			assert.equal(await client.isAvailable(), false);
		});
	});

	describe("listProposals", () => {
		it("lists proposals without filters", async () => {
			const mockProposals: Proposal[] = [
				{ id: "proposal-1", title: "Test Proposal", status: "Active" },
				{ id: "proposal-2", title: "Another Proposal", status: "Complete" },
			] as Proposal[];

			setupMockFetch(async (url) => {
				const urlStr = url.toString();
				assert.ok(
					urlStr.includes("/api/proposals"),
					`Expected /api/proposals in ${urlStr}`,
				);
				return Response.json(mockProposals);
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const proposals = await client.listProposals();

			assert.equal(proposals.length, 2);
			assert.equal(proposals[0]?.id, "proposal-1");
		});

		it("lists proposals with filters", async () => {
			setupMockFetch(async (url) => {
				const urlStr = url.toString();
				assert.ok(
					urlStr.includes("status=Active"),
					`Expected status filter in ${urlStr}`,
				);
				assert.ok(
					urlStr.includes("priority=high"),
					`Expected priority filter in ${urlStr}`,
				);
				return Response.json([]);
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			await client.listProposals({ status: "Active", priority: "high" });
		});
	});

	describe("getProposal", () => {
		it("returns proposal when found", async () => {
			const mockProposal = {
				id: "proposal-37",
				title: "Test",
				status: "Potential",
			};

			setupMockFetch(async (url) => {
				assert.ok(url.toString().includes("/api/proposal/37"));
				return Response.json(mockProposal);
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const proposal = await client.getProposal("37");

			assert.equal(proposal?.id, "proposal-37");
		});

		it("returns null when proposal not found (404)", async () => {
			setupMockFetch(
				async () =>
					new Response(JSON.stringify({ error: "Proposal not found" }), {
						status: 404,
					}),
			);

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const proposal = await client.getProposal("999");

			assert.equal(proposal, null);
		});
	});

	describe("createProposal", () => {
		it("sends correct payload to daemon", async () => {
			let receivedBody: any;

			setupMockFetch(async (_url, init) => {
				if (init?.body) {
					receivedBody = JSON.parse(init.body as string);
				}
				return Response.json({ id: "proposal-100", title: "New Proposal" });
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const input: ProposalCreateInput = {
				title: "New Proposal",
				description: "Test description",
				priority: "high",
				labels: ["test"],
			};

			const result = await client.createProposal(input);

			assert.equal(result.id, "proposal-100");
			assert.equal(receivedBody?.title, "New Proposal");
			assert.equal(receivedBody?.description, "Test description");
			assert.equal(receivedBody?.priority, "high");
			assert.deepEqual(receivedBody?.labels, ["test"]);
		});
	});

	describe("updateProposal", () => {
		it("sends correct update payload", async () => {
			let receivedBody: any;

			setupMockFetch(async (_url, init) => {
				if (init?.method === "PUT" && init?.body) {
					receivedBody = JSON.parse(init.body as string);
				}
				return Response.json({
					id: "proposal-1",
					title: "Updated",
					status: "Active",
				});
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const updates: ProposalUpdateInput = {
				status: "Active",
				implementationNotes: "Working on it",
			};

			await client.updateProposal("proposal-1", updates);

			assert.equal(receivedBody?.status, "Active");
			assert.equal(receivedBody?.implementationNotes, "Working on it");
		});
	});

	describe("deleteProposal", () => {
		it("returns true on successful delete", async () => {
			setupMockFetch(async (_url, init) => {
				assert.equal(init?.method, "DELETE");
				return Response.json({ success: true });
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const result = await client.deleteProposal("proposal-1");

			assert.equal(result, true);
		});

		it("returns false on 404", async () => {
			setupMockFetch(
				async () =>
					new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
			);

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const result = await client.deleteProposal("proposal-999");

			assert.equal(result, false);
		});
	});

	describe("search", () => {
		it("searches with query and filters", async () => {
			setupMockFetch(async (url) => {
				const urlStr = url.toString();
				assert.ok(urlStr.includes("query=test"));
				assert.ok(urlStr.includes("type=proposal"));
				assert.ok(urlStr.includes("status=Active"));
				return Response.json([
					{ type: "proposal", proposal: { id: "proposal-1" } },
				]);
			});

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const results = await client.search({
				query: "test",
				types: ["proposal"],
				filters: { status: "Active" },
			});

			assert.equal(results.length, 1);
		});
	});

	describe("getVersion", () => {
		it("returns version string", async () => {
			setupMockFetch(async () => Response.json({ version: "0.1.10" }));

			const client = new DaemonClient({ baseUrl: "http://localhost:6420" });
			const version = await client.getVersion();

			assert.equal(version, "0.1.10");
		});
	});
});

describe("resolveDaemonUrl", () => {
	const originalEnv = process.env.ROADMAP_DAEMON_URL;

	after(() => {
		if (originalEnv) {
			process.env.ROADMAP_DAEMON_URL = originalEnv;
		} else {
			delete process.env.ROADMAP_DAEMON_URL;
		}
	});

	it("returns env URL when set", () => {
		process.env.ROADMAP_DAEMON_URL = "http://env-daemon:7777";
		const url = resolveDaemonUrl(undefined, process.env.ROADMAP_DAEMON_URL);
		assert.equal(url, "http://env-daemon:7777");
	});

	it("returns config URL when no env", () => {
		delete process.env.ROADMAP_DAEMON_URL;
		const url = resolveDaemonUrl("http://config-daemon:8888");
		assert.equal(url, "http://config-daemon:8888");
	});

	it("returns null when neither is set", () => {
		delete process.env.ROADMAP_DAEMON_URL;
		const url = resolveDaemonUrl();
		assert.equal(url, null);
	});

	it("env takes priority over config", () => {
		process.env.ROADMAP_DAEMON_URL = "http://env-daemon";
		const url = resolveDaemonUrl("http://config-daemon");
		assert.equal(url, "http://env-daemon");
	});
});
