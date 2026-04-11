import type React from "react";
import { useEffect, useState } from "react";
import type { Channel } from "../../../shared/types";
import LoadingSpinner from "./LoadingSpinner";

interface ChannelsPageProps {
	channels?: Channel[];
}

const channelTypeColor = (type: string) => {
	switch (type) {
		case "public":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "private":
			return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
		case "group":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
	}
};

const channelTypeIcon = (type: string) => {
	switch (type) {
		case "public":
			return "#";
		case "private":
			return "🔒";
		case "group":
			return "👥";
		default:
			return "#";
	}
};

const ChannelsPage: React.FC<ChannelsPageProps> = ({
	channels: propChannels,
}) => {
	const [channels, setChannels] = useState<Channel[]>(propChannels || []);
	const [loading, setLoading] = useState(!propChannels);
	const [error, _setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");

	useEffect(() => {
		if (propChannels) {
			setChannels(propChannels);
			setLoading(false);
		}
	}, [propChannels]);

	const filteredChannels = channels.filter(
		(ch) =>
			!filter ||
			ch.name.toLowerCase().includes(filter.toLowerCase()) ||
			ch.type.toLowerCase().includes(filter.toLowerCase()),
	);

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading channels...
				</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-8 text-center">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<p className="text-red-600 dark:text-red-400 font-medium">Error</p>
					<p className="text-red-500 dark:text-red-300 text-sm mt-1">{error}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Channels ({channels.length})
				</h1>
				<input
					type="text"
					placeholder="Filter channels..."
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					className="rounded border px-3 py-1.5 text-sm bg-white dark:bg-gray-800 w-64"
				/>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{filteredChannels.map((channel) => (
					<div
						key={channel.name}
						className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3"
					>
						<div className="flex items-center gap-2">
							<span className="text-lg">{channelTypeIcon(channel.type)}</span>
							<h3 className="font-semibold text-gray-900 dark:text-gray-100">
								{channel.name}
							</h3>
						</div>
						<div className="flex items-center justify-between">
							<span
								className={`px-2 py-0.5 rounded text-xs font-medium ${channelTypeColor(channel.type)}`}
							>
								{channel.type}
							</span>
							<span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
								{channel.fileName}
							</span>
						</div>
					</div>
				))}
			</div>

			{filteredChannels.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					{filter ? "No channels match your filter" : "No channels available"}
				</div>
			)}
		</div>
	);
};

export default ChannelsPage;
