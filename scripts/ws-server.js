#!/usr/bin/env node

// Standalone WebSocket server for roadmap snapshots
// Run with: node --import jiti/register scripts/ws-server.js

import { startWebSocketServer } from "../src/apps/dashboard-web/websocket-server.ts";

const port = process.env.WS_PORT || 3001;
console.log(`Starting WebSocket server on port ${port}...`);
startWebSocketServer(Number(port));

// Keep the process running
process.on("SIGINT", () => {
	console.log("Shutting down WebSocket server...");
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("Shutting down WebSocket server...");
	process.exit(0);
});
