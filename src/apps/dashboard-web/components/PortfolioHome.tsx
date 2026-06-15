import type React from "react";
import { useCallback, useEffect, useState } from "react";

interface PortfolioStats {
	activeProjects: number;
	totalAgencies: number;
	degradedAgencies: number;
	budgetAvailable: boolean;
	totalCostUsd: number | null;
	recentActivity: RecentEvent[];
}

interface RecentEvent {
	id: number | string;
	event_type: string;
	actor: string | null;
	created_at: string;
	summary: string | null;
}

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

const PortfolioHome: React.FC = () => {
	const [stats, setStats] = useState<PortfolioStats | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const fetchStats = useCallback(async () => {
		try {
			const [projectsRes, fleetRes, efficiencyRes] = await Promise.allSettled([
				fetch("/api/projects").then((r) => r.json()),
				fetch("/api/control-plane/fleet").then((r) => r.json()),
				fetch("/api/control-plane/efficiency").then((r) => r.json()),
			]);

			const projectsData =
				projectsRes.status === "fulfilled" ? projectsRes.value : null;
			const fleetData =
				fleetRes.status === "fulfilled" ? fleetRes.value : null;
			const efficiencyData =
				efficiencyRes.status === "fulfilled" ? efficiencyRes.value : null;

			const activeProjects: number =
				Array.isArray(projectsData?.projects) ? projectsData.projects.length : 0;
			const agencies: { status: string }[] = Array.isArray(fleetData?.agencies)
				? fleetData.agencies
				: [];
			const totalAgencies = agencies.length;
			const degradedAgencies = agencies.filter(
				(a) => a.status !== "active" && a.status !== "healthy",
			).length;

			const efficiencyRows: { total_cost_usd: number | null }[] = Array.isArray(
				efficiencyData?.data,
			)
				? efficiencyData.data
				: [];
			const budgetAvailable = efficiencyRows.some(
				(r) => r.total_cost_usd !== null,
			);
			const totalCostUsd = budgetAvailable
				? efficiencyRows.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0)
				: null;

			// Recent activity from pulse endpoint
			let recentActivity: RecentEvent[] = [];
			try {
				const pulseRes = await fetch("/api/pulse?limit=10");
				const pulseData = await pulseRes.json();
				recentActivity = Array.isArray(pulseData)
					? pulseData.slice(0, 10).map((e: Record<string, unknown>) => ({
							id: (e.id as number) ?? Math.random(),
							event_type: (e.type as string) ?? "event",
							actor: (e.agent as string) ?? null,
							created_at: (e.timestamp as string) ?? "",
							summary: (e.title as string) ?? null,
						}))
					: [];
			} catch {
				// pulse unavailable — show empty
			}

			setStats({
				activeProjects,
				totalAgencies,
				degradedAgencies,
				budgetAvailable,
				totalCostUsd,
				recentActivity,
			});
			setError(null);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchStats();
		const t = setInterval(() => void fetchStats(), 30000);
		return () => clearInterval(t);
	}, [fetchStats]);

	const cards = [
		{
			label: "Active Projects",
			value: loading ? "…" : stats?.activeProjects ?? 0,
			detail: "roadmap.project WHERE status='active'",
		},
		{
			label: "Fleet Health",
			value: loading
				? "…"
				: `${stats?.totalAgencies ?? 0} total / ${stats?.degradedAgencies ?? 0} degraded`,
			detail: "roadmap.agency status summary",
		},
		{
			label: "Budget Status",
			value: loading
				? "…"
				: stats?.budgetAvailable
					? `$${(stats.totalCostUsd ?? 0).toFixed(2)}`
					: "N/A",
			detail: stats?.budgetAvailable
				? "30-day cost rollup across projects"
				: "agent_budget_ledger data not available",
		},
		{
			label: "Recent Activity",
			value: loading ? "…" : `${stats?.recentActivity.length ?? 0} events`,
			detail: "last 10 pulse events",
		},
	];

	return (
		<div className="space-y-8 px-4 py-6 md:px-6 xl:px-8">
			<section className="border-b border-gray-200 pb-6 dark:border-gray-800">
				<h1 className="text-3xl font-semibold text-gray-950 dark:text-gray-50">
					AgentHive Control Plane
				</h1>
				<p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
					Cross-project operations overview — fleet, efficiency, identity, and
					platform health.
				</p>
			</section>

			{error && (
				<div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
					Failed to load portfolio data: {error}
				</div>
			)}

			<section
				className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
				data-testid="portfolio-cards"
			>
				{cards.map((card) => (
					<div
						key={card.label}
						className="border border-gray-200 bg-white px-5 py-5 dark:border-gray-800 dark:bg-gray-900"
					>
						<div className="text-[11px] font-medium uppercase tracking-[0.18em] text-gray-500 dark:text-gray-400">
							{card.label}
						</div>
						<div className="mt-3 text-xl font-semibold text-gray-950 dark:text-gray-50">
							{card.value}
						</div>
						<div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
							{card.detail}
						</div>
					</div>
				))}
			</section>

			{!loading && stats && stats.recentActivity.length > 0 && (
				<section className="border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
					<div className="border-b border-gray-200 px-4 py-3 dark:border-gray-800">
						<h2 className="text-base font-semibold text-gray-950 dark:text-gray-50">
							Recent Activity
						</h2>
					</div>
					<div className="divide-y divide-gray-200 dark:divide-gray-800">
						{stats.recentActivity.map((event, idx) => (
							<div
								key={`${event.id}-${idx}`}
								className="flex items-start justify-between gap-4 px-4 py-3"
							>
								<div className="min-w-0">
									<div className="text-sm font-medium text-gray-950 dark:text-gray-50">
										{event.summary ?? event.event_type}
									</div>
									<div className="text-xs text-gray-500 dark:text-gray-400">
										{event.actor ?? "system"} · {event.event_type}
									</div>
								</div>
								<div className="flex-shrink-0 text-xs text-gray-400">
									{timeAgo(event.created_at)}
								</div>
							</div>
						))}
					</div>
				</section>
			)}

			<section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{[
					["Fleet", "/fleet"],
					["Efficiency", "/efficiency"],
					["Identity", "/identity"],
					["Platform", "/platform"],
				].map(([label, href]) => (
					<a
						key={href}
						href={href}
						className="inline-flex items-center justify-center rounded-md border border-gray-200 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
					>
						{label}
					</a>
				))}
			</section>
		</div>
	);
};

export default PortfolioHome;
