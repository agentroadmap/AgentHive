/**
 * Enhanced views with Tab key switching between proposal views and kanban board
 */

import type { Core } from "../../core/roadmap.ts";
import type { Proposal } from "../../shared/types/index.ts";
import { renderBoardTui } from "./board.ts";
import { createLoadingScreen } from "./loading.ts";
import {
	type ViewProposal,
	ViewSwitcher,
	type ViewType,
} from "./view-switcher.ts";

export interface EnhancedViewOptions {
	core: Core;
	initialView: ViewType;
	selectedProposal?: Proposal;
	proposals?: Proposal[];
	filter?: {
		status?: string;
		assignee?: string;
		title?: string;
		filterDescription?: string;
	};
}

/**
 * Main enhanced view controller that handles Tab switching between views
 */
export async function runEnhancedViews(
	options: EnhancedViewOptions,
): Promise<void> {
	const initialProposal: ViewProposal = {
		type: options.initialView,
		selectedProposal: options.selectedProposal,
		proposals: options.proposals,
		filter: options.filter,
	};

	const _currentView: (() => Promise<void>) | null = null;
	let viewSwitcher: ViewSwitcher | null = null;

	// Create view switcher with proposal change handler
	viewSwitcher = new ViewSwitcher({
		core: options.core,
		initialProposal,
		onViewChange: async (newProposal) => {
			// Handle view changes triggered by the switcher
			await switchToView(newProposal);
		},
	});

	// Function to switch to a specific view
	const switchToView = async (proposal: ViewProposal): Promise<void> => {
		switch (proposal.type) {
			case "proposal-list":
			case "proposal-detail":
				await switchToProposalView(proposal);
				break;
			case "kanban":
				await switchToKanbanView(proposal);
				break;
		}
	};

	// Function to handle switching to proposal view
	const switchToProposalView = async (
		proposal: ViewProposal,
	): Promise<void> => {
		if (!proposal.proposals || proposal.proposals.length === 0) {
			console.log("No proposals available.");
			return;
		}

		const proposalToView = proposal.selectedProposal || proposal.proposals[0];
		if (!proposalToView) return;

		// Create enhanced proposal viewer with Tab switching
		await viewProposalEnhancedWithSwitching(proposalToView, {
			proposals: proposal.proposals,
			core: options.core,
			title: proposal.filter?.title,
			filterDescription: proposal.filter?.filterDescription,
			startWithDetailFocus: proposal.type === "proposal-detail",
			viewSwitcher,
			onProposalChange: (newProposal) => {
				// Update proposal when user navigates to different proposal
				viewSwitcher?.updateProposal({
					selectedProposal: newProposal,
					type: newProposal ? "proposal-detail" : "proposal-list",
				});
			},
		});
	};

	// Function to handle switching to kanban view
	const switchToKanbanView = async (proposal: ViewProposal): Promise<void> => {
		if (!proposal.kanbanData) return;

		if (proposal.kanbanData.isLoading) {
			// Show loading screen while waiting for data
			const loadingScreen = await createLoadingScreen("Loading kanban board");

			try {
				// Wait for kanban data to load
				const result = await viewSwitcher?.getKanbanData();
				if (!result) throw new Error("Failed to get kanban data");
				const { proposals, statuses } = result;
				loadingScreen?.close();

				// Now show the kanban board
				await renderBoardTuiWithSwitching(proposals, statuses, {
					viewSwitcher,
					onProposalSelect: (proposal) => {
						// When user selects a proposal in kanban, prepare for potential switch back
						viewSwitcher?.updateProposal({
							selectedProposal: proposal,
						});
					},
				});
			} catch (error) {
				loadingScreen?.close();
				console.error("Failed to load kanban data:", error);
			}
		} else if (proposal.kanbanData.loadError) {
			console.error(
				"Error loading kanban board:",
				proposal.kanbanData.loadError,
			);
		} else {
			// Data is ready, show kanban board immediately
			await renderBoardTuiWithSwitching(
				proposal.kanbanData.proposals,
				proposal.kanbanData.statuses,
				{
					viewSwitcher,
					onProposalSelect: (proposal) => {
						viewSwitcher?.updateProposal({
							selectedProposal: proposal,
						});
					},
				},
			);
		}
	};

	// Start with the initial view
	await switchToView(initialProposal);
}

/**
 * Enhanced proposal viewer that supports view switching
 */
async function viewProposalEnhancedWithSwitching(
	proposal: Proposal,
	options: {
		proposals?: Proposal[];
		core: Core;
		title?: string;
		filterDescription?: string;
		startWithDetailFocus?: boolean;
		viewSwitcher?: ViewSwitcher;
		onProposalChange?: (proposal: Proposal) => void;
	},
): Promise<void> {
	// Import the original viewProposalEnhanced function
	const { viewProposalEnhanced } = await import(
		"./proposal-viewer-with-search.ts"
	);

	// For now, use the original function but we'll need to modify it to support Tab switching
	// This is a placeholder - we'll need to modify the actual proposal-viewer-with-search.ts
	return viewProposalEnhanced(proposal, {
		proposals: options.proposals,
		core: options.core,
		title: options.title,
		filterDescription: options.filterDescription,
		startWithDetailFocus: options.startWithDetailFocus,
		// Add view switcher support
		viewSwitcher: options.viewSwitcher,
		onProposalChange: options.onProposalChange,
	});
}

/**
 * Enhanced kanban board that supports view switching
 */
async function renderBoardTuiWithSwitching(
	proposals: Proposal[],
	statuses: string[],
	_options: {
		viewSwitcher?: ViewSwitcher;
		onProposalSelect?: (proposal: Proposal) => void;
	},
): Promise<void> {
	// Get config for layout and column width
	const core = new (await import("../../core/roadmap.ts")).Core(process.cwd());
	const config = await core.filesystem.loadConfig();
	const layout = "horizontal" as const; // Default layout
	const maxColumnWidth = config?.maxColumnWidth || 20;

	// For now, use the original function but we'll need to modify it to support Tab switching
	// This is a placeholder - we'll need to modify the actual board.ts
	return renderBoardTui(proposals, statuses, layout, maxColumnWidth);
}

// Re-export for convenience
export {
	type ViewProposal,
	ViewSwitcher,
	type ViewType,
} from "./view-switcher.ts";

// Helper function import
