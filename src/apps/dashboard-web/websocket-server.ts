/**
 * WebSocket bridge for the board UI.
 *
 * Serves live data from Postgres — no filesystem dependency.
 * Subscribes to pg_notify for real-time push updates.
 */

import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { query, getPool } from "../../infra/postgres/pool.ts";

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

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

// ─── Wire-format types ─────────────────────────────────────────────────────────

type BoardMessage =
	| { type: "proposals" | "proposal_snapshot"; data: unknown[] }
	| { type: "workforce_snapshot"; data: unknown[] }
	| { type: "channels"; data: unknown[] }
	| { type: "messages" | "message_snapshot"; data: unknown[]; channel?: string }
	| { type: "proposal"; data: unknown | null }
	| { type: "connected" | "subscribed"; message?: string; channel?: string }
	| { type: "error"; message: string; code?: string };

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
	const [proposals, agents, channels, messages] = await Promise.all([
		loadProposals(),
		loadAgents(),
		loadChannels(),
		loadMessages("public"),
	]);
	return { proposals, agents, channels, messages };
}

async function sendSnapshot(ws: WebSocket): Promise<void> {
	const snapshot = await buildSnapshot();
	const payloads: BoardMessage[] = [
		{ type: "proposal_snapshot", data: snapshot.proposals },
		{ type: "workforce_snapshot", data: snapshot.agents },
		{ type: "channels", data: snapshot.channels },
		{ type: "message_snapshot", data: snapshot.messages, channel: "public" },
	];

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

export function startWebSocketServer(
	port = 3001,
): void {
	const server = createServer();
	let snapshotTimer: NodeJS.Timeout | null = null;

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
			await pgClient.query("LISTEN proposal_state_changed");
			await pgClient.query("LISTEN proposal_gate_ready");
			await pgClient.query("LISTEN proposal_maturity_changed");
			await pgClient.query("LISTEN transition_queued");
			pgClient.on("notification", () => {
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
