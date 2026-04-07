/**
 * STATE-46: Multi-Host Federation
 *
 * Enable agents on different machines to collaborate on the same roadmap
 * via HTTP/WebSocket API instead of shared filesystem.
 *
 * AC#1: Agents communicate via HTTP/WebSocket API
 * AC#2: Proposal changes propagated to all connected agents
 * AC#3: Conflict resolution for concurrent edits
 * AC#4: Connection recovery after network interruption
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	request,
	type Server,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { FederationPKI } from "./federation.ts";

// ─── Types ───────────────────────────────────────────────────────────

export type MessageType =
	| "proposal_update"
	| "proposal_request"
	| "proposal_response"
	| "conflict_notify"
	| "conflict_resolve"
	| "heartbeat"
	| "heartbeat_ack"
	| "sync_request"
	| "sync_response"
	| "agent_join"
	| "agent_leave"
	| "error";

export type ConflictResolutionStrategy = "last-write-wins" | "merge" | "manual";

export interface FederationMessage {
	id: string;
	type: MessageType;
	sourceHostId: string;
	targetHostId?: string; // undefined = broadcast
	timestamp: string;
	correlationId?: string; // For request/response pairing
	payload: Record<string, unknown>;
	signature?: string; // Message signature for authenticity
}

export interface ProposalChangePayload {
	proposalId: string;
	proposalPath: string;
	operation: "create" | "update" | "delete" | "claim" | "release";
	previousHash?: string;
	currentHash: string;
	content: string;
	author: string;
	timestamp: string;
}

export interface ConflictEntry {
	conflictId: string;
	proposalId: string;
	conflictType: "concurrent_edit" | "hash_mismatch" | "stale_reference";
	initiatorHostId: string;
	resolverHostId?: string;
	resolution?: string;
	status: "pending" | "resolved" | "escalated";
	strategy: ConflictResolutionStrategy;
	createdAt: string;
	resolvedAt?: string;
	versions: ConflictVersion[];
}

export interface ConflictVersion {
	hostId: string;
	contentHash: string;
	content: string;
	timestamp: string;
	author: string;
}

export interface ConnectedAgent {
	agentId: string;
	hostId: string;
	connectionId: string;
	connectedAt: string;
	lastHeartbeat: string;
	status: "connected" | "disconnected" | "syncing";
	pendingChanges: number;
}

export interface SyncProposal {
	hostId: string;
	lastSyncAt: string;
	syncedProposals: string[];
	pendingProposals: string[];
	failedProposals: string[];
}

export interface FederationConfig {
	port: number;
	hostId: string;
	secretKey: string;
	knownHosts: Array<{ hostId: string; hostname: string; port: number }>;
	heartbeatIntervalMs: number;
	syncBatchSize: number;
	conflictResolution: ConflictResolutionStrategy;
	maxRetries: number;
	retryDelayMs: number;
}

export interface WebSocketConnection {
	id: string;
	hostId: string;
	agentId?: string;
	connectedAt: string;
	lastMessageAt: string;
	pendingMessages: FederationMessage[];
	isAlive: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: Partial<FederationConfig> = {
	port: 8900,
	heartbeatIntervalMs: 30000,
	syncBatchSize: 50,
	conflictResolution: "last-write-wins",
	maxRetries: 3,
	retryDelayMs: 1000,
};

const _FEDERATION_DIR = ".roadmap/federation";
const _SYNC_STATE_FILE = "sync-proposal.json";
const _PENDING_CHANGES_FILE = "pending-changes.json";

// ─── Message Helpers ─────────────────────────────────────────────────

function createMessage(
	type: MessageType,
	sourceHostId: string,
	payload: Record<string, unknown>,
	options?: { targetHostId?: string; correlationId?: string },
): FederationMessage {
	return {
		id: randomUUID(),
		type,
		sourceHostId,
		targetHostId: options?.targetHostId,
		timestamp: new Date().toISOString(),
		correlationId: options?.correlationId,
		payload,
	};
}

function computeContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function serializeMessage(msg: FederationMessage): string {
	return JSON.stringify(msg);
}

function deserializeMessage(data: string): FederationMessage {
	return JSON.parse(data) as FederationMessage;
}

// ─── Conflict Resolver ──────────────────────────────────────────────

export class ConflictResolver {
	private conflicts: Map<string, ConflictEntry> = new Map();
	private strategy: ConflictResolutionStrategy;

	constructor(strategy: ConflictResolutionStrategy = "last-write-wins") {
		this.strategy = strategy;
	}

	/**
	 * AC#3: Detect and register a conflict between concurrent edits.
	 */
	detectConflict(
		proposalId: string,
		version1: ConflictVersion,
		version2: ConflictVersion,
	): ConflictEntry {
		const conflictId = randomUUID();
		const conflict: ConflictEntry = {
			conflictId,
			proposalId,
			conflictType: "concurrent_edit",
			initiatorHostId: version1.hostId,
			status: "pending",
			strategy: this.strategy,
			createdAt: new Date().toISOString(),
			versions: [version1, version2].sort((a, b) =>
				a.timestamp.localeCompare(b.timestamp),
			),
		};
		this.conflicts.set(conflictId, conflict);
		return conflict;
	}

	/**
	 * AC#3: Resolve a conflict using the configured strategy.
	 */
	resolveConflict(
		conflictId: string,
		resolverHostId: string,
	): {
		resolved: boolean;
		winningVersion?: ConflictVersion;
		resolution: string;
	} {
		const conflict = this.conflicts.get(conflictId);
		if (!conflict) {
			return { resolved: false, resolution: "Conflict not found" };
		}

		if (conflict.status === "resolved") {
			return { resolved: false, resolution: "Conflict already resolved" };
		}

		let winningVersion: ConflictVersion | undefined;

		switch (conflict.strategy) {
			case "last-write-wins":
				// Pick the latest timestamp
				winningVersion = conflict.versions[conflict.versions.length - 1];
				break;
			case "merge":
				// For merge strategy, pick the version with more content (heuristic)
				winningVersion = conflict.versions.reduce((a, b) =>
					a.content.length >= b.content.length ? a : b,
				);
				break;
			case "manual":
				// Manual resolution requires explicit resolution
				return {
					resolved: false,
					resolution: "Manual resolution required. Provide resolution content.",
				};
		}

		conflict.status = "resolved";
		conflict.resolverHostId = resolverHostId;
		conflict.resolvedAt = new Date().toISOString();
		conflict.resolution = `Resolved via ${conflict.strategy} by ${resolverHostId}`;

		return {
			resolved: true,
			winningVersion,
			resolution: conflict.resolution,
		};
	}

	/**
	 * Get a conflict by ID.
	 */
	getConflict(conflictId: string): ConflictEntry | null {
		return this.conflicts.get(conflictId) ?? null;
	}

	/**
	 * Get all pending conflicts.
	 */
	getPendingConflicts(): ConflictEntry[] {
		return Array.from(this.conflicts.values()).filter(
			(c) => c.status === "pending",
		);
	}

	/**
	 * Get conflicts for a specific proposal.
	 */
	getProposalConflicts(proposalId: string): ConflictEntry[] {
		return Array.from(this.conflicts.values()).filter(
			(c) => c.proposalId === proposalId,
		);
	}

	/**
	 * Get all conflicts.
	 */
	getAllConflicts(): ConflictEntry[] {
		return Array.from(this.conflicts.values());
	}
}

