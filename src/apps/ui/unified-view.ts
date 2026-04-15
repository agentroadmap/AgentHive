/**
 * Unified view manager that handles Tab switching between proposal views and kanban board
 */

import type { Core } from "../../core/roadmap.ts";
import { DEFAULT_STATUSES } from "../../shared/constants/index.ts";
import type { Directive, Proposal } from "../../shared/types/index.ts";
import { watchConfig } from "../../shared/utils/config-watcher.ts";
import { collectAvailableLabels } from "../../shared/utils/label-filter.ts";
import { hasAnyPrefix } from "../../shared/utils/prefix-config.ts";
import {
	applySharedProposalFilters,
	createProposalSearchIndex,
} from "../../shared/utils/proposal-search.ts";
import { watchProposals } from "../../shared/utils/proposal-watcher.ts";
import { renderBoardTui } from "./board.ts";
import type { WorkforceAgent } from "./cockpit.ts";
import { createLoadingScreen } from "./loading.ts";
import {
	buildProposalViewerDirectiveFilterModel,
	viewProposalEnhanced,
} from "./proposal-viewer-with-search.ts";
import { createScreen } from "./tui.ts";
import {
	type ViewProposal,
	ViewSwitcher,
	type ViewType,
} from "./view-switcher.ts";

export interface UnifiedViewOptions {
	core: Core;
	initialView: ViewType;
	selectedProposal?: Proposal;
	proposals?: Proposal[];
	proposalsLoader?: (
		updateProgress: (message: string) => void,
	) => Promise<{ proposals: Proposal[]; statuses: string[] }>;
	loadingScreenFactory?: (
		initialMessage: string,
	) => Promise<LoadingScreen | null>;
	title?: string;
	filter?: {
		status?: string;
		assignee?: string;
		priority?: string;
		labels?: string[];
		directive?: string;
		sort?: string;
		title?: string;
		filterDescription?: string;
		searchQuery?: string;
		parentProposalId?: string;
	};
	preloadedKanbanData?: {
		proposals: Proposal[];
		statuses: string[];
	};
	directiveMode?: boolean;
	directiveEntities?: Directive[];
	source?: string;
}

type LoadingScreen = {
	update(message: string): void;
	close(): Promise<void> | void;
};

export interface UnifiedViewLoadResult {
	proposals: Proposal[];
	statuses: string[];
}

export interface UnifiedViewFilters {
	searchQuery: string;
	statusFilter: string;
	priorityFilter: string;
	labelFilter: string[];
	directiveFilter: string;
}

export interface KanbanSharedFilters {
	searchQuery: string;
	priorityFilter: string;
	labelFilter: string[];
	directiveFilter: string;
}

export function createKanbanSharedFilters(
	filters: UnifiedViewFilters,
): KanbanSharedFilters {
	return {
		searchQuery: filters.searchQuery,
		priorityFilter: filters.priorityFilter,
		labelFilter: [...filters.labelFilter],
		directiveFilter: filters.directiveFilter,
	};
}

export function filterProposalsForKanban(
	proposals: Proposal[],
	filters: KanbanSharedFilters,
	resolveDirectiveLabel?: (directive: string) => string,
): Proposal[] {
	if (
		!filters.searchQuery.trim() &&
		!filters.priorityFilter &&
		filters.labelFilter.length === 0 &&
		!filters.directiveFilter
	) {
		return [...proposals];
	}

	const searchIndex = createProposalSearchIndex(proposals);
	return applySharedProposalFilters(
		proposals,
		{
			query: filters.searchQuery,
			priority: filters.priorityFilter as "high" | "medium" | "low" | undefined,
			labels: filters.labelFilter,
			directive: filters.directiveFilter || undefined,
			resolveDirectiveLabel,
		},
		searchIndex,
	);
}

export function createUnifiedViewFilters(
	filter: UnifiedViewOptions["filter"] | undefined,
): UnifiedViewFilters {
	return {
		searchQuery: filter?.searchQuery || "",
		statusFilter: filter?.status || "",
		priorityFilter: filter?.priority || "",
		labelFilter: [...(filter?.labels || [])],
		directiveFilter: filter?.directive || "",
	};
}

