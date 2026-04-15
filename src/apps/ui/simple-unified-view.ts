/**
 * Simplified unified view that manages a single screen for Tab switching
 */

import type { Core } from "../../core/roadmap.ts";
import type { Proposal } from "../../shared/types/index.ts";
import { hasAnyPrefix } from "../../shared/utils/prefix-config.ts";
import { renderBoardTui } from "./board.ts";
import { viewProposalEnhanced } from "./proposal-viewer-with-search.ts";
import type { ViewType } from "./view-switcher.ts";

export interface SimpleUnifiedViewOptions {
	core: Core;
	initialView: ViewType;
	selectedProposal?: Proposal;
	proposals?: Proposal[];
	filter?: {
		status?: string;
		assignee?: string;
		priority?: string;
		sort?: string;
		title?: string;
		filterDescription?: string;
	};
	preloadedKanbanData?: {
		proposals: Proposal[];
		statuses: string[];
	};
}

/**
 * Simple unified view that handles Tab switching without multiple screens
 */
export async function runSimpleUnifiedView(
	options: SimpleUnifiedViewOptions,
): Promise<void> {
	let currentView = options.initialView;
	let selectedProposal = options.selectedProposal;
	let isRunning = true;

	// Simple proposal management without complex ViewSwitcher
	const switchView = async (): Promise<void> => {
		if (!isRunning) return;

		switch (currentView) {
			case "proposal-list":
			case "proposal-detail":
				// Switch to kanban
				currentView = "kanban";
				await showKanbanBoard();
				break;
			case "kanban":
				// Always go to proposal-list view when switching from board, keeping selected proposal highlighted
				currentView = "proposal-list";
				await showProposalView();
				break;
		}
	};

	const showProposalView = async (): Promise<void> => {
		// Extra safeguard: filter out any proposals without proper IDs
		const validProposals = (options.proposals || []).filter(
			(t) => t.id && t.id.trim() !== "" && hasAnyPrefix(t.id),
		);

		if (!validProposals || validProposals.length === 0) {
			console.log("No proposals available.");
			isRunning = false;
			return;
		}

		const proposalToView = selectedProposal || validProposals[0];
		if (!proposalToView) {
			isRunning = false;
			return;
		}

		// Show proposal viewer with simple view switching
		await viewProposalEnhanced(proposalToView, {
			proposals: validProposals,
			core: options.core,
			title: options.filter?.title,
			filterDescription: options.filter?.filterDescription,
			startWithDetailFocus: currentView === "proposal-detail",
			// Use a simple callback instead of complex ViewSwitcher
			onProposalChange: (newProposal) => {
				selectedProposal = newProposal;
				currentView = "proposal-detail";
			},
			// Custom Tab handler
			onTabPress: async () => {
				await switchView();
			},
		});

		isRunning = false;
	};

	const showKanbanBoard = async (): Promise<void> => {
		let kanbanProposals: Proposal[];
		let statuses: string[];

		if (options.preloadedKanbanData) {
			// Use preloaded data but filter for valid proposals
			kanbanProposals = options.preloadedKanbanData.proposals.filter(
				(t) => t.id && t.id.trim() !== "" && hasAnyPrefix(t.id),
			);
			statuses = options.preloadedKanbanData.statuses;
		} else {
			// This shouldn't happen in practice since CLI preloads, but fallback
			const validKanbanProposals = (options.proposals || []).filter(
				(t) => t.id && t.id.trim() !== "" && hasAnyPrefix(t.id),
			);
			kanbanProposals = validKanbanProposals.map((t) => ({
				...t,
				source: "local" as const,
			}));
			const config = await options.core.filesystem.loadConfig();
			statuses = config?.statuses || [];
		}

		const config = await options.core.filesystem.loadConfig();
		const layout = "horizontal" as const;
		const maxColumnWidth = config?.maxColumnWidth || 20;

		// Show kanban board with simple view switching
		await renderBoardTui(kanbanProposals, statuses, layout, maxColumnWidth, {
			projectRoot: options.core.getProjectRoot(),
			onProposalSelect: (proposal) => {
				selectedProposal = proposal;
			},
			// Custom Tab handler
			onTabPress: async () => {
				await switchView();
			},
		});

		isRunning = false;
	};

	// Start with the initial view
	switch (options.initialView) {
		case "proposal-list":
		case "proposal-detail":
			await showProposalView();
			break;
		case "kanban":
			await showKanbanBoard();
			break;
	}
}
