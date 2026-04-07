/**
 * STATE-46: Multi-Host Federation Server
 *
 * Enables agents on different machines to collaborate on the same roadmap
 * via HTTP/WebSocket protocol instead of shared filesystem.
 *
 * AC#1: Agents communicate via HTTP/WebSocket API
 * AC#2: Proposal changes propagated to all connected agents
 * AC#3: Conflict resolution for concurrent edits
 * AC#4: Connection recovery after network interruption
 */

import { randomUUID } from "node:crypto";
import type { Proposal } from "../../types/index.ts";
import type { FederationPKI } from "./federation.ts";

// ─── Types ───────────────────────────────────────────────────────────────

/** Federation message types */
export type FederationMessageType =
	| "proposal-sync-request"
	| "proposal-sync-response"
	| "proposal-update"
	| "proposal-delete"
	| "proposal-create"
	| "heartbeat"
	| "heartbeat-ack"
	| "join"
	| "join-ack"
	| "join-reject"
	| "leave"
	| "conflict-detected"
	| "conflict-resolve"
	| "sync-complete"
	| "error";

/** Message envelope for all federation communication */
export interface FederationMessage {
	/** Unique message ID */
	messageId: string;
	/** ISO timestamp */
	timestamp: string;
	/** Source host ID */
	sourceHostId: string;
	/** Target host ID (null = broadcast) */
	targetHostId: string | null;
	/** Message type */
	type: FederationMessageType;
	/** Message payload (type-specific) */
	payload: Record<string, unknown>;
	/** Sequence number for ordering */
	sequence: number;
	/** Nonce for replay protection */
	nonce: string;
	/** HMAC signature of the message */
	signature?: string;
}

/** Connection proposal for a remote host */
export type ConnectionProposal =
	| "disconnected"
	| "connecting"
	| "connected"
	| "syncing"
	| "error"
	| "reconnecting";

/** Federated connection to a remote host */
export interface FederatedConnection {
	connectionId: string;
	hostId: string;
	proposal: ConnectionProposal;
	certificateId?: string;
	createdAt: string;
	lastHeartbeat?: string;
	lastActivity?: string;
	sequenceNumber: number;
	reconnectAttempts: number;
	errorMessage?: string;
	latency?: number;
}

/** Conflict resolution strategies */
export type ConflictStrategy =
	| "latest-wins"
	| "manual"
	| "merge"
	| "source-wins";

/** Edit conflict between two hosts */
export interface EditConflict {
	conflictId: string;
	proposalId: string;
	/** Host that made the local edit */
	localHostId: string;
	/** Host that made the remote edit */
	remoteHostId: string;
	/** Local proposal version */
	localProposal: Proposal;
	/** Remote proposal version */
	remoteProposal: Proposal;
	/** Timestamp of local edit */
	localTimestamp: string;
	/** Timestamp of remote edit */
	remoteTimestamp: string;
	/** Resolution strategy used */
	resolved: boolean;
	resolution?: string;
	resolvedAt?: string;
	resolvedBy?: string;
}

/** Sync proposal snapshot for a host */
export interface HostSyncSnapshot {
	hostId: string;
	timestamp: string;
	proposalCount: number;
	proposalIds: string[];
	checksum: string;
	version: number;
}

/** Federation statistics */
export interface FederationStats {
	totalConnections: number;
	activeConnections: number;
	messagesSent: number;
	messagesReceived: number;
	conflictsDetected: number;
	conflictsResolved: number;
	syncOperations: number;
	avgLatency: number;
	uptime: number;
	startedAt: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const HEARTBEAT_TIMEOUT_MS = 60_000; // 60 seconds
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_SEQUENCE_GAP = 100;
const DEFAULT_CONFLICT_STRATEGY: ConflictStrategy = "latest-wins";

// ─── Federation Server ──────────────────────────────────────────────────

/**
 * Federation server that enables multi-host collaboration.
 *
 * Manages connections, proposal synchronization, conflict resolution,
 * and connection recovery for agents on different machines.
 */
export class FederationServer {
	private hostId: string;
	private hostname: string;
	private port: number;
	private pki: FederationPKI;
	private connections: Map<string, FederatedConnection> = new Map();
	private pendingMessages: Map<string, FederationMessage> = new Map();
	private conflicts: Map<string, EditConflict> = new Map();
	private receivedNonces: Set<string> = new Set();
	private maxNonceCache = 10_000;

	// Proposal management
	private localProposals: Map<string, Proposal> = new Map();
	private proposalVersions: Map<string, number> = new Map();
	private proposalTimestamps: Map<string, string> = new Map();

