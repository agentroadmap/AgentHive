import type React from "react";
import { useCallback, useEffect, useState } from "react";
import LoadingSpinner from "./LoadingSpinner";

interface Team {
	name: string;
	members: string[];
	description?: string;
	created_at?: string;
}

const TeamsPage: React.FC = () => {
	const [teams, setTeams] = useState<Team[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const response = await fetch("/api/teams");
			if (!response.ok) throw new Error("Failed to fetch teams");
			const data = await response.json();
			setTeams(data);
		} catch (err) {
			console.error("Failed to fetch teams:", err);
			setError("Failed to load teams");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading teams...
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
			<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
				Teams ({teams.length})
			</h1>

			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{teams.map((team) => (
					<div
						key={team.name}
						className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3"
					>
						<h3 className="font-semibold text-gray-900 dark:text-gray-100">
							{team.name}
						</h3>
						{team.description && (
							<p className="text-sm text-gray-600 dark:text-gray-400">
								{team.description}
							</p>
						)}
						<div className="space-y-1">
							<p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
								Members ({team.members.length})
							</p>
							<div className="flex flex-wrap gap-1">
								{team.members.map((member) => (
									<span
										key={member}
										className="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-xs"
									>
										{member}
									</span>
								))}
							</div>
						</div>
					</div>
				))}
			</div>

			{teams.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					No teams registered
				</div>
			)}
		</div>
	);
};

export default TeamsPage;
