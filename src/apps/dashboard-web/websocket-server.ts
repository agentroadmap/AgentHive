/**
 * WebSocket bridge for the board UI.
 *
 * Serves live data from Postgres — no filesystem dependency.
 * Subscribes to pg_notify for real-time push updates.
 */

import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
	getPool,
	query,
	setPoolLifecycleMode,
	startPoolPoisonWatchdog,
} from "../../infra/postgres/pool.ts";

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

// ─── Phase 4: Runtime probe for notification_inbox table ─────────────────────

let notificationInboxAvailable = false;

async function probeNotificationInbox(): Promise<boolean> {
	try {
		const result = await query(
			`SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema='roadmap' AND table_name='notification_inbox'
			) as table_exists`,
		);
		return result.rows[0]?.table_exists === true;
	} catch {
		// If query fails, assume table doesn't exist
		return false;
	}
}

async function loadNotifications(): Promise<Record<string, unknown>[]> {
	if (!notificationInboxAvailable) return [];

	try {
		const rows = await query(
			`SELECT id, severity, title, message, created_at, seen
			 FROM roadmap.notification_inbox
			 ORDER BY created_at DESC
			 LIMIT 50`,
		);
		return rows.rows.map((r: any) => ({
			id: r.id,
			severity: r.severity ?? "info",
			title: r.title,
			message: r.message,
			created_at: r.created_at,
			seen: r.seen ?? false,
		}));
	} catch {
		// Graceful degradation: if notification_inbox query fails, return empty
		return [];
	}
}

// ─── Data queries ─────────────────────────────────────────────────────────────

async function loadProposals(): Promise<Record<string, unknown>[]> {
	const rows = await query(
		`SELECT id, display_id, parent_id, type, status, title, summary,
				priority, maturity, tags, created_at, modified_at
		 FROM roadmap_proposal.proposal
		 ORDER BY id`,
	);
	return rows.rows.map((r: any) => ({
		id: r.display_id || r.id,
		displayId: r.display_id,
		parentId: r.parent_id,
		proposalType: r.type,
		category: r.type ?? "",
		domainId: "",
		title: r.title,
		status: r.status,
		priority: r.priority ?? "",
		bodyMarkdown: r.summary ?? null,
		processLogic: null,
		maturityLevel: r.maturity ?? null,
		repositoryPath: null,
		budgetLimitUsd: 0,
		tags: r.tags ? (Array.isArray(r.tags) ? r.tags.join(",") : String(r.tags)) : null,
		createdAt: r.created_at,
		updatedAt: r.modified_at ?? r.created_at,
		createdDate: r.created_at
			? new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")
			: undefined,
		updatedDate: (r.modified_at ?? r.created_at)
			? new Date(r.modified_at ?? r.created_at).toISOString().slice(0, 16).replace("T", " ")
			: undefined,
	}));
}

async function loadAgents(): Promise<Record<string, unknown>[]> {
	const rows = await query(
		`SELECT id, agent_identity, agent_type, role, skills, status,
				trust_tier, agency_id, created_at, updated_at
		 FROM roadmap_workforce.agent_registry
		 ORDER BY agent_identity`,
	);
	return rows.rows.map((r: any) => ({
		identity: r.agent_identity,
		agentId: r.agent_identity,
		role: r.role ?? r.agent_type ?? "agent",
		isActive: r.status === "active",
		activeProposalId: null,
		lastSeenAt: r.updated_at ?? r.created_at,
		statusMessage: r.status,
		isZombie: false,
	}));
}

async function loadChannels(): Promise<Record<string, unknown>[]> {
	const rows = await query(
		`SELECT DISTINCT channel AS name FROM roadmap.channel_subscription ORDER BY channel`,
	);
	return rows.rows.map((r: any) => ({
		channelName: r.name,
		messageCount: 0,
	}));
}

async function loadMessages(channel: string): Promise<Record<string, unknown>[]> {
	const rows = await query(
		`SELECT id, from_agent, to_agent, message_content, created_at
		 FROM roadmap.message_ledger
		 WHERE channel = $1
		 ORDER BY created_at DESC
		 LIMIT 50`,
		[channel],
	);
	return rows.rows.map((r: any) => ({
		id: r.id,
		channelName: channel,
		senderIdentity: r.from_agent,
		content: r.message_content,
		timestamp: r.created_at,
	}));
}

