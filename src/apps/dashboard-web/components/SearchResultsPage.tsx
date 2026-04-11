import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { SearchResult } from "../../../shared/types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

const resultTypeColor = (type: string) => {
	switch (type) {
		case "proposal":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
		case "document":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "decision":
			return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-400";
	}
};

const getSearchResultTitle = (result: SearchResult): string => {
	switch (result.type) {
		case "proposal":
			return `${result.proposal.id} — ${result.proposal.title}`;
		case "document":
			return (
				result.document.title || result.document.name || "Untitled Document"
			);
		case "decision":
			return result.decision.title;
		default:
			return "Unknown";
	}
};

const getSearchResultPreview = (result: SearchResult): string => {
	switch (result.type) {
		case "proposal":
			return result.proposal.description || "";
		case "document":
			return (result.document.rawContent || "").slice(0, 200);
		case "decision":
			return result.decision.context?.slice(0, 200) || "";
		default:
			return "";
	}
};

const SearchResultsPage: React.FC = () => {
	const [results, setResults] = useState<SearchResult[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [typeFilter, setTypeFilter] = useState<string>("");

	const fetchData = useCallback(async () => {
		if (!query.trim()) {
			setResults([]);
			return;
		}
		setLoading(true);
		try {
			setError(null);
			const types = typeFilter
				? [typeFilter as "proposal" | "document" | "decision"]
				: undefined;
			const data = await apiClient.search({ query, types, limit: 50 });
			setResults(data);
		} catch (err) {
			console.error("Failed to search:", err);
			setError("Search failed");
		} finally {
			setLoading(false);
		}
	}, [query, typeFilter]);

	useEffect(() => {
		const timer = setTimeout(fetchData, 300);
		return () => clearTimeout(timer);
	}, [fetchData]);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Search
				</h1>
			</div>

			<div className="flex items-center gap-3">
				<input
					type="text"
					placeholder="Search proposals, documents, decisions..."
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					className="flex-1 rounded border px-3 py-2 text-sm bg-white dark:bg-gray-800"
				/>
				<select
					value={typeFilter}
					onChange={(e) => setTypeFilter(e.target.value)}
					className="rounded border px-2 py-2 text-sm bg-white dark:bg-gray-800"
				>
					<option value="">All types</option>
					<option value="proposal">Proposals</option>
					<option value="document">Documents</option>
					<option value="decision">Decisions</option>
				</select>
			</div>

			{loading && (
				<div className="flex justify-center py-8">
					<LoadingSpinner size="md" text="" />
				</div>
			)}

			{error && (
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
					<p className="text-red-600 dark:text-red-400">{error}</p>
				</div>
			)}

			{!loading && query && results.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					No results found for "{query}"
				</div>
			)}

			{results.length > 0 && (
				<div className="space-y-3">
					<p className="text-sm text-gray-500 dark:text-gray-400">
						{results.length} result{results.length !== 1 ? "s" : ""} found
					</p>
					{results.map((result) => (
						<div
							key={`${result.type}-${getSearchResultTitle(result)}`}
							className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-2"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="space-y-1 flex-1">
									<h3 className="font-medium text-gray-900 dark:text-gray-100">
										{getSearchResultTitle(result)}
									</h3>
									{getSearchResultPreview(result) && (
										<p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
											{getSearchResultPreview(result)}
										</p>
									)}
								</div>
								<div className="flex items-center gap-2 flex-shrink-0">
									<span
										className={`px-2 py-0.5 rounded text-xs font-medium ${resultTypeColor(result.type)}`}
									>
										{result.type}
									</span>
									{result.score !== null && (
										<span className="text-xs text-gray-500 dark:text-gray-400">
											{Math.round(result.score * 100)}%
										</span>
									)}
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
};

export default SearchResultsPage;
