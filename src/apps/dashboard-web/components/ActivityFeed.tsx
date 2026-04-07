import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PulseEvent } from "../../../shared/types";
import { apiClient } from "../lib/api";

const POLL_INTERVAL_MS = 10_000;

const pulseIcon: Record<string, string> = {
	proposal_created: "+",
	proposal_reached: "✓",
	decision_made: "◆",
	obstacle_discovered: "!",
	scope_aggregated: "◎",
	tool_called: "⚙",
};

const pulseColor: Record<string, string> = {
	proposal_created: "text-blue-500",
	proposal_reached: "text-green-500",
	decision_made: "text-purple-500",
	obstacle_discovered: "text-red-500",
	scope_aggregated: "text-yellow-500",
	tool_called: "text-cyan-500",
};

const formatTime = (timestamp: string) => {
	const diff = Date.now() - new Date(timestamp).getTime();
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
};

const formatEventType = (type: string) => {
	return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
};

const ActivityFeed: React.FC = () => {
	const [events, setEvents] = useState<PulseEvent[]>([]);
	const [filteredEvents, setFilteredEvents] = useState<PulseEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [timeRange, setTimeRange] = useState<string>("24h");
	const feedRef = useRef<HTMLDivElement>(null);

	const fetchPulse = useCallback(async () => {
		try {
			// Fetch more events to support local filtering
			const data = await apiClient.fetchPulse(200);
			setEvents(data);
		} catch (err) {
			console.error("Failed to fetch pulse:", err);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchPulse();
		const interval = setInterval(fetchPulse, POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [fetchPulse]);

	useEffect(() => {
		const now = Date.now();
		let rangeMs = Number.MAX_SAFE_INTEGER;

		if (timeRange === "1h") rangeMs = 60 * 60 * 1000;
		else if (timeRange === "24h") rangeMs = 24 * 60 * 60 * 1000;
		else if (timeRange === "7d") rangeMs = 7 * 24 * 60 * 60 * 1000;

		if (timeRange === "all") {
			setFilteredEvents(events);
		} else {
			setFilteredEvents(
				events.filter((e) => {
					const eventTime = new Date(e.timestamp).getTime();
					return now - eventTime <= rangeMs;
				}),
			);
		}
	}, [events, timeRange]);

	// Auto-scroll to top on new events
	// biome-ignore lint/correctness/useExhaustiveDependencies: Trigger scroll when events change
	useEffect(() => {
		if (feedRef.current) {
			feedRef.current.scrollTop = 0;
		}
	}, [filteredEvents]);

	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 flex flex-col h-full overflow-hidden">
			<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-800/50">
				<div className="flex items-center space-x-4">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
						Activity Feed
					</h2>
					<select
						value={timeRange}
						onChange={(e) => setTimeRange(e.target.value)}
						className="text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
					>
						<option value="1h">Last 1h</option>
						<option value="24h">Last 24h</option>
						<option value="7d">Last 7d</option>
						<option value="all">All Recent</option>
					</select>
				</div>
				<span className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">
					Auto-refresh: {POLL_INTERVAL_MS / 1000}s
				</span>
			</div>

			{loading ? (
				<div className="p-8 flex justify-center">
					<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
				</div>
			) : filteredEvents.length === 0 ? (
				<div className="p-8 text-center">
					<p className="text-sm text-gray-500 dark:text-gray-400">
						No activity in this time range
					</p>
				</div>
			) : (
				<div
					ref={feedRef}
					className="divide-y divide-gray-100 dark:divide-gray-700 overflow-y-auto flex-1"
				>
					{filteredEvents.map((event, i) => (
						<div
							key={`${event.id}-${event.timestamp}-${i}`}
							className="px-4 py-3 flex items-start gap-3 hover:bg-gray-50 dark:hover:bg-gray-700/20 transition-colors"
						>
							<span
								className={`text-lg mt-0.5 font-bold ${pulseColor[event.type] || "text-gray-400"}`}
							>
								{pulseIcon[event.type] || "•"}
							</span>
							<div className="flex-1 min-w-0">
								<div className="text-sm text-gray-900 dark:text-gray-100">
									<span className="font-semibold">{event.agent}</span>{" "}
									<span className="text-gray-500 dark:text-gray-400 text-xs">
										{formatEventType(event.type)}
									</span>
								</div>
								<div className="text-sm text-gray-700 dark:text-gray-300 truncate font-medium">
									{event.id} — {event.title}
								</div>
								{event.impact && (
									<div className="text-xs text-gray-500 dark:text-gray-400 mt-1 pl-2 border-l-2 border-gray-200 dark:border-gray-700 italic">
										{event.impact}
									</div>
								)}
							</div>
							<span className="text-[10px] text-gray-400 whitespace-nowrap mt-1 font-mono">
								{formatTime(event.timestamp)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

export default ActivityFeed;
