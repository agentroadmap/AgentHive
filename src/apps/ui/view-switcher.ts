/**
 * View switcher module for handling Tab key navigation between proposal views and kanban board
 * with intelligent background loading and proposal preservation.
 */

import type { Core } from "../../core/roadmap.ts";
import type { Proposal } from "../../shared/types/index.ts";

export type ViewType =
	| "proposal-list"
	| "proposal-detail"
	| "kanban"
	| "cockpit"
	| "headlines"
	| "chat";

export interface ViewProposal {
	type: ViewType;
	selectedProposal?: Proposal;
	proposals?: Proposal[];
	filter?: {
		status?: string;
		assignee?: string;
		priority?: string;
		sort?: string;
		title?: string;
		filterDescription?: string;
		searchQuery?: string;
		parentProposalId?: string;
	};
	kanbanData?: {
		proposals: Proposal[];
		statuses: string[];
		isLoading: boolean;
		loadError?: string;
	};
}

export interface ViewSwitcherOptions {
	core: Core;
	initialProposal: ViewProposal;
	onViewChange?: (newProposal: ViewProposal) => void;
}

/**
 * Background loading proposal for kanban board data
 */
class BackgroundLoader {
	private loadingPromise: Promise<Proposal[]> | null = null;
	private cachedProposals: Proposal[] | null = null;
	private lastLoadTime = 0;
	private readonly CACHE_TTL = 30000; // 30 seconds
	private onProgress?: (message: string) => void;
	private abortController?: AbortController;
	private lastProgressMessage = "";
	private core: Core;

	constructor(core: Core) {
		this.core = core;
	}

	/**
	 * Start loading kanban data in the background
	 */
	startLoading(): void {
		// Don't start new loading if already loading or cache is fresh
		if (this.loadingPromise || this.isCacheFresh()) {
			return;
		}

		// Clear last progress message when starting fresh load
		this.lastProgressMessage = "";

		// Create new abort controller for this loading operation
		this.abortController = new AbortController();
		this.loadingPromise = this.loadKanbanData();
	}

	/**
	 * Get kanban data - either from cache or by waiting for loading
	 */
	async getKanbanData(): Promise<{
		proposals: Proposal[];
		statuses: string[];
	}> {
		// Return cached data if fresh
		if (this.isCacheFresh() && this.cachedProposals) {
			const config = await this.core.filesystem.loadConfig();
			return {
				proposals: this.cachedProposals,
				statuses: config?.statuses || [],
			};
		}

		// Start loading if not already
		if (!this.loadingPromise) {
			this.abortController = new AbortController();
			this.loadingPromise = this.loadKanbanData();
		} else {
			// If loading is already in progress, send a status update to the current progress callback
			this.onProgress?.("Loading proposals from local and remote branches...");
		}

		// Wait for loading to complete
		const proposals = await this.loadingPromise;
		const config = await this.core.filesystem.loadConfig();

		return {
			proposals,
			statuses: config?.statuses || [],
		};
	}

	/**
	 * Check if we have fresh cached data
	 */
	isReady(): boolean {
		return this.isCacheFresh() && this.cachedProposals !== null;
	}

	/**
	 * Get loading status
	 */
	isLoading(): boolean {
		return this.loadingPromise !== null && !this.isCacheFresh();
	}

	private isCacheFresh(): boolean {
		return Date.now() - this.lastLoadTime < this.CACHE_TTL;
	}

	private async loadKanbanData(): Promise<Proposal[]> {
		try {
			// Check for cancellation at the start
			if (this.abortController?.signal.aborted) {
				throw new Error("Loading cancelled");
			}

			// Create a progress wrapper that stores the last message
			const progressWrapper = (msg: string) => {
				this.lastProgressMessage = msg;
				this.onProgress?.(msg);
			};

			// Use the shared Core method for loading board proposals
			const filteredProposals = await this.core.loadProposals(
				progressWrapper,
				this.abortController?.signal,
			);

			// Cache the results
			this.cachedProposals = filteredProposals;
			this.lastLoadTime = Date.now();
			this.loadingPromise = null;
			this.lastProgressMessage = ""; // Clear progress message after completion

			return filteredProposals;
		} catch (error) {
			this.loadingPromise = null;
			this.lastProgressMessage = ""; // Clear progress message on error
			// If it's a cancellation, don't treat it as an error
			if (error instanceof Error && error.message === "Loading cancelled") {
				return []; // Return empty array instead of exiting
			}
			throw error;
		}
	}

	/**
	 * Set progress callback for loading updates
	 */
	setProgressCallback(callback: (message: string) => void): void {
		this.onProgress = callback;
		// If we have a last progress message and loading is in progress, send it immediately
		if (this.lastProgressMessage && this.loadingPromise) {
			callback(this.lastProgressMessage);
		}
	}

	/**
	 * Seed the cache with pre-loaded proposals to avoid redundant loading
	 */
	seedCache(proposals: Proposal[]): void {
		this.cachedProposals = proposals;
		this.lastLoadTime = Date.now();
	}

	/**
	 * Cancel any ongoing loading operations
	 */
	cancelLoading(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = undefined;
		}
		this.loadingPromise = null;
	}
}