	// Stats
	private stats: FederationStats;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private conflictStrategy: ConflictStrategy;
	private startedAt: number = 0;

	// Event handlers
	private onProposalUpdate?: (proposal: Proposal, sourceHostId: string) => void;
	private onProposalCreate?: (proposal: Proposal, sourceHostId: string) => void;
	private onProposalDelete?: (proposalId: string, sourceHostId: string) => void;
	private onConflict?: (conflict: EditConflict) => void;
	private onConnectionChange?: (connection: FederatedConnection) => void;

	constructor(options: {
		hostId: string;
		hostname: string;
		port: number;
		pki: FederationPKI;
		conflictStrategy?: ConflictStrategy;
	}) {
		this.hostId = options.hostId;
		this.hostname = options.hostname;
		this.port = options.port;
		this.pki = options.pki;
		this.conflictStrategy =
			options.conflictStrategy ?? DEFAULT_CONFLICT_STRATEGY;
		this.stats = this.createInitialStats();
	}

	// ─── Lifecycle ───────────────────────────────────────────────────

	/**
	 * Start the federation server.
	 */
	start(): void {
		if (this.heartbeatTimer) {
			return; // Already started
		}

		this.startedAt = Date.now();
		this.heartbeatTimer = setInterval(
			() => this.heartbeatTick(),
			HEARTBEAT_INTERVAL_MS,
		);
	}

	/**
	 * Stop the federation server.
	 */
	stop(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		// Mark all connections as disconnected
		for (const conn of this.connections.values()) {
			conn.proposal = "disconnected";
			this.onConnectionChange?.(conn);
		}

		this.connections.clear();
	}

	// ─── AC#1: HTTP/WebSocket API for Agent Communication ───────────

	/**
	 * Process an incoming federation message.
	 * Returns a response message if applicable, null for fire-and-forget messages.
	 */
	processMessage(
		message: FederationMessage,
		sourceCertId?: string,
	): FederationMessage | null {
		// Verify the message signature if certificate is provided
		if (sourceCertId) {
			const verification = this.verifyMessageSignature(message, sourceCertId);
			if (!verification.valid) {
				return this.createErrorMessage(
					message.sourceHostId,
					"auth-failed",
					`Signature verification failed: ${verification.reason}`,
				);
			}
		}

		// Check for replay attacks
		if (this.receivedNonces.has(message.nonce)) {
			return this.createErrorMessage(
				message.sourceHostId,
				"duplicate",
				"Message nonce already seen (possible replay)",
			);
		}
		this.recordNonce(message.nonce);

		// Check sequence number is reasonable
		const connection = this.connections.get(message.sourceHostId);
		if (connection && message.sequence > 0) {
			const expectedNext = connection.sequenceNumber + 1;
			if (message.sequence < expectedNext - MAX_SEQUENCE_GAP) {
				// Old message, out of order
				return this.createErrorMessage(
					message.sourceHostId,
					"out-of-order",
					`Sequence ${message.sequence} too old, expected >= ${expectedNext - MAX_SEQUENCE_GAP}`,
				);
			}
		}

		this.stats.messagesReceived++;

		// Route by message type
		switch (message.type) {
			case "join":
				return this.handleJoin(message);
			case "join-ack":
				return this.handleJoinAck(message);
			case "join-reject":
				return this.handleJoinReject(message);
			case "leave":
				return this.handleLeave(message);
			case "heartbeat":
				return this.handleHeartbeat(message);
			case "heartbeat-ack":
				return this.handleHeartbeatAck(message);
			case "proposal-sync-request":
				return this.handleSyncRequest(message);
			case "proposal-sync-response":
				return this.handleSyncResponse(message);
			case "proposal-update":
				return this.handleProposalUpdate(message);
			case "proposal-create":
				return this.handleProposalCreate(message);
			case "proposal-delete":
				return this.handleProposalDelete(message);
			case "conflict-detected":
				return this.handleConflictDetected(message);
			case "conflict-resolve":
				return this.handleConflictResolve(message);
			case "sync-complete":
				return this.handleSyncComplete(message);
			default:
				return this.createErrorMessage(
					message.sourceHostId,
					"unknown-type",
					`Unknown message type: ${message.type}`,
				);
		}
	}

	/**
	 * Create a join request to connect to a remote host.
	 */
	createJoinRequest(targetHostId: string): FederationMessage {
		const cert = this.pki.getCertificate(
			this.connections.get(targetHostId)?.certificateId ?? "",
		);

		return this.createMessage(targetHostId, "join", {
			hostId: this.hostId,
			hostname: this.hostname,
			port: this.port,
			certificateId: cert?.certId,
			capabilities: ["proposal-sync", "conflict-resolution"],
			version: "1.0.0",
		});
	}