// P720: Activity Feed — load recent proposal feed events
async function loadActivityFeed(limit = 50): Promise<Record<string, unknown>[]> {
	const rows = await query(
		`SELECT id, from_agent, proposal_id, message_content, created_at, metadata
		 FROM roadmap.message_ledger
		 WHERE channel = 'system:proposal-feed'
		 ORDER BY created_at DESC, id DESC
		 LIMIT $1`,
		[limit],
	);
	return rows.rows.map((r: any) => ({
		id: r.id,
		actor: r.from_agent,
		proposal_id: r.proposal_id,
		message: r.message_content,
		timestamp: r.created_at,
		event_type: r.metadata?.event_type ?? "unknown",
	}));
}

// ─── Wire-format types ─────────────────────────────────────────────────────────

type BoardMessage =
	| { type: "proposals" | "proposal_snapshot"; data: unknown[] }
	| { type: "workforce_snapshot"; data: unknown[] }
	| { type: "channels"; data: unknown[] }
	| { type: "messages" | "message_snapshot"; data: unknown[]; channel?: string }
	| { type: "proposal"; data: unknown | null }
	| { type: "connected" | "subscribed"; message?: string; channel?: string }
	| { type: "error"; message: string; code?: string }
	// P081: SLA state change push
	| { type: "sla_state"; state: string; prev_state: string | null; trigger: string; timestamp: string }
	// P720: Activity feed events
	| { type: "activity_feed_snapshot"; data: unknown[]; channel?: string }
	| { type: "activity_feed_update"; data: unknown; channel?: string }
	// P705 Phase 4: Notification inbox
	| { type: "notification_inbox_snapshot"; data: unknown[] }
	| { type: "notification_insert" | "notification_update"; data: unknown };

type ClientMessage = {
	type?: unknown;
	id?: unknown;
	channel?: unknown;
};

function safeStringify(data: unknown): string {
	return JSON.stringify(data, (_key, value) =>
		typeof value === "bigint" ? value.toString() : value,
	);
}

async function buildSnapshot() {
	const [proposals, agents, channels, messages, activityFeed, notifications] = await Promise.all([
		loadProposals(),
		loadAgents(),
		loadChannels(),
		loadMessages("public"),
		loadActivityFeed(50), // P720: Include activity feed in snapshot
		loadNotifications(), // P705 Phase 4: Include notification inbox
	]);
	return { proposals, agents, channels, messages, activityFeed, notifications };
}

async function sendSnapshot(ws: WebSocket): Promise<void> {
	const snapshot = await buildSnapshot();
	const payloads: BoardMessage[] = [
		{ type: "proposal_snapshot", data: snapshot.proposals },
		{ type: "workforce_snapshot", data: snapshot.agents },
		{ type: "channels", data: snapshot.channels },
		{ type: "message_snapshot", data: snapshot.messages, channel: "public" },
		{ type: "activity_feed_snapshot", data: snapshot.activityFeed, channel: "system:proposal-feed" }, // P720
	];

	// P705 Phase 4: Only send notification_inbox_snapshot if table exists
	if (notificationInboxAvailable && snapshot.notifications.length >= 0) {
		payloads.push({
			type: "notification_inbox_snapshot",
			data: snapshot.notifications,
		});
	}

	for (const payload of payloads) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(safeStringify(payload));
		}
	}
}

function broadcast(message: BoardMessage): void {
	const payload = safeStringify(message);
	for (const client of clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(payload);
		}
	}
}

async function broadcastSnapshot(): Promise<void> {
	const snapshot = await buildSnapshot();
	broadcast({ type: "proposal_snapshot", data: snapshot.proposals });
	broadcast({ type: "workforce_snapshot", data: snapshot.agents });
	broadcast({ type: "channels", data: snapshot.channels });
	broadcast({
		type: "message_snapshot",
		data: snapshot.messages,
		channel: "public",
	});
	// P720: Broadcast activity feed snapshot
	broadcast({
		type: "activity_feed_snapshot",
		data: snapshot.activityFeed,
		channel: "system:proposal-feed",
	});
	// P705 Phase 4: Broadcast notification inbox if available
	if (notificationInboxAvailable) {
		broadcast({
			type: "notification_inbox_snapshot",
			data: snapshot.notifications,
		});
	}
}

