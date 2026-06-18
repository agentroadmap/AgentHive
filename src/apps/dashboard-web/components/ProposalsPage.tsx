import type React from "react";
import { useEffect, useMemo, useState } from "react";
import type { Proposal } from "../../../shared/types";
import {
	formatStoredUtcDateForCompactDisplay,
	parseStoredUtcDate,
} from "../utils/date-display";
import parseTags from "../utils/parseTags";

interface ProposalsPageProps {
	proposals?: Proposal[];
	onProposalClick?: (proposal: Proposal) => void;
}

type SortColumn =
	| "id"
	| "title"
	| "status"
	| "priority"
	| "maturity"
	| "created";
type SortDirection = "asc" | "desc";

const statusColor = (status: string) => {
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

const priorityColor = (priority?: string) => {
	switch (priority) {
		case "high":
			return "text-red-600 dark:text-red-400";
		case "medium":
			return "text-yellow-600 dark:text-yellow-400";
		case "low":
			return "text-green-600 dark:text-green-400";
		default:
			return "text-gray-500 dark:text-gray-400";
	}
};

const PRIORITY_ORDER: Record<string, number> = {
	high: 3,
	medium: 2,
	low: 1,
};

const STATUS_ORDER = ["DRAFT", "REVIEW", "DEVELOP", "MERGE", "COMPLETE"];
// P706: HIDDEN_STATUSES removed. Use maturity=obsolete filter instead of status-based hiding.

const ProposalsPage: React.FC<ProposalsPageProps> = ({
	proposals: propProposals,
	onProposalClick,
}) => {
	const [proposals, setProposals] = useState<Proposal[]>(propProposals || []);
	const [filter, setFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState("");
	const [priorityFilter, setPriorityFilter] = useState("");
	const [typeFilter, setTypeFilter] = useState("");
	const [schemaDriftFilter, setSchemaDriftFilter] = useState(false);
	const [pausedFilter, setPausedFilter] = useState(false);
	const [sortColumn, setSortColumn] = useState<SortColumn>("id");
	const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
	const [currentPage, setCurrentPage] = useState(1);
	const ITEMS_PER_PAGE = 25;

	useEffect(() => {
		if (propProposals) {
			setProposals(propProposals);
		}
	}, [propProposals]);

	const statuses = useMemo(() => {
		// P706: Filter out obsolete proposals by maturity, not by status
		const visibleProposals = proposals.filter(
			(p) => (p.maturity ?? "").toLowerCase() !== "obsolete",
		);
		const seen = [...new Set(visibleProposals.map((p) => p.status))]
			.filter(Boolean);
		return seen.sort((a, b) => {
			const ai = STATUS_ORDER.indexOf(a);
			const bi = STATUS_ORDER.indexOf(b);
			if (ai === -1 && bi === -1) return a.localeCompare(b);
			if (ai === -1) return 1;
			if (bi === -1) return -1;
			return ai - bi;
		});
	}, [proposals]);

	const types = useMemo(
		() =>
			[
				...new Set(proposals.map((p) => p.proposalType).filter(Boolean)),
			] as string[],
		[proposals],
	).sort();

	const filteredProposals = useMemo(() => {
		let result = proposals;

		if (filter) {
			const query = filter.toLowerCase();
			result = result.filter(
				(p) =>
					p.id.toLowerCase().includes(query) ||
					p.title.toLowerCase().includes(query) ||
					(p.description || "").toLowerCase().includes(query),
			);
		}

		if (statusFilter) {
			result = result.filter((p) => p.status === statusFilter);
		}

		if (priorityFilter) {
			result = result.filter((p) => p.priority === priorityFilter);
		}

		if (typeFilter) {
			result = result.filter((p) => p.proposalType === typeFilter);
		}

		if (schemaDriftFilter) {
			result = result.filter((p) => parseTags(p.tags)?.schema_drift === true);
		}

		if (pausedFilter) {
			result = result.filter((p) => p.gatePausedBy === "circuit_breaker");
		}

		return [...result].sort((a, b) => {
			let comparison = 0;
			switch (sortColumn) {
				case "id":
					comparison = a.id.localeCompare(b.id, undefined, {
						numeric: true,
						sensitivity: "base",
					});
					break;
				case "title":
					comparison = a.title.localeCompare(b.title);
					break;
				case "status":
					comparison = a.status.localeCompare(b.status);
					break;
				case "priority":
					comparison =
						(PRIORITY_ORDER[b.priority || ""] || 0) -
						(PRIORITY_ORDER[a.priority || ""] || 0);
					break;
				case "maturity":
					comparison = (a.maturity || "").localeCompare(b.maturity || "");
					break;
				case "created":
					comparison =
						new Date(a.createdDate).getTime() -
						new Date(b.createdDate).getTime();
					break;
			}
			return sortDirection === "asc" ? comparison : -comparison;
		});
	}, [
		proposals,
		filter,
		statusFilter,
		priorityFilter,
		typeFilter,
		schemaDriftFilter,
		pausedFilter,
		sortColumn,
		sortDirection,
	]);

	const handleSort = (column: SortColumn) => {
		if (sortColumn === column) {
			setSortDirection(sortDirection === "asc" ? "desc" : "asc");
		} else {
			setSortColumn(column);
			setSortDirection("asc");
		}
		setCurrentPage(1);
	};

	const totalPages = Math.ceil(filteredProposals.length / ITEMS_PER_PAGE);
	const paginatedProposals = useMemo(() => {
		const start = (currentPage - 1) * ITEMS_PER_PAGE;
		return filteredProposals.slice(start, start + ITEMS_PER_PAGE);
	}, [filteredProposals, currentPage]);

	const SortIcon = ({ column }: { column: SortColumn }) => {
		if (sortColumn !== column)
			return <span className="text-gray-300 dark:text-gray-600">↕</span>;
		return <span>{sortDirection === "asc" ? "↑" : "↓"}</span>;
	};

	// Count circuit-breaker paused proposals
	const pausedCount = proposals.filter(
		(p) => p.gatePausedBy === "circuit_breaker",
	).length;

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
					Proposals ({filteredProposals.length})
				</h1>
			</div>

			{/* Circuit-breaker banner */}
			{pausedCount > 0 && (
				<div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
					<button
						type="button"
						onClick={() => setPausedFilter(!pausedFilter)}
						className="text-red-800 dark:text-red-200 font-medium text-sm hover:underline"
					>
						{pausedCount} proposal{pausedCount !== 1 ? "s" : ""} paused by circuit
						breaker
					</button>
				</div>
			)}

			{/* Filters */}
			<div className="flex flex-wrap items-center gap-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
				<input
					type="text"
					placeholder="Search proposals..."
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					className="rounded border px-3 py-1.5 text-sm bg-white dark:bg-gray-700 w-48"
				/>
				<select
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.target.value)}
					className="rounded border px-2 py-1.5 text-sm bg-white dark:bg-gray-700"
				>
					<option value="">All statuses</option>
					{statuses.map((s) => (
						<option key={s} value={s}>
							{s}
						</option>
					))}
				</select>
				<select
					value={priorityFilter}
					onChange={(e) => setPriorityFilter(e.target.value)}
					className="rounded border px-2 py-1.5 text-sm bg-white dark:bg-gray-700"
				>
					<option value="">All priorities</option>
					<option value="high">High</option>
					<option value="medium">Medium</option>
					<option value="low">Low</option>
				</select>
				{types.length > 0 && (
					<select
						value={typeFilter}
						onChange={(e) => setTypeFilter(e.target.value)}
						className="rounded border px-2 py-1.5 text-sm bg-white dark:bg-gray-700"
					>
						<option value="">All types</option>
						{types.map((t) => (
							<option key={t} value={t}>
								{t}
							</option>
						))}
					</select>
				)}
				<button
					type="button"
					onClick={() => setSchemaDriftFilter(!schemaDriftFilter)}
					className={`px-3 py-1.5 text-sm rounded border font-medium transition-colors ${
						schemaDriftFilter
							? "bg-amber-50 dark:bg-amber-900/20 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200"
							: "bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600"
					}`}
				>
					⚠ Schema drift
				</button>
				{(filter ||
					statusFilter ||
					priorityFilter ||
					typeFilter ||
					schemaDriftFilter ||
					pausedFilter) && (
					<button
						type="button"
						onClick={() => {
							setFilter("");
							setStatusFilter("");
							setPriorityFilter("");
							setTypeFilter("");
							setSchemaDriftFilter(false);
							setPausedFilter(false);
						}}
						className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
					>
						Clear filters
					</button>
				)}
			</div>

			{/* Mobile card list */}
			<div className="md:hidden space-y-2">
				{paginatedProposals.map((proposal) => (
					<button
						type="button"
						key={proposal.id}
						onClick={() => onProposalClick?.(proposal)}
						className="w-full text-left bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-3 hover:border-blue-400 hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
					>
						<div className="flex items-baseline justify-between gap-2">
							<span className="font-mono text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
								{proposal.id}
							</span>
							<span
								className={`flex-shrink-0 px-2 py-0.5 rounded text-xs font-medium ${statusColor(proposal.status)}`}
							>
								{proposal.status}
							</span>
						</div>
						<div className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2">
							{proposal.title}
						</div>
						<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
							<span className={`font-medium ${priorityColor(proposal.priority)}`}>
								{proposal.priority || "—"}
							</span>
							<span className="text-gray-500 dark:text-gray-400">
								{proposal.maturity || "—"}
							</span>
							{proposal.proposalType && (
								<span className="text-gray-500 dark:text-gray-400">
									{proposal.proposalType}
								</span>
							)}
							<span className="ml-auto text-gray-400 dark:text-gray-500">
								{formatStoredUtcDateForCompactDisplay(proposal.createdDate)}
							</span>
						</div>
					</button>
				))}
			</div>

			{/* Desktop table */}
			<div className="hidden md:block bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead className="bg-gray-50 dark:bg-gray-900 text-left">
							<tr>
								<th
									className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
									onClick={() => handleSort("id")}
								>
									ID <SortIcon column="id" />
								</th>
								<th
									className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
									onClick={() => handleSort("title")}
								>
									Title <SortIcon column="title" />
								</th>
								<th
									className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
									onClick={() => handleSort("status")}
								>
									Status <SortIcon column="status" />
								</th>
								<th
									className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
									onClick={() => handleSort("priority")}
								>
									Priority <SortIcon column="priority" />
								</th>
								<th
									className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
									onClick={() => handleSort("maturity")}
								>
									Maturity <SortIcon column="maturity" />
								</th>
								<th className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
									Type
								</th>
								<th
									className="px-4 py-3 font-medium text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
									onClick={() => handleSort("created")}
								>
									Created <SortIcon column="created" />
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-200 dark:divide-gray-700">
							{paginatedProposals.map((proposal) => (
								<tr
									key={proposal.id}
									onClick={() => onProposalClick?.(proposal)}
									className={`transition-colors ${onProposalClick ? "cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20" : "hover:bg-gray-50 dark:hover:bg-gray-700/20"}`}
								>
									<td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">
										{proposal.id}
									</td>
									<td className="px-4 py-3 text-gray-900 dark:text-gray-100 max-w-xs">
										<div className="flex items-center gap-2">
											<span className="truncate">{proposal.title}</span>
											{parseTags(proposal.tags)?.schema_drift === true && (
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onProposalClick?.(
															proposal.parentProposalId
																? proposals.find(
																		(p) =>
																			p.id ===
																			proposal.parentProposalId,
																	) || proposal
																: proposal,
														);
													}}
													className="flex-shrink-0 px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 rounded text-xs font-medium hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
													title="Schema drift detected"
												>
													⚠ drift
												</button>
											)}
										</div>
									</td>
									<td className="px-4 py-3">
										<span
											className={`px-2 py-0.5 rounded text-xs font-medium ${statusColor(proposal.status)}`}
										>
											{proposal.status}
										</span>
									</td>
									<td className="px-4 py-3">
										<span
											className={`text-xs font-medium ${priorityColor(proposal.priority)}`}
										>
											{proposal.priority || "—"}
										</span>
									</td>
									<td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
										{proposal.maturity || "—"}
									</td>
									<td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
										{proposal.proposalType || "—"}
									</td>
									<td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
										{formatStoredUtcDateForCompactDisplay(
											proposal.createdDate,
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			{filteredProposals.length === 0 && (
				<div className="text-center py-12 text-gray-500 dark:text-gray-400">
					{filter || statusFilter || priorityFilter || typeFilter
						? "No proposals match your filters"
						: "No proposals found"}
				</div>
			)}

			{/* Pagination */}
			{filteredProposals.length > 0 && (
				<div className="flex items-center justify-between bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
					<div className="text-sm text-gray-600 dark:text-gray-400">
						Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1} to{" "}
						{Math.min(currentPage * ITEMS_PER_PAGE, filteredProposals.length)} of{" "}
						{filteredProposals.length} proposals
					</div>
					<div className="flex gap-2">
						<button
							type="button"
							disabled={currentPage === 1}
							onClick={() => setCurrentPage(currentPage - 1)}
							className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
						>
							Previous
						</button>
						<div className="flex items-center gap-1">
							{Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
								<button
									key={page}
									type="button"
									onClick={() => setCurrentPage(page)}
									className={`px-2.5 py-1.5 text-sm rounded transition-colors ${
										currentPage === page
											? "bg-blue-600 text-white"
											: "border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
									}`}
								>
									{page}
								</button>
							))}
						</div>
						<button
							type="button"
							disabled={currentPage === totalPages}
							onClick={() => setCurrentPage(currentPage + 1)}
							className="px-3 py-1.5 text-sm rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
						>
							Next
						</button>
					</div>
				</div>
			)}
		</div>
	);
};

export default ProposalsPage;
