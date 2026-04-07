import type React from "react";
import type { Proposal } from "../../../shared/types";

interface DirectiveProposalRowProps {
	proposal: Proposal;
	isReached: boolean;
	statusBadgeClass: string;
	priorityBadgeClass: string;
	onEditProposal: (proposal: Proposal) => void;
	onDragStart: (event: React.DragEvent, proposal: Proposal) => void;
	onDragEnd: (event: React.DragEvent) => void;
}

const DragHandle = () => (
	<svg
		className="w-4 h-4 text-gray-400 cursor-grab active:cursor-grabbing"
		viewBox="0 0 24 24"
		fill="currentColor"
		aria-hidden="true"
		focusable="false"
	>
		<circle cx="9" cy="6" r="1.5" />
		<circle cx="15" cy="6" r="1.5" />
		<circle cx="9" cy="12" r="1.5" />
		<circle cx="15" cy="12" r="1.5" />
		<circle cx="9" cy="18" r="1.5" />
		<circle cx="15" cy="18" r="1.5" />
	</svg>
);

const DirectiveProposalRow: React.FC<DirectiveProposalRowProps> = ({
	proposal,
	isReached,
	statusBadgeClass,
	priorityBadgeClass,
	onEditProposal,
	onDragStart,
	onDragEnd,
}) => {
	const handleActivate = () => {
		onEditProposal(proposal);
	};

	return (
		<button
			type="button"
			draggable
			onDragStart={(event) => onDragStart(event, proposal)}
			onDragEnd={onDragEnd}
			onClick={handleActivate}
			className="group grid w-full grid-cols-[auto_auto_1fr_auto_auto] gap-3 items-center px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors cursor-pointer text-left"
		>
			<div className="w-6 flex justify-center opacity-40 group-hover:opacity-100 transition-opacity">
				<DragHandle />
			</div>

			<div
				className={`w-24 text-xs font-mono text-gray-500 dark:text-gray-400 whitespace-nowrap ${isReached ? "opacity-60" : ""}`}
			>
				{proposal.id}
			</div>

			<div
				className={`min-w-0 overflow-hidden ${isReached ? "opacity-60" : ""}`}
			>
				<span
					className={`text-sm truncate block whitespace-nowrap ${
						isReached
							? "line-through text-gray-500"
							: "text-gray-900 dark:text-gray-100"
					}`}
				>
					{proposal.title}
				</span>
			</div>

			<div className="w-24 flex justify-center">
				<span
					className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${statusBadgeClass}`}
				>
					{proposal.status}
				</span>
			</div>

			<div className="w-20 flex justify-center">
				{proposal.priority ? (
					<span
						className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${priorityBadgeClass}`}
					>
						{proposal.priority}
					</span>
				) : (
					<span className="text-xs text-gray-300 dark:text-gray-600">—</span>
				)}
			</div>
		</button>
	);
};

export default DirectiveProposalRow;