// ─── Connection Manager ─────────────────────────────────────────────

export class ConnectionManager {
	private connections: Map<string, WebSocketConnection> = new Map();
	private reconnectAttempts: Map<string, number> = new Map();
	private maxRetries: number;
	private retryDelayMs: number;

	constructor(options?: { maxRetries?: number; retryDelayMs?: number }) {
		this.maxRetries = options?.maxRetries ?? 3;
		this.retryDelayMs = options?.retryDelayMs ?? 1000;
	}

	/**
	 * Register a new connection.
	 */
	addConnection(connection: WebSocketConnection): void {
		this.connections.set(connection.id, connection);
		this.reconnectAttempts.delete(connection.hostId);
	}

	/**
	 * Remove a connection.
	 */
	removeConnection(connectionId: string): boolean {
		const conn = this.connections.get(connectionId);
		if (conn) {
			this.connections.delete(connectionId);
			return true;
		}
		return false;
	}

	/**
	 * Get a connection by ID.
	 */
	getConnection(connectionId: string): WebSocketConnection | null {
		return this.connections.get(connectionId) ?? null;
	}

	/**
	 * Get all active connections.
	 */
	getActiveConnections(): WebSocketConnection[] {
		return Array.from(this.connections.values()).filter((c) => c.isAlive);
	}

