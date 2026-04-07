import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Channel, Message } from "../../../shared/types";
import { apiClient } from "../lib/api";

const _POLL_INTERVAL_MS = 5000;

const formatTime = (timestamp: string) => {
	const diff = Date.now() - new Date(timestamp).getTime();
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
};

const MessageStream: React.FC = () => {
	const [channels, setChannels] = useState<Channel[]>([]);
	const [selectedChannel, setSelectedChannel] = useState<string>("");
	const [messages, setMessages] = useState<Message[]>([]);
	const [loading, setLoading] = useState(true);
	const [wsConnected, setWsConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const subscribedRef = useRef<string>("");
	const messagesEndRef = useRef<HTMLDivElement>(null);

	// Fetch channels on mount
	useEffect(() => {
		let cancelled = false;
		apiClient
			.fetchChannels()
			.then((chs) => {
				if (!cancelled) {
					setChannels(chs);
					const first = chs[0];
					if (first) setSelectedChannel(first.name);
					setLoading(false);
				}
			})
			.catch((err) => {
				console.error("Failed to fetch channels:", err);
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Load history when channel changes
	useEffect(() => {
		if (!selectedChannel) return;
		let cancelled = false;
		apiClient
			.fetchMessages(selectedChannel)
			.then((msgs) => {
				if (!cancelled) setMessages(msgs);
			})
			.catch((err) => {
				console.error("Failed to fetch messages:", err);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedChannel]);

	// WebSocket for live messages
	useEffect(() => {
		if (!selectedChannel) return;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}`);
		wsRef.current = ws;

		ws.onopen = () => {
			setWsConnected(true);
			// Unsubscribe from previous channel
			if (subscribedRef.current && subscribedRef.current !== selectedChannel) {
				ws.send(
					JSON.stringify({
						type: "unsubscribe",
						channel: subscribedRef.current,
					}),
				);
			}
			ws.send(JSON.stringify({ type: "subscribe", channel: selectedChannel }));
			subscribedRef.current = selectedChannel;
		};

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (
					data.type === "channel-message" &&
					data.channel === selectedChannel
				) {
					setMessages((prev) => [...prev, data.message]);
				}
			} catch {
				// Not JSON or not a channel message, ignore
			}
		};

		ws.onclose = () => {
			setWsConnected(false);
		};

		return () => {
			if (subscribedRef.current) {
				try {
					ws.send(
						JSON.stringify({
							type: "unsubscribe",
							channel: subscribedRef.current,
						}),
					);
				} catch {
					/* already closed */
				}
			}
			subscribedRef.current = "";
			ws.close();
		};
	}, [selectedChannel]);

	// Auto-scroll to bottom on new messages
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, []);

	const handleChannelChange = useCallback(
		(e: React.ChangeEvent<HTMLSelectElement>) => {
			setSelectedChannel(e.target.value);
			setMessages([]);
		},
		[],
	);

	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col h-full">
			<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
				<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
					Messages
				</h2>
				<div className="flex items-center gap-2">
					<span
						className={`w-2 h-2 rounded-full ${wsConnected ? "bg-green-500" : "bg-gray-400"}`}
					/>
					<select
						value={selectedChannel}
						onChange={handleChannelChange}
						className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
					>
						{channels.map((ch) => (
							<option key={ch.name} value={ch.name}>
								{ch.name}
							</option>
						))}
					</select>
				</div>
			</div>

			{loading ? (
				<div className="p-4 text-sm text-gray-500 dark:text-gray-400">
					Loading channels...
				</div>
			) : channels.length === 0 ? (
				<div className="p-4 text-sm text-gray-500 dark:text-gray-400">
					No channels available
				</div>
			) : (
				<div className="divide-y divide-gray-100 dark:divide-gray-700 overflow-y-auto flex-1 p-4 space-y-3">
					{messages.length === 0 ? (
						<p className="text-sm text-gray-500 dark:text-gray-400">
							No messages in #{selectedChannel}
						</p>
					) : (
						messages.map((msg, i) => (
							<div
								key={`${msg.timestamp}-${i}`}
								className="flex items-start gap-2"
							>
								<span className="text-sm font-medium text-blue-600 dark:text-blue-400 whitespace-nowrap">
									{msg.from}
								</span>
								<span className="text-sm text-gray-900 dark:text-gray-100 flex-1">
									{msg.text}
								</span>
								<span className="text-xs text-gray-400 whitespace-nowrap">
									{formatTime(msg.timestamp)}
								</span>
							</div>
						))
					)}
					<div ref={messagesEndRef} />
				</div>
			)}
		</div>
	);
};

export default MessageStream;
