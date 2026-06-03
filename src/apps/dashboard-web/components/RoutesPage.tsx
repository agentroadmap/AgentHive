import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../lib/api";

interface Route {
	id: number;
	model_name: string;
	route_provider: string;
	agent_provider: string;
	agent_cli: string;
	fallback_cli: string;
	is_enabled: boolean;
	priority: number;
	api_spec: string;
	base_url: string;
	cost_per_million_input: number;
	cost_per_million_output: number;
	plan_type: string;
	notes: string;
	created_at: string;
	has_host_policy_match: boolean;
}

const RoutesPage: React.FC = () => {
	const [routes, setRoutes] = useState<Route[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filterProvider, setFilterProvider] = useState<string>("");
	const [showDisabled, setShowDisabled] = useState(false);
	const [showOrphanedOnly, setShowOrphanedOnly] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [togglingIds, setTogglingIds] = useState<Set<number>>(new Set());
	const [toggleErrors, setToggleErrors] = useState<Map<number, string>>(new Map());

	const fetchData = useCallback(async (isRefresh = false) => {
		try {
			setError(null);
			if (isRefresh) setRefreshing(true);
			const data = await apiClient.fetchRoutes();
			setRoutes(data as Route[]);
		} catch (err) {
			console.error("Failed to fetch routes:", err);
			setError("Failed to load routes");
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}, []);

	useEffect(() => {
		void fetchData();
	}, [fetchData]);

	const handleToggle = useCallback(async (route: Route) => {
		if (togglingIds.has(route.id)) return;

		const newEnabled = !route.is_enabled;

		// Optimistic update
		setRoutes((prev) =>
			prev.map((r) => (r.id === route.id ? { ...r, is_enabled: newEnabled } : r)),
		);
		setTogglingIds((prev) => new Set(prev).add(route.id));
		setToggleErrors((prev) => {
			const next = new Map(prev);
			next.delete(route.id);
			return next;
		});

		try {
			await apiClient.toggleRoute(route.id, newEnabled);
		} catch (err) {
			// Revert optimistic update
			setRoutes((prev) =>
				prev.map((r) => (r.id === route.id ? { ...r, is_enabled: route.is_enabled } : r)),
			);
			setToggleErrors((prev) => {
				const next = new Map(prev);
				next.set(route.id, "Toggle failed");
				return next;
			});
		} finally {
			setTogglingIds((prev) => {
				const next = new Set(prev);
				next.delete(route.id);
				return next;
			});
		}
	}, [togglingIds]);

	const providers = [...new Set(routes.map((r) => r.route_provider))].sort();

	const filtered = routes.filter((r) => {
		if (!showDisabled && !r.is_enabled) return false;
		if (filterProvider && r.route_provider !== filterProvider) return false;
		if (showOrphanedOnly && r.has_host_policy_match !== false) return false;
		return true;
	});

	const orphanCount = routes.filter((r) => r.has_host_policy_match === false).length;

	if (loading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-gray-500">Loading routes...</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-4 text-red-600 bg-red-50 rounded">{error}</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-6">
				<div className="flex items-center gap-3">
					<h1 className="text-2xl font-bold">Model Routes</h1>
					{orphanCount > 0 && (
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
							⚠ {orphanCount} no host policy
						</span>
					)}
				</div>
				<div className="flex items-center gap-4 flex-wrap">
					<div className="flex items-center gap-2">
						<label htmlFor="provider-filter" className="text-sm text-gray-600 dark:text-gray-400">
							Provider:
						</label>
						<select
							id="provider-filter"
							value={filterProvider}
							onChange={(e) => setFilterProvider(e.target.value)}
							className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-2 py-1 text-sm"
						>
							<option value="">All</option>
							{providers.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					</div>
					<label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
						<input
							type="checkbox"
							checked={showDisabled}
							onChange={(e) => setShowDisabled(e.target.checked)}
						/>
						Show disabled
					</label>
					{orphanCount > 0 && (
						<label className="flex items-center gap-2 text-sm text-yellow-700 dark:text-yellow-400">
							<input
								type="checkbox"
								checked={showOrphanedOnly}
								onChange={(e) => setShowOrphanedOnly(e.target.checked)}
							/>
							Orphaned only
						</label>
					)}
					<span className="text-sm text-gray-500 dark:text-gray-400">
						{filtered.length} routes
					</span>
					<button
						type="button"
						onClick={() => void fetchData(true)}
						disabled={refreshing}
						className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-600 dark:text-gray-400 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
						title="Refresh routes"
					>
						<svg
							className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`}
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
							/>
						</svg>
						Refresh
					</button>
				</div>
			</div>

			<div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
				<table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
					<thead className="bg-gray-50 dark:bg-gray-800">
						<tr>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Status
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Model
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Provider
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Agent
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								CLI
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Spec
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Cost $/M
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Priority
							</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
								Plan
							</th>
						</tr>
					</thead>
					<tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
						{filtered.map((route) => {
							const isOrphan = route.has_host_policy_match === false;
							const isToggling = togglingIds.has(route.id);
							const toggleError = toggleErrors.get(route.id);
							return (
								<tr
									key={route.id}
									className={
										isOrphan
											? "bg-yellow-50 dark:bg-yellow-900/10 hover:bg-yellow-100 dark:hover:bg-yellow-900/20"
											: "hover:bg-gray-50 dark:hover:bg-gray-800"
									}
								>
									<td className="px-4 py-3">
										<div className="flex flex-col gap-1">
											<button
												type="button"
												onClick={() => void handleToggle(route)}
												disabled={isToggling}
												className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer disabled:opacity-60 ${
													route.is_enabled
														? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200"
														: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400 hover:bg-red-200"
												}`}
											>
												{isToggling ? (
													<span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
												) : null}
												{route.is_enabled ? "ON" : "OFF"}
											</button>
											{toggleError && (
												<span className="text-xs text-red-600">{toggleError}</span>
											)}
										</div>
									</td>
									<td className="px-4 py-3 font-mono text-sm">
										{isOrphan && (
											<span className="mr-1 text-yellow-600" title="No host policy match">
												⚠
											</span>
										)}
										{route.model_name}
									</td>
									<td className="px-4 py-3 text-sm">
										{route.route_provider}
									</td>
									<td className="px-4 py-3 text-sm">
										{route.agent_provider}
									</td>
									<td className="px-4 py-3 font-mono text-sm text-gray-500">
										{route.agent_cli}
									</td>
									<td className="px-4 py-3 text-sm text-gray-500">
										{route.api_spec}
									</td>
									<td className="px-4 py-3 text-sm tabular-nums">
										{route.cost_per_million_input > 0 || route.cost_per_million_output > 0
											? `$${route.cost_per_million_input}/$${route.cost_per_million_output}`
											: "free"}
									</td>
									<td className="px-4 py-3 text-sm tabular-nums">
										{route.priority}
									</td>
									<td className="px-4 py-3 text-sm text-gray-500">
										{route.plan_type || "—"}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{filtered.length === 0 && (
				<div className="text-center py-8 text-gray-500">
					No routes match the current filters.
				</div>
			)}
		</div>
	);
};

export default RoutesPage;
