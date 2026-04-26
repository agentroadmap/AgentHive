import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Proposal, PulseEvent } from "../../../shared/types";
import type {
	Agent as WebSocketAgent,
	Channel as WebSocketChannel,
} from "../hooks/useWebSocket";
import { apiClient } from "../lib/api";
import ActivityFeed from "./ActivityFeed";
import MessageStream from "./MessageStream";

interface DashboardPageProps {
	connected: boolean;
	proposals: Proposal[];
	agents: WebSocketAgent[];
	channels: WebSocketChannel[];
}

interface RouteSummary {
	id: number;
	model_name: string;
	route_provider: string;
	agent_provider: string;
	agent_cli: string;
	is_enabled: boolean;
	cost_per_million_input: number;
	cost_per_million_output: number;
	priority: number;
}

interface DispatchSummary {
	id: number;
	proposal_id: number;
	proposal_display_id?: string | null;
	proposal_title?: string | null;
	agent_identity: string;
	worker_identity: string | null;
	dispatch_role: string;
	dispatch_status: string;
	offer_status: string;
	assigned_at: string;
	reissue_count: number;
	max_reissues: number;
}

interface ProjectStatus {
	initialized: boolean;
	projectPath: string;
}

const pulseTypeColor: Record<string, string> = {
	proposal_created: "text-blue-600 dark:text-blue-300",
	proposal_complete: "text-emerald-600 dark:text-emerald-300",
	proposal_moved: "text-violet-600 dark:text-violet-300",
	decision_made: "text-amber-600 dark:text-amber-300",
	obstacle_discovered: "text-red-600 dark:text-red-300",
	tool_called: "text-cyan-600 dark:text-cyan-300",
};

