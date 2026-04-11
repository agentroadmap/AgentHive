import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { Document } from "../../../shared/types";
import { apiClient } from "../lib/api";
import LoadingSpinner from "./LoadingSpinner";

const docTypeColor = (type: string) => {
	switch (type) {
		case "specification":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
		case "guide":
			return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400";
		case "readme":
			return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400";
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

const DocumentsPage: React.FC = () => {
	const [documents, setDocuments] = useState<Document[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [typeFilter, setTypeFilter] = useState<string>("");
	const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);

	const fetchData = useCallback(async () => {
		try {
			setError(null);
			const data = await apiClient.fetchDocs();
			setDocuments(data);
		} catch (err) {
			console.error("Failed to fetch documents:", err);
			setError("Failed to load documents");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchData();
	}, [fetchData]);

	const docTypes = [...new Set(documents.map((d) => d.type))].sort();

	const filteredDocs = documents.filter((doc) => {
		if (filter) {
			const query = filter.toLowerCase();
			const matchesTitle = doc.title?.toLowerCase().includes(query);
			const matchesName = doc.name?.toLowerCase().includes(query);
			const matchesPath = doc.path?.toLowerCase().includes(query);
			if (!matchesTitle && !matchesName && !matchesPath) return false;
		}
		if (typeFilter && doc.type !== typeFilter) return false;
		return true;
	});

	if (loading) {
		return (
			<div className="flex flex-col justify-center items-center h-64 space-y-4">
				<LoadingSpinner size="lg" text="" />
				<p className="text-lg font-medium text-gray-900 dark:text-gray-100">
					Loading documents...
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

	if (selectedDoc) {
		return (
			<div className="space-y-4">
				<div className="flex items-center gap-4">
					<button
						type="button"
						onClick={() => setSelectedDoc(null)}
						className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
					>
						← Back to documents
					</button>
				</div>
				<div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
					<h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
						{selectedDoc.title || selectedDoc.name}
					</h1>
					<div className="flex items-center gap-3 mt-2">
						<span
							className={`px-2 py-0.5 rounded text-xs font-medium ${docTypeColor(selectedDoc.type)}`}
						>
							{selectedDoc.type}
						</span>
						{selectedDoc.lastModified && (
							<span className="text-xs text-gray-500 dark:text-gray-400">
								Modified: {formatDate(selectedDoc.lastModified)}
							</span>
						)}
					</div>
					<div className="mt-4 prose dark:prose-invert max-w-none">
						<pre className="whitespace-pre-wrap text-sm bg-gray-50 dark:bg-gray-900 p-4 rounded-lg overflow-auto">
							{selectedDoc.rawContent}
						</pre>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Documents ({documents.length})
				</h1>
				<div className="flex items-center gap-3">
					<input
						type="text"
						placeholder="Search documents..."
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="rounded border px-3 py-1.5 text-sm bg-white dark:bg-gray-800 w-48"
					/>
					<select
						value={typeFilter}
						onChange={(e) => setTypeFilter(e.target.value)}
						className="rounded border px-2 py-1.5 text-sm bg-white dark:bg-gray-800"
					>
						<option value="">All types</option>
						{docTypes.map((t) => (
							<option key={t} value={t}>
								{t}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="space-y-3">
				{filteredDocs.map((doc) => (
					<button
						type="button"
						key={doc.id || doc.name}
						onClick={() => setSelectedDoc(doc)}
						className="w-full text-left bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
					>
						<div className="flex items-start justify-between">
							<div className="space-y-1">
								<h3 className="font-medium text-gray-900 dark:text-gray-100">
									{doc.title || doc.name}
								</h3>
								{doc.path && (
									<p className="text-xs font-mono text-gray-500 dark:text-gray-400">
										{doc.path}
									</p>
								)}
							</div>
							<div className="flex items-center gap-2">
								<span
									className={`px-2 py-0.5 rounded text-xs font-medium ${docTypeColor(doc.type)}`}
								>
									{doc.type}
								</span>
								{doc.lastModified && (
									<span className="text-xs text-gray-500 dark:text-gray-400">
										{formatDate(doc.lastModified)}
									</span>
								)}
							</div>
						</div>
					</button>
				))}
			</div>

			{filteredDocs.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					{filter || typeFilter
						? "No documents match your filters"
						: "No documents found"}
				</div>
			)}
		</div>
	);
};

export default DocumentsPage;
