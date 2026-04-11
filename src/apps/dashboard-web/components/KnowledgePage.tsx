import type React from "react";
import { useCallback, useEffect, useState } from "react";
import LoadingSpinner from "./LoadingSpinner";

interface KnowledgeEntry {
	id: string;
	type: string;
	keywords: string[];
	content: string;
	source?: string;
	helpful_count?: number;
	created_at?: string;
}

const entryTypeColor = (type: string) => {
	switch (type) {
		case "solution":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "pattern":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
		case "decision":
			return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400";
		case "obstacle":
			return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
		case "lesson":
			return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
	}
};

const KnowledgePage: React.FC = () => {
	const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [typeFilter, setTypeFilter] = useState<string>("");

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const params = new URLSearchParams();
			if (searchQuery) params.set("query", searchQuery);
			if (typeFilter) params.set("type", typeFilter);
			const url = `/api/knowledge${params.toString() ? `?${params.toString()}` : ""}`;
			const response = await fetch(url);
			if (!response.ok) throw new Error("Failed to fetch knowledge entries");
			const data = await response.json();
			setEntries(data);
		} catch (err) {
			console.error("Failed to fetch knowledge entries:", err);
			setError("Failed to load knowledge entries");
		} finally {
			setLoading(false);
		}
	}, [searchQuery, typeFilter]);

	useEffect(() => {
		const timer = setTimeout(fetchData, 300);
		return () => clearTimeout(timer);
	}, [fetchData]);

	const handleMarkHelpful = async (id: string) => {
		try {
			await fetch(`/api/knowledge/${id}/helpful`, { method: "POST" });
			setEntries((prev) =>
				prev.map((e) =>
					e.id === id ? { ...e, helpful_count: (e.helpful_count || 0) + 1 } : e,
				),
			);
		} catch (err) {
			console.error("Failed to mark as helpful:", err);
		}
	};

	if (loading && entries.length === 0) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading knowledge base...
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Knowledge Base ({entries.length})
				</h1>
				<div className="flex items-center gap-3">
					<input
						type="text"
						placeholder="Search knowledge..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="rounded border px-3 py-1.5 text-sm bg-white dark:bg-gray-800 w-48"
					/>
					<select
						value={typeFilter}
						onChange={(e) => setTypeFilter(e.target.value)}
						className="rounded border px-2 py-1.5 text-sm bg-white dark:bg-gray-800"
					>
						<option value="">All types</option>
						<option value="solution">Solutions</option>
						<option value="pattern">Patterns</option>
						<option value="decision">Decisions</option>
						<option value="obstacle">Obstacles</option>
						<option value="lesson">Lessons</option>
					</select>
				</div>
			</div>

			{error && (
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
					<p className="text-red-600 dark:text-red-400">{error}</p>
				</div>
			)}

			<div className="space-y-4">
				{entries.map((entry) => (
					<div
						key={entry.id}
						className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-3"
					>
						<div className="flex items-start justify-between">
							<span
								className={`px-2 py-0.5 rounded text-xs font-medium ${entryTypeColor(entry.type)}`}
							>
								{entry.type}
							</span>
							<div className="flex items-center gap-2">
								{entry.helpful_count !== undefined && (
									<span className="text-xs text-gray-500 dark:text-gray-400">
										👍 {entry.helpful_count}
									</span>
								)}
								<button
									type="button"
									onClick={() => handleMarkHelpful(entry.id)}
									className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
								>
									Helpful?
								</button>
							</div>
						</div>
						<p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
							{entry.content}
						</p>
						{entry.keywords.length > 0 && (
							<div className="flex flex-wrap gap-1">
								{entry.keywords.map((kw) => (
									<span
										key={kw}
										className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded text-xs"
									>
										{kw}
									</span>
								))}
							</div>
						)}
						{entry.source && (
							<p className="text-xs text-gray-500 dark:text-gray-400">
								Source: {entry.source}
							</p>
						)}
					</div>
				))}
			</div>

			{!loading && entries.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					{searchQuery || typeFilter
						? "No knowledge entries match your search"
						: "No knowledge entries yet"}
				</div>
			)}
		</div>
	);
};

export default KnowledgePage;
