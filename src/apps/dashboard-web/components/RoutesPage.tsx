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
}

const RoutesPage: React.FC = () => {
	const [routes, setRoutes] = useState<Route[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filterProvider, setFilterProvider] = useState<string>("");
	const [showDisabled, setShowDisabled] = useState(false);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchRoutes();
			setRoutes(data as Route[]);
		} catch (err) {
			console.error("Failed to fetch routes:", err);
			setError("Failed to load routes");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchData();
	}, [fetchData]);

	const providers = [...new Set(routes.map((r) => r.route_provider))].sort();

	const filtered = routes.filter((r) => {
		if (!showDisabled && !r.is_enabled) return false;
		if (filterProvider && r.route_provider !== filterProvider) return false;
		return true;
	});

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
				<h1 className="text-2xl font-bold">Model Routes</h1>
				<div className="flex items-center gap-4">
					<div className="flex items-center gap-2">
						<label htmlFor="provider-filter" className="text-sm text-gray-600">
							Provider:
						</label>
						<select
							id="provider-filter"
							value={filterProvider}
							onChange={(e) => setFilterProvider(e.target.value)}
							className="rounded border px-2 py-1 text-sm"
						>
							<option value="">All</option>
							{providers.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					</div>
					<label className="flex items-center gap-2 text-sm text-gray-600">
						<input
							type="checkbox"
							checked={showDisabled}
							onChange={(e) => setShowDisabled(e.target.checked)}
						/>
						Show disabled
					</label>
					<span className="text-sm text-gray-500">
						{filtered.length} routes
					</span>
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
						</tr>
					</thead>
					<tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
						{filtered.map((route) => (
							<tr key={route.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
								<td className="px-4 py-3">
									<span
										className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
											route.is_enabled
												? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
												: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
										}`}
									>
										{route.is_enabled ? "ON" : "OFF"}
									</span>
								</td>
								<td className="px-4 py-3 font-mono text-sm">
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
							</tr>
						))}
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