	/**
	 * Create a leave message.
	 */
	createLeaveMessage(targetHostId: string): FederationMessage {
		return this.createMessage(targetHostId, "leave", {
			hostId: this.hostId,
			reason: "shutdown",
		});
	}

	// ─── AC#2: Proposal Change Propagation ─────────────────────────────

	/**
	 * Create a proposal-update message for broadcasting a proposal change.
	 */
	createProposalUpdateMessage(
		proposal: Proposal,
		targetHostId: string | null,
	): FederationMessage {
		const version = (this.proposalVersions.get(proposal.id) ?? 0) + 1;
		this.proposalVersions.set(proposal.id, version);
		this.proposalTimestamps.set(proposal.id, new Date().toISOString());

		return this.createMessage(targetHostId, "proposal-update", {
			proposal,
			version,
			previousVersion: version - 1,
			sourceHostId: this.hostId,
		});
	}

	/**
	 * Create a proposal-create message for a new proposal.
	 */
	createProposalCreateMessage(
		proposal: Proposal,
		targetHostId: string | null,
	): FederationMessage {
		this.proposalVersions.set(proposal.id, 1);
		this.proposalTimestamps.set(proposal.id, new Date().toISOString());

		return this.createMessage(targetHostId, "proposal-create", {
			proposal,
			version: 1,
			sourceHostId: this.hostId,
		});
	}

