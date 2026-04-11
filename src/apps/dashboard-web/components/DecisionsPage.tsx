import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { Decision } from "../../../shared/types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

const decisionStatusColor = (status: string) => {
	switch (status) {
		case "accepted":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "rejected":
			return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
		case "proposed":
			return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
		case "superseded":
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
	}
};

const formatDate = (dateStr?: string) => {
	if (!dateStr) return "";
	try {
		return new Date(dateStr).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		return dateStr;
	}
};

const DecisionsPage: React.FC = () => {
	const [decisions, setDecisions] = useState<Decision[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [statusFilter, setStatusFilter] = useState<string>("");
	const [selectedDecision, setSelectedDecision] = useState<Decision | null>(
		null,
	);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchDecisions();
			setDecisions(data);
		} catch (err) {
			console.error("Failed to fetch decisions:", err);
			setError("Failed to load decisions");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const filteredDecisions = decisions.filter((d) => {
		if (statusFilter && d.status !== statusFilter) return false;
		return true;
	});

	const statusCounts = decisions.reduce(
		(acc, d) => {
			acc[d.status] = (acc[d.status] || 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading decisions...
				</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="p-8 text-center">
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6">
					<p className="text-red-600 dark:text-red-400 font-medium">Error</p>
					<p className="text-red-500 dark:text-red-300 text-sm mt-1">{error}</p>
					<button
						type="button"
						onClick={fetchData}
						className="mt-4 px-4 py-2 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50"
					>
						Retry
					</button>
				</div>
			</div>
		);
	}

	if (selectedDecision) {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-4">
					<button
						type="button"
						onClick={() => setSelectedDecision(null)}
						className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
					>
						← Back to decisions
					</button>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 space-y-4">
					<div className="flex items-start justify-between">
						<h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
							{selectedDecision.title}
						</h1>
						<span
							className={`px-2 py-0.5 rounded text-xs font-medium ${decisionStatusColor(selectedDecision.status)}`}
						>
							{selectedDecision.status}
						</span>
					</div>
					<div className="text-xs text-gray-500 dark:text-gray-400">
						{formatDate(selectedDecision.date)}
					</div>
					<div className="space-y-4">
						<div>
							<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
								Context
							</h3>
							<p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
								{selectedDecision.context}
							</p>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
								Decision
							</h3>
							<p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
								{selectedDecision.decision}
							</p>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
								Consequences
							</h3>
							<p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
								{selectedDecision.consequences}
							</p>
						</div>
						{selectedDecision.alternatives && (
							<div>
								<h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wider">
									Alternatives Considered
								</h3>
								<p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
									{selectedDecision.alternatives}
								</p>
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Decisions ({decisions.length})
				</h1>
				<div className="flex items-center gap-2">
					<select
						value={statusFilter}
						onChange={(e) => setStatusFilter(e.target.value)}
						className="rounded border px-2 py-1.5 text-sm bg-white dark:bg-gray-800"
					>
						<option value="">All statuses</option>
						{Object.entries(statusCounts).map(([status, count]) => (
							<option key={status} value={status}>
								{status} ({count})
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="space-y-3">
				{filteredDecisions.map((decision) => (
					<button
						type="button"
						key={decision.id}
						onClick={() => setSelectedDecision(decision)}
						className="w-full text-left bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
					>
						<div className="flex items-start justify-between">
							<div className="space-y-1">
								<h3 className="font-medium text-gray-900 dark:text-gray-100">
									{decision.title}
								</h3>
								<p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
									{decision.context}
								</p>
							</div>
							<div className="flex items-center gap-2">
								<span
									className={`px-2 py-0.5 rounded text-xs font-medium ${decisionStatusColor(decision.status)}`}
								>
									{decision.status}
								</span>
								<span className="text-xs text-gray-500 dark:text-gray-400">
									{formatDate(decision.date)}
								</span>
							</div>
						</div>
					</button>
				))}
			</div>

			{filteredDecisions.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					{statusFilter
						? "No decisions match your filter"
						: "No decisions found"}
				</div>
			)}
		</div>
	);
};

export default DecisionsPage;
