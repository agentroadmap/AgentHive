import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server } from "node:http";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { subscribeSdb } from "../core/storage/sdb-sdk-loader.ts";
import { createUniqueTestDir, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;
let originalCwd: string;

let wsServer: WebSocketServer;
let httpServer: Server;
let connectedClients: WebSocket[] = [];

let sqlRequestCount = 0;
let lastSqlQueries: string[] = [];

describe("E2E: WebSocket Feed for State Changes and Messaging Channel", () => {
	before(async () => { console.log("Before hook start"); 
		originalCwd = process.cwd();
		TEST_DIR = createUniqueTestDir("test-ws-feed");
		mkdirSync(join(TEST_DIR, "roadmap"), { recursive: true });

		// Write a dummy config to point SpacetimeDB to our local mock servers
		// We'll use a random port for HTTP/WS to avoid conflicts
		const port = 3000 + Math.floor(Math.random() * 10000);
		writeFileSync(
			join(TEST_DIR, "roadmap", "config.yaml"),
			`database:\n  host: "127.0.0.1"\n  port: ${port}\n  name: "testdb"\n`
		);

		process.chdir(TEST_DIR);

		// Start Mock HTTP Server for SpacetimeDB SQL queries
		httpServer = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				sqlRequestCount++;
				if (body.includes("SELECT")) {
					lastSqlQueries.push(body);
				}

				let schema: any = { elements: [] };
				let rows: any[] = [];

				if (body.includes("SELECT * FROM proposal")) {
					schema.elements = [
						{ name: "id" },
						{ name: "display_id" },
						{ name: "title" },
						{ name: "status" },
						{ name: "priority" },
						{ name: "body_markdown" },
						{ name: "created_at" },
						{ name: "updated_at" },
						{ name: "proposal_type" }
					];
					rows = [
						[
							1,
							"proposal-1",
							"Test Proposal",
							"Active",
							"high",
							"Description",
							Date.now() * 1000,
							Date.now() * 1000,
							"STANDARD"
						]
					];
				} else if (body.includes("SELECT * FROM message_ledger")) {
					schema.elements = [
						{ name: "id" },
						{ name: "channel_name" },
						{ name: "sender" },
						{ name: "message" },
						{ name: "timestamp" }
					];
					rows = [
						[
							1,
							"general",
							"system",
							"Hello world",
							Date.now() * 1000
						]
					];
				} else if (body.includes("SELECT id, display_id, title")) {
                    // Directives query
					schema.elements = [
						{ name: "id" },
						{ name: "display_id" },
						{ name: "title" },
						{ name: "description" },
						{ name: "status" }
					];
					rows = [];
				}

				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify([{ schema, rows }]));
			});
		});

		await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));

		// Start Mock WS Server for SpacetimeDB Subscriptions
		wsServer = new WebSocketServer({ server: httpServer });
		wsServer.on("connection", (ws) => {
			connectedClients.push(ws);
			ws.on("message", (msg) => {
				const data = JSON.parse(msg.toString());
				if (data.subscribe) {
					// Acknowledge subscription implicitly or send initial data if needed
				}
			});
			ws.on("close", () => {
				connectedClients = connectedClients.filter((c) => c !== ws);
			});
		});
	});

	afterEach(() => {
		sqlRequestCount = 0;
		lastSqlQueries = [];
	});

	after(async () => {
		if (wsServer) wsServer.close();
		if (httpServer) {
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
		process.chdir(originalCwd);
		try {
			await safeCleanup(TEST_DIR);
		} catch (e) {}
	});

	it("should establish a websocket connection and subscribe to tables", async () => {
		let unsubscribe: (() => void) | undefined;

		const updateReceived = new Promise<any>((resolve) => {
			let callCount = 0;
			unsubscribe = subscribeSdb((data) => {
				callCount++;
				if (data && data.proposals && data.proposals.length > 0) {
					resolve(data);
				}
			});
		});

        // Wait a little bit for the connection to establish
        await new Promise((resolve) => setTimeout(resolve, 100));

		// Verify connection was made
		assert.ok(connectedClients.length > 0, "WebSocket client should have connected");

		// Simulate a SpacetimeDB SubscriptionUpdate event
		connectedClients[0].send(JSON.stringify({ SubscriptionUpdate: true }));

		// Wait for the callback to be triggered
		const data = await updateReceived;

		assert.ok(data, "Callback should receive data");
		assert.strictEqual(data.proposals.length, 1, "Should parse 1 proposal");
		assert.strictEqual(data.proposals[0].id, "proposal-1", "Proposal ID should match");
		assert.strictEqual(data.messages.length, 1, "Should parse 1 message");
		assert.strictEqual(data.messages[0].message, "Hello world", "Message content should match");

		// Verify SQL queries were executed correctly
		assert.ok(sqlRequestCount >= 3, "Should have executed SQL queries via HTTP to fetch data");

		if (unsubscribe) {
			unsubscribe();
		}
	});

	it("should handle polling fallback if WebSocket server is down", async () => {
		// Close the WS server to simulate failure
		wsServer.close();
		connectedClients.forEach(ws => ws.close());

		let unsubscribe: (() => void) | undefined;
		let callCount = 0;

		const updateReceived = new Promise<any>((resolve) => {
			unsubscribe = subscribeSdb((data) => {
				callCount++;
				if (callCount > 0) {
					resolve(data);
				}
			});
		});

		// Polling interval is 3000ms, so we wait for the first fetch to complete, 
        // wait, the first fetch happens *inside* startPolling interval or immediately?
        // Let's check `subscribeSdb`. It sets an interval but doesn't call it immediately.
        // Wait, startPolling: `pollInterval = setInterval(() => { getSdbData().then(...) }, 3000)`.
        // So we'd have to wait 3 seconds. To avoid long tests, we might want to skip or just mock timers.
        // Let's just wait up to 3.5s.
		const data = await updateReceived;

		assert.ok(data, "Fallback polling should eventually return data");
		assert.strictEqual(data.proposals.length, 1);

		if (unsubscribe) {
			unsubscribe();
		}
	});
});
