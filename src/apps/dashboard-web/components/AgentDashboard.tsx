import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { Agent, Proposal } from "../../../shared/types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

interface ClaimInfo {
	agent: string;
	proposalId: string;
	proposalTitle: string;
	status: string;
	lastHeartbeat?: string;
	expires: string;
}

interface AgentDashboardProps {
	proposals?: Proposal[];
}

const AgentDashboard: React.FC<AgentDashboardProps> = ({ proposals }) => {
	const [agents, setAgents] = useState<Agent[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [releasingId, setReleasingId] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const agentsData = await apiClient.fetchAgents();
			setAgents(agentsData);
		} catch (err) {
			console.error("Failed to fetch agent data:", err);
			setError("Failed to load agent dashboard");
		}
	}, []);

	useEffect(() => {
		let isMounted = true;

		const load = async () => {
			setLoading(true);
			await fetchData();
			if (isMounted) setLoading(false);
		};

		load();
		return () => {
			isMounted = false;
		};
	}, [fetchData]);

	const handleReleaseLease = async (proposalId: string) => {
		try {
			setReleasingId(proposalId);
			await apiClient.releaseProposal(proposalId);
			await fetchData();
		} catch (err) {
			console.error("Failed to release lease:", err);
			alert(
				`Failed to release lease: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setReleasingId(null);
		}
	};

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading agent dashboard...
				</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-8 text-center">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<p className="text-red-600 dark:text-red-400 font-medium">
						Error loading dashboard
					</p>
					<p className="text-red-500 dark:text-red-300 text-sm mt-1">{error}</p>
				</div>
			</div>
		);
	}

	const now = Date.now();
	const HEALTHY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
	const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

	const getHealthStatus = (lastHeartbeat?: string) => {
		if (!lastHeartbeat) return "offline";
		const diff = now - new Date(lastHeartbeat).getTime();
		if (diff < HEALTHY_THRESHOLD_MS) return "healthy";
		if (diff < STALE_THRESHOLD_MS) return "degraded";
		return "offline";
	};

	const healthColor = (status: string) => {
		switch (status) {
			case "healthy":
				return "bg-green-500";
			case "degraded":
				return "bg-yellow-500";
			case "offline":
				return "bg-red-500";
			default:
				return "bg-gray-400";
		}
	};

	const healthTextColor = (status: string) => {
		switch (status) {
			case "healthy":
				return "text-green-700 dark:text-green-400";
			case "degraded":
				return "text-yellow-700 dark:text-yellow-400";
			case "offline":
				return "text-red-700 dark:text-red-400";
			default:
				return "text-gray-500";
		}
	};

	// Derive claims from agent data
	const claims: ClaimInfo[] = agents.flatMap((agent) =>
		(agent.claims || []).map((proposal) => ({
			agent: agent.name,
			proposalId: proposal.id,
			proposalTitle: proposal.title,
			status: proposal.status,
			lastHeartbeat: proposal.claim?.lastHeartbeat,
			expires: proposal.claim?.expires || "",
		})),
	);

	const staleClaims = claims.filter((c) => {
		return getHealthStatus(c.lastHeartbeat) === "offline";
	});

	// Compute directive progress from proposals if available
	const directiveProgress = new Map<
		string,
		{
			total: number;
			reached: number;
			active: number;
			ready: number;
			blocked: number;
		}
	>();
	if (proposals) {
		for (const proposal of proposals) {
			const ms = proposal.directive || "No Directive";
			let entry = directiveProgress.get(ms);
			if (!entry) {
				entry = { total: 0, reached: 0, active: 0, ready: 0, blocked: 0 };
				directiveProgress.set(ms, entry);
			}
			entry.total++;
			if (proposal.status === "Complete") entry.reached++;
			else if (proposal.status === "Develop") entry.active++;
			else if (proposal.ready) entry.ready++;
			const hasUnmetDeps = proposal.dependencies.some((depId) => {
				const dep = proposals?.find((s) => s.id === depId);
				return dep && dep.status !== "Complete";
			});
			if (hasUnmetDeps && proposal.status !== "Complete") entry.blocked++;
		}
	}

	// Aging active proposals (active for more than 7 days)
	const AGING_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
	const agingProposals = (proposals || []).filter((s) => {
		if (s.status !== "Develop") return false;
		const updated = s.updatedDate || s.createdDate;
		return now - new Date(updated).getTime() > AGING_THRESHOLD_MS;
	});

	// Missing proof for reached proposals
	const missingProofProposals = (proposals || []).filter((s) => {
		return s.status === "Complete" && (!s.proof || s.proof.length === 0);
	});

	// Blocked in-flight proposals (Develop but dependencies not complete)
	const blockedActiveProposals = (proposals || []).filter((s) => {
		if (s.status !== "Develop") return false;
		return s.dependencies.some((depId) => {
			const dep = proposals?.find((st) => st.id === depId);
			return dep && dep.status !== "Complete";
		});
	});

	const formatTimeAgo = (dateStr: string) => {
		if (!dateStr) return "";
		const diff = now - new Date(dateStr).getTime();
		const minutes = Math.floor(diff / 60000);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		return `${Math.floor(hours / 24)}d ago`;
	};

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

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
				Agent Dashboard
			</h1>

			{/* Overview Cards */}
			<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
					<p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
						Total Agents
					</p>
					<p className="text-3xl font-bold text-gray-900 dark:text-gray-100 mt-1">
						{agents.length}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-green-200 dark:border-green-800/50 p-4 shadow-sm">
					<p className="text-xs font-semibold text-green-600 dark:text-green-400 uppercase tracking-wider">
						Healthy
					</p>
					<p className="text-3xl font-bold text-green-700 dark:text-green-300 mt-1">
						{
							claims.filter(
								(c) => getHealthStatus(c.lastHeartbeat) === "healthy",
							).length
						}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-yellow-200 dark:border-yellow-800/50 p-4 shadow-sm">
					<p className="text-xs font-semibold text-yellow-600 dark:text-yellow-400 uppercase tracking-wider">
						Degraded
					</p>
					<p className="text-3xl font-bold text-yellow-700 dark:text-yellow-300 mt-1">
						{
							claims.filter(
								(c) => getHealthStatus(c.lastHeartbeat) === "degraded",
							).length
						}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-red-200 dark:border-red-800/50 p-4 shadow-sm">
					<p className="text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wider">
						Offline/Stale
					</p>
					<p className="text-3xl font-bold text-red-700 dark:text-red-300 mt-1">
						{
							claims.filter(
								(c) => getHealthStatus(c.lastHeartbeat) === "offline",
							).length
						}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 shadow-sm hidden lg:block">
					<p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
						Active Proposal
					</p>
					<p className="text-xl font-bold text-gray-600 dark:text-gray-300 mt-2 truncate">
						{claims.length > 0 ? claims[0]?.proposalId : "None"}
					</p>
				</div>
			</div>

			{/* Bottlenecks */}
			{(staleClaims.length > 0 ||
				agingProposals.length > 0 ||
				blockedActiveProposals.length > 0 ||
				missingProofProposals.length > 0) && (
				<div className="bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-lg p-4">
					<h2 className="text-lg font-semibold text-red-800 dark:text-red-300 mb-3 flex items-center">
						<span className="mr-2">⚠️</span> Bottlenecks
					</h2>
					<div className="space-y-3">
						{staleClaims.map((c) => (
							<div
								key={`${c.agent}-${c.proposalId}`}
								className="flex items-center justify-between text-sm"
							>
								<span className="text-red-700 dark:text-red-300">
									Stale claim: <strong>{c.agent}</strong> on{" "}
									<strong>{c.proposalId}</strong> — {c.proposalTitle}
								</span>
								<span className="text-red-500 dark:text-red-400 text-xs">
									{c.lastHeartbeat
										? `last heartbeat ${formatTimeAgo(c.lastHeartbeat)}`
										: "no heartbeat"}
								</span>
							</div>
						))}
						{agingProposals.map((s) => (
							<div
								key={s.id}
								className="flex items-center justify-between text-sm"
							>
								<span className="text-red-700 dark:text-red-300">
									Aging proposal: <strong>{s.id}</strong> — {s.title}
								</span>
								<span className="text-red-500 dark:text-red-400 text-xs">
									active for{" "}
									{formatTimeAgo(s.updatedDate || s.createdDate).replace(
										" ago",
										"",
									)}
								</span>
							</div>
						))}
						{blockedActiveProposals.map((s) => {
							const unmetDeps = s.dependencies.filter((depId) => {
								const dep = proposals?.find((st) => st.id === depId);
								return dep && dep.status !== "Complete";
							});
							return (
								<div key={`blocked-${s.id}`} className="flex flex-col text-sm">
									<div className="flex items-center justify-between">
										<span className="text-orange-700 dark:text-orange-400 font-medium">
											Blocked Active: {s.id} — {s.title}
										</span>
									</div>
									<div className="text-orange-600 dark:text-orange-500 text-xs ml-2">
										Waiting for: {unmetDeps.join(", ")}
									</div>
								</div>
							);
						})}
						{missingProofProposals.map((s) => (
							<div
								key={`missing-proof-${s.id}`}
								className="flex items-center justify-between text-sm"
							>
								<span className="text-orange-700 dark:text-orange-400">
									Missing proof: <strong>{s.id}</strong> — {s.title} (Complete)
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Active Claims */}
			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
				<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
						Active Claims
					</h2>
				</div>
				{claims.length === 0 ? (
					<p className="p-4 text-sm text-gray-500 dark:text-gray-400">
						No active claims
					</p>
				) : (
					<div className="divide-y divide-gray-200 dark:divide-gray-700">
						{claims.map((c) => {
							const health = getHealthStatus(c.lastHeartbeat);
							return (
								<div
									key={`${c.agent}-${c.proposalId}`}
									className="px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/20 transition-colors"
								>
									<div className="flex items-center space-x-3">
										<div className="relative">
											<span
												className={
													"px-2 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
												}
											>
												{c.agent}
											</span>
											<span
												className={`absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-gray-800 ${healthColor(health)}`}
												title={health}
											/>
										</div>
										<span className="text-sm text-gray-900 dark:text-gray-100 font-medium">
											{c.proposalId} — {c.proposalTitle}
										</span>
									</div>
									<div className="flex flex-col items-end space-y-1">
										<div
											className={`text-[10px] font-semibold uppercase tracking-wider ${healthTextColor(health)}`}
										>
											{health}
										</div>
										<div className="flex items-center space-x-3 text-xs text-gray-500 dark:text-gray-400 font-mono">
											<span>
												{c.lastHeartbeat
													? `HB: ${formatTimeAgo(c.lastHeartbeat)}`
													: "No Heartbeat"}
											</span>
											{c.expires && (
												<span>EXP: {formatTimeAgo(c.expires)}</span>
											)}
										</div>
										<button
											type="button"
											onClick={() => handleReleaseLease(c.proposalId)}
											disabled={releasingId === c.proposalId}
											className="mt-1 text-[10px] px-2 py-0.5 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
										>
											{releasingId === c.proposalId
												? "Releasing..."
												: "Release Lease"}
										</button>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Agent Cards */}
			<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
				<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
						Registered Agents
					</h2>
				</div>
				{agents.length === 0 ? (
					<p className="p-4 text-sm text-gray-500 dark:text-gray-400">
						No agents registered
					</p>
				) : (
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
						{agents.map((agent) => {
							const agentClaims = claims.filter((c) => c.agent === agent.name);
							return (
								<div
									key={agent.name}
									className="border border-gray-200 dark:border-gray-600 rounded-lg p-4 space-y-2"
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
										{agent.capabilities.length > 0 && (
											<div className="flex flex-wrap gap-1">
												{agent.capabilities.map((cap) => (
													<span
														key={cap}
														className="px-1.5 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded"
													>
														{cap}
													</span>
												))}
											</div>
										)}
										<div className="flex justify-between">
											<span>Trust: {agent.trustScore}</span>
											{agent.costClass && <span>Cost: {agent.costClass}</span>}
											<span>Seen: {formatTimeAgo(agent.lastSeen)}</span>
										</div>
										{agentClaims.length > 0 && (
											<div className="mt-1 pt-1 border-t border-gray-200 dark:border-gray-600">
												<span className="text-gray-600 dark:text-gray-300">
													Working on:{" "}
												</span>
												{agentClaims.map((c) => (
													<span
														key={c.proposalId}
														className="text-gray-900 dark:text-gray-100 font-medium"
													>
														{c.proposalId}{" "}
													</span>
												))}
											</div>
										)}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Directive Progress */}
			{directiveProgress.size > 0 && (
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
					<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
						<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
							Directive Progress
						</h2>
					</div>
					<div className="divide-y divide-gray-200 dark:divide-gray-700">
						{[...directiveProgress.entries()].map(([name, counts]) => (
							<div key={name} className="px-4 py-3">
								<div className="flex items-center justify-between mb-1">
									<span className="text-sm font-medium text-gray-900 dark:text-gray-100">
										{name}
									</span>
									<span className="text-xs text-gray-500 dark:text-gray-400">
										{counts.reached}/{counts.total} reached
									</span>
								</div>
								<div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
									<div
										className="bg-green-500 h-2 rounded-full"
										style={{
											width: `${counts.total > 0 ? (counts.reached / counts.total) * 100 : 0}%`,
										}}
									/>
								</div>
								<div className="flex gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
									<span>Active: {counts.active}</span>
									<span>Ready: {counts.ready}</span>
									{counts.blocked > 0 && (
										<span className="text-red-500">
											Blocked: {counts.blocked}
										</span>
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
};

export default AgentDashboard;
