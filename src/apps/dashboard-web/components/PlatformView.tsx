import type React from "react";
import { useCallback, useEffect, useState } from "react";

interface RouteRow {
	route_id: number;
	model_name: string;
	route_provider: string;
	is_enabled: boolean;
	health_status: string | null;
}

interface TenantPlatform {
	project_id: number;
	slug: string;
	name: string;
	schema_version: number | null;
}

interface PlatformError {
	project_id: number;
	slug: string;
	name: string;
	error: string;
}

interface PlatformData {
	routes: RouteRow[];
	data: TenantPlatform[];
	errors: PlatformError[];
	partial: boolean;
}

const PlatformView: React.FC = () => {
	const [data, setData] = useState<PlatformData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			const res = await fetch("/api/control-plane/platform");
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
		const t = setInterval(() => void fetchData(), 30000);
		return () => clearInterval(t);
	}, [fetchData]);

	if (loading) {
		return (
			<div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400">
				Loading platform data…
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
				Failed to load platform data: {error}
			</div>
		);
	}

	const enabledRoutes = data?.routes.filter((r) => r.is_enabled).length ?? 0;
	const totalRoutes = data?.routes.length ?? 0;

	return (
		<div className="space-y-6 px-4 py-6 md:px-6">
			<div className="border-b border-gray-200 pb-4 dark:border-gray-800">
				<h1 className="text-2xl font-semibold text-gray-950 dark:text-gray-50">
					Platform
				</h1>
				<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
					Model routes and per-project schema migration versions.
				</p>
				{data?.partial && (
					<div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
						Partial result — some tenants unavailable ({data.errors.length} errors)
					</div>
				)}
			</div>

			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{[
					{
						label: "Active Routes",
						value: `${enabledRoutes} / ${totalRoutes}`,
					},
					{
						label: "Projects Reporting",
						value: `${data?.data.filter((p) => p.schema_version != null).length ?? 0} / ${data?.data.length ?? 0}`,
					},
				].map((s) => (
					<div
						key={s.label}
						className="border border-gray-200 bg-white px-5 py-4 dark:border-gray-800 dark:bg-gray-900"
					>
						<div className="text-[11px] font-medium uppercase tracking-widest text-gray-500 dark:text-gray-400">
							{s.label}
						</div>
						<div className="mt-2 text-2xl font-semibold text-gray-950 dark:text-gray-50">
							{s.value}
						</div>
					</div>
				))}
			</div>

			<section>
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
					Model Routes ({totalRoutes})
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
									className={`rounded-full px-2 py-0.5 font-medium ${
										route.is_enabled
											? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
											: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
									}`}
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

			<section>
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
					Schema Versions
				</h2>
				<div className="divide-y divide-gray-200 border border-gray-200 bg-white dark:divide-gray-800 dark:border-gray-800 dark:bg-gray-900">
					{data?.data.length === 0 && (
						<div className="px-4 py-4 text-sm text-gray-500 dark:text-gray-400">
							No projects.
						</div>
					)}
					{data?.data.map((p) => (
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
							<div className="text-right text-sm font-mono text-gray-700 dark:text-gray-300">
								{p.schema_version != null ? `v${p.schema_version}` : "N/A"}
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
		</div>
	);
};

export default PlatformView;
