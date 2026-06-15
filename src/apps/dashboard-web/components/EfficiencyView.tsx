import type React from "react";
import { useCallback, useEffect, useState } from "react";

interface TenantEfficiency {
	project_id: number;
	slug: string;
	name: string;
	total_cost_usd: number | null;
	total_input_tokens: number | null;
	total_output_tokens: number | null;
	total_calls: number | null;
}

interface EfficiencyError {
	project_id: number;
	slug: string;
	name: string;
	error: string;
}

interface EfficiencyData {
	data: TenantEfficiency[];
	errors: EfficiencyError[];
	partial: boolean;
}

function fmt(n: number | null | undefined, decimals = 2): string {
	if (n == null) return "—";
	return n.toLocaleString(undefined, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
}

function fmtTokens(n: number | null | undefined): string {
	if (n == null) return "—";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

const EfficiencyView: React.FC = () => {
	const [data, setData] = useState<EfficiencyData | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			const res = await fetch("/api/control-plane/efficiency");
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
				Loading efficiency data…
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
				Failed to load efficiency data: {error}
			</div>
		);
	}

	const totalCost = data?.data.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0) ?? 0;
	const totalCalls = data?.data.reduce((s, r) => s + (r.total_calls ?? 0), 0) ?? 0;
	const totalTokens =
		(data?.data.reduce((s, r) => s + (r.total_input_tokens ?? 0), 0) ?? 0) +
		(data?.data.reduce((s, r) => s + (r.total_output_tokens ?? 0), 0) ?? 0);

	return (
		<div className="space-y-6 px-4 py-6 md:px-6">
			<div className="border-b border-gray-200 pb-4 dark:border-gray-800">
				<h1 className="text-2xl font-semibold text-gray-950 dark:text-gray-50">
					Efficiency
				</h1>
				<p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
					30-day cost and token usage across all projects.
				</p>
				{data?.partial && (
					<div className="mt-2 text-xs text-amber-700 dark:text-amber-400">
						Partial result — some tenants unavailable ({data.errors.length} errors)
					</div>
				)}
			</div>

			<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
				{[
					{ label: "Total Cost (30d)", value: `$${fmt(totalCost)}` },
					{ label: "Total Calls", value: totalCalls.toLocaleString() },
					{ label: "Total Tokens", value: fmtTokens(totalTokens) },
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
					Per-Project Breakdown
				</h2>
				<div className="overflow-x-auto border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500 dark:border-gray-800 dark:text-gray-400">
								<th className="px-4 py-3 font-medium">Project</th>
								<th className="px-4 py-3 font-medium text-right">Cost (USD)</th>
								<th className="px-4 py-3 font-medium text-right">Calls</th>
								<th className="px-4 py-3 font-medium text-right">In tokens</th>
								<th className="px-4 py-3 font-medium text-right">Out tokens</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-800">
							{data?.data.length === 0 && (
								<tr>
									<td
										colSpan={5}
										className="px-4 py-4 text-center text-gray-500 dark:text-gray-400"
									>
										No data available.
									</td>
								</tr>
							)}
							{data?.data.map((row) => (
								<tr
									key={row.project_id}
									className="hover:bg-gray-50 dark:hover:bg-gray-800/50"
								>
									<td className="px-4 py-3">
										<div className="font-medium text-gray-950 dark:text-gray-50">
											{row.name}
										</div>
										<div className="text-xs text-gray-500 dark:text-gray-400">
											{row.slug}
										</div>
									</td>
									<td className="px-4 py-3 text-right font-mono text-gray-950 dark:text-gray-50">
										{row.total_cost_usd != null ? `$${fmt(row.total_cost_usd)}` : "N/A"}
									</td>
									<td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
										{row.total_calls?.toLocaleString() ?? "—"}
									</td>
									<td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
										{fmtTokens(row.total_input_tokens)}
									</td>
									<td className="px-4 py-3 text-right text-gray-700 dark:text-gray-300">
										{fmtTokens(row.total_output_tokens)}
									</td>
								</tr>
							))}
							{data?.errors.map((e) => (
								<tr key={e.project_id} className="bg-red-50 dark:bg-red-950/20">
									<td className="px-4 py-3">
										<div className="text-red-700 dark:text-red-400">{e.name}</div>
										<div className="text-xs text-red-500 dark:text-red-400">{e.slug}</div>
									</td>
									<td colSpan={4} className="px-4 py-3 text-xs text-red-600 dark:text-red-400">
										{e.error}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	);
};

export default EfficiencyView;
