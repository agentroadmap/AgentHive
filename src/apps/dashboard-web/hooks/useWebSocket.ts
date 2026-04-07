/**
 * WebSocket client hook for the board bridge.
 *
 * Subscribes to proposal, agent, channel, and message snapshots published by
 * the local roadmap websocket server.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface WebSocketMessage {
	type: string;
	data?: unknown;
	[key: string]: unknown;
}

export interface Proposal {
	id: string;
	displayId: string;
	parentId: string | null;
	proposalType: string;
	category: string;
	domainId: string;
	title: string;
	status: string;
	priority: string;
	bodyMarkdown: string | null;
	processLogic: string | null;
	maturityLevel: number | null;
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

export function useWebSocket(
	url: string = "ws://localhost:3001",
): UseWebSocketReturn {
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
			wsRef.current.close();
		}

		const ws = new WebSocket(url);
		wsRef.current = ws;

		ws.onopen = () => {
			console.log("[WS] Connected to roadmap bridge");
			setConnected(true);
			// Subscribe to the bridge snapshot stream
			ws.send(
				JSON.stringify({
					type: "subscribe",
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
						setProposals(msg.data || []);
						break;

					case "proposal_insert":
					case "proposal_update":
						setProposals((prev) => {
							const updated = msg.data;
							const idx = prev.findIndex((p) => p.id === updated.id);
							if (idx >= 0) {
								const next = [...prev];
								next[idx] = updated;
								return next;
							}
							return [...prev, updated];
						});
						break;

					case "proposal_delete":
						setProposals((prev) => prev.filter((p) => p.id !== msg.data?.id));
						break;

					case "agents":
					case "workforce_snapshot":
						setAgents(msg.data || []);
						break;

					case "workforce_insert":
					case "workforce_update":
						setAgents((prev) => {
							const updated = msg.data;
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
						break;

					case "channels":
						setChannels(msg.data || []);
						break;

					case "messages":
					case "message_snapshot":
						setMessages(msg.data || []);
						break;

					case "message_insert":
						setMessages((prev) => [...prev, msg.data].slice(-200));
						break;

					case "sync":
						// Refresh snapshot after a bridge sync event
						ws.send(
							JSON.stringify({ type: "subscribe", tables: ["proposal"] }),
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
			console.log("[WS] Disconnected");
			setConnected(false);
			// Auto-reconnect after 3 seconds
			reconnectTimeoutRef.current = setTimeout(() => {
				console.log("[WS] Reconnecting...");
				connect();
			}, 3000);
		};

		ws.onerror = (err) => {
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

	const reconnect = useCallback(() => {
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
		}
		connect();
	}, [connect]);

	return { connected, proposals, agents, channels, messages, reconnect };
}
