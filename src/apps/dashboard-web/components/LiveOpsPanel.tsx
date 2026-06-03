import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { useProjectScope } from "../hooks/useProjectScope";

// P477 AC-3: live operations panel.
// Single-roundtrip view of workforce health, active cubics, route health,
// messaging traffic, and recent system activity. Reuses the AgentDetail
// slide-over for "click an agent to see more".

type Overview = {
	generated_at: string;
	project?: { project_id: number; slug: string; name: string };
	workforce: {
		healthy: string | number;
		stale: string | number;
		offline: string | number;
		crashed: string | number;
		total: string | number;
	} | null;
	busy_agents: Array<{
		agent_identity: string;
		status: string;
		current_task: string | null;
		current_proposal: number | null;
		current_cubic: string | null;
		active_model: string | null;
		last_heartbeat_at: string;
	}>;
	cubics_summary: {
		active: string | number;
		idle: string | number;
		expired: string | number;
		complete: string | number;
		total: string | number;
	} | null;
	active_cubics: Array<{
		cubic_id: string;
		phase: string;
		status: string;
		agent_identity: string | null;
		budget_usd: string | number | null;
		lock_holder: string | null;
		activated_at: string | null;
	}>;
	routes: Array<{
		model_name: string;
		route_provider: string;
		agent_provider: string;
		agent_cli: string | null;
		is_enabled: boolean;
		priority: number;
		tier: string | null;
	}>;
	messages: {
		last_5m: string | number;
		last_1h: string | number;
		last_24h: string | number;
		direct_1h: string | number;
		broadcast_1h: string | number;
		team_1h: string | number;
	} | null;
	recent_runs: Array<{
		id: number;
		agent_identity: string;
		proposal_display_id: string | null;
		stage: string;
		status: string;
		model_used: string;
		started_at: string;
		completed_at: string | null;
		duration_ms: number | null;
		cost_usd: number | string | null;
	}>;
	// P238: state-machine dashboard sections
	queue_pools: Array<{
		project_slug: string;
		workflow_name: string;
		stage: string;
		maturity: string;
		proposal_count: string | number;
		oldest_created_at: string | null;
		oldest_updated_at: string | null;
	}>;
	candidate_ranking: Array<{
		display_id: string;
		title: string;
		workflow_name: string;
		stage: string;
		maturity: string;
		priority: string;
		dependency_blockers: string | number;
		stale_lease_boost: string | number;
		capacity_blocked: boolean;
		active_dispatches: string | number;
		last_transition_at: string | null;
	}>;
	dispatch_lifecycle: {
		status_counts: {
			posted: string | number;
			claimed: string | number;
			running: string | number;
			completed: string | number;
			failed: string | number;
			throttled: string | number;
			cancelled: string | number;
			expired: string | number;
		};
		recent_dispatches: Array<{
			id: number;
			proposal_display_id: string | null;
			proposal_title: string | null;
			dispatch_role: string;
			dispatch_status: string;
			offer_status: string;
			agent_identity: string | null;
			worker_identity: string | null;
			assigned_at: string | null;
			claim_expires_at: string | null;
		}>;
	} | null;
	lease_recovery: {
		summary: {
			active: string | number;
			expired: string | number;
			recovered_workspaces: string | number;
		};
		recent_expired: Array<{
			display_id: string;
			title: string;
			agent_identity: string | null;
			claimed_at: string | null;
			expires_at: string | null;
			release_reason: string | null;
		}>;
	} | null;
	liaison_health: {
		summary: {
			active: string | number;
			throttled: string | number;
			dormant: string | number;
			offline: string | number;
			retired: string | number;
			sessions: string | number;
		};
		agencies: Array<{
			agency_identity: string;
			status: string;
			last_seen_at: string | null;
			max_in_flight: string | number;
			in_flight_count: string | number;
			throttle_count: string | number;
			recent_failure_count: string | number;
			session_started_at: string | null;
			liaison_host: string | null;
			liaison_pid: number | null;
		}>;
	} | null;
	gate_audit: {
		decision_counts: {
			advance: string | number;
			hold: string | number;
			reject: string | number;
			waive: string | number;
			escalate: string | number;
		};
		recent_decisions: Array<{
			display_id: string;
			title: string;
			from_state: string;
			to_state: string | null;
			maturity: string | null;
			decision: string;
			decided_by: string;
			created_at: string;
		}>;
		recent_transitions: Array<{
			display_id: string;
			title: string;
			from_state: string;
			to_state: string;
			transition_reason: string | null;
			transitioned_by: string;
			transitioned_at: string;
		}>;
	} | null;
	route_budget_audit: {
		recent_route_decisions: Array<{
			display_id: string | null;
			role: string;
			agency_identity: string;
			chosen_route: string;
			eliminated_count: string | number;
			decided_at: string;
		}>;
		budget_counters: {
			tracked_principals: string | number;
			total_budget_cents: string | number;
			total_spent_cents: string | number;
			over_budget_principals: string | number;
		};
		budget_decisions: {
			approved: string | number;
			rejected: string | number;
			deny_budget: string | number;
			deny_compliance: string | number;
		};
	} | null;
};

