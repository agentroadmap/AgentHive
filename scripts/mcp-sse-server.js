import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// P1123: protect the shared pool from stray pool.end() in shared CLI/tool code.
// Tool handlers use src/infra/postgres/pool.ts transitively.
//
// HOTFIX 2026-05-16: node --import jiti/register collapses TS named exports
// to module.default — same pattern the createMcpServer/handleDirectMcpRequest/
// getVersion lookups below already defend against. Without this fallback,
// poolModule.setPoolLifecycleMode is undefined at boot and the MCP service
// crash-loops with TypeError (NRestarts hit 66 today before this fix).
const poolModule = await import("../src/infra/postgres/pool.ts");
const setPoolLifecycleMode =
	poolModule.setPoolLifecycleMode || poolModule.default?.setPoolLifecycleMode;
if (typeof setPoolLifecycleMode !== "function") {
	console.error("[MCP] Failed to load setPoolLifecycleMode from pool module");
	process.exit(1);
}
setPoolLifecycleMode("long-running");

// P1123 Phase 3: start the pool watchdog. Same jiti-named-export fallback
// pattern as setPoolLifecycleMode above.
const watchdogModule = await import("../src/infra/postgres/pool-watchdog.ts");
const startPoolWatchdog =
	watchdogModule.startPoolWatchdog ||
	watchdogModule.default?.startPoolWatchdog;
if (typeof startPoolWatchdog === "function") {
	startPoolWatchdog("agenthive-mcp");
}

const serverModule = await import("../src/apps/mcp-server/server.ts");
const httpCompatModule = await import("../src/apps/mcp-server/http-compat.ts");
const versionModule = await import("../src/shared/utils/version.ts");
const poolModule = await import("../src/infra/postgres/pool.ts");
const createMcpServer =
	serverModule.createMcpServer || serverModule.default?.createMcpServer;
const handleDirectMcpRequest =
	httpCompatModule.handleDirectMcpRequest ||
	httpCompatModule.default?.handleDirectMcpRequest;
const getVersion =
	versionModule.getVersion || versionModule.default?.getVersion;
poolModule.setPoolLifecycleMode("long-running");
poolModule.startPoolPoisonWatchdog("agenthive-mcp");

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

const jsonBodyParser = express.json({ limit: "4mb" });

app.post(["/mcp", "/api/mcp"], jsonBodyParser, async (req, res) => {
	try {
		const response = await handleDirectMcpRequest(sharedServer, req.body, req.headers.authorization);
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
				// one-to-one with transport). Pool leak is contained by state-names
				// dispose-on-reload; see P522.
				const server = await createMcpServer(projectRoot);
				const transport = await server.createStreamableHttpTransport();
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
			const sseTransport = await sharedServer.createSseTransport("/messages", res);

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
			res.status(400).send(`No active SSE connection for session: ${sessionId}`);
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
	console.log(`[MCP] AgentHive MCP server v${APP_VERSION} listening on port ${port}`);
	console.log(`[MCP] Transport config: MCP_TRANSPORT=${MCP_TRANSPORT}`);
	console.log(`[MCP] Readiness URL: http://localhost:${port}/health`);
	if (SSE_ENABLED) {
		console.log(`[MCP] SSE Endpoint:             http://localhost:${port}/sse`);
		console.log(`[MCP] SSE Message Endpoint:     http://localhost:${port}/messages`);
		console.log(`[MCP] SSE deprecation target:   2026-07-01`);
	}
	if (HTTP_ENABLED) {
		console.log(`[MCP] StreamableHTTP Endpoint:  http://localhost:${port}/mcp-streamable`);
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

// Handle graceful shutdown
process.on("SIGTERM", () => {
	console.log("[MCP] SIGTERM received, shutting down gracefully");
	clearInterval(keepalive);
	server.close(() => {
		console.log("[MCP] Server closed");
		process.exit(0);
	});
});

process.on("SIGINT", () => {
	console.log("[MCP] SIGINT received, shutting down gracefully");
	clearInterval(keepalive);
	server.close(() => {
		console.log("[MCP] Server closed");
		process.exit(0);
	});
});

process.on("uncaughtException", (err) => {
	console.error("[MCP] Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
	console.error("[MCP] Unhandled rejection:", reason);
});
