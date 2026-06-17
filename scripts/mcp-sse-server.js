import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// P3794: canonical graceful-exit helpers (armHardExit / dumpActiveHandles).
const gracefulExitModule = await import(
	"../src/shared/runtime/graceful-exit.ts"
);
const { armHardExit } = gracefulExitModule;

// P1123: protect the shared pool from stray pool.end() in shared CLI/tool code.
// Tool handlers use src/infra/postgres/pool.ts transitively.
//
// Post-P1128 (bun migration): Module resolution now uses bun runtime which
// correctly returns named exports without collapsing to module.default.
const poolModule = await import("../src/infra/postgres/pool.ts");
const { setPoolLifecycleMode, query: queryFn } = poolModule;

if (typeof setPoolLifecycleMode !== "function") {
	console.error("[MCP] Failed to load setPoolLifecycleMode from pool module");
	process.exit(1);
}
setPoolLifecycleMode("long-running");

// P1123 Phase 3: start the pool watchdog.
const watchdogModule = await import("../src/infra/postgres/pool-watchdog.ts");
const { startPoolWatchdog } = watchdogModule;

if (typeof startPoolWatchdog === "function") {
	startPoolWatchdog("agenthive-mcp");
}

const serverModule = await import("../src/apps/mcp-server/server.ts");
const httpCompatModule = await import("../src/apps/mcp-server/http-compat.ts");
const versionModule = await import("../src/shared/utils/version.ts");
const { createMcpServer } = serverModule;
const { handleDirectMcpRequest } = httpCompatModule;
const { getVersion } = versionModule;

if (!createMcpServer) {
	console.error("[MCP] Failed to load createMcpServer from server module");
	process.exit(1);
}
if (!handleDirectMcpRequest) {
	console.error("[MCP] Failed to load direct MCP request handler");
	process.exit(1);
}

// MCP_TRANSPORT controls which transports are active.
// Values: "sse" | "http" | "both" (default: "both")
// During the migration window both transports run by default.
// Set MCP_TRANSPORT=sse to disable StreamableHTTP (rollback path).
// Set MCP_TRANSPORT=http to disable SSE (post-migration).
const MCP_TRANSPORT = (process.env.MCP_TRANSPORT || "both").toLowerCase();
const SSE_ENABLED = MCP_TRANSPORT === "sse" || MCP_TRANSPORT === "both";
const HTTP_ENABLED = MCP_TRANSPORT === "http" || MCP_TRANSPORT === "both";

const port = process.env.MCP_PORT || 6421;
const host = process.env.MCP_HOST || "127.0.0.1";
const APP_VERSION = getVersion ? await getVersion() : "unknown";
const SERVER_STARTED_AT = new Date().toISOString();

const app = express();

// Single shared MCP server for the lifetime of the process.
// createSseTransport() and createStreamableHttpTransport() create per-session
// SDK Server instances (required by the SDK's one-transport-per-Protocol
// constraint) but those session servers delegate all request handling back to
// this shared instance, so createMcpServer() — and its DB queries and NOTIFY
// listener setup — runs exactly once.
const sharedServer = await createMcpServer(projectRoot);

// Session tracking: sessionId → SSEServerTransport
const sessions = new Map();

// Health check / readiness endpoint.
// Returns transport config, version, and session count so operators and
// automated checks can verify the service without opening a streaming session.
app.get("/health", async (_req, res) => {
	const activeTransports = [];
	const endpoints = {};

	if (SSE_ENABLED) {
		activeTransports.push("sse");
		endpoints.sse = {
			connect: `http://localhost:${port}/sse`,
			messages: `http://localhost:${port}/messages`,
			status: "active",
		};
	}
	if (HTTP_ENABLED) {
		activeTransports.push("streamable-http");
		endpoints["streamable-http"] = {
			endpoint: `http://localhost:${port}/mcp-streamable`,
			aliases: ["/mcp/streamable", "/streamable"],
			status: "active",
		};
	}

	res.json({
		status: "ok",
		version: APP_VERSION,
		uptime: Math.round(process.uptime()),
		sessions: sessions.size,
		transport: {
			active: activeTransports,
			config: MCP_TRANSPORT,
			endpoints,
			readiness_url: `http://localhost:${port}/health`,
			deprecation: {
				sse_retire_after: "2026-07-01",
				note: "SSE will be retired after all clients migrate to streamable-http. Set MCP_TRANSPORT=http to opt in early.",
			},
		},
		timestamp: new Date().toISOString(),
	});
});

