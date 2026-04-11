import type React from "react";
import { useMemo } from "react";
import type { Proposal } from "../../../shared/types";

interface StatisticsPageProps {
	proposals?: Proposal[];
}

interface StatusStat {
	status: string;
	count: number;
	percentage: number;
	color: string;
}

interface TypeStat {
	type: string;
	count: number;
	percentage: number;
}

const statusColors: Record<string, string> = {
	Draft: "#9CA3AF",
	Review: "#F59E0B",
	Develop: "#3B82F6",
	Merge: "#8B5CF6",
	Complete: "#10B981",
};

const StatisticsPage: React.FC<StatisticsPageProps> = ({ proposals = [] }) => {
	const stats = useMemo(() => {
		const total = proposals.length;
		const statusMap = new Map<string, number>();
		const typeMap = new Map<string, number>();
		const directiveMap = new Map<string, number>();
		const maturityMap = new Map<string, number>();

		for (const p of proposals) {
			const status = p.status || "Unknown";
			statusMap.set(status, (statusMap.get(status) || 0) + 1);

			const type = p.proposalType || "Unknown";
			typeMap.set(type, (typeMap.get(type) || 0) + 1);

			const directive = p.directive || "None";
			directiveMap.set(directive, (directiveMap.get(directive) || 0) + 1);

			const maturity = p.maturity || "Unknown";
			maturityMap.set(maturity, (maturityMap.get(maturity) || 0) + 1);
		}

		const statusStats: StatusStat[] = Array.from(statusMap.entries())
			.map(([status, count]) => ({
				status,
				count,
				percentage: total > 0 ? Math.round((count / total) * 100) : 0,
				color: statusColors[status] || "#6B7280",
			}))
			.sort((a, b) => b.count - a.count);

		const typeStats: TypeStat[] = Array.from(typeMap.entries())
			.map(([type, count]) => ({
				type,
				count,
				percentage: total > 0 ? Math.round((count / total) * 100) : 0,
			}))
			.sort((a, b) => b.count - a.count);

		const directiveStats = Array.from(directiveMap.entries())
			.map(([directive, count]) => ({
				directive,
				count,
				percentage: total > 0 ? Math.round((count / total) * 100) : 0,
			}))
			.sort((a, b) => b.count - a.count);

		const maturityStats = Array.from(maturityMap.entries())
			.map(([maturity, count]) => ({
				maturity,
				count,
				percentage: total > 0 ? Math.round((count / total) * 100) : 0,
			}))
			.sort((a, b) => b.count - a.count);

		// Completion metrics
		const completedCount = statusMap.get("Complete") || 0;
		const activeCount = statusMap.get("Develop") || 0;
		const reviewCount = statusMap.get("Review") || 0;
		const draftCount = statusMap.get("Draft") || 0;

		return {
			total,
			statusStats,
			typeStats,
			directiveStats,
			maturityStats,
			completedCount,
			activeCount,
			reviewCount,
			draftCount,
			completionRate:
				total > 0 ? Math.round((completedCount / total) * 100) : 0,
		};
	}, [proposals]);

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
				Statistics
			</h1>

			{/* Overview Cards */}
			<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
					<p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
						Total Proposals
					</p>
					<p className="text-3xl font-bold text-gray-900 dark:text-gray-100 mt-1">
						{stats.total}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-green-200 dark:border-green-800/50 p-4 shadow-sm">
					<p className="text-xs font-semibold text-green-600 dark:text-green-400 uppercase tracking-wider">
						Completed
					</p>
					<p className="text-3xl font-bold text-green-700 dark:text-green-300 mt-1">
						{stats.completedCount}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-blue-200 dark:border-blue-800/50 p-4 shadow-sm">
					<p className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">
						In Development
					</p>
					<p className="text-3xl font-bold text-blue-700 dark:text-blue-300 mt-1">
						{stats.activeCount}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-yellow-200 dark:border-yellow-800/50 p-4 shadow-sm">
					<p className="text-xs font-semibold text-yellow-600 dark:text-yellow-400 uppercase tracking-wider">
						In Review
					</p>
					<p className="text-3xl font-bold text-yellow-700 dark:text-yellow-300 mt-1">
						{stats.reviewCount}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
					<p className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
						Drafts
					</p>
					<p className="text-3xl font-bold text-gray-900 dark:text-gray-100 mt-1">
						{stats.draftCount}
					</p>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-purple-200 dark:border-purple-800/50 p-4 shadow-sm">
					<p className="text-xs font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wider">
						Completion Rate
					</p>
					<p className="text-3xl font-bold text-purple-700 dark:text-purple-300 mt-1">
						{stats.completionRate}%
					</p>
				</div>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
				{/* Status Distribution */}
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
						Status Distribution
					</h2>
					<div className="space-y-3">
						{stats.statusStats.map((stat) => (
							<div key={stat.status} className="flex items-center gap-3">
								<span className="w-20 text-sm text-gray-700 dark:text-gray-300">
									{stat.status}
								</span>
								<div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-4">
									<div
										className="h-4 rounded-full transition-all"
										style={{
											width: `${stat.percentage}%`,
											backgroundColor: stat.color,
										}}
									/>
								</div>
								<span className="w-16 text-right text-sm text-gray-600 dark:text-gray-400">
									{stat.count} ({stat.percentage}%)
								</span>
							</div>
						))}
					</div>
				</div>

				{/* Type Distribution */}
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
						Proposal Types
					</h2>
					<div className="space-y-3">
						{stats.typeStats.map((stat) => (
							<div
								key={stat.type}
								className="flex items-center justify-between"
							>
								<span className="text-sm text-gray-700 dark:text-gray-300">
									{stat.type}
								</span>
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-gray-900 dark:text-gray-100">
										{stat.count}
									</span>
									<span className="text-xs text-gray-500 dark:text-gray-400">
										({stat.percentage}%)
									</span>
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Maturity Distribution */}
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
						Maturity Levels
					</h2>
					<div className="space-y-3">
						{stats.maturityStats.map((stat) => (
							<div
								key={stat.maturity}
								className="flex items-center justify-between"
							>
								<span className="text-sm text-gray-700 dark:text-gray-300">
									{stat.maturity}
								</span>
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-gray-900 dark:text-gray-100">
										{stat.count}
									</span>
									<span className="text-xs text-gray-500 dark:text-gray-400">
										({stat.percentage}%)
									</span>
								</div>
							</div>
						))}
					</div>
				</div>

				{/* Directive Distribution */}
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
					<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
						Directives
					</h2>
					<div className="space-y-3">
						{stats.directiveStats.slice(0, 10).map((stat) => (
							<div
								key={stat.directive}
								className="flex items-center justify-between"
							>
								<span className="text-sm text-gray-700 dark:text-gray-300 truncate max-w-[200px]">
									{stat.directive}
								</span>
								<div className="flex items-center gap-2">
									<span className="text-sm font-medium text-gray-900 dark:text-gray-100">
										{stat.count}
									</span>
									<span className="text-xs text-gray-500 dark:text-gray-400">
										({stat.percentage}%)
									</span>
								</div>
							</div>
						))}
					</div>
				</div>
			</div>

			{stats.total === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					No proposals to analyze
				</div>
			)}
		</div>
	);
};

export default StatisticsPage;