export function mergeUnifiedViewFilters(
	current: UnifiedViewFilters,
	update: UnifiedViewFilters,
): UnifiedViewFilters {
	return {
		...current,
		searchQuery: update.searchQuery,
		statusFilter: update.statusFilter,
		priorityFilter: update.priorityFilter,
		labelFilter: [...update.labelFilter],
		directiveFilter: update.directiveFilter,
	};
}

export async function loadProposalsForUnifiedView(
	core: Core,
	options: Pick<
		UnifiedViewOptions,
		"proposals" | "proposalsLoader" | "loadingScreenFactory"
	>,
): Promise<UnifiedViewLoadResult> {
	if (options.proposals && options.proposals.length > 0) {
		const config = await core.filesystem.loadConfig();
		return {
			proposals: options.proposals,
			statuses: config?.statuses || [...DEFAULT_STATUSES],
		};
	}

	const loader =
		options.proposalsLoader ||
		(async (
			updateProgress: (message: string) => void,
		): Promise<{ proposals: Proposal[]; statuses: string[] }> => {
			const proposals = await core.loadProposals(updateProgress);
			const config = await core.filesystem.loadConfig();
			return {
				proposals,
				statuses: config?.statuses || [...DEFAULT_STATUSES],
			};
		});

	const loadingScreenFactory =
		options.loadingScreenFactory || createLoadingScreen;
	const loadingScreen = await loadingScreenFactory("Loading proposals");

	try {
		const result = await loader((message) => {
			loadingScreen?.update(message);
		});

		return {
			proposals: result.proposals,
			statuses: result.statuses,
		};
	} finally {
		await loadingScreen?.close();
	}
}

type ViewResult = "switch" | "exit";

/**
 * Main unified view controller that handles Tab switching between views
 */