// P446: Structured health endpoint.
// Returns DB reachability and schema version separately from service health,
// so operators can distinguish version mismatch from transport errors.
// Never exposes DB credentials — only host, name, schema.
app.get("/healthz", async (_req, res) => {
	const health = {
		service: "ok",
		db: "ok",
		schema_version: null,
		git_revision: "unknown",
		project_root: projectRoot,
		db_host: process.env.PGHOST || "127.0.0.1",
		db_name: process.env.PGDATABASE || "agenthive",
		schema: process.env.PGSCHEMA || "roadmap",
		started_at: SERVER_STARTED_AT,
		mcp_protocol_version: "2024-11-05",
	};

	// DB health: query schema_info for the most recent schema version.
	// 3s timeout prevents /healthz from hanging when DB is unreachable.
	if (typeof queryFn === "function") {
		try {
			const dbResult = await Promise.race([
				queryFn(
					"SELECT schema_version FROM roadmap.schema_info ORDER BY id DESC LIMIT 1",
					[],
				),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("db_timeout")), 3000),
				),
			]);
			health.schema_version = dbResult.rows[0]?.schema_version ?? null;
		} catch {
			health.db = "error";
		}
	} else {
		health.db = "error";
	}

	// Git revision — stale is fine; the field helps distinguish version mismatch
	// from transport failures. Never fatal if the working tree lacks git.
	try {
		health.git_revision = execSync("git rev-parse --short HEAD", {
			cwd: projectRoot,
			encoding: "utf-8",
			timeout: 3000,
		}).trim();
	} catch {
		// non-fatal; leave as "unknown"
	}

	res.status(200).json(health);
});

// P446: Smoke-test endpoint.
// Runs initialize → tools/list → a known-safe tools/call and returns per-step
// timings. Use this to verify MCP handler health before agents depend on it.
app.post("/smoke", express.json({ limit: "1mb" }), async (_req, res) => {
	const t0 = Date.now();
	const steps = [];

	async function runStep(name, payload) {
		const tStep = Date.now();
		let result = "ok";
		let error = null;
		try {
			const r = await handleDirectMcpRequest(sharedServer, payload);
			// tools/call result may carry isError inside the MCP result body
			const isToolError =
				name === "tools/call:mcp_ops" && r.body?.result?.isError === true;
			result = r.status === 200 && !isToolError ? "ok" : "error";
		} catch (err) {
			result = "error";
			error = err.message;
		}
		const step = { name, elapsed_ms: Date.now() - tStep, result };
		if (error) step.error = error;
		steps.push(step);
	}

	await runStep("initialize", { jsonrpc: "2.0", id: 1, method: "initialize" });
	await runStep("tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list" });
	await runStep("tools/call:mcp_ops", {
		jsonrpc: "2.0",
		id: 3,
		method: "tools/call",
		params: { name: "mcp_ops", arguments: { action: "list_actions" } },
	});

	res.json({ steps, total_ms: Date.now() - t0 });
});

const jsonBodyParser = express.json({ limit: "4mb" });

app.post(["/mcp", "/api/mcp"], jsonBodyParser, async (req, res) => {
	try {
		const response = await handleDirectMcpRequest(
			sharedServer,
			req.body,
			req.headers.authorization,
		);
		res.status(response.status).json(response.body);
	} catch (err) {
		console.error("[MCP] Direct MCP request failed:", String(err));
		res.status(500).json({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32000, message: "Direct MCP request failed" },
		});
	}
});

// StreamableHTTP endpoint — compatible with hermes MCP client and other modern clients.
// Single endpoint handles GET (SSE stream), POST (JSON-RPC), DELETE (cleanup).
// Gated by MCP_TRANSPORT; disabled when MCP_TRANSPORT=sse.
if (HTTP_ENABLED) {
	app.all(
		["/mcp-streamable", "/mcp/streamable", "/streamable"],
		jsonBodyParser,
		async (req, res) => {
			try {
				// SDK requires fresh Server per StreamableHTTP request (Protocol is
				// P1123/P1399 HOTFIX: Reuse the singleton sharedServer instead of
				// calling createMcpServer per request. Creating a fresh server
				// on every HTTP hit creates a new DB connection pool and
				// installs a new NOTIFY listener, exhausting Postgres
				// connections and eventually poisoning the pool with
				// "Cannot use a pool after calling end".
				const transport = await sharedServer.createStreamableHttpTransport();
				await transport.handleRequest(req, res, req.body);
			} catch (err) {
				console.error("[MCP] StreamableHTTP request failed:", err.message);
				if (!res.writableEnded) {
					res.status(500).json({
						jsonrpc: "2.0",
						id: null,
						error: { code: -32000, message: "StreamableHTTP request failed" },
					});
				}
			}
		},
	);
} else {
	// When SSE-only mode is active, return a clear migration hint
	app.all(
		["/mcp-streamable", "/mcp/streamable", "/streamable"],
		(_req, res) => {
			res.status(503).json({
				error: "StreamableHTTP transport is disabled",
				hint: "Set MCP_TRANSPORT=http or MCP_TRANSPORT=both to enable",
			});
		},
	);
}