	/**
	 * Get connection by host ID.
	 */
	getConnectionByHost(hostId: string): WebSocketConnection | null {
		return (
			Array.from(this.connections.values()).find((c) => c.hostId === hostId) ??
			null
		);
	}

	/**
	 * AC#4: Track reconnection attempts for a host.
	 */
	recordReconnectAttempt(hostId: string): number {
		const attempts = (this.reconnectAttempts.get(hostId) ?? 0) + 1;
		this.reconnectAttempts.set(hostId, attempts);
		return attempts;
	}

	/**
	 * AC#4: Check if we should retry connection to a host.
	 */
	shouldRetryConnection(hostId: string): boolean {
		const attempts = this.reconnectAttempts.get(hostId) ?? 0;
		return attempts < this.maxRetries;
	}

	/**
	 * AC#4: Get retry delay with exponential backoff.
	 */
	getRetryDelay(hostId: string): number {
		const attempts = this.reconnectAttempts.get(hostId) ?? 0;
		return this.retryDelayMs * 2 ** attempts;
	}

	/**
	 * Reset reconnection attempts for a host (after successful connection).
	 */
	resetReconnectAttempts(hostId: string): void {
		this.reconnectAttempts.delete(hostId);
	}

	/**
	 * Mark a connection as dead (heartbeat failed).
	 */
	markConnectionDead(connectionId: string): void {
		const conn = this.connections.get(connectionId);
		if (conn) {
			conn.isAlive = false;
		}
	}

	/**
	 * Get all connections (alive and dead).
	 */
	getAllConnections(): WebSocketConnection[] {
		return Array.from(this.connections.values());
	}

	/**
	 * Get connection statistics.
	 */
	getStats(): {
		total: number;
		alive: number;
		dead: number;
		pendingMessages: number;
	} {
		const all = Array.from(this.connections.values());
		return {
			total: all.length,
			alive: all.filter((c) => c.isAlive).length,
			dead: all.filter((c) => !c.isAlive).length,
			pendingMessages: all.reduce(
				(sum, c) => sum + c.pendingMessages.length,
				0,
			),
		};
	}
}

// ─── Federation Server ──────────────────────────────────────────────

export class FederationServer {
	private server: Server | null = null;
	private config: FederationConfig;
	private pki: FederationPKI;
	private conflictResolver: ConflictResolver;
	private connectionManager: ConnectionManager;
	private connectedAgents: Map<string, ConnectedAgent> = new Map();
	private messageHandlers: Map<
		MessageType,
		(msg: FederationMessage) => Promise<FederationMessage | null>
	> = new Map();
	private pendingChanges: Map<string, ProposalChangePayload> = new Map();

	constructor(
		config: Partial<FederationConfig> & { hostId: string; secretKey: string },
	) {
		this.config = { ...DEFAULT_CONFIG, ...config } as FederationConfig;
		this.pki = new FederationPKI();
		this.conflictResolver = new ConflictResolver(
			this.config.conflictResolution,
		);
		this.connectionManager = new ConnectionManager({
			maxRetries: this.config.maxRetries,
			retryDelayMs: this.config.retryDelayMs,
		});
		this.setupMessageHandlers();
	}

	/**
	 * AC#1: Start the federation server.
	 */
	async start(): Promise<void> {
		this.server = createServer(this.handleRequest.bind(this));
		await new Promise<void>((resolve) => {
			this.server?.listen(this.config.port, () => {
				console.log(`Federation server listening on port ${this.config.port}`);
				resolve();
			});
		});
	}

