#!/usr/bin/env node

// WebSocket Bridge Server for AgentRoadmap
// Run with: node --import jiti/register scripts/ws-bridge.js

import { startWebSocketServer } from "../src/apps/dashboard-web/websocket-server.ts";

const port = process.env.WS_PORT || 3001;
console.log(`Starting WebSocket bridge on port ${port}...`);
startWebSocketServer(Number(port));

// Keep the process running
process.on("SIGINT", () => {
	console.log("Shutting down WebSocket bridge...");
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("Shutting down WebSocket bridge...");
	process.exit(0);
});
