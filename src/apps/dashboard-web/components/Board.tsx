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
import { maturityBarColors } from "../lib/maturity-colors";

interface BoardProps {
	proposals: Proposal[];
	statuses: string[];
	onProposalClick?: (proposal: Proposal) => void;
	highlightProposalId?: string | null;
	laneMode: LaneMode;
	proposalTypes: string[];
	domains: string[];
	focusStatus?: string | null;
	columnDwell?: Record<string, number | null>;
}

const Board: React.FC<BoardProps> = ({
	proposals,
	statuses,
	onProposalClick,
	highlightProposalId,
	laneMode,
	proposalTypes,
	domains,
	focusStatus,
	columnDwell,
}) => {
	const [_collapsedLanes, setCollapsedLanes] = useState<
		Record<string, boolean>
	>({});
	const [activeStatus, setActiveStatus] = useState<string | null>(null);

	const visibleProposals = proposals;

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

	// When focusStatus is set, restrict to that one column (single-state focus view).
	const visibleStatuses = useMemo(
		() =>
			focusStatus && statuses.includes(focusStatus) ? [focusStatus] : statuses,
		[statuses, focusStatus],
	);
	const isFocused = visibleStatuses.length === 1 && !!focusStatus;

	const mobileActiveStatus =
		activeStatus && visibleStatuses.includes(activeStatus)
			? activeStatus
			: visibleStatuses[0] ?? null;

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
			{/* Lane summary (status + maturity filters now live in BoardPage controls) */}
			<div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="text-sm text-gray-500 dark:text-gray-400 w-full md:w-auto">
					{visibleProposals.length} proposals across {lanes.length} lane
					{lanes.length !== 1 ? "s" : ""}
					{isFocused && (
						<span className="ml-2 text-xs px-2 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200">
							Focused on {focusStatus}
						</span>
					)}
				</div>
			</div>

			{/* Mobile status picker */}
			<div
				className="md:hidden mb-3 px-3 overflow-x-auto"
				style={{ touchAction: "pan-x" }}
			>
				<div className="inline-flex gap-2 pb-1">
					{visibleStatuses.map((status) => {
						const count = visibleProposals.filter((p) => p.status === status).length;
						const isOn = status === mobileActiveStatus;
						return (
							<button
								key={status}
								type="button"
								onClick={() => setActiveStatus(status)}
								className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
									isOn
										? "bg-stone-700 text-white border-stone-700 dark:bg-stone-200 dark:text-stone-900 dark:border-stone-200"
										: "bg-white text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-200 dark:border-gray-600"
								}`}
							>
								{status} <span className="opacity-70">({count})</span>
							</button>
						);
					})}
				</div>
			</div>

			{/* Board Grid */}
			<div className="md:overflow-x-auto">
				<div className="flex flex-col md:inline-flex md:flex-row gap-4 md:min-w-full">
					{/* Status columns */}
					{visibleStatuses.map((status) => (
						<div
							key={status}
							className={`flex-shrink-0 w-full ${
								isFocused ? "md:w-full md:max-w-3xl md:mx-auto" : "md:w-64"
							} ${status === mobileActiveStatus ? "" : "hidden md:block"}`}
						>
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
								{columnDwell && columnDwell[status] != null && (
									<div
										className="text-xs text-gray-400 mt-0.5"
										title={`Average dwell: ${columnDwell[status]} days`}
									>
										avg {columnDwell[status]}d
									</div>
								)}
							</div>

							{/* Cards */}
							<div className="bg-gray-50 dark:bg-gray-800/40 rounded-b-lg px-0 py-1 md:p-2 min-h-[200px] space-y-2">
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
													className={`w-full text-left bg-white dark:bg-gray-900 rounded-none md:rounded-lg p-3 border-y md:border md:shadow-sm cursor-pointer md:hover:shadow-md transition-shadow border-gray-200 dark:border-gray-700 ${
														proposal.id === highlightProposalId
															? "ring-2 ring-blue-400"
															: ""
													}`}
												>
													<div
														className={`-mx-3 -mt-3 mb-2 px-3 py-1 rounded-t-lg flex items-center justify-between gap-2 ${maturityBarColors(proposal.maturity)}`}
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

export default Board;
