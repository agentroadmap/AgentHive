import type React from "react";
import { useCallback, useEffect, useState } from "react";

interface AgencyRow {
	agency_id: string;
	display_name: string | null;
	host_id: string | null;
	status: string;
	last_heartbeat_at: string | null;
}

interface RouteRow {
	route_id: number;
	model_name: string;
	route_provider: string;
	is_enabled: boolean;
	health_status: string | null;
}

interface ProjectRuntime {
	project_id: number;
	slug: string;
	name: string;
	active_agent_runs: number;
	live_cubics: number;
}

interface FleetError {
	project_id: number;
	slug: string;
	name: string;
	error: string;
}

interface FleetData {
	agencies: AgencyRow[];
	routes: RouteRow[];
	projects: ProjectRuntime[];
	errors: FleetError[];
	partial: boolean;
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

function statusDot(status: string): string {
	if (status === "active" || status === "healthy") return "bg-emerald-500";
	if (status === "paused" || status === "dormant") return "bg-amber-500";
	return "bg-gray-400";
}

const FleetView: React.FC = () => {
	const [data, setData] = useState<FleetData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			const res = await fetch("/api/control-plane/fleet");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setData(await res.json());
			setError(null);
		} catch (err) {
			setError((err as Error).message);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchData();
		const t = setInterval(() => void fetchData(), 15000);
		return () => clearInterval(t);
	}, [fetchData]);

	if (loading) {
		return (
			<div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400">
				Loading fleet data…
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
				Failed to load fleet: {error}
			</div>
		);
	}

	return (
		<div className="space-y-6 px-4 py-6 md:px-6">
			<div className="border-b border-gray-200 pb-4 dark:border-gray-800">
				<h1 className="text-2xl font-semibold text-gray-950 dark:text-gray-50">
					Fleet
				</h1>
				<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
					Cross-project agency registry and per-project runtime counts.
				</p>
				{data?.partial && (
					<div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
						Partial result — some tenants unavailable ({data.errors.length} errors)
					</div>
				)}
			</div>

			<section>
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
					Agencies ({data?.agencies.length ?? 0})
				</h2>
				<div className="divide-y divide-gray-200 border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
					{data?.agencies.length === 0 && (
						<div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
							No agencies registered.
						</div>
					)}
					{data?.agencies.map((agency) => (
						<div
							key={agency.agency_id}
							className="flex items-start justify-between gap-4 px-4 py-3"
						>
							<div className="flex items-center gap-2 min-w-0">
								<span
									className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDot(agency.status)}`}
								/>
								<div className="min-w-0">
									<div className="text-sm font-medium text-gray-950 dark:text-gray-50">
										{agency.display_name ?? agency.agency_id}
									</div>
									<div className="text-xs text-gray-500 dark:text-gray-400">
										{agency.agency_id} · host: {agency.host_id ?? "—"}
									</div>
								</div>
							</div>
							<div className="flex-shrink-0 text-right text-xs text-gray-500 dark:text-gray-400">
								<div>{agency.status}</div>
								<div>{timeAgo(agency.last_heartbeat_at)}</div>
							</div>
						</div>
					))}
				</div>
			</section>

			<section>
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
					Per-Project Runtime
				</h2>
				<div className="divide-y divide-gray-200 border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
					{data?.projects.length === 0 && (
						<div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
							No projects.
						</div>
					)}
					{data?.projects.map((p) => (
						<div
							key={p.project_id}
							className="flex items-center justify-between gap-4 px-4 py-3"
						>
							<div>
								<div className="text-sm font-medium text-gray-950 dark:text-gray-50">
									{p.name}
								</div>
								<div className="text-xs text-gray-500 dark:text-gray-400">
									{p.slug}
								</div>
							</div>
							<div className="text-right text-xs text-gray-600 dark:text-gray-300">
								<div>{p.active_agent_runs} active runs</div>
								<div>{p.live_cubics} live cubics</div>
							</div>
						</div>
					))}
					{data?.errors.map((e) => (
						<div
							key={e.project_id}
							className="flex items-center justify-between gap-4 px-4 py-3 bg-red-50 dark:bg-red-950/20"
						>
							<div className="text-sm text-red-700 dark:text-red-400">
								{e.name} ({e.slug})
							</div>
							<div className="text-xs text-red-600 dark:text-red-400">
								{e.error}
							</div>
						</div>
					))}
				</div>
			</section>

			<section>
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
					Model Routes ({data?.routes.length ?? 0})
				</h2>
				<div className="divide-y divide-gray-200 border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
					{data?.routes.length === 0 && (
						<div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
							No routes.
						</div>
					)}
					{data?.routes.map((route) => (
						<div
							key={route.route_id}
							className="flex items-center justify-between gap-4 px-4 py-3"
						>
							<div>
								<div className="text-sm font-medium text-gray-950 dark:text-gray-50">
									{route.model_name}
								</div>
								<div className="text-xs text-gray-500 dark:text-gray-400">
									{route.route_provider}
								</div>
							</div>
							<div className="flex items-center gap-2 text-xs">
								<span
									className={`rounded-full px-2 py-0.5 font-medium ${route.is_enabled ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}
								>
									{route.is_enabled ? "enabled" : "disabled"}
								</span>
								{route.health_status && (
									<span className="text-gray-500 dark:text-gray-400">
										{route.health_status}
									</span>
								)}
							</div>
						</div>
					))}
				</div>
			</section>
		</div>
	);
};

export default FleetView;