export async function runUnifiedView(
	options: UnifiedViewOptions,
): Promise<void> {
	try {
		const { proposals: loadedProposals, statuses: loadedStatuses } =
			await loadProposalsForUnifiedView(options.core, {
				proposals: options.proposals,
				proposalsLoader: options.proposalsLoader,
				loadingScreenFactory: options.loadingScreenFactory,
			});

		const baseProposals = (loadedProposals || []).filter(
			(t) => t.id && t.id.trim() !== "" && hasAnyPrefix(t.id),
		);
		if (baseProposals.length === 0) {
			if (options.filter?.parentProposalId) {
				console.log(
					`No child proposals found for parent proposal ${options.filter.parentProposalId}.`,
				);
			} else {
				console.log("No proposals found.");
			}
			return;
		}
		const initialConfig = await options.core.filesystem.loadConfig();
		let configuredLabels = initialConfig?.labels ?? [];
		let directiveEntities = await options.core.filesystem.listDirectives();
		let directiveFilterModel =
			buildProposalViewerDirectiveFilterModel(directiveEntities);
		let currentFilters = createUnifiedViewFilters(options.filter);
		const initialProposal: ViewProposal = {
			type: options.initialView,
			selectedProposal: options.selectedProposal,
			proposals: baseProposals,
			filter: options.filter,
			// Initialize kanban data if starting with kanban view
			kanbanData:
				options.initialView === "kanban"
					? {
							proposals: baseProposals,
							statuses: loadedStatuses,
							isLoading: false,
						}
					: undefined,
		};

		let isRunning = true;
		let viewSwitcher: ViewSwitcher | null = null;
		let currentView: ViewType = options.initialView;
		let selectedProposal: Proposal | undefined = options.selectedProposal;
		let proposals = baseProposals;
		let kanbanStatuses = loadedStatuses ?? [];
		let boardUpdater:
			| ((nextProposals: Proposal[], nextStatuses: string[]) => void)
			| null = null;

		const getRenderableProposals = () =>
			proposals.filter(
				(proposal) =>
					proposal.id && proposal.id.trim() !== "" && hasAnyPrefix(proposal.id),
			);
		const getBoardAvailableLabels = () =>
			collectAvailableLabels(getRenderableProposals(), configuredLabels);
		const getBoardAvailableDirectives = () => [
			...directiveFilterModel.availableDirectiveTitles,
		];

		const emitBoardUpdate = () => {
			if (!boardUpdater) return;
			boardUpdater(getRenderableProposals(), kanbanStatuses);
		};
		let isInitialLoad = true; // Track if this is the first view load

		// Create view switcher (without problematic onViewChange callback)
		viewSwitcher = new ViewSwitcher({
			core: options.core,
			initialProposal,
		});

		const watcher = watchProposals(options.core, {
			onProposalAdded(proposal) {
				proposals.push(proposal);
				const viewProposal = viewSwitcher?.getProposal();
				viewSwitcher?.updateProposal({
					proposals,
					kanbanData: viewProposal?.kanbanData
						? { ...viewProposal.kanbanData, proposals }
						: undefined,
				});
				emitBoardUpdate();
			},
			onProposalChanged(proposal) {
				const idx = proposals.findIndex((t) => t.id === proposal.id);
				if (idx >= 0) {
					proposals[idx] = proposal;
				} else {
					proposals.push(proposal);
				}
				const viewProposal = viewSwitcher?.getProposal();
				viewSwitcher?.updateProposal({
					proposals,
					kanbanData: viewProposal?.kanbanData
						? { ...viewProposal.kanbanData, proposals }
						: undefined,
				});
				emitBoardUpdate();
			},
			onProposalRemoved(proposalId) {
				proposals = proposals.filter((t) => t.id !== proposalId);
				if (selectedProposal?.id === proposalId) {
					selectedProposal = proposals[0];
				}
				const proposal = viewSwitcher?.getProposal();
				viewSwitcher?.updateProposal({
					proposals,
					kanbanData: proposal?.kanbanData
						? { ...proposal.kanbanData, proposals }
						: undefined,
				});
				emitBoardUpdate();
			},
		});
		process.on("exit", () => watcher.stop());

		const configWatcher = watchConfig(options.core, {
			onConfigChanged: (config) => {
				kanbanStatuses = config?.statuses ?? [];
				configuredLabels = config?.labels ?? [];
				emitBoardUpdate();
			},
		});
		process.on("exit", () => configWatcher.stop());

		// Function to show proposal view
		const showProposalView = async (): Promise<ViewResult> => {
			const availableProposals = proposals.filter(
				(t) => t.id && t.id.trim() !== "" && hasAnyPrefix(t.id),
			);

			if (availableProposals.length === 0) {
				console.log("No proposals available.");
				return "exit";
			}

			// Find the proposal to view - if selectedProposal has an ID, find it in available proposals
			let proposalToView: Proposal | undefined;
			if (selectedProposal?.id) {
				const foundProposal = availableProposals.find(
					(t) => t.id === selectedProposal?.id,
				);
				proposalToView = foundProposal || availableProposals[0];
			} else {
				proposalToView = availableProposals[0];
			}

			if (!proposalToView) {
				console.log("No proposal selected.");
				return "exit";
			}

			// Show enhanced proposal viewer with view switching support
			return new Promise<ViewResult>((resolve) => {
				let result: ViewResult = "exit"; // Default to exit

				const onTabPress = async () => {
					result = "switch";
				};

				// Determine initial focus based on where we're coming from
				// - If we have a search query on initial load, focus search
				// - If currentView is proposal-detail, focus detail
				// - Otherwise (including when coming from kanban), focus proposal list
				const hasSearchQuery = options.filter
					? "searchQuery" in options.filter
					: false;
				const shouldFocusSearch = isInitialLoad && hasSearchQuery;

				viewProposalEnhanced(proposalToView, {
					proposals: availableProposals,
					core: options.core,
					title: options.filter?.title,
					filterDescription: options.filter?.filterDescription,
					searchQuery: currentFilters.searchQuery,
					statusFilter: currentFilters.statusFilter,
					priorityFilter: currentFilters.priorityFilter,
					labelFilter: currentFilters.labelFilter,
					directiveFilter: currentFilters.directiveFilter,
					startWithDetailFocus: currentView === "proposal-detail",
					startWithSearchFocus: shouldFocusSearch,
					onProposalChange: (newProposal) => {
						selectedProposal = newProposal;
						currentView = "proposal-detail";
					},
					onFilterChange: (filters) => {
						currentFilters = mergeUnifiedViewFilters(currentFilters, filters);
					},
					onTabPress,
				}).then(() => {
					// If user wants to exit, do it immediately
					if (result === "exit") {
						process.exit(0);
					}
					resolve(result);
				});
			});
		};

		// Function to show kanban view
		const showKanbanView = async (): Promise<ViewResult> => {
			const config = await options.core.filesystem.loadConfig();
			configuredLabels = config?.labels ?? configuredLabels;
			const layout = "horizontal" as const;
			const maxColumnWidth = config?.maxColumnWidth || 20;
			directiveEntities = await options.core.filesystem.listDirectives();
			directiveFilterModel =
				buildProposalViewerDirectiveFilterModel(directiveEntities);
			const kanbanProposals = getRenderableProposals();
			const statuses = kanbanStatuses;

			// Show kanban board with view switching support
			return new Promise<ViewResult>((resolve) => {
				let result: ViewResult = "exit"; // Default to exit

				const onTabPress = async () => {
					result = "switch";
				};

				renderBoardTui(kanbanProposals, statuses, layout, maxColumnWidth, {
					onProposalSelect: (proposal) => {
						selectedProposal = proposal;
					},
					onTabPress,
					filters: createKanbanSharedFilters(currentFilters),
					availableLabels: getBoardAvailableLabels(),
					availableDirectives: getBoardAvailableDirectives(),
					onFilterChange: (filters) => {
						currentFilters = {
							...currentFilters,
							searchQuery: filters.searchQuery,
							priorityFilter: filters.priorityFilter,
							labelFilter: [...filters.labelFilter],
							directiveFilter: filters.directiveFilter,
						};
					},
					subscribeUpdates: (updater) => {
						boardUpdater = updater;
						emitBoardUpdate();
					},
					directiveMode: options.directiveMode,
					directiveEntities,
				}).then(() => {
					// If user wants to exit, do it immediately
					if (result === "exit") {
						process.exit(0);
					}
					boardUpdater = null;
					resolve(result);
				});
			});
		};

		// Function to show cockpit (formerly cubic dashboard)
		const showCockpit = async (): Promise<ViewResult> => {
			const { renderCockpit } = await import("./cockpit.ts");
			const screen = createScreen({ title: "Engineer's Cockpit" });

			return new Promise<ViewResult>((resolve) => {
				let _result: ViewResult = "exit";

				const onTabPress = () => {
					_result = "switch";
				};

				const refresh = async () => {
					// Load proposals first, then pass to listAgents to avoid deadlock
					const pipelineProposals = await options.core.loadProposals();
					options.core.setPreloadedProposalsForAgents(pipelineProposals);
					const [agents, pulseMessages] = await Promise.all([
						options.core.listAgents(),
						options.core.readMessages({ channel: "public" }),
					]);

					const agentData: WorkforceAgent[] = agents.map((agent) => ({
						id: agent.identity ?? agent.name,
						name: agent.name,
						role: agent.capabilities[0] ?? "agent",
						status: agent.status === "offline" ? "offline" : "active",
						currentProposal: agent.claims?.[0]?.id,
						statusMessage: agent.status,
						lastSeen: Date.parse(agent.lastSeen || new Date().toISOString()),
					}));

					const cockpitMessages = pulseMessages.messages
						.slice(-30)
						.map((message) => ({
							sender_identity: message.from,
							content: message.text,
							timestamp: Date.parse(message.timestamp) * 1000,
						}));

					renderCockpit(screen, {
						agents: agentData,
						proposals: pipelineProposals.map((proposal) => ({
							id: proposal.id,
							display_id: proposal.id,
							title: proposal.title,
							status: proposal.status,
							priority: proposal.priority ?? "none",
							proposal_type: proposal.proposalType ?? "proposal",
						})),
						ledger: [],
						messages: cockpitMessages,
					});
				};

				// Initial render
				void refresh();

				// Live Update Loop (500ms)
				const timer = setInterval(() => {
					void refresh();
				}, 1000);

				// Set up key handlers
				(screen as any).key(["tab"], () => {
					onTabPress();
					clearInterval(timer);
					delete (screen as any)._cockpitContainer;
					(screen as any).destroy();
					resolve("switch");
				});
				(screen as any).key(["q", "C-c"], () => {
					clearInterval(timer);
					delete (screen as any)._cockpitContainer;
					(screen as any).destroy();
					resolve("exit");
				});
			});
		};

		// Function to show headlines view (system feed)
		const showHeadlinesView = async (): Promise<ViewResult> => {
			const { renderHeadlines } = await import("./headlines.ts");
			const config = await options.core.filesystem.loadConfig();
			const screen = createScreen({ title: "System Feed" });

			return new Promise<ViewResult>((resolve) => {
				let _result: ViewResult = "exit";

				const onTabPress = () => {
					_result = "switch";
				};

				const refresh = async () => {
					const messages = (await options.core.listPulse(50)).map((event) => ({
						id: event.id,
						sender_identity: event.agent,
						content: event.impact || event.title,
						timestamp: Date.parse(event.timestamp) * 1000,
						channel_name: "pulse",
					}));
					renderHeadlines(screen, {
						messages: messages as any[],
						projectName: config?.projectName || "Roadmap.md",
					});
				};

				void refresh();
				const timer = setInterval(() => {
					void refresh();
				}, 1000);

				// Set up key handlers
				(screen as any).key(["tab"], () => {
					onTabPress();
					clearInterval(timer);
					delete (screen as any)._headlinesContainer;
					(screen as any).destroy();
					resolve("switch");
				});
				(screen as any).key(["q", "C-c"], () => {
					clearInterval(timer);
					delete (screen as any)._headlinesContainer;
					(screen as any).destroy();
					resolve("exit");
				});
			});
		};

		// Function to show chat view
		const showChatView = async (): Promise<ViewResult> => {
			const { renderChat } = await import("./chat.ts");
			const config = await options.core.filesystem.loadConfig();
			const screen = createScreen({ title: "Project Chat" });

			return new Promise<ViewResult>((resolve) => {
				let _result: ViewResult = "exit";

				const onTabPress = () => {
					_result = "switch";
				};

				const currentChannel = "public";
				const refresh = async () => {
					const [channelsResult, messagesResult] = await Promise.all([
						options.core.listChannels(),
						options.core.readMessages({ channel: currentChannel }),
					]);

					renderChat(screen, {
						messages: messagesResult.messages.map((message, index) => ({
							id: `${message.timestamp}-${index}`,
							sender_identity: message.from,
							content: message.text,
							timestamp: Date.parse(message.timestamp) * 1000,
							channel_name: currentChannel,
						})),
						channels: channelsResult.map((channel) => channel.name),
						currentChannel,
						projectName: config?.projectName || "Roadmap.md",
						userSystemName: "HUMAN",
						onSend: async (content: string) => {
							await options.core.sendMessage({
								from: "HUMAN",
								type: "group",
								group: currentChannel,
								message: content,
							});
						},
					});
				};

				void refresh();
				const timer = setInterval(() => {
					void refresh();
				}, 1000);

				// Set up key handlers
				(screen as any).key(["tab"], () => {
					onTabPress();
					clearInterval(timer);
					delete (screen as any)._chatContainer;
					(screen as any).destroy();
					resolve("switch");
				});
				(screen as any).key(["q", "C-c"], () => {
					clearInterval(timer);
					delete (screen as any)._chatContainer;
					(screen as any).destroy();
					resolve("exit");
				});
			});
		};

		// Main view loop
		while (isRunning) {
			// Show the current view and get the result
			let result: ViewResult;
			switch (currentView) {
				case "proposal-list":
				case "proposal-detail":
					result = await showProposalView();
					break;
				case "kanban":
					result = await showKanbanView();
					break;
				case "cockpit":
					result = await showCockpit();
					break;
				case "headlines":
					result = await showHeadlinesView();
					break;
				case "chat":
					result = await showChatView();
					break;
				default:
					result = "exit";
			}

			// After the first view, we're no longer on initial load
			isInitialLoad = false;

			// Handle the result
			if (result === "switch") {
				// User pressed Tab, cycle through views
				switch (currentView) {
					case "proposal-list":
					case "proposal-detail":
						currentView = "kanban";
						break;
					case "kanban":
						currentView = "cockpit";
						break;
					case "cockpit":
						currentView = "headlines";
						break;
					case "headlines":
						currentView = "chat";
						break;
					case "chat":
						currentView = "proposal-list";
						break;
				}
			} else {
				// User pressed q/Esc, exit the loop
				isRunning = false;
			}
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