/**
 * Main view switcher class
 */
export class ViewSwitcher {
	private proposal: ViewProposal;
	private backgroundLoader: BackgroundLoader;
	private onViewChange?: (newProposal: ViewProposal) => void;

	constructor(options: ViewSwitcherOptions) {
		this.proposal = options.initialProposal;
		this.backgroundLoader = new BackgroundLoader(options.core);
		this.onViewChange = options.onViewChange;

		// If starting with kanban view and we already have loaded proposals, seed the cache
		if (
			this.proposal.type === "kanban" &&
			this.proposal.kanbanData?.proposals &&
			!this.proposal.kanbanData.isLoading
		) {
			this.backgroundLoader.seedCache(this.proposal.kanbanData.proposals);
		}
		// Note: We no longer auto-start background loading - proposals are loaded once
		// at the unified view level and passed through
	}

	/**
	 * Get current view proposal
	 */
	getProposal(): ViewProposal {
		return { ...this.proposal };
	}

	/**
	 * Switch to the next view based on current proposal
	 */
	async switchView(): Promise<ViewProposal> {
		switch (this.proposal.type) {
			case "proposal-list":
			case "proposal-detail":
				return await this.switchToKanban();
			case "kanban":
				return this.switchToCockpit();
			case "cockpit":
				return this.switchToHeadlines();
			case "headlines":
				return this.switchToChat();
			case "chat":
				return this.switchToProposalView();
			default:
				return this.proposal;
		}
	}

	/**
	 * Switch to kanban board view
	 */
	private async switchToKanban(): Promise<ViewProposal> {
		try {
			if (this.backgroundLoader.isReady()) {
				// Data is ready, switch instantly
				const { proposals, statuses } =
					await this.backgroundLoader.getKanbanData();
				this.proposal = {
					...this.proposal,
					type: "kanban",
					kanbanData: {
						proposals,
						statuses,
						isLoading: false,
					},
				};
			} else {
				// Data is still loading, indicate loading proposal
				this.proposal = {
					...this.proposal,
					type: "kanban",
					kanbanData: {
						proposals: [],
						statuses: [],
						isLoading: true,
					},
				};
			}

			this.onViewChange?.(this.proposal);
			return this.proposal;
		} catch (error) {
			// Handle loading error
			this.proposal = {
				...this.proposal,
				type: "kanban",
				kanbanData: {
					proposals: [],
					statuses: [],
					isLoading: false,
					loadError:
						error instanceof Error
							? error.message
							: "Failed to load kanban data",
				},
			};

			this.onViewChange?.(this.proposal);
			return this.proposal;
		}
	}

	/**
	 * Switch to cockpit view
	 */
	private switchToCockpit(): ViewProposal {
		this.proposal = {
			...this.proposal,
			type: "cockpit",
		};
		this.onViewChange?.(this.proposal);
		return this.proposal;
	}

	/**
	 * Switch to headlines view (full-width event stream)
	 */
	private switchToHeadlines(): ViewProposal {
		this.proposal = {
			...this.proposal,
			type: "headlines",
		};
		this.onViewChange?.(this.proposal);
		return this.proposal;
	}

	/**
	 * Switch to chat view
	 */
	private switchToChat(): ViewProposal {
		this.proposal = {
			...this.proposal,
			type: "chat",
		};
		this.onViewChange?.(this.proposal);
		return this.proposal;
	}

	/**
	 * Switch back to proposal view (preserve previous view type)
	 */
	private switchToProposalView(): ViewProposal {
		// Default to proposal-list if no previous proposal view
		const viewType = this.proposal.selectedProposal
			? "proposal-detail"
			: "proposal-list";

		this.proposal = {
			...this.proposal,
			type: viewType,
		};

		// Start background loading for next potential kanban switch
		this.backgroundLoader.startLoading();

		this.onViewChange?.(this.proposal);
		return this.proposal;
	}

	/**
	 * Update the current proposal (used when user navigates within a view)
	 */
	updateProposal(updates: Partial<ViewProposal>): ViewProposal {
		this.proposal = { ...this.proposal, ...updates };

		// Start background loading if switching to proposal views
		if (
			this.proposal.type === "proposal-list" ||
			this.proposal.type === "proposal-detail"
		) {
			this.backgroundLoader.startLoading();
		}

		this.onViewChange?.(this.proposal);
		return this.proposal;
	}

	/**
	 * Check if kanban data is ready for instant switching
	 */
	isKanbanReady(): boolean {
		return this.backgroundLoader.isReady();
	}

	/**
	 * Pre-load kanban data
	 */
	preloadKanban(): void {
		this.backgroundLoader.startLoading();
	}

	/**
	 * Get kanban data - delegates to background loader
	 */
	async getKanbanData(): Promise<{
		proposals: Proposal[];
		statuses: string[];
	}> {
		return await this.backgroundLoader.getKanbanData();
	}

	/**
	 * Set progress callback for loading updates
	 */
	setProgressCallback(callback: (message: string) => void): void {
		this.backgroundLoader.setProgressCallback(callback);
	}

	/**
	 * Clean up resources and cancel any ongoing operations
	 */
	cleanup(): void {
		this.backgroundLoader.cancelLoading();
	}
}
