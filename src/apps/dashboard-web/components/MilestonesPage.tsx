import Fuse from "fuse.js";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
	buildDirectiveBuckets,
	collectArchivedDirectiveKeys,
	isReachedStatus,
} from "../../../core/proposal/directives.ts";
import type {
	Directive,
	DirectiveBucket,
	Proposal,
} from "../../../shared/types";
import { apiClient } from "../lib/api";
import DirectiveProposalRow from "./DirectiveProposalRow";
import Modal from "./Modal";

interface DirectiveSearchEntry {
	id: string;
	title: string;
}

const rebuildFilteredBucket = (
	bucket: DirectiveBucket,
	filteredProposals: Proposal[],
	statuses: string[],
): DirectiveBucket => {
	const counts: Record<string, number> = {};
	for (const status of statuses) {
		counts[status] = 0;
	}
	for (const proposal of filteredProposals) {
		const status = proposal.status ?? "";
		counts[status] = (counts[status] ?? 0) + 1;
	}

	const doneCount = filteredProposals.filter((proposal) =>
		isReachedStatus(proposal.status),
	).length;
	const progress =
		filteredProposals.length > 0
			? Math.round((doneCount / filteredProposals.length) * 100)
			: 0;

	return {
		...bucket,
		proposals: filteredProposals,
		statusCounts: counts,
		total: filteredProposals.length,
		doneCount,
		progress,
	};
};

interface DirectivesPageProps {
	proposals: Proposal[];
	statuses: string[];
	directiveEntities: Directive[];
	archivedDirectives: Directive[];
	onEditProposal: (proposal: Proposal) => void;
	onRefreshData?: () => Promise<void>;
}