async function handleMessage(
	ws: WebSocket,
	msg: ClientMessage,
): Promise<void> {
	switch (msg.type) {
		case "getProposals":
			await sendSnapshot(ws);
			return;
		case "getProposal": {
			const id = String(msg.id ?? "");
			const rows = await query(
				`SELECT * FROM roadmap_proposal.proposal
				 WHERE id = $1 OR display_id = $1`,
				[/^\d+$/.test(id) ? parseInt(id, 10) : id],
			);
			ws.send(safeStringify({ type: "proposal", data: rows.rows[0] ?? null }));
			return;
		}
		case "getAgents": {
			const agents = await loadAgents();
			ws.send(
				safeStringify({ type: "workforce_snapshot", data: agents }),
			);
			return;
		}
		case "getChannels": {
			const channels = await loadChannels();
			ws.send(safeStringify({ type: "channels", data: channels }));
			return;
		}
		case "getMessages": {
			const channel =
				typeof msg.channel === "string" && msg.channel.trim()
					? msg.channel
					: "public";
			const messages = await loadMessages(channel);
			ws.send(
				safeStringify({
					type: "messages",
					channel,
					data: messages,
				}),
			);
			return;
		}
		case "subscribe":
			ws.send(
				safeStringify({ type: "subscribed", channel: msg.channel ?? "public" }),
			);
			await sendSnapshot(ws);
			return;
		case "createProposal":
			ws.send(
				safeStringify({
					type: "error",
					message: "Creating proposals over the websocket bridge is not supported.",
					code: "UNSUPPORTED",
				}),
			);
			return;
		default:
			ws.send(
				safeStringify({ type: "error", message: "Unknown message type" }),
			);
	}
}

