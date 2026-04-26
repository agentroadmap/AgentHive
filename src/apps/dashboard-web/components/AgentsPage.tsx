import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { Agent } from "../../../shared/types";
import { apiClient } from "../lib/api";
import AgentDetail from "./AgentDetail";
import LoadingSpinner from "./LoadingSpinner";

interface AgentsPageProps {
	agents?: Agent[];
}

const statusColor = (status: string) => {
	switch (status) {
		case "active":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "idle":
			return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
		case "offline":
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
	}
};

const formatTimeAgo = (dateStr: string) => {
	if (!dateStr) return "";
	const now = Date.now();
	const diff = now - new Date(dateStr).getTime();
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
};

const AgentsPage: React.FC<AgentsPageProps> = ({ agents: propAgents }) => {
	const [agents, setAgents] = useState<Agent[]>(propAgents || []);
	const [loading, setLoading] = useState(!propAgents);
	const [error, setError] = useState<string | null>(null);
	const [sortBy, setSortBy] = useState<
		"name" | "status" | "lastSeen" | "trustScore"
	>("name");
	const [selectedIdentity, setSelectedIdentity] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchAgents();
			setAgents(data);
		} catch (err) {
			console.error("Failed to fetch agents:", err);
			setError("Failed to load agents");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (propAgents && propAgents.length > 0) {
			setAgents(propAgents);
			setLoading(false);
			return;
		}
		fetchData();
	}, [propAgents, fetchData]);

	const sortedAgents = [...agents].sort((a, b) => {
		switch (sortBy) {
			case "name":
				return a.name.localeCompare(b.name);
			case "status":
				return a.status.localeCompare(b.status);
			case "lastSeen":
				return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
			case "trustScore":
				return b.trustScore - a.trustScore;
			default:
				return 0;
		}
	});

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading agents...
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
					<button
						type="button"
						onClick={fetchData}
						className="mt-4 px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50"
					>
						Retry
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Agents ({agents.length})
				</h1>
				<div className="flex items-center gap-2">
					<label
						htmlFor="agent-sort"
						className="text-sm text-gray-500 dark:text-gray-400"
					>
						Sort by:
					</label>
					<select
						id="agent-sort"
						value={sortBy}
						onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
						className="rounded border px-2 py-1 text-sm bg-white dark:bg-gray-800"
					>
						<option value="name">Name</option>
						<option value="status">Status</option>
						<option value="lastSeen">Last Seen</option>
						<option value="trustScore">Trust Score</option>
					</select>
				</div>
			</div>

			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{sortedAgents.map((agent) => (
					<button
						type="button"
						key={agent.name}
						onClick={() =>
							setSelectedIdentity(agent.identity || agent.name || null)
						}
						className="text-left bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3 hover:border-blue-400 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition"
					>
						<div className="flex items-center justify-between">
							<h3 className="font-semibold text-gray-900 dark:text-gray-100">
								{agent.name}
							</h3>
							<span
								className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(agent.status)}`}
							>
								{agent.status}
							</span>
						</div>
						<div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
							<div className="flex justify-between">
								<span>Trust Score: {agent.trustScore}</span>
								{agent.costClass && <span>Cost: {agent.costClass}</span>}
							</div>
							<div className="flex justify-between">
								<span>Last seen: {formatTimeAgo(agent.lastSeen)}</span>
								{agent.identity && (
									<span className="font-mono">{agent.identity}</span>
								)}
							</div>
						</div>
						{agent.capabilities.length > 0 && (
							<div className="flex flex-wrap gap-1">
								{agent.capabilities.map((cap) => (
									<span
										key={cap}
										className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-xs"
									>
										{cap}
									</span>
								))}
							</div>
						)}
					</button>
				))}
			</div>

			{agents.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					No agents registered
				</div>
			)}

			{selectedIdentity && (
				<AgentDetail
					identity={selectedIdentity}
					onClose={() => setSelectedIdentity(null)}
				/>
			)}
		</div>
	);
};

export default AgentsPage;
