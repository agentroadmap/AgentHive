/**
 * WebSocket bridge for the board UI.
 *
 * Publishes filesystem-backed proposal, agent, channel, and message snapshots
 * so the browser UI can stay in sync without any database-specific runtime.
 */

import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { Core } from "../../core/roadmap.ts";

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

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

async function buildSnapshot(core: Core) {
	// Load proposals first, then pass them to listAgents to avoid deadlock
	// (listAgents used to re-load all proposals internally, causing a
	// circular dependency when called in parallel with loadProposals).
	const proposals = await core.loadProposals();
	core.setPreloadedProposalsForAgents(proposals);
	const [agents, channels, publicMessages] = await Promise.all([
		core.listAgents(),
		core.listChannels(),
		core.readMessages({ channel: "public" }),
	]);

	return {
		proposals,
		agents: agents.map((agent) => ({
			identity: agent.identity ?? agent.name,
			agentId: agent.name,
			role: agent.capabilities[0] ?? "agent",
			isActive: agent.status !== "offline",
			activeProposalId: agent.claims?.[0]?.id ?? null,
			lastSeenAt: agent.lastSeen,
			statusMessage: agent.status,
			isZombie: false,
		})),
		channels: channels.map((channel) => ({
			channelName: channel.name,
			messageCount: 0,
		})),
		messages: publicMessages.messages.map((message, index) => ({
			id: `${message.timestamp}-${index}`,
			channelName: "public",
			senderIdentity: message.from,
			content: message.text,
			timestamp: message.timestamp,
		})),
	};
}

async function sendSnapshot(ws: WebSocket, core: Core): Promise<void> {
	const snapshot = await buildSnapshot(core);
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

async function broadcastSnapshot(core: Core): Promise<void> {
	const snapshot = await buildSnapshot(core);
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
	core: Core,
): Promise<void> {
	switch (msg.type) {
		case "getProposals":
			await sendSnapshot(ws, core);
			return;
		case "getProposal": {
			const proposal = await core.getProposal(String(msg.id ?? ""));
			ws.send(safeStringify({ type: "proposal", data: proposal ?? null }));
			return;
		}
		case "getAgents": {
			const snapshot = await buildSnapshot(core);
			ws.send(
				safeStringify({ type: "workforce_snapshot", data: snapshot.agents }),
			);
			return;
		}
		case "getChannels": {
			const snapshot = await buildSnapshot(core);
			ws.send(safeStringify({ type: "channels", data: snapshot.channels }));
			return;
		}
		case "getMessages": {
			const channel =
				typeof msg.channel === "string" && msg.channel.trim()
					? msg.channel
					: "public";
			const result = await core.readMessages({ channel });
			ws.send(
				safeStringify({
					type: "messages",
					channel,
					data: result.messages.map((message, index) => ({
						id: `${message.timestamp}-${index}`,
						channelName: channel,
						senderIdentity: message.from,
						content: message.text,
						timestamp: message.timestamp,
					})),
				}),
			);
			return;
		}
		case "subscribe":
			ws.send(
				safeStringify({ type: "subscribed", channel: msg.channel ?? "public" }),
			);
			await sendSnapshot(ws, core);
			return;
		case "createProposal":
			ws.send(
				safeStringify({
					type: "error",
					message:
						"Creating proposals over the websocket bridge is not supported.",
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
	projectRoot = process.cwd(),
): void {
	const server = createServer();
	const core = new Core(projectRoot, { enableWatchers: true });
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
				message: "Connected to roadmap bridge",
			}),
		);
		void sendSnapshot(ws, core);

		ws.on("message", async (data: Buffer) => {
			try {
				const msg = JSON.parse(data.toString());
				await handleMessage(ws, msg, core);
			} catch {
				ws.send(safeStringify({ type: "error", message: "Invalid message" }));
			}
		});

		ws.on("close", () => {
			clients.delete(ws);
		});
	});

	server.listen(port, () => {
		console.log(`[WS] WebSocket server running on port ${port}`);
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

	snapshotTimer = setInterval(() => {
		void broadcastSnapshot(core).catch((error) => {
			console.error("[WS] Snapshot refresh failed:", error);
		});
	}, 3000);

	process.on("exit", () => {
		if (snapshotTimer) {
			clearInterval(snapshotTimer);
			snapshotTimer = null;
		}
		wss?.close();
	});
}
