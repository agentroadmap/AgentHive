import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileSystem } from "../../src/file-system/operations.ts";
import { RoadmapServer } from "../../src/server/index.ts";
import {
	createUniqueTestDir,
	expect,
	retry,
	safeCleanup,
} from "../support/test-utils.ts";

const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let TEST_DIR: string;
let server: RoadmapServer | null = null;
let serverPort = 0;

async function fetchUrl(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`http://127.0.0.1:${serverPort}${path}`, opts);
}

async function postMcp(body: unknown): Promise<Response> {
	return fetchUrl("/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function waitForMcp(): Promise<void> {
	await retry(
		async () => {
			const res = await postMcp({
				jsonrpc: "2.0",
				id: 0,
				method: "tools/list",
				params: {},
			});
			assert.ok(res.ok);
			const json = (await res.json()) as { result?: { tools?: unknown[] } };
			assert.ok(Array.isArray(json.result?.tools));
		},
		20,
		150,
	);
}

describe("MCP runtime reliability (P446)", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("mcp-reliability");
		const filesystem = new FileSystem(TEST_DIR);
		await filesystem.ensureRoadmapStructure();
		await filesystem.saveConfig({
			projectName: "Reliability Test",
			statuses: ["Potential", "Active", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			dateFormat: "YYYY-MM-DD",
			remoteOperations: false,
		});

		server = new RoadmapServer(TEST_DIR);
		await server.start(0, false);
		const port = server.getPort();
		assert.notStrictEqual(port, null);
		serverPort = port ?? 0;
		assert.ok(serverPort > 0);
	});

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = null;
		}
		await safeCleanup(TEST_DIR);
	});

	// ─── AC#4: GET /healthz ──────────────────────────────────────────────────

	describe("GET /healthz", () => {
		it("returns HTTP 200 with all required fields", async () => {
			const res = await fetchUrl("/healthz");
			assert.strictEqual(res.status, 200, "healthz must always return HTTP 200");

			const body = (await res.json()) as Record<string, unknown>;

			assert.strictEqual(body.service, "ok", "service must be 'ok'");
			assert.ok(
				body.db === "ok" || body.db === "error",
				`db must be 'ok' or 'error', got: ${body.db}`,
			);
			assert.ok("schema_version" in body, "schema_version field must be present");
			assert.ok("git_revision" in body, "git_revision must be present");
			assert.ok(
				typeof body.app_version === "string",
				"app_version must be a string",
			);
			assert.ok(
				typeof body.project_root === "string",
				"project_root must be a string",
			);
			assert.ok(
				typeof body.db_host === "string",
				"db_host must be a string",
			);
			assert.ok(
				typeof body.db_name === "string",
				"db_name must be a string",
			);
			assert.ok("schema" in body, "schema field must be present");
			assert.ok(
				body.started_at === null ||
					(typeof body.started_at === "string" &&
						ISO_REGEX.test(body.started_at as string)),
				`started_at must be ISO string or null, got: ${body.started_at}`,
			);
			assert.strictEqual(
				body.mcp_protocol_version,
				"2024-11-05",
				"mcp_protocol_version must be '2024-11-05'",
			);
		});

		it("still returns HTTP 200 when the database is unreachable", async () => {
			const origHost = process.env.PGHOST;
			const origPort = process.env.PGPORT;
			const origTimeout = process.env.PG_CONNECTION_TIMEOUT_MS;

			// Redirect the pool to a port where nothing is listening.
			// Changing PGPORT forces a pool-signature mismatch, causing pool recreation.
			// ECONNREFUSED surfaces faster than a network timeout.
			process.env.PGHOST = "127.0.0.1";
			process.env.PGPORT = "19999";
			process.env.PG_CONNECTION_TIMEOUT_MS = "400";

			try {
				const res = await fetchUrl("/healthz");
				assert.strictEqual(
					res.status,
					200,
					"healthz must return 200 even when DB is down",
				);
				const body = (await res.json()) as Record<string, unknown>;
				assert.strictEqual(body.db, "error", "db must be 'error' when unreachable");
				assert.ok(
					typeof body.db_error === "string" && body.db_error.length > 0,
					"db_error message must be a non-empty string",
				);
			} finally {
				if (origHost === undefined) delete process.env.PGHOST;
				else process.env.PGHOST = origHost;
				if (origPort === undefined) delete process.env.PGPORT;
				else process.env.PGPORT = origPort;
				if (origTimeout === undefined) delete process.env.PG_CONNECTION_TIMEOUT_MS;
				else process.env.PG_CONNECTION_TIMEOUT_MS = origTimeout;
			}
		});
	});

	// ─── AC#5: POST /smoke ───────────────────────────────────────────────────

	describe("POST /smoke", () => {
		it("returns steps array with exactly 3 named steps and total_ms", async () => {
			await waitForMcp();

			const res = await fetchUrl("/smoke", { method: "POST" });
			assert.ok(res.ok, `smoke returned ${res.status}`);

			const body = (await res.json()) as {
				steps: Array<{ name: string; elapsed_ms: number; result: string }>;
				total_ms: number;
			};

			assert.ok(Array.isArray(body.steps), "steps must be an array");
			assert.strictEqual(body.steps.length, 3, "smoke must run exactly 3 steps");

			const names = body.steps.map((s) => s.name);
			assert.deepStrictEqual(names, ["initialize", "tools/list", "tools/call"]);

			for (const step of body.steps) {
				assert.ok(
					typeof step.elapsed_ms === "number" && step.elapsed_ms >= 0,
					`${step.name}: elapsed_ms must be a non-negative number`,
				);
				assert.ok(
					step.result === "ok" || step.result === "error",
					`${step.name}: result must be 'ok' or 'error', got: ${step.result}`,
				);
			}

			assert.ok(
				typeof body.total_ms === "number" && body.total_ms >= 0,
				"total_ms must be a non-negative number",
			);
		});
	});

	// ─── AC#6: Structured error envelopes ────────────────────────────────────

	describe("structured error envelopes", () => {
		it("tool validation errors carry code, message, request_id (UUID), and timestamp (ISO)", async () => {
			await waitForMcp();

			// Call proposal_create without the required 'title' field
			// so the validated wrapper fires McpValidationError → handleMcpError.
			const res = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "proposal_create",
					arguments: {},
				},
			});
			assert.ok(res.ok, `Expected HTTP 200, got ${res.status}`);

			const jsonRpc = (await res.json()) as {
				result?: {
					isError?: boolean;
					structuredContent?: Record<string, unknown>;
				};
			};

			assert.ok(jsonRpc.result, "JSON-RPC result field must be present");
			assert.strictEqual(
				jsonRpc.result?.isError,
				true,
				"result.isError must be true for a validation failure",
			);

			const sc = jsonRpc.result?.structuredContent;
			assert.ok(sc, "structuredContent must be present in the error result");
			assert.ok(
				typeof sc.code === "string",
				`error code must be a string, got: ${typeof sc.code}`,
			);
			assert.ok(
				typeof sc.message === "string" && sc.message.length > 0,
				"error message must be a non-empty string",
			);
			assert.ok(
				typeof sc.request_id === "string" && UUID_REGEX.test(sc.request_id as string),
				`request_id must be a UUID v4, got: ${sc.request_id}`,
			);
			assert.ok(
				typeof sc.timestamp === "string" && ISO_REGEX.test(sc.timestamp as string),
				`timestamp must be an ISO 8601 string, got: ${sc.timestamp}`,
			);
		});

		it("transport stays open after a handler exception — subsequent call succeeds", async () => {
			await waitForMcp();

			// First call: trigger a validation error (missing required title)
			const errRes = await postMcp({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "proposal_create",
					arguments: {},
				},
			});
			assert.strictEqual(
				errRes.status,
				200,
				"error result must come back as HTTP 200, not a transport error",
			);
			const errJson = (await errRes.json()) as {
				result?: { isError?: boolean };
			};
			assert.strictEqual(
				errJson.result?.isError,
				true,
				"first call must be an error result",
			);

			// Second call: tools/list must succeed without restarting the server,
			// proving the transport was not closed by the previous failure.
			const listRes = await postMcp({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			});
			assert.ok(
				listRes.ok,
				`tools/list after error must succeed, got ${listRes.status}`,
			);
			const listJson = (await listRes.json()) as {
				result?: { tools?: unknown[] };
			};
			assert.ok(
				Array.isArray(listJson.result?.tools),
				"tools/list must return a tools array",
			);
		});
	});
});
