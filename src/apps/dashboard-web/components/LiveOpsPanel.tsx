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
		</section>
	);
};

export default LiveOpsPanel;
