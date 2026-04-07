import type React from "react";
import { useEffect, useState } from "react";
import type { Proposal } from "../../../shared/types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

interface AchievementsViewProps {
	proposals?: Proposal[];
}

const AchievementsView: React.FC<AchievementsViewProps> = ({
	proposals: initialProposals,
}) => {
	const [proposals, setProposals] = useState<Proposal[]>(
		initialProposals || [],
	);
	const [loading, setLoading] = useState(!initialProposals);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (initialProposals) {
			setProposals(initialProposals.filter((s) => s.status === "Complete"));
			setLoading(false);
			return;
		}

		let isMounted = true;
		const fetchData = async () => {
			try {
				setLoading(true);
				const reachedProposals = await apiClient.fetchProposals({
					status: "Complete",
				});
				if (isMounted) {
					setProposals(reachedProposals);
				}
			} catch (err) {
				if (isMounted) {
					console.error("Failed to fetch reached proposals:", err);
					setError("Failed to load achievements");
				}
			} finally {
				if (isMounted) setLoading(false);
			}
		};

		fetchData();
		return () => {
			isMounted = false;
		};
	}, [initialProposals]);

	if (loading) return <LoadingSpinner text="Loading achievements..." />;
	if (error) return <div className="p-4 text-red-500">{error}</div>;

	return (
		<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
			<div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
				<h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
					Recent Achievements
				</h2>
			</div>
			<div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-[400px] overflow-y-auto">
				{proposals.length === 0 ? (
					<p className="p-4 text-sm text-gray-500 dark:text-gray-400">
						No achievements recorded yet.
					</p>
				) : (
					proposals
						.sort((a, b) => {
							const dateA = new Date(a.updatedDate || a.createdDate).getTime();
							const dateB = new Date(b.updatedDate || b.createdDate).getTime();
							return dateB - dateA;
						})
						.map((proposal) => (
							<div
								key={proposal.id}
								className="p-4 space-y-2 hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
							>
								<div className="flex items-start justify-between">
									<div className="flex items-center space-x-2">
										<span className="flex-shrink-0 w-2 h-2 rounded-full bg-green-500" />
										<h3 className="font-medium text-gray-900 dark:text-gray-100">
											{proposal.id} — {proposal.title}
										</h3>
									</div>
									<span className="text-xs text-gray-500 dark:text-gray-400">
										{new Date(
											proposal.updatedDate || proposal.createdDate,
										).toLocaleDateString()}
									</span>
								</div>

								{proposal.finalSummary && (
									<p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-2 italic">
										"{proposal.finalSummary}"
									</p>
								)}

								{proposal.proof && proposal.proof.length > 0 && (
									<div className="flex flex-wrap gap-2 mt-2">
										{proposal.proof.map((p) => (
											<span
												key={p}
												className="px-2 py-0.5 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400 text-xs rounded border border-green-100 dark:border-green-800/50"
											>
												{p.length > 30 ? `${p.substring(0, 27)}...` : p}
											</span>
										))}
									</div>
								)}

								{proposal.directive && (
									<div className="text-xs text-gray-400 dark:text-gray-500">
										Directive: {proposal.directive}
									</div>
								)}
							</div>
						))
				)}
			</div>
		</div>
	);
};

export default AchievementsView;
