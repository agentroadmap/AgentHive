/**
 * Board — v2.5 Kanban for proposals
 *
 * Simplified proposal-based board replacing the old directive-heavy version.
 */

import type React from "react";
import { useMemo, useState } from "react";
import type { Proposal } from "../hooks/useWebSocket";
import {
	buildLanes,
	groupProposalsByLaneAndStatus,
	type LaneMode,
} from "../lib/lanes";

interface BoardProps {
	proposals: Proposal[];
	statuses: string[];
	onProposalClick?: (proposal: Proposal) => void;
	highlightProposalId?: string | null;
	laneMode: LaneMode;
	proposalTypes: string[];
	domains: string[];
}

const Board: React.FC<BoardProps> = ({
	proposals,
	statuses,
	onProposalClick,
	highlightProposalId,
	laneMode,
	proposalTypes,
	domains,
}) => {
	const [_collapsedLanes, setCollapsedLanes] = useState<
		Record<string, boolean>
	>({});
	const [hideComplete, setHideComplete] = useState(false);
	const [hideObsolete, setHideObsolete] = useState(true);

	const visibleProposals = useMemo(
		() =>
			hideObsolete
				? proposals.filter(
						(proposal) => (proposal.maturity ?? "").toLowerCase() !== "obsolete",
					)
				: proposals,
		[hideObsolete, proposals],
	);

	// Build lane definitions
	const lanes = useMemo(
		() => buildLanes(laneMode, visibleProposals, proposalTypes, domains),
		[laneMode, visibleProposals, proposalTypes, domains],
	);

	// Group proposals by lane and status
	const proposalsByLane = useMemo(
		() =>
			groupProposalsByLaneAndStatus(
				laneMode,
				lanes,
				statuses,
				visibleProposals,
			),
		[laneMode, lanes, statuses, visibleProposals],
	);

	// Filtered proposals (hide complete if toggled)
	const visibleStatuses = useMemo(
		() => (hideComplete ? statuses.filter((s) => s.toUpperCase() !== "COMPLETE") : statuses),
		[statuses, hideComplete],
	);

	const _toggleLane = (laneKey: string) => {
		setCollapsedLanes((prev) => ({ ...prev, [laneKey]: !prev[laneKey] }));
	};

	const getProposalsForCell = (laneKey: string, status: string): Proposal[] => {
		const statusMap = proposalsByLane.get(laneKey);
		if (!statusMap) return [];
		return statusMap.get(status) || [];
	};

	const _laneCount = (laneKey: string): number => {
		const statusMap = proposalsByLane.get(laneKey);
		if (!statusMap) return 0;
		let count = 0;
		for (const list of statusMap.values()) count += list.length;
		return count;
	};

	return (
		<div>
			{/* Controls */}
			<div className="mb-4 flex items-center gap-4">
				<label className="flex items-center gap-2 text-sm text-gray-600">
					<input
						type="checkbox"
						checked={hideComplete}
						onChange={(e) => setHideComplete(e.target.checked)}
					/>
					Hide Complete
				</label>
				<label className="flex items-center gap-2 text-sm text-gray-600">
					<input
						type="checkbox"
						checked={hideObsolete}
						onChange={(e) => setHideObsolete(e.target.checked)}
					/>
					Hide Obsolete
				</label>
				<div className="ml-auto text-sm text-gray-500">
					{visibleProposals.length} proposals across {lanes.length} lane
					{lanes.length !== 1 ? "s" : ""}
				</div>
			</div>

			{/* Board Grid */}
			<div className="overflow-x-auto">
				<div className="inline-flex gap-4 min-w-full">
					{/* Status columns */}
					{visibleStatuses.map((status) => (
						<div key={status} className="flex-shrink-0 w-64">
							{/* Column header */}
							<div className="sticky top-0 z-10 bg-gray-100 rounded-t-lg px-3 py-2 border-b">
								<div className="flex items-center justify-between">
									<h3 className="font-semibold text-sm text-gray-700">
										{status}
									</h3>
									<span className="text-xs text-gray-500 bg-white px-2 py-0.5 rounded-full">
										{
											visibleProposals.filter((p) => p.status === status)
												.length
										}
									</span>
								</div>
							</div>

							{/* Cards */}
							<div className="bg-gray-50 rounded-b-lg p-2 min-h-[200px] space-y-2">
								{lanes.map((lane) => {
									const cellProposals = getProposalsForCell(lane.key, status);
									if (cellProposals.length === 0) return null;

									return (
										<div key={lane.key}>
											{laneMode !== "none" && (
												<div className="text-xs font-medium text-gray-500 mb-1 px-1">
													{lane.label}
												</div>
											)}
											{cellProposals.map((proposal) => (
												<button
													key={proposal.id}
													type="button"
													onClick={() => onProposalClick?.(proposal)}
													className={`
                            w-full text-left bg-white rounded-lg p-3 shadow-sm border cursor-pointer
                            hover:shadow-md transition-shadow mb-2
                            ${proposal.id === highlightProposalId ? "ring-2 ring-blue-400" : ""}
                          `}
												>
													<div
														className={`-mx-3 -mt-3 mb-2 px-3 py-1 rounded-t-lg flex items-center justify-between gap-2 ${getMaturityTitleBarColor(proposal.maturity)}`}
													>
														<span className="text-xs font-mono opacity-80">
															{proposal.displayId}
														</span>
														<div className="flex items-center gap-1.5">
															{proposal.maturity && (
																<span className="text-[10px] uppercase tracking-wide font-semibold opacity-90">
																	{proposal.maturity}
																</span>
															)}
															<span
																className={`text-xs px-1.5 py-0.5 rounded ${getPriorityColor(proposal.priority)}`}
															>
																{proposal.priority}
															</span>
														</div>
													</div>
													<h4 className="text-sm font-medium line-clamp-2 text-gray-800 dark:text-gray-100">
														{proposal.title}
													</h4>
													<div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
														<span>{proposal.proposalType}</span>
														<span>•</span>
														<span>{proposal.domainId}</span>
														{proposal.budgetLimitUsd > 0 && (
															<>
																<span>•</span>
																<span>${proposal.budgetLimitUsd}</span>
															</>
														)}
													</div>
													{proposal.tags && (
														<div className="mt-1.5 flex flex-wrap gap-1">
															{proposal.tags.split(",").map((tag) => (
																<span
																	key={tag.trim()}
																	className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded"
																>
																	{tag.trim()}
																</span>
															))}
														</div>
													)}
												</button>
											))}
										</div>
									);
								})}

								{/* Empty state */}
								{lanes.every(
									(lane) => getProposalsForCell(lane.key, status).length === 0,
								) && (
									<div className="text-center text-sm text-gray-400 py-8">
										No proposals
									</div>
								)}
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
};

function getPriorityColor(priority: string): string {
	switch (priority) {
		case "Strategic":
			return "bg-red-100 text-red-700";
		case "High":
			return "bg-orange-100 text-orange-700";
		case "Medium":
			return "bg-yellow-100 text-yellow-700";
		case "Low":
			return "bg-green-100 text-green-700";
		default:
			return "bg-gray-100 text-gray-700";
	}
}

function getMaturityTitleBarColor(maturity?: string | null): string {
	switch ((maturity ?? "").toLowerCase()) {
		case "mature":
			return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
		case "active":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200";
		case "obsolete":
			return "bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-500";
		case "new":
			return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
		default:
			return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
	}
}

export default Board;
