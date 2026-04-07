/**
 * Tests for proposal-46: Multi-Host Federation
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	ConflictResolver,
	type ConflictVersion,
	type ConnectedAgent,
	ConnectionManager,
	computeHash,
	createHeartbeatMessage,
	createProposalUpdateMessage,
	FederationServer,
	hasConflict,
	type WebSocketConnection,
} from "../../src/core/infrastructure/federation-api.ts";

describe("proposal-46: Multi-Host Federation", () => {
	describe("ConflictResolver", () => {
		it("should detect concurrent edit conflicts", () => {
			const resolver = new ConflictResolver();
			const v1: ConflictVersion = {
				hostId: "host-1",
				contentHash: "hash1",
				content: "version 1",
				timestamp: "2026-03-24T10:00:00Z",
				author: "alice",
			};
			const v2: ConflictVersion = {
				hostId: "host-2",
				contentHash: "hash2",
				content: "version 2",
				timestamp: "2026-03-24T10:00:01Z",
				author: "bob",
			};

			const conflict = resolver.detectConflict("proposal-1", v1, v2);
			assert.ok(conflict.conflictId);
			assert.equal(conflict.proposalId, "proposal-1");
			assert.equal(conflict.status, "pending");
			assert.equal(conflict.versions.length, 2);
		});

		it("AC#3: resolves conflicts with last-write-wins strategy", () => {
			const resolver = new ConflictResolver("last-write-wins");
			const v1: ConflictVersion = {
				hostId: "host-1",
				contentHash: "hash1",
				content: "version 1",
				timestamp: "2026-03-24T10:00:00Z",
				author: "alice",
			};
			const v2: ConflictVersion = {
				hostId: "host-2",
				contentHash: "hash2",
				content: "version 2 is longer",
				timestamp: "2026-03-24T10:00:01Z",
				author: "bob",
			};

			const conflict = resolver.detectConflict("proposal-1", v1, v2);
			const result = resolver.resolveConflict(conflict.conflictId, "host-3");

			assert.equal(result.resolved, true);
			assert.ok(result.winningVersion);
			assert.equal(result.winningVersion?.hostId, "host-2"); // Last write wins
		});

		it("AC#3: resolves conflicts with merge strategy", () => {
			const resolver = new ConflictResolver("merge");
			const v1: ConflictVersion = {
				hostId: "host-1",
				contentHash: "hash1",
				content: "short",
				timestamp: "2026-03-24T10:00:00Z",
				author: "alice",
			};
			const v2: ConflictVersion = {
				hostId: "host-2",
				contentHash: "hash2",
				content: "this is a much longer version with more content",
				timestamp: "2026-03-24T10:00:01Z",
				author: "bob",
			};

			const conflict = resolver.detectConflict("proposal-1", v1, v2);
			const result = resolver.resolveConflict(conflict.conflictId, "host-3");

			assert.equal(result.resolved, true);
			assert.ok(result.winningVersion);
			assert.equal(result.winningVersion?.hostId, "host-2"); // Merge picks longer
		});

		it("AC#3: returns manual resolution needed for manual strategy", () => {
			const resolver = new ConflictResolver("manual");
			const v1: ConflictVersion = {
				hostId: "host-1",
				contentHash: "hash1",
				content: "version 1",
				timestamp: "2026-03-24T10:00:00Z",
				author: "alice",
			};
			const v2: ConflictVersion = {
				hostId: "host-2",
				contentHash: "hash2",
				content: "version 2",
				timestamp: "2026-03-24T10:00:01Z",
				author: "bob",
			};

			const conflict = resolver.detectConflict("proposal-1", v1, v2);
			const result = resolver.resolveConflict(conflict.conflictId, "host-3");

			assert.equal(result.resolved, false);
			assert.ok(result.resolution.includes("Manual"));
		});

		it("should get pending conflicts", () => {
			const resolver = new ConflictResolver();
			const v1: ConflictVersion = {
				hostId: "host-1",
				contentHash: "hash1",
				content: "v1",
				timestamp: "2026-03-24T10:00:00Z",
				author: "a",
			};
			const v2: ConflictVersion = {
				hostId: "host-2",
				contentHash: "hash2",
				content: "v2",
				timestamp: "2026-03-24T10:00:01Z",
				author: "b",
			};

			resolver.detectConflict("s1", v1, v2);
			resolver.detectConflict("s2", v1, v2);

			const pending = resolver.getPendingConflicts();
			assert.equal(pending.length, 2);
		});

		it("should get conflicts by proposal ID", () => {
			const resolver = new ConflictResolver();
			const v1: ConflictVersion = {
				hostId: "host-1",
				contentHash: "hash1",
				content: "v1",
				timestamp: "2026-03-24T10:00:00Z",
				author: "a",
			};
			const v2: ConflictVersion = {
				hostId: "host-2",
				contentHash: "hash2",
				content: "v2",
				timestamp: "2026-03-24T10:00:01Z",
				author: "b",
			};

			resolver.detectConflict("proposal-specific", v1, v2);
			resolver.detectConflict("other-proposal", v1, v2);

			const proposalConflicts =
				resolver.getProposalConflicts("proposal-specific");
			assert.equal(proposalConflicts.length, 1);
			assert.equal(proposalConflicts[0].proposalId, "proposal-specific");
		});
	});

	describe("ConnectionManager", () => {
		it("should add and retrieve connections", () => {
			const manager = new ConnectionManager();
			const conn: WebSocketConnection = {
				id: "conn-1",
				hostId: "host-1",
				connectedAt: new Date().toISOString(),
				lastMessageAt: new Date().toISOString(),
				pendingMessages: [],
				isAlive: true,
			};

			manager.addConnection(conn);
			const retrieved = manager.getConnection("conn-1");
			assert.ok(retrieved);
			assert.equal(retrieved.hostId, "host-1");
		});

		it("should get active connections", () => {
			const manager = new ConnectionManager();
			const alive: WebSocketConnection = {
				id: "conn-1",
				hostId: "host-1",
				connectedAt: new Date().toISOString(),
				lastMessageAt: new Date().toISOString(),
				pendingMessages: [],
				isAlive: true,
			};
			const dead: WebSocketConnection = {
				id: "conn-2",
				hostId: "host-2",
				connectedAt: new Date().toISOString(),
				lastMessageAt: new Date().toISOString(),
				pendingMessages: [],
				isAlive: false,
			};

			manager.addConnection(alive);
			manager.addConnection(dead);

			const active = manager.getActiveConnections();
			assert.equal(active.length, 1);
			assert.equal(active[0].id, "conn-1");
		});

		it("should get connection by host ID", () => {
			const manager = new ConnectionManager();
			const conn: WebSocketConnection = {
				id: "conn-1",
				hostId: "host-unique",
				connectedAt: new Date().toISOString(),
				lastMessageAt: new Date().toISOString(),
				pendingMessages: [],
				isAlive: true,
			};

			manager.addConnection(conn);
			const retrieved = manager.getConnectionByHost("host-unique");
			assert.ok(retrieved);
			assert.equal(retrieved.id, "conn-1");
		});

		it("AC#4: should track reconnection attempts", () => {
			const manager = new ConnectionManager({ maxRetries: 3 });

			assert.equal(manager.shouldRetryConnection("host-1"), true);

			manager.recordReconnectAttempt("host-1");
			manager.recordReconnectAttempt("host-1");
			manager.recordReconnectAttempt("host-1");

			assert.equal(manager.shouldRetryConnection("host-1"), false);
		});

		it("AC#4: should calculate exponential backoff delay", () => {
			const manager = new ConnectionManager({ retryDelayMs: 1000 });

			assert.equal(manager.getRetryDelay("host-1"), 1000); // 2^0 * 1000
			manager.recordReconnectAttempt("host-1");
			assert.equal(manager.getRetryDelay("host-1"), 2000); // 2^1 * 1000
			manager.recordReconnectAttempt("host-1");
			assert.equal(manager.getRetryDelay("host-1"), 4000); // 2^2 * 1000
		});

		it("AC#4: should reset reconnection attempts after success", () => {
			const manager = new ConnectionManager({ maxRetries: 3 });

			manager.recordReconnectAttempt("host-1");
			manager.recordReconnectAttempt("host-1");
			assert.equal(manager.shouldRetryConnection("host-1"), true);

			manager.resetReconnectAttempts("host-1");
			assert.equal(manager.shouldRetryConnection("host-1"), true);
			assert.equal(manager.getRetryDelay("host-1"), 1000);
		});

		it("should mark connection as dead", () => {
			const manager = new ConnectionManager();
			const conn: WebSocketConnection = {
				id: "conn-1",
				hostId: "host-1",
				connectedAt: new Date().toISOString(),
				lastMessageAt: new Date().toISOString(),
				pendingMessages: [],
				isAlive: true,
			};

			manager.addConnection(conn);
			manager.markConnectionDead("conn-1");

			const updated = manager.getConnection("conn-1");
			assert.equal(updated?.isAlive, false);
		});

		it("should provide connection statistics", () => {
			const manager = new ConnectionManager();
			manager.addConnection({
				id: "c1",
				hostId: "h1",
				connectedAt: new Date().toISOString(),
				lastMessageAt: new Date().toISOString(),
				pendingMessages: [],
				isAlive: true,
			});
			manager.addConnection({
				id: "c2",
				hostId: "h2",
				connectedAt: new Date().toISOString(),
				lastMessageAt: new Date().toISOString(),
				pendingMessages: [],
				isAlive: false,
			});

			const stats = manager.getStats();
			assert.equal(stats.total, 2);
			assert.equal(stats.alive, 1);
			assert.equal(stats.dead, 1);
		});
	});

	describe("Message Helpers", () => {
		it("should create proposal update message", () => {
			const msg = createProposalUpdateMessage(
				"host-1",
				"proposal-1",
				"content",
				"alice",
			);

			assert.equal(msg.type, "proposal_update");
			assert.equal(msg.sourceHostId, "host-1");
			assert.ok(msg.id);
			assert.ok(msg.timestamp);
			assert.ok(msg.payload);
		});

		it("should create heartbeat message", () => {
			const msg = createHeartbeatMessage("host-1", "agent-1");

			assert.equal(msg.type, "heartbeat");
			assert.equal(msg.sourceHostId, "host-1");
			assert.equal(msg.payload.agentId, "agent-1");
		});

		it("should detect hash conflicts", () => {
			assert.equal(hasConflict("hash1", "hash1"), false);
			assert.equal(hasConflict("hash1", "hash2"), true);
		});

		it("should compute consistent content hashes", () => {
			const hash1 = computeHash("test content");
			const hash2 = computeHash("test content");
			const hash3 = computeHash("different content");

			assert.equal(hash1, hash2);
			assert.notEqual(hash1, hash3);
		});
	});

	describe("FederationServer", () => {
		let server: FederationServer;

		before(async () => {
			server = new FederationServer({
				hostId: "test-host",
				secretKey: "test-secret-key-12345",
				port: 18900, // Use a different port for testing
			});
		});

		after(async () => {
			await server.stop();
		});

		it("should create server with config", () => {
			assert.ok(server);
			const status = server.getStatus();
			assert.equal(status.hostId, "test-host");
		});

		it("should register and list connected agents", () => {
			const agent: ConnectedAgent = {
				agentId: "agent-1",
				hostId: "test-host",
				connectionId: "conn-1",
				connectedAt: new Date().toISOString(),
				lastHeartbeat: new Date().toISOString(),
				status: "connected",
				pendingChanges: 0,
			};

			server.registerAgent(agent);
			const agents = server.getConnectedAgents();
			assert.equal(agents.length, 1);
			assert.equal(agents[0].agentId, "agent-1");
		});

		it("should unregister agents", () => {
			const agent: ConnectedAgent = {
				agentId: "agent-2",
				hostId: "test-host",
				connectionId: "conn-2",
				connectedAt: new Date().toISOString(),
				lastHeartbeat: new Date().toISOString(),
				status: "connected",
				pendingChanges: 0,
			};

			server.registerAgent(agent);
			assert.equal(server.getConnectedAgents().length, 2);

			const result = server.unregisterAgent("agent-2");
			assert.equal(result, true);
			assert.equal(server.getConnectedAgents().length, 1);
		});

		it("should get conflict resolver", () => {
			const resolver = server.getConflictResolver();
			assert.ok(resolver);
			assert.equal(typeof resolver.detectConflict, "function");
			assert.equal(typeof resolver.resolveConflict, "function");
		});

		it("should get connection manager", () => {
			const manager = server.getConnectionManager();
			assert.ok(manager);
			assert.equal(typeof manager.addConnection, "function");
			assert.equal(typeof manager.removeConnection, "function");
		});

		it("should get PKI instance", () => {
			const pki = server.getPKI();
			assert.ok(pki);
		});

		it("should report status with agent count", () => {
			const status = server.getStatus();
			assert.ok(status.connectedAgents >= 1);
			assert.equal(status.hostId, "test-host");
			assert.ok(status.connectionStats);
		});
	});
});