interface LiveOpsPanelProps {
	onAgentClick?: (identity: string) => void;
}

const num = (v: string | number | null | undefined): number => {
	if (v == null) return 0;
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
};

const ago = (iso?: string | null): string => {
	if (!iso) return "—";
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return "—";
	const diff = Date.now() - t;
	if (diff < 0) return "just now";
	const m = Math.floor(diff / 60000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
};

const healthColor = (k: string) =>
	({
		healthy: "text-emerald-700 dark:text-emerald-300",
		stale: "text-amber-700 dark:text-amber-300",
		offline: "text-gray-500 dark:text-gray-400",
		crashed: "text-red-700 dark:text-red-300",
	})[k] ?? "text-gray-700 dark:text-gray-300";

const runStatusColor = (status: string) =>
	({
		completed: "text-emerald-700 dark:text-emerald-300",
		running: "text-blue-700 dark:text-blue-300",
		failed: "text-red-700 dark:text-red-300",
		cancelled: "text-gray-500 dark:text-gray-400",
	})[status] ?? "text-gray-700 dark:text-gray-300";

const LiveOpsPanel: React.FC<LiveOpsPanelProps> = ({ onAgentClick }) => {
	const [data, setData] = useState<Overview | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadedAt, setLoadedAt] = useState<number | null>(null);
	const scope = useProjectScope();

	const load = useCallback(async () => {
		try {
			const res = await scope.scopedFetch("/api/control-plane/overview", {
				headers: { Accept: "application/json" },
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			setData((await res.json()) as Overview);
			setLoadedAt(Date.now());
			setError(null);
		} catch (e) {
			setError((e as Error).message);
		}
	}, [scope.scopedFetch]);

	useEffect(() => {
		void load();
		const t = setInterval(() => void load(), 5000);
		return () => clearInterval(t);
	}, [load]);

	if (!data && !error) {
		return (
			<div className="text-sm text-gray-500 dark:text-gray-400 p-4">
				Loading live operations…
			</div>
		);
	}
	if (error && !data) {
		return (
			<div className="text-sm text-red-600 dark:text-red-400 p-4">
				Live ops unavailable: {error}
			</div>
		);
	}

	const w = data?.workforce;
	const c = data?.cubics_summary;
	const m = data?.messages;

	return (
		<section className="space-y-4">
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="flex items-center gap-3">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
						Live operations
					</h2>
					{/* P477 AC-2: switcher lives in the global header. Surface
					    only the active project + drift indicator here so this
					    panel reflects what the operator chose without a duplicate
					    dropdown. */}
					{scope.current && (
						<span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
							<span className="uppercase tracking-wide">project</span>
							<span className="text-gray-700 dark:text-gray-300">
								{scope.current.name}
							</span>
							{data?.project &&
								data.project.project_id !== scope.current.project_id && (
									<span
										className="text-amber-700 dark:text-amber-300"
										title="Server returned different project than the chip suggests; refresh imminent."
									>
										⟳
									</span>
								)}
						</span>
					)}
				</div>
				<span className="text-xs text-gray-500 dark:text-gray-400">
					{loadedAt ? `refreshed ${ago(new Date(loadedAt).toISOString())}` : ""}
				</span>
			</div>

			{/* Top tile row: workforce / cubics / messages */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
						Workforce ({num(w?.total)})
					</div>
					<div className="grid grid-cols-4 gap-2 text-sm">
						{(["healthy", "stale", "offline", "crashed"] as const).map((k) => (
							<div key={k} className="text-center">
								<div className={`text-lg font-semibold ${healthColor(k)}`}>
									{num(w?.[k])}
								</div>
								<div className="text-[10px] uppercase text-gray-500 dark:text-gray-400">
									{k}
								</div>
							</div>
						))}
					</div>
				</div>
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
						Cubics ({num(c?.total)})
					</div>
					<div className="grid grid-cols-4 gap-2 text-sm">
						{(["active", "idle", "expired", "complete"] as const).map((k) => (
							<div key={k} className="text-center">
								<div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
									{num(c?.[k])}
								</div>
								<div className="text-[10px] uppercase text-gray-500 dark:text-gray-400">
									{k}
								</div>
							</div>
						))}
					</div>
				</div>
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
						Messaging
					</div>
					<dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
						<dt className="text-gray-500">last 5m</dt>
						<dd className="font-mono text-right">{num(m?.last_5m)}</dd>
						<dt className="text-gray-500">last 1h</dt>
						<dd className="font-mono text-right">{num(m?.last_1h)}</dd>
						<dt className="text-gray-500">last 24h</dt>
						<dd className="font-mono text-right">{num(m?.last_24h)}</dd>
						<dt className="text-gray-500">direct (1h)</dt>
						<dd className="font-mono text-right">{num(m?.direct_1h)}</dd>
						<dt className="text-gray-500">team (1h)</dt>
						<dd className="font-mono text-right">{num(m?.team_1h)}</dd>
						<dt className="text-gray-500">broadcast (1h)</dt>
						<dd className="font-mono text-right">{num(m?.broadcast_1h)}</dd>
					</dl>
				</div>
			</div>

			{/* Busy agents */}
			<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
				<div className="flex items-baseline justify-between mb-2">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
						Busy agents
					</h3>
					<span className="text-[11px] text-gray-500">
						{data?.busy_agents.length ?? 0} shown
					</span>
				</div>
				{(data?.busy_agents.length ?? 0) === 0 ? (
					<div className="text-xs text-gray-500">No active heartbeats.</div>
				) : (
					<ul className="divide-y divide-gray-100 dark:divide-gray-700">
						{data?.busy_agents.map((a) => (
							<li key={a.agent_identity} className="py-1.5 text-xs">
								<button
									type="button"
									onClick={() => onAgentClick?.(a.agent_identity)}
									className="w-full text-left grid grid-cols-12 gap-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 rounded px-1 py-0.5"
								>
									<span className="col-span-3 font-mono truncate">
										{a.agent_identity}
									</span>
									<span
										className={`col-span-1 ${healthColor(a.status)} font-medium`}
									>
										{a.status}
									</span>
									<span className="col-span-5 truncate text-gray-700 dark:text-gray-300">
										{a.current_task ?? "—"}
									</span>
									<span className="col-span-2 truncate text-gray-500">
										{a.active_model ?? "—"}
									</span>
									<span className="col-span-1 text-right text-gray-500">
										{ago(a.last_heartbeat_at)}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Active cubics + Recent runs side-by-side on wide screens */}
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
						Active cubics
					</h3>
					{(data?.active_cubics.length ?? 0) === 0 ? (
						<div className="text-xs text-gray-500">No active cubics.</div>
					) : (
						<ul className="text-xs space-y-1.5 max-h-80 overflow-y-auto">
							{data?.active_cubics.map((cu) => (
								<li
									key={cu.cubic_id}
									className="border border-gray-100 dark:border-gray-700 rounded p-1.5"
								>
									<div className="flex justify-between gap-2">
										<span className="font-mono truncate" title={cu.cubic_id}>
											{cu.cubic_id.slice(0, 12)}…
										</span>
										<span className="text-gray-500">
											{ago(cu.activated_at)}
										</span>
									</div>
									<div className="flex justify-between text-gray-600 dark:text-gray-400 mt-0.5">
										<span>
											{cu.phase} · {cu.status}
										</span>
										<span className="font-mono">
											{cu.agent_identity ?? "—"}
										</span>
									</div>
									{(cu.lock_holder || num(cu.budget_usd) > 0) && (
										<div className="text-[10px] text-gray-500 mt-0.5">
											{cu.lock_holder ? `lock: ${cu.lock_holder}` : ""}
											{cu.lock_holder && num(cu.budget_usd) > 0 ? " · " : ""}
											{num(cu.budget_usd) > 0
												? `$${num(cu.budget_usd).toFixed(2)}`
												: ""}
										</div>
									)}
								</li>
							))}
						</ul>
					)}
				</div>

				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
						Recent runs
					</h3>
					{(data?.recent_runs.length ?? 0) === 0 ? (
						<div className="text-xs text-gray-500">No recent runs.</div>
					) : (
						<ul className="text-xs space-y-1 max-h-80 overflow-y-auto">
							{data?.recent_runs.map((r) => (
								<li
									key={r.id}
									className="grid grid-cols-12 gap-2 py-0.5 border-b border-gray-50 dark:border-gray-700/50"
								>
									<button
										type="button"
										onClick={() => onAgentClick?.(r.agent_identity)}
										className="col-span-3 font-mono truncate text-left hover:underline"
									>
										{r.agent_identity}
									</button>
									<span className="col-span-2 truncate">
										{r.proposal_display_id ?? "—"}
									</span>
									<span className="col-span-2 truncate text-gray-500">
										{r.stage}
									</span>
									<span
										className={`col-span-2 font-medium ${runStatusColor(r.status)}`}
									>
										{r.status}
									</span>
									<span className="col-span-3 text-right text-gray-500">
										{ago(r.started_at)}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>

			{/* Route health */}
			<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
				<div className="flex items-baseline justify-between mb-2">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
						Route health
					</h3>
					<span className="text-[11px] text-gray-500">
						{data?.routes.length ?? 0} routes
					</span>
				</div>
				{(data?.routes.length ?? 0) === 0 ? (
					<div className="text-xs text-gray-500">No routes configured.</div>
				) : (
					<ul className="text-xs grid grid-cols-1 md:grid-cols-2 gap-1">
						{data?.routes.map((r) => (
							<li
								key={`${r.model_name}-${r.route_provider}-${r.priority}`}
								className="flex justify-between items-center px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-700/40"
							>
								<span className="flex items-center gap-2 truncate">
									<span
										className={
											r.is_enabled
												? "h-1.5 w-1.5 rounded-full bg-emerald-500"
												: "h-1.5 w-1.5 rounded-full bg-gray-400"
										}
									/>
									<span className="font-mono truncate">{r.model_name}</span>
								</span>
								<span className="text-gray-500 truncate ml-2">
									{r.route_provider} → {r.agent_provider}
									{r.agent_cli ? ` · ${r.agent_cli}` : ""}
									{r.tier ? ` · ${r.tier}` : ""}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* P238: Queue pools */}
			{(data?.queue_pools?.length ?? 0) > 0 && (
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<div className="flex items-baseline justify-between mb-2">
						<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
							Queue pools
						</h3>
						<span className="text-[11px] text-gray-500">
							{data?.queue_pools.length} buckets
						</span>
					</div>
					<div className="overflow-x-auto">
						<table className="text-xs w-full">
							<thead>
								<tr className="text-[10px] uppercase text-gray-500 border-b border-gray-100 dark:border-gray-700">
									<th className="text-left pb-1 pr-2">workflow</th>
									<th className="text-left pb-1 pr-2">stage</th>
									<th className="text-left pb-1 pr-2">maturity</th>
									<th className="text-right pb-1 pr-2">count</th>
									<th className="text-right pb-1">oldest</th>
								</tr>
							</thead>
							<tbody>
								{data?.queue_pools.map((qp, i) => (
									<tr
										key={i}
										className="border-b border-gray-50 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30"
									>
										<td className="py-0.5 pr-2 truncate max-w-[8rem]">{qp.workflow_name}</td>
										<td className="py-0.5 pr-2 font-medium">{qp.stage}</td>
										<td className="py-0.5 pr-2 text-gray-500">{qp.maturity}</td>
										<td className="py-0.5 pr-2 text-right font-mono">{num(qp.proposal_count)}</td>
										<td className="py-0.5 text-right text-gray-500">{ago(qp.oldest_updated_at ?? qp.oldest_created_at)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}

			{/* P238: Candidate ranking */}
			{(data?.candidate_ranking?.length ?? 0) > 0 && (
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<div className="flex items-baseline justify-between mb-2">
						<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
							Develop candidates
						</h3>
						<span className="text-[11px] text-gray-500">
							top {data?.candidate_ranking.length}
						</span>
					</div>
					<ul className="text-xs space-y-1">
						{data?.candidate_ranking.map((cr, i) => (
							<li
								key={i}
								className="grid grid-cols-12 gap-1 py-0.5 border-b border-gray-50 dark:border-gray-700/50"
							>
								<span className="col-span-2 font-mono text-gray-500">{cr.display_id}</span>
								<span className="col-span-4 truncate">{cr.title}</span>
								<span className={`col-span-1 font-medium ${
									cr.priority === "critical" ? "text-red-600 dark:text-red-400" :
									cr.priority === "high" ? "text-orange-600 dark:text-orange-400" :
									"text-gray-500"
								}`}>{cr.priority}</span>
								<span className="col-span-1 text-gray-500">{cr.maturity}</span>
								<span className={`col-span-2 text-right ${num(cr.dependency_blockers) > 0 ? "text-red-600 dark:text-red-400" : "text-gray-400"}`}>
									{num(cr.dependency_blockers) > 0 ? `${num(cr.dependency_blockers)} blocked` : ""}
								</span>
								<span className={`col-span-2 text-right ${cr.capacity_blocked ? "text-orange-600 dark:text-orange-400" : "text-gray-400"}`}>
									{cr.capacity_blocked ? "cap. full" : num(cr.active_dispatches) > 0 ? `${num(cr.active_dispatches)} disp` : ""}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{/* P238: Dispatch lifecycle */}
			{data?.dispatch_lifecycle && (
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
						Dispatch lifecycle
					</h3>
					<div className="grid grid-cols-4 md:grid-cols-8 gap-2 text-center text-xs mb-3">
						{(["posted","claimed","running","completed","failed","throttled","cancelled","expired"] as const).map((k) => {
							const colors: Record<string, string> = {
								posted: "text-blue-700 dark:text-blue-300",
								claimed: "text-yellow-700 dark:text-yellow-300",
								running: "text-emerald-700 dark:text-emerald-300",
								completed: "text-gray-500",
								failed: "text-red-700 dark:text-red-300",
								throttled: "text-orange-700 dark:text-orange-300",
								cancelled: "text-gray-400",
								expired: "text-purple-700 dark:text-purple-300",
							};
							return (
								<div key={k}>
									<div className={`text-base font-semibold ${colors[k]}`}>
										{num((data.dispatch_lifecycle?.status_counts as Record<string, string | number>)?.[k])}
									</div>
									<div className="text-[10px] uppercase text-gray-500">{k}</div>
								</div>
							);
						})}
					</div>
					{(data.dispatch_lifecycle.recent_dispatches?.length ?? 0) > 0 && (
						<ul className="text-xs space-y-0.5 max-h-40 overflow-y-auto">
							{data.dispatch_lifecycle.recent_dispatches.map((d) => (
								<li
									key={d.id}
									className="grid grid-cols-12 gap-1 py-0.5 border-b border-gray-50 dark:border-gray-700/50"
								>
									<span className="col-span-2 font-mono text-gray-500">#{d.id}</span>
									<span className="col-span-2 truncate">{d.proposal_display_id ?? "—"}</span>
									<span className="col-span-3 truncate text-gray-500">{d.dispatch_role}</span>
									<span className="col-span-2 font-medium">{d.offer_status}</span>
									<span className="col-span-3 truncate text-gray-500">{d.worker_identity ?? d.agent_identity ?? "—"}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{/* P238: Lease recovery */}
			{data?.lease_recovery && (
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
						Lease recovery
					</h3>
					<div className="grid grid-cols-3 gap-3 mb-3 text-center text-xs">
						<div>
							<div className="text-base font-semibold text-emerald-700 dark:text-emerald-300">
								{num(data.lease_recovery.summary.active)}
							</div>
							<div className="text-[10px] uppercase text-gray-500">active</div>
						</div>
						<div>
							<div className={`text-base font-semibold ${num(data.lease_recovery.summary.expired) > 0 ? "text-red-700 dark:text-red-300" : "text-gray-500"}`}>
								{num(data.lease_recovery.summary.expired)}
							</div>
							<div className="text-[10px] uppercase text-gray-500">expired</div>
						</div>
						<div>
							<div className={`text-base font-semibold ${num(data.lease_recovery.summary.recovered_workspaces) > 0 ? "text-amber-700 dark:text-amber-300" : "text-gray-500"}`}>
								{num(data.lease_recovery.summary.recovered_workspaces)}
							</div>
							<div className="text-[10px] uppercase text-gray-500">recovered ws</div>
						</div>
					</div>
					{(data.lease_recovery.recent_expired?.length ?? 0) > 0 && (
						<ul className="text-xs space-y-0.5 max-h-32 overflow-y-auto">
							{data.lease_recovery.recent_expired.map((le, i) => (
								<li key={i} className="flex items-center gap-2 py-0.5 border-b border-gray-50 dark:border-gray-700/50">
									<span className="font-mono text-gray-500 shrink-0">{le.display_id}</span>
									<span className="truncate flex-1">{le.title}</span>
									<span className="text-red-600 dark:text-red-400 shrink-0">{ago(le.expires_at)}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{/* P238: Liaison / agency health */}
			{data?.liaison_health && (
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
						Liaison / agency health
					</h3>
					<div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center text-xs mb-3">
						{(["active","throttled","dormant","offline","retired","sessions"] as const).map((k) => {
							const colors: Record<string, string> = {
								active: "text-emerald-700 dark:text-emerald-300",
								throttled: "text-orange-700 dark:text-orange-300",
								dormant: "text-amber-700 dark:text-amber-300",
								offline: "text-gray-500",
								retired: "text-gray-400",
								sessions: "text-blue-700 dark:text-blue-300",
							};
							return (
								<div key={k}>
									<div className={`text-base font-semibold ${colors[k]}`}>
										{num((data.liaison_health?.summary as Record<string, string | number>)?.[k])}
									</div>
									<div className="text-[10px] uppercase text-gray-500">{k}</div>
								</div>
							);
						})}
					</div>
					{(data.liaison_health.agencies?.length ?? 0) > 0 && (
						<ul className="text-xs space-y-1 max-h-40 overflow-y-auto">
							{data.liaison_health.agencies.map((ag) => (
								<li key={ag.agency_identity} className="grid grid-cols-12 gap-1 py-0.5 border-b border-gray-50 dark:border-gray-700/50">
									<span className="col-span-4 font-mono truncate">{ag.agency_identity}</span>
									<span className={`col-span-2 font-medium ${ag.status === "active" ? "text-emerald-600" : "text-amber-600"}`}>{ag.status}</span>
									<span className="col-span-2 text-right text-gray-500">{num(ag.in_flight_count)}/{num(ag.max_in_flight)} in-flight</span>
									<span className={`col-span-2 text-right ${num(ag.recent_failure_count) > 0 ? "text-red-600 dark:text-red-400" : "text-gray-400"}`}>
										{num(ag.recent_failure_count)} fail
									</span>
									<span className="col-span-2 text-right text-gray-400">{ago(ag.last_seen_at)}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{/* P238: Gate / transition audit */}
			{data?.gate_audit && (
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
						Gate / transition audit <span className="text-[10px] font-normal text-gray-400">(last 24 h)</span>
					</h3>
					<div className="grid grid-cols-5 gap-2 text-center text-xs mb-3">
						{(["advance","hold","reject","waive","escalate"] as const).map((k) => {
							const colors: Record<string, string> = {
								advance: "text-emerald-700 dark:text-emerald-300",
								hold: "text-amber-700 dark:text-amber-300",
								reject: "text-red-700 dark:text-red-300",
								waive: "text-blue-700 dark:text-blue-300",
								escalate: "text-purple-700 dark:text-purple-300",
							};
							return (
								<div key={k}>
									<div className={`text-base font-semibold ${colors[k]}`}>
										{num((data.gate_audit?.decision_counts as Record<string, string | number>)?.[k])}
									</div>
									<div className="text-[10px] uppercase text-gray-500">{k}</div>
								</div>
							);
						})}
					</div>
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
						{(data.gate_audit.recent_decisions?.length ?? 0) > 0 && (
							<div>
								<div className="text-[10px] uppercase text-gray-400 mb-1">recent gate decisions</div>
								<ul className="text-xs space-y-0.5 max-h-28 overflow-y-auto">
									{data.gate_audit.recent_decisions.map((gd, i) => (
										<li key={i} className="flex items-center gap-2 py-0.5 border-b border-gray-50 dark:border-gray-700/50">
											<span className="font-mono text-gray-500 shrink-0">{gd.display_id}</span>
											<span className={`font-medium shrink-0 ${gd.decision === "advance" ? "text-emerald-600" : gd.decision === "reject" ? "text-red-600" : "text-amber-600"}`}>{gd.decision}</span>
											<span className="truncate flex-1 text-gray-500">{gd.from_state}{gd.to_state ? ` → ${gd.to_state}` : ""}</span>
											<span className="text-gray-400 shrink-0">{ago(gd.created_at)}</span>
										</li>
									))}
								</ul>
							</div>
						)}
						{(data.gate_audit.recent_transitions?.length ?? 0) > 0 && (
							<div>
								<div className="text-[10px] uppercase text-gray-400 mb-1">recent transitions</div>
								<ul className="text-xs space-y-0.5 max-h-28 overflow-y-auto">
									{data.gate_audit.recent_transitions.map((t, i) => (
										<li key={i} className="flex items-center gap-2 py-0.5 border-b border-gray-50 dark:border-gray-700/50">
											<span className="font-mono text-gray-500 shrink-0">{t.display_id}</span>
											<span className="shrink-0 text-gray-700 dark:text-gray-300">{t.from_state} → {t.to_state}</span>
											<span className="truncate flex-1 text-gray-400">{t.transitioned_by}</span>
											<span className="text-gray-400 shrink-0">{ago(t.transitioned_at)}</span>
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				</div>
			)}

			{/* P238: Route / budget audit */}
			{data?.route_budget_audit && (
				<div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
					<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">
						Route / budget audit
					</h3>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
						<div>
							<div className="text-[10px] uppercase text-gray-400 mb-1">budget counters</div>
							<dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
								<dt className="text-gray-500">tracked principals</dt>
								<dd className="font-mono text-right">{num(data.route_budget_audit.budget_counters.tracked_principals)}</dd>
								<dt className="text-gray-500">total budget</dt>
								<dd className="font-mono text-right">${(num(data.route_budget_audit.budget_counters.total_budget_cents) / 100).toFixed(2)}</dd>
								<dt className="text-gray-500">spent</dt>
								<dd className="font-mono text-right">${(num(data.route_budget_audit.budget_counters.total_spent_cents) / 100).toFixed(2)}</dd>
								<dt className={`${num(data.route_budget_audit.budget_counters.over_budget_principals) > 0 ? "text-red-600 dark:text-red-400" : "text-gray-500"}`}>over budget</dt>
								<dd className={`font-mono text-right ${num(data.route_budget_audit.budget_counters.over_budget_principals) > 0 ? "text-red-600 dark:text-red-400" : ""}`}>
									{num(data.route_budget_audit.budget_counters.over_budget_principals)}
								</dd>
							</dl>
							<div className="text-[10px] uppercase text-gray-400 mt-2 mb-1">budget decisions (24h)</div>
							<dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
								<dt className="text-gray-500">approved</dt><dd className="font-mono text-right text-emerald-600">{num(data.route_budget_audit.budget_decisions.approved)}</dd>
								<dt className="text-gray-500">rejected</dt><dd className="font-mono text-right text-red-600">{num(data.route_budget_audit.budget_decisions.rejected)}</dd>
								<dt className="text-gray-500">deny_budget</dt><dd className="font-mono text-right text-amber-600">{num(data.route_budget_audit.budget_decisions.deny_budget)}</dd>
								<dt className="text-gray-500">deny_compliance</dt><dd className="font-mono text-right text-amber-600">{num(data.route_budget_audit.budget_decisions.deny_compliance)}</dd>
							</dl>
						</div>
						{(data.route_budget_audit.recent_route_decisions?.length ?? 0) > 0 && (
							<div>
								<div className="text-[10px] uppercase text-gray-400 mb-1">recent route decisions</div>
								<ul className="text-xs space-y-0.5 max-h-36 overflow-y-auto">
									{data.route_budget_audit.recent_route_decisions.map((rd, i) => (
										<li key={i} className="flex items-center gap-2 py-0.5 border-b border-gray-50 dark:border-gray-700/50">
											<span className="font-mono text-gray-500 shrink-0">{rd.display_id ?? "—"}</span>
											<span className="truncate flex-1">{rd.chosen_route}</span>
											<span className="text-gray-400 shrink-0">{rd.eliminated_count > 0 ? `-${num(rd.eliminated_count)}` : ""}</span>
											<span className="text-gray-400 shrink-0">{ago(rd.decided_at)}</span>
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				</div>
			)}
		</section>
	);
};

export default LiveOpsPanel;
