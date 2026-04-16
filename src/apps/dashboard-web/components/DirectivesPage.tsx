import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Directive, Proposal } from "../../../shared/types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

interface DirectivesPageProps {
	proposals?: Proposal[];
	statuses?: string[];
	directiveEntities?: Directive[];
	archivedDirectives?: Directive[];
	onEditProposal?: (proposal: Proposal) => void;
	onRefreshData?: () => Promise<void>;
}

const _statusColor = (status: string) => {
	switch (status?.toLowerCase()) {
		case "complete":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "develop":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
		case "review":
			return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
		case "draft":
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
		case "merge":
			return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
	}
};

const DirectivesPage: React.FC<DirectivesPageProps> = ({
	proposals = [],
	directiveEntities,
}) => {
	const [directives, setDirectives] = useState<Directive[]>(directiveEntities ?? []);
	const [loading, setLoading] = useState(!directiveEntities);
	const [error, setError] = useState<string | null>(null);
	const [_showArchived, _setShowArchived] = useState(false);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchDirectives();
			setDirectives(data);
		} catch (err) {
			console.error("Failed to fetch directives:", err);
			setError("Failed to load directives");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (directiveEntities) {
			setDirectives(directiveEntities);
			setLoading(false);
			return;
		}
		fetchData();
	}, [directiveEntities, fetchData]);

	const directiveStats = useMemo(() => {
		const stats = new Map<
			string,
			{ total: number; completed: number; active: number }
		>();
		for (const proposal of proposals) {
			const dir = proposal.directive || "No Directive";
			const s = stats.get(dir) || { total: 0, completed: 0, active: 0 };
			s.total++;
			if (proposal.status === "Complete") s.completed++;
			if (proposal.status === "Develop") s.active++;
			stats.set(dir, s);
		}
		return stats;
	}, [proposals]);

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading directives...
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

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Directives ({directives.length})
				</h1>
			</div>

			<div className="space-y-4">
				{directives.map((directive) => {
					const stats = directiveStats.get(directive.id) || {
						total: 0,
						completed: 0,
						active: 0,
					};
					const progress =
						stats.total > 0
							? Math.round((stats.completed / stats.total) * 100)
							: 0;
					return (
						<div
							key={directive.id}
							className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4"
						>
							<div className="flex items-start justify-between">
								<div className="space-y-1">
									<h3 className="font-semibold text-gray-900 dark:text-gray-100">
										{directive.title}
									</h3>
									<span className="text-xs font-mono text-gray-500 dark:text-gray-400">
										{directive.id}
									</span>
								</div>
								<div className="text-right text-sm">
									<span className="text-gray-500 dark:text-gray-400">
										{stats.completed}/{stats.total} proposals
									</span>
								</div>
							</div>
							{directive.description && (
								<p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
									{directive.description}
								</p>
							)}
							<div className="mt-3">
								<div className="flex items-center gap-2">
									<div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
										<div
											className="bg-green-500 h-2 rounded-full transition-all"
											style={{ width: `${progress}%` }}
										/>
									</div>
									<span className="text-xs text-gray-500 dark:text-gray-400">
										{progress}%
									</span>
								</div>
							</div>
							{stats.active > 0 && (
								<div className="mt-2">
									<span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-xs">
										{stats.active} active
									</span>
								</div>
							)}
						</div>
					);
				})}
			</div>

			{directives.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					No directives found
				</div>
			)}
		</div>
	);
};

export default DirectivesPage;
