/**
 * LiveEventFeed - Real-time event stream component
 * Shows proposal changes, agent activity, handoffs, merges, etc.
 */

import type React from "react";

interface Event {
	id: string;
	type: string;
	timestamp: number;
	proposalId?: string;
	agentId?: string;
	message: string;
	metadata: Record<string, string>;
}

interface LiveEventFeedProps {
	events: Event[];
	maxEvents?: number;
}

const EVENT_ICONS: Record<string, string> = {
	proposal_accepted: "📋",
	proposal_claimed: "✋",
	proposal_coding: "💻",
	review_requested: "👀",
	proposal_reviewing: "🔍",
	review_passed: "✅",
	review_failed: "❌",
	proposal_complete: "🎉",
	proposal_merged: "🔀",
	proposal_pushed: "🚀",
	agent_online: "🟢",
	agent_offline: "🔴",
	message: "💬",
	cubic_phase_change: "🔄",
	handoff: "🤝",
	heartbeat: "💓",
	custom: "📌",
};

const EVENT_COLORS: Record<string, string> = {
	proposal_accepted: "text-blue-400",
	proposal_claimed: "text-yellow-400",
	proposal_coding: "text-green-400",
	review_requested: "text-purple-400",
	proposal_reviewing: "text-purple-300",
	review_passed: "text-green-500",
	review_failed: "text-red-500",
	proposal_complete: "text-green-300",
	proposal_merged: "text-cyan-400",
	proposal_pushed: "text-cyan-300",
	agent_online: "text-green-400",
	agent_offline: "text-gray-400",
	message: "text-gray-300",
	cubic_phase_change: "text-orange-400",
	handoff: "text-orange-300",
	heartbeat: "text-gray-500",
	custom: "text-gray-300",
};

function formatTime(timestamp: number): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function timeAgo(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ago`;
}

export function LiveEventFeed({
	events,
	maxEvents = 30,
}: LiveEventFeedProps): React.ReactElement {
	const displayEvents = events.slice(0, maxEvents);

	return (
		<div className="flex flex-col h-full">
			<div className="px-3 py-2 border-b border-gray-700">
				<span className="text-sm font-semibold text-white">
					📡 Live Event Stream
				</span>
				<span className="text-xs text-gray-500 ml-2">
					{events.length} events
				</span>
			</div>

			<div className="flex-1 overflow-y-auto p-2 space-y-1">
				{displayEvents.length === 0 ? (
					<div className="text-gray-500 text-sm text-center py-4">
						Waiting for events...
					</div>
				) : (
					displayEvents.map((event) => {
						const icon = EVENT_ICONS[event.type] || "📌";
						const color = EVENT_COLORS[event.type] || "text-gray-300";

						return (
							<div
								key={event.id}
								className="flex items-start gap-2 px-2 py-1 rounded hover:bg-gray-800/50 transition-colors"
							>
								<span className="text-sm flex-shrink-0">{icon}</span>
								<div className="flex-1 min-w-0">
									<div className={`text-sm ${color} truncate`}>
										{event.message}
									</div>
									<div className="text-xs text-gray-600">
										{timeAgo(event.timestamp)}
										{event.agentId && (
											<span className="ml-2 text-gray-500">
												by {event.agentId}
											</span>
										)}
									</div>
								</div>
								<span className="text-xs text-gray-600 flex-shrink-0">
									{formatTime(event.timestamp)}
								</span>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}

export default LiveEventFeed;