	/**
	 * Stop the federation server.
	 */
	async stop(): Promise<void> {
		if (this.server) {
			await new Promise<void>((resolve) => {
				this.server?.close(() => resolve());
			});
			this.server = null;
		}
	}

	/**
	 * AC#1: Handle incoming HTTP requests.
	 */
	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			try {
				// Handle different endpoints
				if (req.method === "POST" && req.url === "/federation/message") {
					const message = deserializeMessage(body);
					const response = await this.processMessage(message);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(
						serializeMessage(
							response ??
								createMessage("error", this.config.hostId, {
									error: "No response",
								}),
						),
					);
				} else if (req.method === "POST" && req.url === "/federation/sync") {
					const syncData = JSON.parse(body);
					const result = await this.handleSyncRequest(syncData);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(result));
				} else if (req.method === "GET" && req.url === "/federation/status") {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(this.getStatus()));
				} else if (
					req.method === "POST" &&
					req.url === "/federation/heartbeat"
				) {
					const msg = deserializeMessage(body);
					const ack = createMessage(
						"heartbeat_ack",
						this.config.hostId,
						{ receivedAt: new Date().toISOString() },
						{ correlationId: msg.id },
					);
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(serializeMessage(ack));
				} else {
					res.writeHead(404);
					res.end("Not Found");
				}
			} catch (error) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: String(error) }));
			}
		});
	}

	/**
	 * Setup internal message handlers.
	 */
	private setupMessageHandlers(): void {
		// AC#2: Handle proposal updates
		this.messageHandlers.set("proposal_update", async (msg) => {
			const payload = msg.payload as unknown as ProposalChangePayload;
			await this.applyProposalChange(payload);
			return createMessage(
				"heartbeat_ack",
				this.config.hostId,
				{ applied: true },
				{ correlationId: msg.id },
			);
		});

		// AC#2: Handle proposal requests
		this.messageHandlers.set("proposal_request", async (msg) => {
			const proposalId = msg.payload.proposalId as string;
			const proposalContent = await this.getProposalContent(proposalId);
			return createMessage(
				"proposal_response",
				this.config.hostId,
				{ proposalId, content: proposalContent },
				{ correlationId: msg.id },
			);
		});

		// AC#3: Handle conflict notifications
		this.messageHandlers.set("conflict_notify", async (msg) => {
			const versions = msg.payload.versions as ConflictVersion[];
			const proposalId = msg.payload.proposalId as string;
			const conflict = this.conflictResolver.detectConflict(
				proposalId,
				versions[0],
				versions[1],
			);
			return createMessage(
				"conflict_resolve",
				this.config.hostId,
				{ conflictId: conflict.conflictId, status: conflict.status },
				{ correlationId: msg.id },
			);
		});

		// AC#4: Handle heartbeats
		this.messageHandlers.set("heartbeat", async (msg) => {
			const agentId = msg.payload.agentId as string;
			if (agentId) {
				const agent = this.connectedAgents.get(agentId);
				if (agent) {
					agent.lastHeartbeat = new Date().toISOString();
				}
			}
			return createMessage(
				"heartbeat_ack",
				this.config.hostId,
				{ timestamp: new Date().toISOString() },
				{ correlationId: msg.id },
			);
		});

		// AC#2: Handle sync requests
		this.messageHandlers.set("sync_request", async (msg) => {
			const since = msg.payload.since as string;
			const changes = await this.getChangesSince(since);
			return createMessage(
				"sync_response",
				this.config.hostId,
				{ changes, syncTimestamp: new Date().toISOString() },
				{ correlationId: msg.id },
			);
		});
	}

	/**
	 * Process an incoming message.
	 */
	async processMessage(
		message: FederationMessage,
	): Promise<FederationMessage | null> {
		const handler = this.messageHandlers.get(message.type);
		if (handler) {
			return await handler(message);
		}
		return createMessage(
			"error",
			this.config.hostId,
			{ error: `Unknown message type: ${message.type}` },
			{ correlationId: message.id },
		);
	}

	/**
	 * AC#2: Apply a proposal change from another host.
	 */
	private async applyProposalChange(
		payload: ProposalChangePayload,
	): Promise<void> {
		// Check for conflicts
		const currentProposalHash = await this.getProposalHash(payload.proposalId);
		if (currentProposalHash && currentProposalHash !== payload.previousHash) {
			// Conflict detected - the previous hash doesn't match
			const conflict = this.conflictResolver.detectConflict(
				payload.proposalId,
				{
					hostId: this.config.hostId,
					contentHash: currentProposalHash,
					content: (await this.getProposalContent(payload.proposalId)) ?? "",
					timestamp: new Date().toISOString(),
					author: "local",
				},
				{
					hostId: payload.author,
					contentHash: payload.currentHash,
					content: payload.content,
					timestamp: payload.timestamp,
					author: payload.author,
				},
			);

			// Auto-resolve if possible
			const resolution = this.conflictResolver.resolveConflict(
				conflict.conflictId,
				this.config.hostId,
			);
			if (resolution.resolved && resolution.winningVersion) {
				await this.saveProposalContent(
					payload.proposalId,
					resolution.winningVersion.content,
				);
			}
		} else {
			// No conflict - apply directly
			await this.saveProposalContent(payload.proposalId, payload.content);
		}

		// Record the change
		this.pendingChanges.set(payload.proposalId, payload);
	}

	/**
	 * AC#1: Send a message to a specific host.
	 */
	async sendMessage(
		targetHostname: string,
		targetPort: number,
		message: FederationMessage,
	): Promise<FederationMessage | null> {
		const body = serializeMessage(message);

		return new Promise((resolve, reject) => {
			const req = request(
				{
					hostname: targetHostname,
					port: targetPort,
					path: "/federation/message",
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"Content-Length": Buffer.byteLength(body),
						"X-Host-Id": this.config.hostId,
					},
				},
				(res: any) => {
					let data = "";
					res.on("data", (chunk: any) => {
						data += chunk;
					});
					res.on("end", () => {
						try {
							resolve(deserializeMessage(data));
						} catch {
							reject(new Error("Failed to parse response"));
						}
					});
				},
			);

			req.on("error", (err: any) => {
				// AC#4: Record reconnection attempt
				this.connectionManager.recordReconnectAttempt(targetHostname);
				reject(err);
			});

			req.write(body);
			req.end();
		});
	}

	/**
	 * AC#2: Broadcast a proposal change to all connected hosts.
	 */
	async broadcastProposalChange(payload: ProposalChangePayload): Promise<void> {
		const message = createMessage(
			"proposal_update",
			this.config.hostId,
			payload as unknown as Record<string, unknown>,
		);

		for (const host of this.config.knownHosts) {
			try {
				await this.sendMessage(host.hostname, host.port, message);
			} catch (error) {
				console.error(
					`Failed to broadcast to ${host.hostname}:${host.port}:`,
					error,
				);
			}
		}
	}

	/**
	 * AC#4: Request sync from a peer.
	 */
	async requestSync(
		hostname: string,
		port: number,
		since?: string,
	): Promise<SyncProposal | null> {
		const message = createMessage("sync_request", this.config.hostId, {
			since: since ?? new Date(0).toISOString(),
		});

		try {
			const response = await this.sendMessage(hostname, port, message);
			if (response && response.type === "sync_response") {
				const changes = response.payload.changes as ProposalChangePayload[];
				for (const change of changes) {
					await this.applyProposalChange(change);
				}
				return {
					hostId: response.sourceHostId,
					lastSyncAt: response.timestamp,
					syncedProposals: changes.map((c) => c.proposalId),
					pendingProposals: [],
					failedProposals: [],
				};
			}
		} catch (error) {
			console.error(`Sync failed with ${hostname}:${port}:`, error);
		}
		return null;
	}

	/**
	 * AC#3: Handle sync request and return changes.
	 */
	private async handleSyncRequest(data: {
		since: string;
	}): Promise<{ changes: ProposalChangePayload[] }> {
		const changes = await this.getChangesSince(data.since);
		return { changes };
	}

	/**
	 * Get all changes since a timestamp.
	 */
	private async getChangesSince(
		since: string,
	): Promise<ProposalChangePayload[]> {
		const changes: ProposalChangePayload[] = [];
		for (const [, change] of this.pendingChanges) {
			if (change.timestamp > since) {
				changes.push(change);
			}
		}
		return changes;
	}

	/**
	 * Get content hash for a proposal.
	 */
	private async getProposalHash(proposalId: string): Promise<string | null> {
		const content = await this.getProposalContent(proposalId);
		return content ? computeContentHash(content) : null;
	}

	/**
	 * Get content for a proposal.
	 */
	private async getProposalContent(proposalId: string): Promise<string | null> {
		try {
			const proposalPath = join(
				process.cwd(),
				"roadmap",
				"proposals",
				`${proposalId}.md`,
			);
			await access(proposalPath);
			return await readFile(proposalPath, "utf-8");
		} catch {
			return null;
		}
	}

	/**
	 * Save content for a proposal.
	 */
	private async saveProposalContent(
		proposalId: string,
		content: string,
	): Promise<void> {
		const proposalPath = join(
			process.cwd(),
			"roadmap",
			"proposals",
			`${proposalId}.md`,
		);
		const dir = join(process.cwd(), "roadmap", "proposals");
		if (!existsSync(dir)) {
			await mkdir(dir, { recursive: true });
		}
		await writeFile(proposalPath, content, "utf-8");
	}

	/**
	 * Register a connected agent.
	 */
	registerAgent(agent: ConnectedAgent): void {
		this.connectedAgents.set(agent.agentId, agent);
	}

	/**
	 * Unregister an agent.
	 */
	unregisterAgent(agentId: string): boolean {
		return this.connectedAgents.delete(agentId);
	}

	/**
	 * Get all connected agents.
	 */
	getConnectedAgents(): ConnectedAgent[] {
		return Array.from(this.connectedAgents.values());
	}

	/**
	 * Get federation status.
	 */
	getStatus(): {
		hostId: string;
		port: number;
		connectedAgents: number;
		pendingChanges: number;
		conflicts: number;
		connectionStats: ReturnType<ConnectionManager["getStats"]>;
	} {
		return {
			hostId: this.config.hostId,
			port: this.config.port,
			connectedAgents: this.connectedAgents.size,
			pendingChanges: this.pendingChanges.size,
			conflicts: this.conflictResolver.getPendingConflicts().length,
			connectionStats: this.connectionManager.getStats(),
		};
	}

	/**
	 * Get the conflict resolver.
	 */
	getConflictResolver(): ConflictResolver {
		return this.conflictResolver;
	}

	/**
	 * Get the connection manager.
	 */
	getConnectionManager(): ConnectionManager {
		return this.connectionManager;
	}

	/**
	 * Get the PKI instance.
	 */
	getPKI(): FederationPKI {
		return this.pki;
	}
}

// ─── Convenience Functions ──────────────────────────────────────────

/**
 * Create a federation message for proposal update.
 */
export function createProposalUpdateMessage(
	sourceHostId: string,
	proposalId: string,
	content: string,
	author: string,
	options?: { previousHash?: string },
): FederationMessage {
	const currentHash = computeContentHash(content);
	return createMessage("proposal_update", sourceHostId, {
		proposalId,
		proposalPath: `roadmap/proposals/${proposalId}.md`,
		operation: "update",
		previousHash: options?.previousHash,
		currentHash,
		content,
		author,
		timestamp: new Date().toISOString(),
	});
}

/**
 * Create a heartbeat message.
 */
export function createHeartbeatMessage(
	sourceHostId: string,
	agentId: string,
): FederationMessage {
	return createMessage("heartbeat", sourceHostId, {
		agentId,
		timestamp: new Date().toISOString(),
	});
}

/**
 * Check if two content versions conflict.
 */
export function hasConflict(hash1: string, hash2: string): boolean {
	return hash1 !== hash2;
}

/**
 * Compute content hash (exported for external use).
 */
export function computeHash(content: string): string {
	return computeContentHash(content);
}
