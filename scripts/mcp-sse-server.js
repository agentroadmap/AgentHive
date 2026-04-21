import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const serverModule = await import("../src/apps/mcp-server/server.ts");
const httpCompatModule = await import("../src/apps/mcp-server/http-compat.ts");
const createMcpServer =
	serverModule.createMcpServer || serverModule.default?.createMcpServer;
const handleDirectMcpRequest =
	httpCompatModule.handleDirectMcpRequest ||
	httpCompatModule.default?.handleDirectMcpRequest;

if (!createMcpServer) {
	console.error("[MCP] Failed to load createMcpServer from server module");
	process.exit(1);
}
if (!handleDirectMcpRequest) {
	console.error("[MCP] Failed to load direct MCP request handler");
	process.exit(1);
}

const app = express();
const directMcpServer = await createMcpServer(projectRoot);

// Session tracking: sessionId → { server, transport }
const sessions = new Map();

// Health check endpoint
app.get("/health", async (_req, res) => {
	const sessionCount = sessions.size;
	const uptime = process.uptime();
	res.json({
		status: "ok",
		uptime: Math.round(uptime),
		sessions: sessionCount,
		timestamp: new Date().toISOString(),
	});
});

app.post(["/mcp", "/api/mcp"], express.json(), async (req, res) => {
	try {
		const response = await handleDirectMcpRequest(directMcpServer, req.body);
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

// StreamableHTTP endpoint — compatible with hermes MCP client and other modern clients
// Single endpoint handles GET (SSE stream), POST (JSON-RPC), DELETE (cleanup)
app.all("/mcp-streamable", async (req, res) => {
	try {
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
});

app.get("/sse", async (_req, res) => {
	console.log("[MCP] New SSE connection request");
	try {
		const server = await createMcpServer(projectRoot);
		const sseTransport = await server.createSseTransport("/messages", res);

		const sessionId = sseTransport.sessionId;
		sessions.set(sessionId, { server, transport: sseTransport });
		console.log(
			`[MCP] SSE session created: ${sessionId}, active sessions: ${sessions.size}`,
		);

		res.on("close", () => {
			console.log(`[MCP] SSE connection closed: ${sessionId}`);
			sessions.delete(sessionId);
			server.stop().catch(() => {});
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
	const session = sessions.get(sessionId);

	if (!session) {
		res.status(400).send(`No active SSE connection for session: ${sessionId}`);
		return;
	}

	try {
		// Pass req, res, AND the pre-parsed body (req.body from express.json())
		// The SDK needs the parsed body because it won't try to re-read the stream
		await session.server.handleSseMessage(
			session.transport,
			req,
			res,
			req.body,
		);
	} catch (err) {
		console.error("[MCP] Error handling message:", err.message);
		if (!res.writableEnded) {
			res.status(500).send("Internal error");
		}
	}
});

const port = process.env.MCP_PORT || 6421;
const server = app.listen(port, "0.0.0.0", () => {
	console.log(`[MCP] AgentHive SSE MCP server listening on port ${port}`);
	console.log(`[MCP] SSE Endpoint: http://localhost:${port}/sse`);
	console.log(`[MCP] Message Endpoint: http://localhost:${port}/messages`);
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