// SSE transport — legacy endpoint kept for backward compatibility.
// Gated by MCP_TRANSPORT; disabled when MCP_TRANSPORT=http.
if (SSE_ENABLED) {
	app.get("/sse", async (_req, res) => {
		console.log("[MCP] New SSE connection request");
		try {
			const sseTransport = await sharedServer.createSseTransport(
				"/messages",
				res,
			);

			const sessionId = sseTransport.sessionId;
			sessions.set(sessionId, sseTransport);
			console.log(
				`[MCP] SSE session created: ${sessionId}, active sessions: ${sessions.size}`,
			);

			res.on("close", () => {
				console.log(`[MCP] SSE connection closed: ${sessionId}`);
				sessions.delete(sessionId);
				console.log(`[MCP] Active sessions: ${sessions.size}`);
			});
		} catch (err) {
			console.error("[MCP] Failed to create SSE session:", err.message);
			if (!res.writableEnded) {
				res.status(500).send("Failed to create SSE session");
			}
		}
	});

	app.post("/messages", express.json(), async (req, res) => {
		const sessionId = req.query.sessionId;
		const transport = sessions.get(sessionId);

		if (!transport) {
			res
				.status(400)
				.send(`No active SSE connection for session: ${sessionId}`);
			return;
		}

		try {
			await sharedServer.handleSseMessage(transport, req, res, req.body);
		} catch (err) {
			console.error("[MCP] Error handling message:", err.message);
			if (!res.writableEnded) {
				res.status(500).send("Internal error");
			}
		}
	});
} else {
	app.get("/sse", (_req, res) => {
		res.status(503).json({
			error: "SSE transport is disabled",
			hint: "Set MCP_TRANSPORT=sse or MCP_TRANSPORT=both to enable",
		});
	});
}

const server = app.listen(port, host, () => {
	console.log(
		`[MCP] AgentHive MCP server v${APP_VERSION} listening on port ${port}`,
	);
	console.log(`[MCP] Transport config: MCP_TRANSPORT=${MCP_TRANSPORT}`);
	console.log(`[MCP] Readiness URL: http://localhost:${port}/health`);
	if (SSE_ENABLED) {
		console.log(`[MCP] SSE Endpoint:             http://localhost:${port}/sse`);
		console.log(
			`[MCP] SSE Message Endpoint:     http://localhost:${port}/messages`,
		);
		console.log(`[MCP] SSE deprecation target:   2026-07-01`);
	}
	if (HTTP_ENABLED) {
		console.log(
			`[MCP] StreamableHTTP Endpoint:  http://localhost:${port}/mcp-streamable`,
		);
	}
});

// Keepalive: prevent Node from exiting when event loop would otherwise be empty
const keepalive = setInterval(() => {
	// No-op — just keeps the event loop active
	server.getConnections((err, count) => {
		if (!err && count === 0) {
			// No active connections — normal state, keep running
		}
	});
}, 30000); // Every 30 seconds

// Handle graceful shutdown.
// P3198: long-lived SSE connections never close on their own, so server.close()'s
// callback would never fire and systemd would kill the unit on TimeoutStopSec.
// Force-close open sockets so close() can complete, and arm an unref'd failsafe
// that exits regardless if anything still pins the event loop.
let shuttingDown = false;
function shutdown(sig) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[MCP] ${sig} received, shutting down gracefully`);
	clearInterval(keepalive);

	// P3794 AC-2: canonical failsafe — if shutdown() hangs at any point after
	// this line, armHardExit fires and force-exits the process rather than
	// waiting for systemd's SIGKILL (TimeoutStopSec).
	armHardExit("mcp-sse-server", 8_000);

	server.close(() => {
		console.log("[MCP] Server closed");
		process.exit(0);
	});

	// Node >=18.2: drop idle keep-alive + long-lived SSE sockets so close() resolves.
	if (typeof server.closeAllConnections === "function") {
		server.closeAllConnections();
	} else if (typeof server.closeIdleConnections === "function") {
		server.closeIdleConnections();
	}
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
	console.error("[MCP] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
	console.error("[MCP] Unhandled rejection:", reason);
});