function timeAgo(value?: string | null): string {
	if (!value) return "—";
	const diffMs = Date.now() - new Date(value).getTime();
	const minutes = Math.floor(diffMs / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function heartbeatText(seconds?: number): string {
	if (typeof seconds !== "number") return "—";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 3600)}h`;
}

function proposalMaturityClass(maturity?: string): string {
	switch ((maturity ?? "").toLowerCase()) {
		case "mature":
			return "text-emerald-700 dark:text-emerald-300";
		case "active":
			return "text-blue-700 dark:text-blue-300";
		case "obsolete":
			return "text-gray-400 dark:text-gray-500";
		case "new":
			return "text-amber-700 dark:text-amber-300";
		default:
			return "text-gray-900 dark:text-gray-100";
	}
}

function badgeClass(value: string): string {
	switch (value.toLowerCase()) {
		case "active":
		case "assigned":
		case "open":
		case "healthy":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300";
		case "mature":
		case "complete":
		case "completed":
		case "delivered":
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300";
		case "blocked":
		case "claimed":
		case "degraded":
			return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
		case "obsolete":
		case "offline":
		case "expired":
		case "rejected":
			return "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300";
	}
}

const DashboardPage: React.FC<DashboardPageProps> = ({
	connected,
	proposals,
	agents,
	channels,
}) => {
	const [status, setStatus] = useState<ProjectStatus | null>(null);
	const [routes, setRoutes] = useState<RouteSummary[]>([]);
	const [dispatches, setDispatches] = useState<DispatchSummary[]>([]);
	const [pulse, setPulse] = useState<PulseEvent[]>([]);
	const [releasingProposalId, setReleasingProposalId] = useState<string | null>(
		null,
	);

	const fetchControlPlaneData = useCallback(async () => {
		const [statusData, routesData, dispatchData, pulseData] = await Promise.all([
			apiClient.checkStatus(),
			apiClient.fetchRoutes().catch(() => []),
			apiClient.fetchDispatches().catch(() => []),
			apiClient.fetchPulse(40).catch(() => []),
		]);
		setStatus(statusData);
		setRoutes(routesData as RouteSummary[]);
		setDispatches(dispatchData as DispatchSummary[]);
		setPulse(pulseData);
	}, []);

	useEffect(() => {
		void fetchControlPlaneData();
		const timer = setInterval(() => {
			void fetchControlPlaneData();
		}, 15000);
		return () => clearInterval(timer);
	}, [fetchControlPlaneData]);

	const activeProposals = useMemo(
		() =>
			proposals.filter((proposal) => {
				const statusKey = proposal.status.toLowerCase();
				return statusKey !== "complete" && statusKey !== "deployed";
			}),
		[proposals],
	);
	const matureQueue = useMemo(
		() =>
			activeProposals.filter(
				(proposal) => (proposal.maturity ?? "").toLowerCase() === "mature",
			),
		[activeProposals],
	);
	const obsoleteCount = useMemo(
		() =>
			proposals.filter(
				(proposal) => (proposal.maturity ?? "").toLowerCase() === "obsolete",
			).length,
		[proposals],
	);
	const blockedCount = useMemo(
		() =>
			activeProposals.filter((proposal) => {
				const dependencies = proposal.dependencies ?? [];
				return dependencies.some((dependencyId) => {
					const dependency = proposals.find((item) => item.id === dependencyId);
					return dependency && dependency.status.toLowerCase() !== "complete";
				});
			}).length,
		[activeProposals, proposals],
	);
	const budgetTracked = useMemo(
		() =>
			proposals.filter(
				(proposal) => Number(proposal.budgetLimitUsd ?? 0) > 0,
			),
		[proposals],
	);
	const totalBudget = useMemo(
		() =>
			budgetTracked.reduce(
				(sum, proposal) => sum + Number(proposal.budgetLimitUsd ?? 0),
				0,
			),
		[budgetTracked],
	);
	const enabledRoutes = useMemo(
		() => routes.filter((route) => route.is_enabled),
		[routes],
	);
	const activeDispatches = useMemo(
		() =>
			dispatches.filter((dispatch) =>
				["assigned", "active", "blocked"].includes(
					dispatch.dispatch_status.toLowerCase(),
				),
			),
		[dispatches],
	);
	const activeAgents = useMemo(
		() => agents.filter((agent) => agent.isActive),
		[agents],
	);
	const hotProposals = useMemo(
		() =>
			[...activeProposals]
				.sort((left, right) => {
					const leftHeartbeat =
						left.liveActivity?.heartbeatAgeSeconds ?? Number.MAX_SAFE_INTEGER;
					const rightHeartbeat =
						right.liveActivity?.heartbeatAgeSeconds ?? Number.MAX_SAFE_INTEGER;
					if (leftHeartbeat !== rightHeartbeat) return leftHeartbeat - rightHeartbeat;
					return (left.updatedDate ?? left.createdDate).localeCompare(
						right.updatedDate ?? right.createdDate,
					);
				})
				.slice(0, 12),
		[activeProposals],
	);
	const workforce = useMemo(
		() =>
			[...agents].sort((left, right) => {
				if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
				return left.identity.localeCompare(right.identity);
			}),
		[agents],
	);

	const handleReleaseLease = useCallback(async (proposalId: string) => {
		try {
			setReleasingProposalId(proposalId);
			await apiClient.releaseProposal(proposalId);
		} finally {
			setReleasingProposalId(null);
		}
	}, []);

	return (
		<div className="space-y-8 px-4 py-6 md:px-6 xl:px-8">
			<section className="border-b border-gray-200 pb-6 dark:border-gray-800">
				<div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
					<div className="space-y-3">
						<div className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
							<span
								className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 tracking-normal ${connected ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"}`}
							>
								<span
									className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-red-500"}`}
								/>
								{connected ? "Live Websocket" : "Websocket Down"}
							</span>
							{status?.initialized ? "Project Ready" : "Project Uninitialized"}
						</div>
						<div>
							<h1 className="text-3xl font-semibold text-gray-950 dark:text-gray-50">
								AgentHive Control Plane
							</h1>
							<p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
								Live workforce, proposal flow, dispatch pressure, channels, and
								model route posture in one place.
							</p>
						</div>
						<div className="flex flex-wrap gap-3 text-sm text-gray-600 dark:text-gray-300">
							<span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
								Project: {status?.projectPath ?? "loading"}
							</span>
							<span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
								Scope: {proposals.length} proposals
							</span>
							<span className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800">
								Channels: {channels.length}
							</span>
						</div>
					</div>
					<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:w-[420px]">
						{[
							["Board", "/board"],
							["Agents", "/agents"],
							["Dispatch", "/dispatch"],
							["Channels", "/channels"],
							["Routes", "/routes"],
							["Settings", "/settings"],
						].map(([label, href]) => (
							<a
								key={href}
								href={href}
								className="inline-flex items-center justify-center rounded-md border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
							>
								{label}
							</a>
						))}
					</div>
				</div>
			</section>

			<section className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
				{[
					["In Flight", activeProposals.length, "Active workflow surface"],
					["Gate Ready", matureQueue.length, "Mature proposals awaiting advance"],
					["Blocked", blockedCount, "Dependencies not yet complete"],
					["Obsolete", obsoleteCount, "Hidden by default on board"],
					["Live Agents", activeAgents.length, "Websocket workforce presence"],
					["Dispatches", activeDispatches.length, "Assigned, active, blocked"],
					["Routes", enabledRoutes.length, "Enabled model routes"],
					["Budget", `$${totalBudget}`, `${budgetTracked.length} tracked proposals`],
				].map(([label, value, detail]) => (
					<div
						key={label}
						className="border border-gray-200 bg-white px-4 py-4 dark:border-gray-800 dark:bg-gray-900"
					>
						<div className="text-[11px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
							{label}
						</div>
						<div className="mt-3 text-2xl font-semibold text-gray-950 dark:text-gray-50">
							{value}
						</div>
						<div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
							{detail}
						</div>
					</div>
				))}
			</section>

			<section className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.9fr)]">
				<div className="space-y-6">
					<div className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
						<div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
							<div>
								<h2 className="text-base font-semibold text-gray-950 dark:text-gray-50">
									Proposal Hotlist
								</h2>
								<p className="text-sm text-gray-500 dark:text-gray-400">
									Current work surface with lease, cubic, model, and gate context.
								</p>
							</div>
						</div>
						<div className="divide-y divide-gray-200 dark:divide-gray-800">
							{hotProposals.map((proposal) => (
								<div
									key={proposal.id}
									className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_180px_120px]"
								>
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-mono text-xs text-gray-500 dark:text-gray-400">
												{proposal.id}
											</span>
											<span
												className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClass(proposal.status)}`}
											>
												{proposal.status}
											</span>
											{proposal.maturity ? (
												<span
													className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClass(proposal.maturity)}`}
												>
													{proposal.maturity}
												</span>
											) : null}
										</div>
										<div
											className={`mt-2 text-sm font-medium ${proposalMaturityClass(proposal.maturity)}`}
										>
											{proposal.title}
										</div>
										<div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500 dark:text-gray-400">
											<span>
												Lease: {proposal.liveActivity?.leaseHolder ?? "—"}
											</span>
											<span>
												Cubic: {proposal.liveActivity?.activeCubic ?? "—"}
											</span>
											<span>
												Model: {proposal.liveActivity?.activeModel ?? "—"}
											</span>
											<span>
												Heartbeat:{" "}
												{heartbeatText(proposal.liveActivity?.heartbeatAgeSeconds)}
											</span>
										</div>
									</div>
									<div className="text-xs text-gray-600 dark:text-gray-300">
										<div>Updated {timeAgo(proposal.updatedDate ?? proposal.createdDate)}</div>
										<div className="mt-1">
											Last event: {proposal.liveActivity?.lastEventType ?? "—"}
										</div>
										<div className="mt-1">
											Gate: {proposal.liveActivity?.gateDispatchStatus ?? "—"}
										</div>
									</div>
									<div className="flex items-center justify-start md:justify-end">
										{proposal.liveActivity?.leaseHolder ? (
											<button
												type="button"
												onClick={() => void handleReleaseLease(proposal.id)}
												disabled={releasingProposalId === proposal.id}
												className="inline-flex items-center justify-center rounded-md border border-red-200 px-3 py-2 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40"
											>
												{releasingProposalId === proposal.id
													? "Releasing..."
													: "Release Lease"}
											</button>
										) : (
											<a
												href="/board"
												className="inline-flex items-center justify-center rounded-md border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
											>
												Open Board
											</a>
										)}
									</div>
								</div>
							))}
						</div>
					</div>

					<div className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
						<div className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
							<div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
								<h2 className="text-base font-semibold text-gray-950 dark:text-gray-50">
									Workforce
								</h2>
								<p className="text-sm text-gray-500 dark:text-gray-400">
									Live presence, role, and recent heartbeat by agent identity.
								</p>
							</div>
							<div className="divide-y divide-gray-200 dark:divide-gray-800">
								{workforce.map((agent) => (
									<div
										key={agent.identity}
										className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_140px]"
									>
										<div className="min-w-0">
											<div className="flex items-center gap-2">
												<span
													className={`inline-flex h-2.5 w-2.5 rounded-full ${agent.isActive ? "bg-emerald-500" : "bg-gray-400"}`}
												/>
												<span className="truncate text-sm font-medium text-gray-950 dark:text-gray-50">
													{agent.identity}
												</span>
											</div>
											<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
												Role: {agent.role || "agent"} · Agent ID:{" "}
												{agent.agentId || "—"}
											</div>
											{agent.statusMessage ? (
												<div className="mt-1 truncate text-xs text-gray-600 dark:text-gray-300">
													{agent.statusMessage}
												</div>
											) : null}
										</div>
										<div className="text-xs text-gray-600 dark:text-gray-300 md:text-right">
											<div
												className={`inline-flex rounded-full px-2 py-0.5 font-medium ${badgeClass(agent.isActive ? "active" : "offline")}`}
											>
												{agent.isActive ? "active" : "offline"}
											</div>
											<div className="mt-2">Seen {timeAgo(agent.lastSeenAt)}</div>
											{agent.activeProposalId ? (
												<div className="mt-1 font-mono text-[11px] text-gray-500 dark:text-gray-400">
													{agent.activeProposalId}
												</div>
											) : null}
										</div>
									</div>
								))}
							</div>
						</div>

						<div className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
							<div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
								<h2 className="text-base font-semibold text-gray-950 dark:text-gray-50">
									Dispatch and Route Pressure
								</h2>
								<p className="text-sm text-gray-500 dark:text-gray-400">
									Queue load, offer churn, and route availability.
								</p>
							</div>
							<div className="space-y-5 px-4 py-4">
								<div>
									<div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
										Dispatches
									</div>
									<div className="space-y-2">
										{activeDispatches.slice(0, 6).map((dispatch) => (
											<div
												key={dispatch.id}
												className="flex items-start justify-between gap-3 border border-gray-200 px-3 py-2 dark:border-gray-800"
											>
												<div className="min-w-0">
													<div className="truncate text-sm font-medium text-gray-950 dark:text-gray-50">
														{dispatch.proposal_display_id ?? `P${dispatch.proposal_id}`} ·{" "}
														{dispatch.proposal_title ?? dispatch.dispatch_role}
													</div>
													<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
														{dispatch.agent_identity} →{" "}
														{dispatch.worker_identity ?? "unclaimed"} ·{" "}
														{dispatch.dispatch_role}
													</div>
												</div>
												<div className="text-right text-xs">
													<div
														className={`inline-flex rounded-full px-2 py-0.5 font-medium ${badgeClass(dispatch.dispatch_status)}`}
													>
														{dispatch.dispatch_status}
													</div>
													<div className="mt-1 text-gray-500 dark:text-gray-400">
														{timeAgo(dispatch.assigned_at)}
													</div>
												</div>
											</div>
										))}
										{activeDispatches.length === 0 ? (
											<div className="text-sm text-gray-500 dark:text-gray-400">
												No active dispatches.
											</div>
										) : null}
									</div>
								</div>
								<div>
									<div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
										Utilities and Routes
									</div>
									<div className="space-y-2">
										{enabledRoutes.slice(0, 6).map((route) => (
											<div
												key={route.id}
												className="flex items-center justify-between border border-gray-200 px-3 py-2 text-sm dark:border-gray-800"
											>
												<div>
													<div className="font-medium text-gray-950 dark:text-gray-50">
														{route.model_name}
													</div>
													<div className="text-xs text-gray-500 dark:text-gray-400">
														{route.route_provider} · {route.agent_cli}
													</div>
												</div>
												<div className="text-right text-xs text-gray-500 dark:text-gray-400">
													<div>
														${route.cost_per_million_input}/$
														{route.cost_per_million_output}
													</div>
													<div>P{route.priority}</div>
												</div>
											</div>
										))}
										{enabledRoutes.length === 0 ? (
											<div className="text-sm text-gray-500 dark:text-gray-400">
												Route registry unavailable.
											</div>
										) : null}
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>

				<div className="space-y-6">
					<div className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
						<div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
							<h2 className="text-base font-semibold text-gray-950 dark:text-gray-50">
								Recent Activity
							</h2>
							<p className="text-sm text-gray-500 dark:text-gray-400">
								Latest pulse events across the project.
							</p>
						</div>
						<div className="divide-y divide-gray-200 dark:divide-gray-800">
							{pulse.map((event, index) => (
								<div key={`${event.id}-${event.timestamp}-${index}`} className="px-4 py-3">
									<div className="flex items-center justify-between gap-3">
										<div className="min-w-0">
											<div className="text-sm text-gray-950 dark:text-gray-50">
												<span className="font-medium">{event.agent}</span>{" "}
												<span
													className={`text-xs ${pulseTypeColor[event.type] ?? "text-gray-500 dark:text-gray-400"}`}
												>
													{event.type}
												</span>
											</div>
											<div className="truncate text-sm text-gray-600 dark:text-gray-300">
												{event.id} · {event.title}
											</div>
											{event.impact ? (
												<div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
													{event.impact}
												</div>
											) : null}
										</div>
										<div className="text-xs text-gray-400">{timeAgo(event.timestamp)}</div>
									</div>
								</div>
							))}
							{pulse.length === 0 ? (
								<div className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">
									No recent pulse activity.
								</div>
							) : null}
						</div>
					</div>

					<div className="grid grid-cols-1 gap-6">
						<div className="h-[420px]">
							<ActivityFeed />
						</div>
						<div className="h-[420px]">
							<MessageStream />
						</div>
					</div>
				</div>
			</section>
		</div>
	);
};

export default DashboardPage;
