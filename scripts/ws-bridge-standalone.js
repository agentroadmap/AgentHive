// Standalone WebSocket Bridge for AgentRoadmap
// Run with: node scripts/ws-bridge-standalone.js

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const port = process.env.WS_PORT || 3001;
const server = createServer();
const wss = new WebSocketServer({ server });
const clients = new Set();

console.log(`Starting WebSocket bridge on port ${port}...`);

wss.on("connection", (ws) => {
	clients.add(ws);
	console.log("[WS] Client connected");

	ws.on("message", async (data) => {
		try {
			const msg = JSON.parse(data.toString());
			console.log("[WS] Received:", msg);

			// Handle different message types
			switch (msg.type) {
				case "subscribe":
					ws.send(JSON.stringify({ type: "subscribed", channel: msg.channel }));
					break;
				case "ping":
					ws.send(JSON.stringify({ type: "pong" }));
					break;
				default:
					ws.send(
						JSON.stringify({ type: "error", message: "Unknown message type" }),
					);
			}
		} catch (_error) {
			ws.send(JSON.stringify({ type: "error", message: "Invalid message" }));
		}
	});

	ws.on("close", () => {
		clients.delete(ws);
		console.log("[WS] Client disconnected");
	});

	ws.send(
		JSON.stringify({
			type: "connected",
			message: "Connected to AgentRoadmap WebSocket Bridge",
		}),
	);
});

server.listen(port, () => {
	console.log(`[WS] WebSocket bridge running on port ${port}`);
});

// Keep the process running
process.on("SIGINT", () => {
	console.log("Shutting down WebSocket bridge...");
	wss.close();
	server.close();
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("Shutting down WebSocket bridge...");
	wss.close();
	server.close();
	process.exit(0);
});
