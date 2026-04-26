/**
 * WebSocket client hook for the board bridge.
 *
 * Subscribes to proposal, agent, channel, and message snapshots published by
 * the local roadmap websocket server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
	getStoredProjectId,
	onProjectScopeChange,
} from "../lib/project-scope-storage";

export interface WebSocketMessage {
	type: string;
	data?: unknown;
	[key: string]: unknown;
}

export interface Proposal {
	id: string;
	displayId: string;
	websocketId?: string;
	parentId: string | null;
	proposalType: string;
	category: string;
	domainId: string;
	title: string;
	status: string;
	priority: string;
	bodyMarkdown: string | null;
	summary?: string | null;
	motivation?: string | null;
	design?: string | null;
	drawbacks?: string | null;
	alternatives?: string | null;
	dependencyNote?: string | null;
	processLogic: string | null;
	implementationPlan?: string | null;
	implementationNotes?: string | null;
	finalSummary?: string | null;
	acceptanceCriteriaItems?: Array<{ index: number; text: string; checked: boolean }>;
	requiredCapabilities?: string[];
	needsCapabilities?: string[];
	liveActivity?: {
		leaseHolder?: string;
		gateDispatchAgent?: string;
		gateDispatchRole?: string;
		gateDispatchStatus?: string;
		activeCubic?: string;
		activeModel?: string;
		heartbeatAgeSeconds?: number;
		lastEventType?: string;
	};
	maturityLevel: number | null;
	maturity?: string;
	repositoryPath: string | null;
	budgetLimitUsd: number;
	tags: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface Agent {
	identity: string;
	agentId: string;
	role: string;
	isActive: boolean;
	activeProposalId: string | null;
	lastSeenAt: string;
	statusMessage: string;
	isZombie: boolean;
}

export interface Channel {
	channelName: string;
	messageCount: number;
}

export interface Message {
	id: string;
	channelName: string;
	senderIdentity: string;
	content: string;
	timestamp: string;
}

export interface UseWebSocketReturn {
	connected: boolean;
	proposals: Proposal[];
	agents: Agent[];
	channels: Channel[];
	messages: Message[];
	reconnect: () => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isProposal(value: unknown): value is Proposal {
	return isObject(value) && typeof value.id === "string";
}

function isAgent(value: unknown): value is Agent {
	return isObject(value) && typeof value.identity === "string";
}

function isChannel(value: unknown): value is Channel {
	return isObject(value) && typeof value.channelName === "string";
}

function isMessage(value: unknown): value is Message {
	return isObject(value) && typeof value.id === "string";
}

function asArrayOf<T>(
	value: unknown,
	guard: (entry: unknown) => entry is T,
): T[] {
	return Array.isArray(value) ? value.filter(guard) : [];
}

export function useWebSocket(
	url?: string,
): UseWebSocketReturn {
	// Derive WebSocket URL from current page location if not specified
	// This ensures WS connects to the same host/port as the HTTP server
	const wsUrl = url ?? (typeof window !== "undefined"
		? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`
		: "ws://localhost:6420");
	const [connected, setConnected] = useState(false);
	const [proposals, setProposals] = useState<Proposal[]>([]);
	const [agents, setAgents] = useState<Agent[]>([]);
	const [channels, setChannels] = useState<Channel[]>([]);
	const [messages, setMessages] = useState<Message[]>([]);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	const connect = useCallback(() => {
		// Clean up existing connection
		if (wsRef.current) {
			// Strip handlers off the old socket so its onclose can't
			// reschedule another reconnect after we replace it. Without this
			// guard, every replaced socket fires onclose → setTimeout(connect),
			// causing an exponential snapshot-loop on the server.
			const old = wsRef.current;
			old.onopen = null;
			old.onclose = null;
			old.onerror = null;
			old.onmessage = null;
			try {
				old.close();
			} catch {
				// ignore
			}
		}

		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		ws.onopen = () => {
			if (wsRef.current !== ws) return;
			console.log("[WS] Connected to roadmap bridge");
			setConnected(true);
			// Subscribe to the bridge snapshot stream.
			// P477 AC-2: include the operator's selected project_id so the
			// server-side snapshot/insert/update broadcasts are scoped.
			ws.send(
				JSON.stringify({
					type: "subscribe",
					project_id: getStoredProjectId(),
					tables: [
						"proposal",
						"workforce_registry",
						"workforce_pulse",
						"message_ledger",
					],
				}),
			);
		};

		ws.onmessage = (event) => {
			try {
				const msg: WebSocketMessage = JSON.parse(event.data);

				switch (msg.type) {
					case "proposals":
					case "proposal_snapshot":
						setProposals(asArrayOf(msg.data, isProposal));
						break;

					case "proposal_insert":
					case "proposal_update":
						if (!isProposal(msg.data)) {
							break;
						}
						{
							const updated = msg.data;
							setProposals((prev) => {
								const idx = prev.findIndex((p) => p.id === updated.id);
								if (idx >= 0) {
									const next = [...prev];
									next[idx] = updated;
									return next;
								}
								return [...prev, updated];
							});
						}
						break;

					case "proposal_delete":
						if (!isObject(msg.data) || typeof msg.data.id !== "string") {
							break;
						}
						{
							const deletedId = msg.data.id;
							setProposals((prev) => prev.filter((p) => p.id !== deletedId));
						}
						break;

					case "agents":
					case "workforce_snapshot":
						setAgents(asArrayOf(msg.data, isAgent));
						break;

					case "workforce_insert":
					case "workforce_update":
						if (!isAgent(msg.data)) {
							break;
						}
						{
							const updated = msg.data;
							setAgents((prev) => {
								const idx = prev.findIndex(
									(a) => a.identity === updated.identity,
								);
								if (idx >= 0) {
									const next = [...prev];
									next[idx] = { ...next[idx], ...updated };
									return next;
								}
								return [...prev, updated];
							});
						}
						break;

					case "channels":
						setChannels(asArrayOf(msg.data, isChannel));
						break;

					case "messages":
					case "message_snapshot":
						setMessages(asArrayOf(msg.data, isMessage));
						break;

					case "message_insert":
						if (!isMessage(msg.data)) {
							break;
						}
						{
							const message = msg.data;
							setMessages((prev) => [...prev, message].slice(-200));
						}
						break;

					case "sync":
						// Refresh snapshot after a bridge sync event
						ws.send(
							JSON.stringify({
								type: "subscribe",
								project_id: getStoredProjectId(),
								tables: ["proposal"],
							}),
						);
						break;

					case "error":
						console.error("[WS] Server error:", msg.data);
						break;

					default:
						console.log("[WS] Unknown message type:", msg.type);
				}
			} catch (err) {
				console.error("[WS] Error parsing message:", err);
			}
		};

		ws.onclose = () => {
			// Ignore close events for sockets we already replaced — their
			// reconnect would double-fire and trigger snapshot floods.
			if (wsRef.current !== ws) return;
			console.log("[WS] Disconnected");
			setConnected(false);
			// Auto-reconnect after 3 seconds
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			reconnectTimeoutRef.current = setTimeout(() => {
				console.log("[WS] Reconnecting...");
				connect();
			}, 3000);
		};

		ws.onerror = (err) => {
			if (wsRef.current !== ws) return;
			console.error("[WS] Error:", err);
			ws.close();
		};
	}, [url]);

	useEffect(() => {
		connect();
		return () => {
			if (reconnectTimeoutRef.current) {
				clearTimeout(reconnectTimeoutRef.current);
			}
			if (wsRef.current) {
				wsRef.current.close();
			}
		};
	}, [connect]);

	// P477 AC-2: when the operator switches projects, push a fresh
	// subscribe payload through the existing WS so the server scopes
	// snapshot replies to the new project. Reconnecting would also work
	// but would trigger a snapshot flood; this re-uses the open socket.
	useEffect(() => {
		const off = onProjectScopeChange((id) => {
			const ws = wsRef.current;
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			try {
				ws.send(
					JSON.stringify({
						type: "subscribe",
						project_id: id,
						tables: [
							"proposal",
							"workforce_registry",
							"workforce_pulse",
							"message_ledger",
						],
					}),
				);
			} catch {
				// best-effort; reconnect will eventually pick up the new scope.
			}
		});
		return off;
	}, []);

	const reconnect = useCallback(() => {
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
		}
		connect();
	}, [connect]);

	return { connected, proposals, agents, channels, messages, reconnect };
}