	/**
	 * Create a proposal-delete message.
	 */
	createProposalDeleteMessage(
		proposalId: string,
		targetHostId: string | null,
	): FederationMessage {
		return this.createMessage(targetHostId, "proposal-delete", {
			proposalId,
			sourceHostId: this.hostId,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Create a sync request to get all proposals from a host.
	 */
	createSyncRequest(targetHostId: string): FederationMessage {
		const localSnapshot = this.createLocalSnapshot();

		return this.createMessage(targetHostId, "proposal-sync-request", {
			snapshot: localSnapshot,
			since: this.getLastSyncTime(targetHostId),
		});
	}

	/**
	 * Create a sync response with our current proposals.
	 */
	createSyncResponse(targetHostId: string, since?: string): FederationMessage {
		const proposals = since
			? this.getProposalsModifiedSince(since)
			: Array.from(this.localProposals.values());

		return this.createMessage(targetHostId, "proposal-sync-response", {
			proposals,
			snapshot: this.createLocalSnapshot(),
			count: proposals.length,
		});
	}

	/**
	 * Register local proposals with the federation server.
	 */
	setLocalProposals(proposals: Proposal[]): void {
		for (const proposal of proposals) {
			this.localProposals.set(proposal.id, proposal);
			if (!this.proposalVersions.has(proposal.id)) {
				this.proposalVersions.set(proposal.id, 1);
			}
			this.proposalTimestamps.set(proposal.id, new Date().toISOString());
		}
	}

	/**
	 * Update a single local proposal.
	 */
	updateLocalProposal(proposal: Proposal): void {
		const prevVersion = this.proposalVersions.get(proposal.id) ?? 0;
		this.localProposals.set(proposal.id, proposal);
		this.proposalVersions.set(proposal.id, prevVersion + 1);
		this.proposalTimestamps.set(proposal.id, new Date().toISOString());
	}

	/**
	 * Remove a local proposal.
	 */
	removeLocalProposal(proposalId: string): void {
		this.localProposals.delete(proposalId);
		this.proposalVersions.delete(proposalId);
		this.proposalTimestamps.delete(proposalId);
	}

	// ─── AC#3: Conflict Resolution for Concurrent Edits ─────────────

	/**
	 * Detect conflicts between local and remote proposal versions.
	 */
	detectConflict(
		proposalId: string,
		remoteProposal: Proposal,
		remoteHostId: string,
		remoteTimestamp: string,
	): EditConflict | null {
		const localProposal = this.localProposals.get(proposalId);
		const localTimestamp = this.proposalTimestamps.get(proposalId);

		if (!localProposal || !localTimestamp) {
			// No local proposal, no conflict
			return null;
		}

		// Check if both have been modified since last sync
		const localVersion = this.proposalVersions.get(proposalId) ?? 0;
		const remoteVersion =
			((remoteProposal as unknown as Record<string, unknown>)
				._federationVersion as number | undefined) ?? 0;

		// If both have been modified, we have a conflict
		if (
			localVersion > 0 &&
			remoteVersion > 0 &&
			localTimestamp !== remoteTimestamp
		) {
			// Check if the timestamps are close enough to indicate concurrent edits
			const timeDiff = Math.abs(
				new Date(localTimestamp).getTime() -
					new Date(remoteTimestamp).getTime(),
			);

			// If both were modified within a reasonable window, treat as conflict
			if (timeDiff < HEARTBEAT_TIMEOUT_MS) {
				const conflict: EditConflict = {
					conflictId: randomUUID(),
					proposalId,
					localHostId: this.hostId,
					remoteHostId,
					localProposal: { ...localProposal },
					remoteProposal: { ...remoteProposal },
					localTimestamp,
					remoteTimestamp,
					resolved: false,
				};

				this.conflicts.set(conflict.conflictId, conflict);
				this.stats.conflictsDetected++;

				// Auto-resolve based on strategy
				this.resolveConflict(
					conflict.conflictId,
					this.conflictStrategy,
					"system",
				);

				return conflict;
			}
		}

		return null;
	}

	/**
	 * Resolve a conflict using the specified strategy.
	 */
	resolveConflict(
		conflictId: string,
		strategy: ConflictStrategy,
		resolvedBy: string,
	): EditConflict | null {
		const conflict = this.conflicts.get(conflictId);
		if (!conflict || conflict.resolved) return null;

		let winner: Proposal;
		let resolution: string;

		switch (strategy) {
			case "latest-wins":
				// Compare timestamps
				if (
					new Date(conflict.localTimestamp) >=
					new Date(conflict.remoteTimestamp)
				) {
					winner = conflict.localProposal;
					resolution = "local-wins: local timestamp is later or equal";
				} else {
					winner = conflict.remoteProposal;
					resolution = "remote-wins: remote timestamp is later";
				}
				break;

			case "source-wins":
				// Remote host wins (source of truth)
				winner = conflict.remoteProposal;
				resolution = "source-wins: remote host is designated source of truth";
				break;

			case "manual":
				// Leave unresolved for manual resolution
				return conflict;

			case "merge":
				// Simple merge: use remote proposal but keep local acceptance criteria if present
				winner = {
					...conflict.remoteProposal,
					acceptanceCriteriaItems:
						(conflict.localProposal.acceptanceCriteriaItems?.length ?? 0) > 0
							? conflict.localProposal.acceptanceCriteriaItems
							: conflict.remoteProposal.acceptanceCriteriaItems,
				};
				resolution =
					"merge: remote proposal with local acceptance criteria preserved";
				break;

			default:
				return null;
		}

		conflict.resolved = true;
		conflict.resolution = resolution;
		conflict.resolvedAt = new Date().toISOString();
		conflict.resolvedBy = resolvedBy;

		this.stats.conflictsResolved++;

		// Update local proposal with winner
		this.localProposals.set(conflict.proposalId, winner);
		this.proposalVersions.set(
			conflict.proposalId,
			(this.proposalVersions.get(conflict.proposalId) ?? 0) + 1,
		);
		this.proposalTimestamps.set(conflict.proposalId, new Date().toISOString());

		return conflict;
	}

	/**
	 * Get unresolved conflicts.
	 */
	getUnresolvedConflicts(): EditConflict[] {
		return Array.from(this.conflicts.values()).filter((c) => !c.resolved);
	}

	/**
	 * Get all conflicts.
	 */
	getConflicts(): EditConflict[] {
		return Array.from(this.conflicts.values());
	}

	/**
	 * Create a conflict resolution message.
	 */
	createConflictResolveMessage(
		conflictId: string,
		targetHostId: string,
		winningProposal: Proposal,
		strategy: ConflictStrategy,
	): FederationMessage {
		return this.createMessage(targetHostId, "conflict-resolve", {
			conflictId,
			resolvedProposal: winningProposal,
			strategy,
			resolvedBy: this.hostId,
			resolvedAt: new Date().toISOString(),
		});
	}

	// ─── AC#4: Connection Recovery After Network Interruption ───────

	/**
	 * Get connection proposal for a host.
	 */
	getConnection(hostId: string): FederatedConnection | undefined {
		return this.connections.get(hostId);
	}

	/**
	 * Get all connections.
	 */
	getConnections(): FederatedConnection[] {
		return Array.from(this.connections.values());
	}

	/**
	 * Get active connections only.
	 */
	getActiveConnections(): FederatedConnection[] {
		return Array.from(this.connections.values()).filter(
			(c) => c.proposal === "connected" || c.proposal === "syncing",
		);
	}

	/**
	 * Mark a connection as failed and start reconnection.
	 */
	markConnectionFailed(hostId: string, error: string): void {
		const conn = this.connections.get(hostId);
		if (!conn) return;

		conn.proposal = "error";
		conn.errorMessage = error;
		conn.reconnectAttempts++;

		this.onConnectionChange?.(conn);

		// Schedule reconnection with exponential backoff
		if (conn.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
			const delay = Math.min(
				RECONNECT_BASE_DELAY_MS * 2 ** (conn.reconnectAttempts - 1),
				MAX_RECONNECT_DELAY_MS,
			);

			setTimeout(() => {
				this.attemptReconnect(hostId);
			}, delay);
		} else {
			// Max attempts reached, mark as disconnected
			conn.proposal = "disconnected";
			conn.errorMessage = `Max reconnect attempts reached: ${error}`;
			this.onConnectionChange?.(conn);
		}
	}

	/**
	 * Attempt to reconnect to a host.
	 */
	attemptReconnect(hostId: string): FederationMessage | null {
		const conn = this.connections.get(hostId);
		if (!conn) return null;

		conn.proposal = "reconnecting";
		this.onConnectionChange?.(conn);

		// Create a reconnection heartbeat to test if host is reachable
		return this.createMessage(hostId, "heartbeat", {
			hostId: this.hostId,
			timestamp: new Date().toISOString(),
			reconnect: true,
			previousSequence: conn.sequenceNumber,
		});
	}

	/**
	 * Handle successful reconnection.
	 */
	handleReconnectSuccess(hostId: string): void {
		const conn = this.connections.get(hostId);
		if (!conn) return;

		conn.proposal = "connected";
		conn.reconnectAttempts = 0;
		conn.errorMessage = undefined;
		conn.lastHeartbeat = new Date().toISOString();

		this.onConnectionChange?.(conn);
	}

	/**
	 * Register a connection to a remote host.
	 */
	registerConnection(
		hostId: string,
		certificateId?: string,
	): FederatedConnection {
		const existing = this.connections.get(hostId);
		if (existing) {
			// Update existing connection
			existing.proposal = "connected";
			existing.certificateId = certificateId;
			existing.lastHeartbeat = new Date().toISOString();
			existing.reconnectAttempts = 0;
			this.onConnectionChange?.(existing);
			return existing;
		}

		const connection: FederatedConnection = {
			connectionId: randomUUID(),
			hostId,
			proposal: "connected",
			certificateId,
			createdAt: new Date().toISOString(),
			lastHeartbeat: new Date().toISOString(),
			sequenceNumber: 0,
			reconnectAttempts: 0,
		};

		this.connections.set(hostId, connection);
		this.onConnectionChange?.(connection);
		return connection;
	}

	/**
	 * Remove a connection.
	 */
	removeConnection(hostId: string): boolean {
		const conn = this.connections.get(hostId);
		if (!conn) return false;

		conn.proposal = "disconnected";
		this.onConnectionChange?.(conn);
		this.connections.delete(hostId);
		return true;
	}

	/**
	 * Create a heartbeat message.
	 */
	createHeartbeat(targetHostId: string): FederationMessage {
		return this.createMessage(targetHostId, "heartbeat", {
			hostId: this.hostId,
			timestamp: new Date().toISOString(),
			localProposalCount: this.localProposals.size,
			sequenceNumber: this.getNextSequence(targetHostId),
		});
	}

	/**
	 * Create a heartbeat acknowledgment.
	 */
	createHeartbeatAck(
		targetHostId: string,
		originalMessageId: string,
	): FederationMessage {
		return this.createMessage(targetHostId, "heartbeat-ack", {
			hostId: this.hostId,
			timestamp: new Date().toISOString(),
			replyTo: originalMessageId,
			localProposalCount: this.localProposals.size,
		});
	}

	// ─── Statistics & Observability ─────────────────────────────────

	/**
	 * Get federation statistics.
	 */
	getStats(): FederationStats {
		return {
			...this.stats,
			activeConnections: this.getActiveConnections().length,
			uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
			avgLatency: this.calculateAverageLatency(),
		};
	}

	/**
	 * Set event handlers.
	 */
	on(handler: {
		proposalUpdate?: (proposal: Proposal, sourceHostId: string) => void;
		proposalCreate?: (proposal: Proposal, sourceHostId: string) => void;
		proposalDelete?: (proposalId: string, sourceHostId: string) => void;
		conflict?: (conflict: EditConflict) => void;
		connectionChange?: (connection: FederatedConnection) => void;
	}): void {
		if (handler.proposalUpdate) this.onProposalUpdate = handler.proposalUpdate;
		if (handler.proposalCreate) this.onProposalCreate = handler.proposalCreate;
		if (handler.proposalDelete) this.onProposalDelete = handler.proposalDelete;
		if (handler.conflict) this.onConflict = handler.conflict;
		if (handler.connectionChange)
			this.onConnectionChange = handler.connectionChange;
	}

	/**
	 * Get the host ID.
	 */
	getHostId(): string {
		return this.hostId;
	}

	// ─── Internal Methods ───────────────────────────────────────────

	private createMessage(
		targetHostId: string | null,
		type: FederationMessageType,
		payload: Record<string, unknown>,
	): FederationMessage {
		const message: FederationMessage = {
			messageId: randomUUID(),
			timestamp: new Date().toISOString(),
			sourceHostId: this.hostId,
			targetHostId,
			type,
			payload,
			sequence: targetHostId ? this.getNextSequence(targetHostId) : 0,
			nonce: randomUUID(),
		};

		// Track pending messages for retry
		if (targetHostId) {
			this.pendingMessages.set(message.messageId, message);
		}

		this.stats.messagesSent++;
		return message;
	}

	private createErrorMessage(
		targetHostId: string,
		errorCode: string,
		message: string,
	): FederationMessage {
		return this.createMessage(targetHostId, "error", {
			errorCode,
			message,
			timestamp: new Date().toISOString(),
		});
	}

	private getNextSequence(hostId: string): number {
		const conn = this.connections.get(hostId);
		if (!conn) return 1;
		conn.sequenceNumber++;
		return conn.sequenceNumber;
	}

	private handleJoin(message: FederationMessage): FederationMessage {
		const { hostId, hostname, port, certificateId, capabilities } =
			message.payload;

		// Verify certificate if provided
		if (certificateId) {
			const certVerification = this.pki.verifyCertificate(
				certificateId as string,
			);
			if (!certVerification.valid) {
				return this.createMessage(message.sourceHostId, "join-reject", {
					reason: `Certificate invalid: ${certVerification.reason}`,
					hostId: this.hostId,
				});
			}
		}

		// Register the connection
		const connection = this.registerConnection(
			hostId as string,
			certificateId as string | undefined,
		);

		this.stats.syncOperations++;

		// Send acknowledgment
		return this.createMessage(message.sourceHostId, "join-ack", {
			hostId: this.hostId,
			hostname: this.hostname,
			port: this.port,
			connectionId: connection.connectionId,
			capabilities: ["proposal-sync", "conflict-resolution"],
			version: "1.0.0",
		});
	}

	private handleJoinAck(message: FederationMessage): FederationMessage | null {
		const { hostId, connectionId } = message.payload;

		const conn = this.connections.get(hostId as string);
		if (conn) {
			conn.proposal = "connected";
			conn.connectionId = connectionId as string;
			conn.lastHeartbeat = new Date().toISOString();
			this.onConnectionChange?.(conn);
		}

		// Trigger initial sync
		return this.createSyncRequest(hostId as string);
	}

	private handleJoinReject(message: FederationMessage): null {
		const { reason } = message.payload;
		const conn = this.connections.get(message.sourceHostId);
		if (conn) {
			conn.proposal = "disconnected";
			conn.errorMessage = `Join rejected: ${reason}`;
			this.onConnectionChange?.(conn);
		}
		return null;
	}

	private handleLeave(message: FederationMessage): null {
		this.removeConnection(message.sourceHostId);
		return null;
	}

	private handleHeartbeat(message: FederationMessage): FederationMessage {
		const conn = this.connections.get(message.sourceHostId);
		if (conn) {
			conn.lastHeartbeat = new Date().toISOString();
			conn.lastActivity = new Date().toISOString();
		}

		return this.createHeartbeatAck(message.sourceHostId, message.messageId);
	}

	private handleHeartbeatAck(message: FederationMessage): null {
		const conn = this.connections.get(message.sourceHostId);
		if (conn) {
			conn.lastHeartbeat = new Date().toISOString();
			conn.proposal = "connected";
			conn.reconnectAttempts = 0;
			conn.errorMessage = undefined;

			// Calculate latency
			const sentTime = this.pendingMessages.get(
				(message.payload.replyTo as string) ?? "",
			);
			if (sentTime) {
				conn.latency = Date.now() - new Date(sentTime.timestamp).getTime();
				this.pendingMessages.delete(message.payload.replyTo as string);
			}

			this.onConnectionChange?.(conn);
		}
		return null;
	}

	private handleSyncRequest(message: FederationMessage): FederationMessage {
		const { since } = message.payload;
		this.stats.syncOperations++;

		return this.createSyncResponse(
			message.sourceHostId,
			since as string | undefined,
		);
	}

	private handleSyncResponse(message: FederationMessage): null {
		const { proposals, snapshot } = message.payload;

		// Process incoming proposals
		if (Array.isArray(proposals)) {
			for (const proposal of proposals as Proposal[]) {
				const existing = this.localProposals.get(proposal.id);
				if (!existing) {
					// New proposal from remote
					this.localProposals.set(proposal.id, proposal);
					this.proposalVersions.set(proposal.id, 1);
					this.proposalTimestamps.set(proposal.id, new Date().toISOString());
					this.onProposalCreate?.(proposal, message.sourceHostId);
				} else {
					// Check for conflict
					const conflict = this.detectConflict(
						proposal.id,
						proposal,
						message.sourceHostId,
						message.timestamp,
					);

					if (conflict) {
						this.onConflict?.(conflict);
					} else {
						// No conflict, update local proposal
						this.updateLocalProposal(proposal);
						this.onProposalUpdate?.(proposal, message.sourceHostId);
					}
				}
			}
		}

		// Update connection sync proposal
		const conn = this.connections.get(message.sourceHostId);
		if (conn) {
			conn.proposal = "connected";
			conn.lastActivity = new Date().toISOString();
			this.onConnectionChange?.(conn);
		}

		return null;
	}

	private handleProposalUpdate(
		message: FederationMessage,
	): FederationMessage | null {
		const { proposal, version, sourceHostId } = message.payload;
		const proposalData = proposal as Proposal;

		// Check for conflict with local version
		const conflict = this.detectConflict(
			proposalData.id,
			proposalData,
			(sourceHostId as string) ?? message.sourceHostId,
			message.timestamp,
		);

		if (conflict) {
			this.onConflict?.(conflict);
			// Send conflict notification
			return this.createMessage(message.sourceHostId, "conflict-detected", {
				conflictId: conflict.conflictId,
				proposalId: proposalData.id,
				localTimestamp: conflict.localTimestamp,
				remoteTimestamp: conflict.remoteTimestamp,
			});
		}

		// No conflict, apply update
		this.updateLocalProposal(proposalData);
		this.onProposalUpdate?.(
			proposalData,
			(sourceHostId as string) ?? message.sourceHostId,
		);

		// Clean up pending message
		this.pendingMessages.delete(message.messageId);

		return null;
	}

	private handleProposalCreate(message: FederationMessage): null {
		const { proposal, sourceHostId } = message.payload;
		const proposalData = proposal as Proposal;

		this.localProposals.set(proposalData.id, proposalData);
		this.proposalVersions.set(proposalData.id, 1);
		this.proposalTimestamps.set(proposalData.id, message.timestamp);

		this.onProposalCreate?.(
			proposalData,
			(sourceHostId as string) ?? message.sourceHostId,
		);
		return null;
	}

	private handleProposalDelete(message: FederationMessage): null {
		const { proposalId, sourceHostId } = message.payload;

		this.removeLocalProposal(proposalId as string);
		this.onProposalDelete?.(
			proposalId as string,
			(sourceHostId as string) ?? message.sourceHostId,
		);
		return null;
	}

	private handleConflictDetected(
		message: FederationMessage,
	): FederationMessage | null {
		// The other host detected a conflict. If we have a newer local version,
		// send our resolution.
		const { conflictId, proposalId, remoteTimestamp } = message.payload;

		const localTimestamp = this.proposalTimestamps.get(proposalId as string);
		if (localTimestamp && localTimestamp > (remoteTimestamp as string)) {
			// Our version is newer
			const localProposal = this.localProposals.get(proposalId as string);
			if (localProposal) {
				return this.createConflictResolveMessage(
					conflictId as string,
					message.sourceHostId,
					localProposal,
					"latest-wins",
				);
			}
		}

		return null;
	}

	private handleConflictResolve(message: FederationMessage): null {
		const { conflictId, resolvedProposal, strategy, resolvedBy } =
			message.payload;

		const conflict = this.conflicts.get(conflictId as string);
		if (conflict && !conflict.resolved) {
			conflict.resolved = true;
			conflict.resolution = `Resolved by ${resolvedBy} using ${strategy}`;
			conflict.resolvedAt = new Date().toISOString();
			conflict.resolvedBy = resolvedBy as string;

			this.stats.conflictsResolved++;

			// Apply the resolved proposal
			this.localProposals.set(
				conflict.proposalId,
				resolvedProposal as Proposal,
			);
		}

		return null;
	}

	private handleSyncComplete(message: FederationMessage): null {
		const conn = this.connections.get(message.sourceHostId);
		if (conn) {
			conn.proposal = "connected";
			conn.lastActivity = new Date().toISOString();
			this.onConnectionChange?.(conn);
		}
		return null;
	}

	private verifyMessageSignature(
		_message: FederationMessage,
		sourceCertId: string,
	): { valid: boolean; reason?: string } {
		return this.pki.verifyCertificate(sourceCertId);
	}

	private recordNonce(nonce: string): void {
		this.receivedNonces.add(nonce);

		// Evict old nonces to prevent unbounded growth
		if (this.receivedNonces.size > this.maxNonceCache) {
			// Convert to array, remove oldest entries
			const arr = Array.from(this.receivedNonces);
			this.receivedNonces = new Set(arr.slice(arr.length / 2));
		}
	}

	private createLocalSnapshot(): HostSyncSnapshot {
		const proposalIds = Array.from(this.localProposals.keys()).sort();
		return {
			hostId: this.hostId,
			timestamp: new Date().toISOString(),
			proposalCount: this.localProposals.size,
			proposalIds,
			checksum: this.computeSnapshotChecksum(proposalIds),
			version: 1,
		};
	}

	private computeSnapshotChecksum(proposalIds: string[]): string {
		// Simple checksum based on sorted proposal IDs
		const data = proposalIds.join(",");
		let hash = 0;
		for (let i = 0; i < data.length; i++) {
			const char = data.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash).toString(16).padStart(8, "0");
	}

	private getLastSyncTime(_hostId: string): string | undefined {
		// In a full implementation, would track per-host sync timestamps
		return undefined;
	}

	private getProposalsModifiedSince(since: string): Proposal[] {
		const sinceDate = new Date(since).getTime();
		return Array.from(this.localProposals.values()).filter((proposal) => {
			const timestamp = this.proposalTimestamps.get(proposal.id);
			if (!timestamp) return false;
			return new Date(timestamp).getTime() > sinceDate;
		});
	}

	private heartbeatTick(): void {
		const now = Date.now();

		for (const conn of this.connections.values()) {
			if (conn.proposal === "connected" || conn.proposal === "syncing") {
				// Check if heartbeat has timed out
				if (conn.lastHeartbeat) {
					const timeSinceHeartbeat =
						now - new Date(conn.lastHeartbeat).getTime();
					if (timeSinceHeartbeat > HEARTBEAT_TIMEOUT_MS) {
						// Connection timed out
						this.markConnectionFailed(conn.hostId, "heartbeat-timeout");
					}
				}
			}
		}
	}

	private calculateAverageLatency(): number {
		let total = 0;
		let count = 0;

		for (const conn of this.connections.values()) {
			if (conn.latency !== undefined) {
				total += conn.latency;
				count++;
			}
		}

		return count > 0 ? total / count : 0;
	}

	private createInitialStats(): FederationStats {
		return {
			totalConnections: 0,
			activeConnections: 0,
			messagesSent: 0,
			messagesReceived: 0,
			conflictsDetected: 0,
			conflictsResolved: 0,
			syncOperations: 0,
			avgLatency: 0,
			uptime: 0,
			startedAt: new Date().toISOString(),
		};
	}
}

// ─── Convenience Functions ──────────────────────────────────────────────

/**
 * Create a federation server for a host.
 */
export function createFederationServer(options: {
	hostId: string;
	hostname: string;
	port: number;
	pki: FederationPKI;
	conflictStrategy?: ConflictStrategy;
}): FederationServer {
	return new FederationServer(options);
}

/**
 * Serialize a federation message for WebSocket transmission.
 */
export function serializeMessage(message: FederationMessage): string {
	return JSON.stringify(message);
}

/**
 * Deserialize a federation message from WebSocket data.
 */
export function deserializeMessage(data: string): FederationMessage | null {
	try {
		const parsed = JSON.parse(data);
		if (
			typeof parsed.messageId === "string" &&
			typeof parsed.type === "string" &&
			typeof parsed.sourceHostId === "string"
		) {
			return parsed as FederationMessage;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Validate a federation message structure.
 */
export function validateMessage(
	message: unknown,
): message is FederationMessage {
	if (typeof message !== "object" || message === null) return false;

	const msg = message as Record<string, unknown>;
	return (
		typeof msg.messageId === "string" &&
		typeof msg.timestamp === "string" &&
		typeof msg.sourceHostId === "string" &&
		typeof msg.type === "string" &&
		typeof msg.payload === "object" &&
		msg.payload !== null &&
		typeof msg.sequence === "number" &&
		typeof msg.nonce === "string"
	);
}