export function startWebSocketServer(port = 3001): void {
	setPoolLifecycleMode("long-running");
	startPoolPoisonWatchdog("agenthive-board-ws");
	const server = createServer();
	let snapshotTimer: NodeJS.Timeout | null = null;

	// P705 Phase 4: Probe for notification_inbox table at startup
	probeNotificationInbox()
		.then((available) => {
			notificationInboxAvailable = available;
			if (available) {
				console.log("[WS] notification_inbox table detected; enabling Phase 4 features");
			} else {
				console.log("[WS] notification_inbox table not found; Phase 4 disabled (graceful degradation)");
			}
		})
		.catch((err) => {
			console.warn("[WS] notification_inbox probe failed:", err.message);
			notificationInboxAvailable = false;
		});

	wss = new WebSocketServer({ server });

	wss.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.warn(
				`[WS] Port ${port} already in use, WebSocket server disabled`,
			);
			wss = null;
			return;
		}
		console.error("[WS] WebSocket server error:", err);
	});

	wss.on("connection", (ws: WebSocket) => {
		clients.add(ws);
		ws.send(
			safeStringify({
				type: "connected",
				message: "Connected to roadmap bridge (Postgres)",
			}),
		);
		void sendSnapshot(ws);

		ws.on("message", async (data: Buffer) => {
			try {
				const msg = JSON.parse(data.toString());
				await handleMessage(ws, msg);
			} catch {
				ws.send(safeStringify({ type: "error", message: "Invalid message" }));
			}
		});

		ws.on("close", () => {
			clients.delete(ws);
		});
	});

	server.listen(port, () => {
		console.log(`[WS] WebSocket server running on port ${port} (Postgres)`);
	});

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			console.warn(
				`[WS] Port ${port} already in use, WebSocket server disabled`,
			);
			wss = null;
			return;
		}
		console.error("[WS] Server error:", err);
	});

	// Poll Postgres every 5s for updates
	snapshotTimer = setInterval(() => {
		void broadcastSnapshot().catch((error) => {
			console.error("[WS] Snapshot refresh failed:", error);
		});
	}, 5000);

	// Subscribe to pg_notify for real-time push.
	//
	// Self-heals on startup race: if PG isn't reachable yet (typical when
	// systemd brings ws-bridge up before postgresql.service is accepting
	// connections), we retry with exponential backoff capped at 60s instead
	// of falling back to poll-only mode forever. Also re-attaches if the
	// LISTEN client errors out after the fact (idle disconnects, PG restart).
	void (async () => {
		const setupListener = async (): Promise<void> => {
			const pool = getPool();
			const pgClient = await pool.connect();
			pgClient.on("error", (err) => {
				console.error("[WS] pg_notify client error, will reconnect:", err.message);
				try { pgClient.release(true); } catch { /* already released */ }
				scheduleRetry();
			});
			// P753: transition_queued was retired; proposal_maturity_changed +
			// proposal_gate_ready cover the activity feed without it.
			await pgClient.query("LISTEN proposal_state_changed");
			await pgClient.query("LISTEN proposal_gate_ready");
			await pgClient.query("LISTEN proposal_maturity_changed");
			// P081: SLA state change notifications
			await pgClient.query("LISTEN sla_state_change");
			// P720: Activity feed real-time notifications
			await pgClient.query("LISTEN new_message");
			// P705 Phase 4: Notification inbox updates
			if (notificationInboxAvailable) {
				try {
					await pgClient.query("LISTEN notification_inbox_change");
				} catch {
					// Graceful: trigger may not exist yet if P674 not applied
					console.warn("[WS] notification_inbox_change trigger not available");
				}
			}
			pgClient.on("notification", (msg) => {
				if (msg.channel === "sla_state_change" && msg.payload) {
					try {
						const payload = JSON.parse(msg.payload) as {
							state: string;
							prev_state: string | null;
							trigger: string;
							timestamp: string;
						};
						broadcast({
							type: "sla_state",
							state: payload.state,
							prev_state: payload.prev_state,
							trigger: payload.trigger,
							timestamp: payload.timestamp,
						});
					} catch {
						// Ignore malformed SLA payloads
					}
					return;
				}
				// P720: Handle activity feed updates in real-time
				if (msg.channel === "new_message" && msg.payload) {
					try {
						const notifData = JSON.parse(msg.payload) as {
							id?: string | number;
							msg_id?: string | number;
						};
						const msgId = notifData.id ?? notifData.msg_id;
						if (!msgId) return;

						// Query the message to check if it's a system:proposal-feed event
						void (async () => {
							try {
								const pool = getPool();
								const result = await pool.query<ActivityFeedEvent>(
									`SELECT id, channel, from_agent, message_content, proposal_id, created_at,
									        metadata->>'event_type' as event_type
									 FROM roadmap.message_ledger
									 WHERE id = $1 AND channel = 'system:proposal-feed'`,
									[msgId],
								);
								if (result.rows.length > 0) {
									const event = result.rows[0];
									broadcast({
										type: "activity_feed_update",
										event: {
											id: event.id,
											actor: event.from_agent,
											proposal_id: event.proposal_id,
											message: event.message_content,
											timestamp: event.created_at,
											event_type: event.event_type || "event",
										},
									});
								}
							} catch (err) {
								console.error("[WS] Activity feed event query failed:", err);
							}
						})();
					} catch {
						// Ignore malformed new_message payloads
					}
					return;
				}
				// P705 Phase 4: Handle notification_inbox_change events
				if (msg.channel === "notification_inbox_change" && msg.payload) {
					try {
						const notifData = JSON.parse(msg.payload) as {
							id?: string;
							change_type?: string;
						};
						if (!notifData.id) return;

						// Query the notification to get updated record
						void (async () => {
							try {
								const pool = getPool();
								const result = await pool.query(
									`SELECT id, severity, title, message, created_at, seen
									 FROM roadmap.notification_inbox
									 WHERE id = $1`,
									[notifData.id],
								);
								if (result.rows.length > 0) {
									const notif = result.rows[0];
									broadcast({
										type: notifData.change_type === "insert" ? "notification_insert" : "notification_update",
										data: {
											id: notif.id,
											severity: notif.severity ?? "info",
											title: notif.title,
											message: notif.message,
											created_at: notif.created_at,
											seen: notif.seen ?? false,
										},
									});
								}
							} catch (err) {
								console.warn("[WS] Notification inbox query failed:", err);
							}
						})();
					} catch {
						// Ignore malformed notification_inbox_change payloads
					}
					return;
				}
				void broadcastSnapshot().catch((error) => {
					console.error("[WS] pg_notify snapshot failed:", error);
				});
			});
			console.log("[WS] Listening for pg_notify events");
		};

		let attempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		const scheduleRetry = () => {
			if (retryTimer) return;
			attempt += 1;
			const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(attempt - 1, 6));
			console.warn(
				`[WS] pg_notify setup failed; retrying in ${delayMs / 1000}s (attempt ${attempt})`,
			);
			retryTimer = setTimeout(() => {
				retryTimer = null;
				setupListener().catch((err) => {
					console.warn("[WS] pg_notify retry failed:", err.message);
					scheduleRetry();
				});
			}, delayMs);
		};

		try {
			await setupListener();
			attempt = 0;
		} catch (error) {
			console.warn("[WS] pg_notify initial setup failed:", (error as Error).message);
			scheduleRetry();
		}
	})();

	process.on("exit", () => {
		if (snapshotTimer) {
			clearInterval(snapshotTimer);
			snapshotTimer = null;
		}
		wss?.close();
	});
}
