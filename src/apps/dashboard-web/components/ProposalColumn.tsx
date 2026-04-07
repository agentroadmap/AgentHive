import React from "react";
import type { Proposal } from "../../../shared/types";
import type { ReorderProposalPayload } from "../lib/api";
import ProposalCard from "./ProposalCard";

interface ProposalColumnProps {
	title: string;
	proposals: Proposal[];
	onProposalUpdate: (proposalId: string, updates: Partial<Proposal>) => void;
	onEditProposal: (proposal: Proposal) => void;
	onProposalReorder?: (payload: ReorderProposalPayload) => void;
	dragSourceStatus?: string | null;
	dragSourceLane?: string | null;
	onDragStart?: (context: { status: string; laneId?: string | null }) => void;
	onDragEnd?: () => void;
	onCleanup?: () => void;
	laneId?: string;
	targetDirective?: string | null;
	selectedProposalId?: string | null;
	onSelectProposal?: (proposalId: string | null) => void;
}

const ProposalColumn: React.FC<ProposalColumnProps> = ({
	title,
	proposals,
	onProposalUpdate,
	onEditProposal,
	onProposalReorder,
	dragSourceStatus,
	dragSourceLane,
	onDragStart,
	onDragEnd,
	onCleanup,
	laneId,
	targetDirective,
	selectedProposalId,
	onSelectProposal,
}) => {
	const [isDragOver, setIsDragOver] = React.useState(false);
	const [draggedProposalId, setDraggedProposalId] = React.useState<
		string | null
	>(null);
	const [dropPosition, setDropPosition] = React.useState<{
		index: number;
		position: "before" | "after";
	} | null>(null);
	const getStatusBadgeClass = (status: string) => {
		const statusLower = status.toLowerCase();
		if (statusLower.includes("done") || statusLower.includes("complete")) {
			return "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 transition-colors duration-200";
		}
		if (statusLower.includes("progress") || statusLower.includes("doing")) {
			return "bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 transition-colors duration-200";
		}
		if (statusLower.includes("blocked") || statusLower.includes("stuck")) {
			return "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 transition-colors duration-200";
		}
		return "bg-stone-100 dark:bg-stone-900 text-stone-800 dark:text-stone-200 transition-colors duration-200";
	};

	const handleDrop = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragOver(false);
		setDropPosition(null);

		const droppedProposalId = e.dataTransfer.getData("text/plain");
		const sourceStatus = e.dataTransfer.getData("text/status");

		if (!droppedProposalId) return;

		if (!onProposalReorder) {
			return;
		}

		const columnWithoutDropped = proposals.filter(
			(proposal) => proposal.id !== droppedProposalId,
		);

		let insertIndex = columnWithoutDropped.length;
		if (dropPosition) {
			const { index, position } = dropPosition;
			const baseIndex = position === "before" ? index : index + 1;
			let count = 0;
			for (let i = 0; i < Math.min(baseIndex, proposals.length); i += 1) {
				if (proposals[i]?.id === droppedProposalId) {
					continue;
				}
				count += 1;
			}
			insertIndex = count;
		}

		const orderedProposalIds = columnWithoutDropped.map(
			(proposal) => proposal.id,
		);
		orderedProposalIds.splice(insertIndex, 0, droppedProposalId);

		const isSameColumn = sourceStatus === title;
		const isOrderUnchanged =
			isSameColumn &&
			orderedProposalIds.length === proposals.length &&
			orderedProposalIds.every(
				(proposalId, idx) => proposalId === proposals[idx]?.id,
			);

		if (isOrderUnchanged) {
			return;
		}

		onProposalReorder({
			proposalId: droppedProposalId,
			targetStatus: title,
			orderedProposalIds,
			...(targetDirective !== undefined ? { targetDirective } : {}),
		});
	};

	const _handleDragOver = (e: React.DragEvent) => {
		e.preventDefault();
	};

	const handleDragEnter = (e: React.DragEvent) => {
		e.preventDefault();
		setIsDragOver(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		e.preventDefault();
		// Only set to false if we're leaving the column entirely
		if (!e.currentTarget.contains(e.relatedTarget as Node)) {
			setIsDragOver(false);
			setDropPosition(null);
		}
	};

	const handleDragOverColumn = (e: React.DragEvent) => {
		e.preventDefault();
		// Clear drop position if dragging in empty space
		const target = e.target as HTMLElement;
		if (target === e.currentTarget || target.classList.contains("space-y-3")) {
			setDropPosition(null);
		}
	};

	const isEmpty = proposals.length === 0;

	return (
		<section
			className={`rounded-lg p-4 transition-colors duration-200 h-full ${
				isEmpty ? "min-h-24" : "min-h-96"
			} ${
				isDragOver &&
				(
					dragSourceStatus !== title ||
						(dragSourceLane ?? null) !== (laneId ?? null)
				)
					? "bg-green-50 dark:bg-green-900/20 border border-green-300 dark:border-green-600 border-dashed"
					: isEmpty
						? "bg-gray-50/50 dark:bg-gray-800/30 border border-gray-200/50 dark:border-gray-700/50"
						: "bg-white border border-gray-200 shadow-sm dark:bg-gray-800 dark:border-gray-700"
			}`}
			onDrop={handleDrop}
			onDragOver={handleDragOverColumn}
			onDragEnter={handleDragEnter}
			onDragLeave={handleDragLeave}
			aria-label={`${title} proposal column`}
		>
			<div className="flex items-center justify-between mb-4">
				<div className="flex items-center gap-2">
					<h3 className="font-semibold text-gray-900 dark:text-gray-100 transition-colors duration-200">
						{title}
					</h3>
					<span
						className={`px-2 py-1 text-xs font-medium rounded-circle ${getStatusBadgeClass(title)}`}
					>
						{proposals.length}
					</span>
				</div>
			</div>

			<div className="space-y-3">
				{proposals.map((proposal, index) => (
					<button
						type="button"
						key={proposal.id}
						className={`relative block w-full text-left ${selectedProposalId === proposal.id ? "ring-2 ring-blue-500 ring-offset-2 dark:ring-offset-gray-800 rounded-md" : ""}`}
						onClick={(e) => {
							e.stopPropagation();
							onSelectProposal?.(proposal.id);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.stopPropagation();
								onSelectProposal?.(proposal.id);
							}
						}}
						onDragOver={(e) => {
							if (
								!onProposalReorder ||
								!draggedProposalId ||
								draggedProposalId === proposal.id
							)
								return;

							e.preventDefault();
							const rect = e.currentTarget.getBoundingClientRect();
							const y = e.clientY - rect.top;
							const height = rect.height;

							// Determine if we're in the top or bottom half
							if (y < height / 2) {
								setDropPosition({ index, position: "before" });
							} else {
								setDropPosition({ index, position: "after" });
							}
						}}
					>
						{/* Drop indicator for before this proposal */}
						{dropPosition?.index === index &&
							dropPosition.position === "before" && (
								<div className="h-1 bg-blue-500 rounded-full mb-2 animate-pulse" />
							)}

						<ProposalCard
							proposal={proposal}
							onUpdate={onProposalUpdate}
							onEdit={onEditProposal}
							onDragStart={() => {
								setDraggedProposalId(proposal.id);
								onDragStart?.({ status: title, laneId: laneId ?? null });
							}}
							onDragEnd={() => {
								setDraggedProposalId(null);
								setDropPosition(null);
								onDragEnd?.();
							}}
							status={title}
							laneId={laneId}
						/>

						{/* Drop indicator for after this proposal */}
						{dropPosition?.index === index &&
							dropPosition.position === "after" && (
								<div className="h-1 bg-blue-500 rounded-full mt-2 animate-pulse" />
							)}
					</button>
				))}

				{/* Drop zone indicator - only show in different columns */}
				{isDragOver && dragSourceStatus !== title && (
					<div className="border-2 border-green-400 dark:border-green-500 border-dashed rounded-md bg-green-50 dark:bg-green-900/20 p-4 text-center transition-colors duration-200">
						<div className="text-green-600 dark:text-green-400 text-sm font-medium transition-colors duration-200">
							Drop proposal here to change status
						</div>
					</div>
				)}

				{isEmpty && !isDragOver && (
					<div className="text-center py-2 text-gray-400 dark:text-gray-500 text-xs transition-colors duration-200">
						{dragSourceStatus && dragSourceStatus !== title
							? `Drop to move`
							: `Empty`}
					</div>
				)}

				{/* Cleanup button for Complete column */}
				{onCleanup &&
					title.toLowerCase() === "done" &&
					proposals.length > 0 && (
						<div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
							<button
								type="button"
								onClick={onCleanup}
								className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors duration-200"
								title="Clean up old completed proposals"
							>
								<svg
									className="w-4 h-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									xmlns="http://www.w3.org/2000/svg"
									aria-hidden="true"
									focusable="false"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
									/>
								</svg>
								Clean Up Old Proposals
							</button>
						</div>
					)}
			</div>
		</section>
	);
};

export default ProposalColumn;