const DirectivesPage: React.FC<DirectivesPageProps> = ({
	proposals,
	statuses,
	directiveEntities,
	archivedDirectives,
	onEditProposal,
	onRefreshData,
}) => {
	const [newDirective, setNewDirective] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState<string | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const [showAddModal, setShowAddModal] = useState(false);
	const [expandedBuckets, setExpandedBuckets] = useState<
		Record<string, boolean>
	>({});
	const [draggedProposal, setDraggedProposal] = useState<Proposal | null>(null);
	const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
	const [showAllUnassigned, setShowAllUnassigned] = useState(false);
	const [showCompleted, setShowCompleted] = useState(false);
	const [archivingDirectiveKey, setArchivingDirectiveKey] = useState<
		string | null
	>(null);
	const [searchQuery, setSearchQuery] = useState("");

	const archivedDirectiveIds = useMemo(
		() => collectArchivedDirectiveKeys(archivedDirectives, directiveEntities),
		[archivedDirectives, directiveEntities],
	);
	const buckets = useMemo(
		() =>
			buildDirectiveBuckets(proposals, directiveEntities, statuses, {
				archivedDirectiveIds,
				archivedDirectives,
			}),
		[
			proposals,
			directiveEntities,
			statuses,
			archivedDirectiveIds,
			archivedDirectives,
		],
	);
	const searchQueryTrimmed = searchQuery.trim();
	const isSearchActive = searchQueryTrimmed.length > 0;
	const defaultExpandedByBucketKey = useMemo(() => {
		const map: Record<string, boolean> = {};
		for (const bucket of buckets) {
			map[bucket.key] = bucket.total > 0 && bucket.total <= 8;
		}
		return map;
	}, [buckets]);
	const visibleBuckets = useMemo(() => {
		if (!isSearchActive) {
			return buckets;
		}

		const searchableProposals: DirectiveSearchEntry[] = buckets.flatMap(
			(bucket) =>
				bucket.proposals.map((proposal) => ({
					id: proposal.id,
					title: proposal.title,
				})),
		);
		if (searchableProposals.length === 0) {
			return buckets.map((bucket) =>
				rebuildFilteredBucket(bucket, [], statuses),
			);
		}
		const normalizedQuery = searchQueryTrimmed.toLowerCase();
		const exactIdMatches = searchableProposals.filter(
			(proposal) => proposal.id.toLowerCase() === normalizedQuery,
		);
		const matchedProposalIds =
			exactIdMatches.length > 0
				? new Set(exactIdMatches.map((proposal) => proposal.id))
				: (() => {
						const fuse = new Fuse(searchableProposals, {
							threshold: 0.35,
							ignoreLocation: true,
							minMatchCharLength: 2,
							keys: [
								{ name: "title", weight: 0.55 },
								{ name: "id", weight: 0.45 },
							],
						});
						const matches = fuse.search(searchQueryTrimmed);
						return new Set(matches.map((match) => match.item.id));
					})();

		return buckets.map((bucket) => {
			const filteredProposals = bucket.proposals.filter((proposal) =>
				matchedProposalIds.has(proposal.id),
			);
			return rebuildFilteredBucket(bucket, filteredProposals, statuses);
		});
	}, [buckets, isSearchActive, searchQueryTrimmed, statuses]);

	// Separate buckets into categories and sort by ID descending
	const { unassignedBucket, activeDirectives, completedDirectives } =
		useMemo(() => {
			// Sort directives by ID descending (newest first - IDs are sequential m-0, m-1, etc.)
			const sortByIdDesc = (a: DirectiveBucket, b: DirectiveBucket) => {
				const aDirective = a.directive ?? "";
				const bDirective = b.directive ?? "";
				const aMatch = aDirective.match(/^m-(\d+)/);
				const bMatch = bDirective.match(/^m-(\d+)/);
				const aNum = aMatch?.[1] ? Number.parseInt(aMatch[1], 10) : -1;
				const bNum = bMatch?.[1] ? Number.parseInt(bMatch[1], 10) : -1;
				return bNum - aNum;
			};

			const unassigned = visibleBuckets.find((b) => b.isNoDirective);
			const activeWithProposals = visibleBuckets.filter(
				(b) => !b.isNoDirective && !b.isCompleted && b.total > 0,
			);
			const empty = visibleBuckets.filter(
				(b) => !b.isNoDirective && !b.isCompleted && b.total === 0,
			);
			const completed = visibleBuckets.filter(
				(b) => !b.isNoDirective && b.isCompleted,
			);

			// Sort each group by ID descending, then combine (active with proposals first, then empty)
			const sortedActive = [...activeWithProposals].sort(sortByIdDesc);
			const sortedEmpty = [...empty].sort(sortByIdDesc);
			const sortedCompleted = [...completed].sort(sortByIdDesc);

			return {
				unassignedBucket: unassigned,
				activeDirectives: [...sortedActive, ...sortedEmpty],
				completedDirectives: sortedCompleted,
			};
		}, [visibleBuckets]);

	// Drag and drop handlers
	const handleDragStart = useCallback(
		(e: React.DragEvent, proposal: Proposal) => {
			setDraggedProposal(proposal);
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", proposal.id);
			// Add dragging class for visual feedback
			if (e.currentTarget instanceof HTMLElement) {
				e.currentTarget.style.opacity = "0.5";
			}
		},
		[],
	);

	const handleDragEnd = useCallback((e: React.DragEvent) => {
		setDraggedProposal(null);
		setDropTargetKey(null);
		if (e.currentTarget instanceof HTMLElement) {
			e.currentTarget.style.opacity = "1";
		}
	}, []);

	const handleDragOver = useCallback(
		(e: React.DragEvent, bucketKey: string) => {
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			setDropTargetKey(bucketKey);
		},
		[],
	);

	const handleDragLeave = useCallback(() => {
		setDropTargetKey(null);
	}, []);

	const handleDrop = useCallback(
		async (e: React.DragEvent, targetDirective: string | undefined) => {
			e.preventDefault();
			setDropTargetKey(null);

			if (!draggedProposal) return;

			// Don't do anything if dropping on same directive
			if (draggedProposal.directive === targetDirective) {
				setDraggedProposal(null);
				return;
			}

			try {
				await apiClient.updateProposal(draggedProposal.id, {
					directive: targetDirective,
				});
				if (onRefreshData) {
					await onRefreshData();
				}
			} catch (err) {
				console.error("Failed to update proposal directive:", err);
			}

			setDraggedProposal(null);
		},
		[draggedProposal, onRefreshData],
	);

	const handleNewDirectiveChange = (value: string) => {
		setNewDirective(value);
		if (error) setError(null);
		if (success) setSuccess(null);
	};

	const closeAddModal = () => {
		setShowAddModal(false);
		setNewDirective("");
		setError(null);
	};

	const handleAddDirective = async (
		event?: React.FormEvent<HTMLFormElement>,
	) => {
		event?.preventDefault();
		const value = newDirective.trim();
		if (!value) {
			setError("Directive name cannot be empty.");
			setSuccess(null);
			return;
		}

		setIsSaving(true);
		setError(null);
		setSuccess(null);
		try {
			await apiClient.createDirective(value);
			setNewDirective("");
			setSuccess(`Added directive "${value}"`);
			setShowAddModal(false);
			if (onRefreshData) {
				await onRefreshData();
			}
			setTimeout(() => setSuccess(null), 3000);
		} catch (err) {
			console.error("Failed to add directive:", err);
			setError(err instanceof Error ? err.message : "Failed to add directive.");
		} finally {
			setIsSaving(false);
		}
	};

	const handleArchiveDirective = useCallback(
		async (bucket: DirectiveBucket) => {
			if (!bucket.directive) return;

			const label = bucket.label || bucket.directive;
			const confirmed = window.confirm(
				`Archive directive "${label}"? This moves it to roadmap/archive/directives and hides it from the directives view.`,
			);
			if (!confirmed) return;

			setArchivingDirectiveKey(bucket.key);
			setError(null);
			setSuccess(null);
			try {
				await apiClient.archiveDirective(bucket.directive);
				setSuccess(`Archived directive "${label}"`);
				if (onRefreshData) {
					await onRefreshData();
				}
				setTimeout(() => setSuccess(null), 3000);
			} catch (err) {
				console.error("Failed to archive directive:", err);
				setError(
					err instanceof Error ? err.message : "Failed to archive directive.",
				);
			} finally {
				setArchivingDirectiveKey(null);
			}
		},
		[onRefreshData],
	);

	const getStatusBadgeClass = (status?: string | null) => {
		const normalized = (status ?? "").toLowerCase();
		if (normalized.includes("done") || normalized.includes("complete")) {
			return "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300";
		}
		if (normalized.includes("progress")) {
			return "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300";
		}
		return "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300";
	};

	const getPriorityBadgeClass = (priority?: string) => {
		switch (priority?.toLowerCase()) {
			case "high":
				return "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300";
			case "medium":
				return "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300";
			case "low":
				return "bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300";
			default:
				return "";
		}
	};

	const getStatusDotColor = (status?: string | null) => {
		const normalized = (status ?? "").toLowerCase();
		if (normalized.includes("done") || normalized.includes("complete"))
			return "#10b981";
		if (normalized.includes("progress")) return "#3b82f6";
		return "#6b7280";
	};

	const getInlineStatusClass = (status: string) => {
		const normalized = status.toLowerCase();
		if (normalized.includes("done") || normalized.includes("complete"))
			return "text-emerald-700 dark:text-emerald-300";
		if (normalized.includes("progress"))
			return "text-blue-700 dark:text-blue-300";
		return "text-gray-600 dark:text-gray-400";
	};

	const getSortedProposals = (bucketProposals: Proposal[]) => {
		return bucketProposals.slice().sort((a, b) => {
			// Complete proposals go to the bottom
			const aReached = isReachedStatus(a.status);
			const bReached = isReachedStatus(b.status);
			if (aReached !== bReached) return aReached ? 1 : -1;
			// Sort by created date descending (newest first)
			const aDate = a.createdDate ?? "";
			const bDate = b.createdDate ?? "";
			return bDate.localeCompare(aDate);
		});
	};

	const safeIdSegment = (value: string) =>
		value.replace(/[^a-zA-Z0-9_-]/g, "-");

	// Render a directive card (drop target)
	const renderDirectiveCard = (bucket: DirectiveBucket, isEmpty: boolean) => {
		const progress =
			bucket.total > 0
				? Math.round((bucket.doneCount / bucket.total) * 100)
				: 0;
		const defaultExpanded =
			defaultExpandedByBucketKey[bucket.key] ??
			(bucket.total > 0 && bucket.total <= 8);
		const isExpanded = expandedBuckets[bucket.key] ?? defaultExpanded;
		const listId = `directive-${safeIdSegment(bucket.key)}`;
		const sortedProposals = getSortedProposals(bucket.proposals);
		const isDropTarget = dropTargetKey === bucket.key;
		const isDragging = draggedProposal !== null;
		const isArchiving = archivingDirectiveKey === bucket.key;

		return (
			<div
				key={bucket.key}
				className={`rounded-lg border-2 transition-all duration-200 ${
					isDropTarget
						? "border-blue-400 dark:border-blue-500 bg-blue-50 dark:bg-blue-900/20 scale-[1.01]"
						: isDragging
							? "border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800"
							: "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
				}`}
				onDragOver={(e) => handleDragOver(e, bucket.key)}
				onDragLeave={handleDragLeave}
				onDrop={(e) => handleDrop(e, bucket.directive)}
			>
				<div className="px-5 py-4">
					{/* Header row */}
					<div className="flex items-center justify-between gap-4">
						<h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 truncate">
							{bucket.label}
						</h3>
						{isEmpty ? (
							<span className="text-sm text-gray-400 dark:text-gray-500">
								{isDragging ? "Drop here" : "No proposals"}
							</span>
						) : (
							<div className="flex items-center gap-3">
								<span className="text-sm text-gray-500 dark:text-gray-400">
									{bucket.total} proposal{bucket.total === 1 ? "" : "s"}
								</span>
								<span className="text-lg font-bold text-emerald-600 dark:text-emerald-400">
									{progress}%
								</span>
							</div>
						)}
					</div>

					{/* Progress bar - only for non-empty */}
					{!isEmpty && (
						<div className="mt-3 w-full h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
							<div
								className="h-full bg-emerald-500 transition-all duration-300"
								style={{ width: `${progress}%` }}
							/>
						</div>
					)}

					{/* Status breakdown - only for non-empty */}
					{!isEmpty && (
						<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
							{statuses.map((status) => {
								const count = bucket.statusCounts[status] ?? 0;
								if (count === 0) return null;
								return (
									<span
										key={status}
										className={`inline-flex items-center gap-1.5 ${getInlineStatusClass(status)}`}
									>
										<span
											className="h-2 w-2 rounded-full"
											style={{ backgroundColor: getStatusDotColor(status) }}
										/>
										{count} {status}
									</span>
								);
							})}
						</div>
					)}

					{/* Actions */}
					<div className="mt-4 flex items-center justify-between gap-3 border-t border-gray-100 dark:border-gray-700 pt-4">
						<div className="flex items-center gap-2">
							<Link
								to={`/?lane=directive&directive=${encodeURIComponent(bucket.directive ?? "")}`}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
							>
								<svg
									className="w-3.5 h-3.5"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
									/>
								</svg>
								Board
							</Link>
							<Link
								to={`/proposals?directive=${encodeURIComponent(bucket.directive ?? "")}`}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
							>
								<svg
									className="w-3.5 h-3.5"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M4 6h16M4 10h16M4 14h16M4 18h16"
									/>
								</svg>
								List
							</Link>
							<button
								type="button"
								onClick={() => handleArchiveDirective(bucket)}
								disabled={isArchiving}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-red-200 dark:border-red-800 text-red-600 dark:text-red-300 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors disabled:opacity-60"
							>
								<svg
									className="w-3.5 h-3.5"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
								{isArchiving ? "Archiving..." : "Archive"}
							</button>
						</div>
						<button
							type="button"
							aria-expanded={isExpanded}
							aria-controls={listId}
							onClick={() =>
								setExpandedBuckets((c) => ({ ...c, [bucket.key]: !isExpanded }))
							}
							className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
						>
							{isExpanded ? "Hide" : "Show"} proposals
							<svg
								className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M19 9l-7 7-7-7"
								/>
							</svg>
						</button>
					</div>

					{/* Proposal list */}
					{isExpanded && !isEmpty && (
						<div
							id={listId}
							className="mt-4 rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden"
						>
							<div className="divide-y divide-gray-200 dark:divide-gray-700">
								{sortedProposals.slice(0, 10).map((proposal) => {
									return (
										<DirectiveProposalRow
											key={proposal.id}
											proposal={proposal}
											isReached={isReachedStatus(proposal.status)}
											statusBadgeClass={getStatusBadgeClass(proposal.status)}
											priorityBadgeClass={getPriorityBadgeClass(
												proposal.priority,
											)}
											onEditProposal={onEditProposal}
											onDragStart={handleDragStart}
											onDragEnd={handleDragEnd}
										/>
									);
								})}
							</div>
							{sortedProposals.length > 10 && (
								<div className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-gray-700">
									<Link
										to={`/proposals?directive=${encodeURIComponent(bucket.directive ?? "")}`}
										className="text-blue-600 dark:text-blue-400 hover:underline"
									>
										View all {sortedProposals.length} proposals →
									</Link>
								</div>
							)}
						</div>
					)}
				</div>
			</div>
		);
	};

	// Render unassigned proposals section with table layout
	const renderUnassignedSection = () => {
		if (!unassignedBucket || (!isSearchActive && unassignedBucket.total === 0))
			return null;

		const sortedActiveProposals = getSortedProposals(
			unassignedBucket.proposals.filter(
				(proposal) => !isReachedStatus(proposal.status),
			),
		);
		const isExpanded = expandedBuckets.__unassigned ?? true;
		const displayProposals = showAllUnassigned
			? sortedActiveProposals
			: sortedActiveProposals.slice(0, 12);
		const hasMore = sortedActiveProposals.length > 12;
		const hasActiveUnassignedProposals = sortedActiveProposals.length > 0;

		return (
			<div className="mb-8 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/50 transition-colors duration-200">
				<div className="px-5 py-4">
					{/* Header */}
					<div className="flex items-center justify-between gap-4">
						<div className="flex items-center gap-2">
							<svg
								className="w-4 h-4 text-gray-400"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							<h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
								Unassigned proposals
							</h3>
							<span className="text-sm text-gray-500 dark:text-gray-400">
								({sortedActiveProposals.length})
							</span>
						</div>
						<button
							type="button"
							onClick={() =>
								setExpandedBuckets((c) => ({ ...c, __unassigned: !isExpanded }))
							}
							className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
						>
							{isExpanded ? "Collapse" : "Expand"}
							<svg
								className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M19 9l-7 7-7-7"
								/>
							</svg>
						</button>
					</div>

					{isExpanded && (
						<div className="mt-4">
							{hasActiveUnassignedProposals ? (
								<>
									{/* Table */}
									<div className="rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden bg-white dark:bg-gray-800">
										{/* Table header */}
										<div className="grid grid-cols-[auto_auto_1fr_auto_auto] gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
											<div className="w-6" /> {/* Drag handle column */}
											<div className="w-24">ID</div>
											<div>Title</div>
											<div className="text-center w-24">Status</div>
											<div className="text-center w-20">Priority</div>
										</div>

										{/* Table rows */}
										<div className="divide-y divide-gray-200 dark:divide-gray-700">
											{displayProposals.map((proposal) => (
												<DirectiveProposalRow
													key={proposal.id}
													proposal={proposal}
													isReached={isReachedStatus(proposal.status)}
													statusBadgeClass={getStatusBadgeClass(
														proposal.status,
													)}
													priorityBadgeClass={getPriorityBadgeClass(
														proposal.priority,
													)}
													onEditProposal={onEditProposal}
													onDragStart={handleDragStart}
													onDragEnd={handleDragEnd}
												/>
											))}
										</div>

										{/* Footer with show more/less */}
										{hasMore && (
											<div className="px-3 py-2 text-xs border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30">
												<button
													type="button"
													onClick={() =>
														setShowAllUnassigned(!showAllUnassigned)
													}
													className="text-blue-600 dark:text-blue-400 hover:underline"
												>
													{showAllUnassigned
														? "Show less ↑"
														: `Show all ${sortedActiveProposals.length} proposals ↓`}
												</button>
											</div>
										)}
									</div>

									{/* Hint */}
									<p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
										Drag proposals to a directive below to assign them
									</p>
								</>
							) : (
								<p className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 bg-white/70 dark:bg-gray-800/50 px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
									{isSearchActive
										? "No matching unassigned proposals."
										: "No active unassigned proposals. Completed proposals are hidden."}
								</p>
							)}
						</div>
					)}
				</div>
			</div>
		);
	};

	const hasSearchMatches = visibleBuckets.some((bucket) => bucket.total > 0);
	const showSearchNoMatchHint = isSearchActive && !hasSearchMatches;
	const noDirectives =
		!isSearchActive &&
		activeDirectives.length === 0 &&
		completedDirectives.length === 0;

	return (
		<div className="container mx-auto px-4 py-8 transition-colors duration-200">
			{/* Header */}
			<div className="flex flex-wrap items-center justify-between gap-4 mb-6">
				<div className="flex flex-wrap items-center gap-4">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-white">
						Directives
					</h1>
					<div className="relative w-full min-w-[240px] max-w-[420px]">
						<span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-gray-400 dark:text-gray-500">
							<svg
								className="h-4 w-4"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
								/>
							</svg>
						</span>
						<label htmlFor="directives-search" className="sr-only">
							Search directives
						</label>
						<input
							id="directives-search"
							type="text"
							value={searchQuery}
							onInput={(event) =>
								setSearchQuery((event.target as HTMLInputElement).value)
							}
							placeholder="Search by proposal ID or title"
							aria-label="Search directives"
							className="w-full pl-10 pr-10 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent transition-colors duration-200"
						/>
						{isSearchActive && (
							<button
								type="button"
								onClick={() => setSearchQuery("")}
								aria-label="Clear directive search"
								className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
							>
								<svg
									className="h-4 w-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						)}
					</div>
				</div>
				<div className="flex items-center gap-3">
					{success && (
						<span className="inline-flex items-center gap-1.5 text-sm text-green-600 dark:text-green-400">
							<svg
								className="w-4 h-4"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M5 13l4 4L19 7"
								/>
							</svg>
							{success}
						</span>
					)}
					{error && (
						<span className="inline-flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400">
							<svg
								className="w-4 h-4"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M12 9v4m0 4h.01M5.07 19h13.86a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.33 16a2 2 0 001.74 3z"
								/>
							</svg>
							{error}
						</span>
					)}
					<button
						type="button"
						onClick={() => setShowAddModal(true)}
						className="inline-flex items-center px-4 py-2 bg-blue-500 text-white text-sm font-medium rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-400 dark:focus:ring-offset-gray-900 transition-colors"
					>
						+ Add directive
					</button>
				</div>
			</div>

			{/* Search no-match hint */}
			{showSearchNoMatchHint && (
				<div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-4 py-3">
					<p className="text-sm text-amber-800 dark:text-amber-200">
						No directives or proposals match &quot;{searchQueryTrimmed}&quot;.
					</p>
					<button
						type="button"
						onClick={() => setSearchQuery("")}
						className="rounded-md border border-amber-300 dark:border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
					>
						Clear search
					</button>
				</div>
			)}

			{/* Unassigned proposals */}
			{renderUnassignedSection()}

			{/* Active directives */}
			{activeDirectives.length > 0 && (
				<div className="space-y-4">
					{activeDirectives.map((bucket) =>
						renderDirectiveCard(bucket, bucket.total === 0),
					)}
				</div>
			)}

			{/* Completed directives */}
			{completedDirectives.length > 0 && (
				<div className="mt-8">
					{isSearchActive ? (
						<div className="inline-flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300">
							<span>Completed directives</span>
							<span className="text-xs text-gray-400 dark:text-gray-500">
								({completedDirectives.length})
							</span>
						</div>
					) : (
						<button
							type="button"
							onClick={() => setShowCompleted((value) => !value)}
							className="inline-flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white transition-colors"
						>
							<span>Completed directives</span>
							<span className="text-xs text-gray-400 dark:text-gray-500">
								({completedDirectives.length})
							</span>
							<svg
								className={`w-4 h-4 transition-transform ${showCompleted ? "rotate-180" : ""}`}
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M19 9l-7 7-7-7"
								/>
							</svg>
						</button>
					)}
					{(isSearchActive || showCompleted) && (
						<div className="mt-4 space-y-4">
							{completedDirectives.map((bucket) =>
								renderDirectiveCard(bucket, false),
							)}
						</div>
					)}
				</div>
			)}

			{/* Empty proposal */}
			{noDirectives && !unassignedBucket?.total && (
				<div className="flex flex-col items-center justify-center py-16 text-center">
					<svg
						className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
						/>
					</svg>
					<p className="text-gray-500 dark:text-gray-400">
						No directives yet. Create one to start organizing your proposals.
					</p>
				</div>
			)}

			{/* Add modal */}
			<Modal
				isOpen={showAddModal}
				onClose={closeAddModal}
				title="Add directive"
				maxWidthClass="max-w-md"
			>
				<form onSubmit={handleAddDirective} className="space-y-4">
					<div className="space-y-2">
						<label className="text-sm font-medium text-gray-900 dark:text-gray-100">
							Directive name
						</label>
						<input
							type="text"
							value={newDirective}
							onChange={(e) => handleNewDirectiveChange(e.target.value)}
							placeholder="e.g. Release 1.0"
							className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
						/>
						{error && (
							<p className="text-xs text-red-600 dark:text-red-400">{error}</p>
						)}
					</div>
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={closeAddModal}
							className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={isSaving || !newDirective.trim()}
							className="px-4 py-2 rounded-md text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 transition-colors"
						>
							{isSaving ? "Saving..." : "Create"}
						</button>
					</div>
				</form>
			</Modal>
		</div>
	);
};

export default DirectivesPage;
