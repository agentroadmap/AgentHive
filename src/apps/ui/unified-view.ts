/**
 * Unified view manager that handles Tab switching between proposal views and kanban board
 */

import type { Core } from "../../core/roadmap.ts";
import { query as pgQuery } from "../../postgres/pool.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
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
import type { LedgerEntry, WorkforceAgent } from "./cockpit.ts";
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
	if (options.proposals !== undefined) {
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
	const config = await core.filesystem.loadConfig();
	const useLoadingScreen =
		options.loadingScreenFactory !== undefined ||
		config?.database?.provider !== "Postgres";
	const loadingScreen = useLoadingScreen
		? await loadingScreenFactory("Loading proposals")
		: null;

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
			return new Promise<ViewResult>((resolve, reject) => {
				let result: ViewResult = "exit"; // Default to exit
				let settled = false;

				const finish = (value: ViewResult) => {
					if (settled) {
						return;
					}
					settled = true;
					resolve(value);
				};

				const onTabPress = async () => {
					result = "switch";
					finish("switch");
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
					if (settled) {
						return;
					}
					// If user wants to exit, do it immediately
					if (result === "exit") {
						process.exit(0);
					}
					finish(result);
				}).catch((error) => {
					if (!settled) {
						reject(error);
					}
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
				projectRoot: options.core.getProjectRoot(),
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

			// Auto-refresh silently. This runs while the board already owns the TUI,
			// so it must not create a separate loading screen.
			const refreshTimer = setInterval(() => {
				void (async () => {
					const refreshed = await loadProposalsForUnifiedView(options.core, {
						loadingScreenFactory: async () => null,
					});
					proposals = (refreshed.proposals || []).filter(
						(proposal) =>
							proposal.id &&
							proposal.id.trim() !== "" &&
							hasAnyPrefix(proposal.id),
					);
					kanbanStatuses = refreshed.statuses ?? kanbanStatuses;
					emitBoardUpdate();
				})();
			}, 5000);

			// Clean up timer when board exits
			const origResolve = resolve;
			resolve = ((value: ViewResult) => {
				clearInterval(refreshTimer);
				origResolve(value);
			}) as typeof resolve;
			});
			// Note: previously had a unified-view-level setInterval here that
			// called loadProposalsForUnifiedView() every 5s. That broke the board
			// because loadProposalsForUnifiedView creates a fresh blessed loading
			// screen (line 184) which paints over the live board on every tick,
			// AND its return value was discarded so closure state stayed stale.
			// board.ts has its own silent refresh via core.queryProposals (board.ts:2599)
			// which is the correct mechanism. Removed 2026-05-19.
		};

		// Function to show cockpit (formerly cubic dashboard)
		const showCockpit = async (): Promise<ViewResult> => {
			const t0 = performance.now();
			const { renderCockpit } = await import("./cockpit.ts");
			const t1 = performance.now();
			const screen = createScreen({ title: "Engineer's Cockpit" });
			const t2 = performance.now();

			// Resolve the user-configurable layout preference. Single source of
			// truth is FlagKeys.TUI_COCKPIT_LAYOUT (backed by core.runtime_flag,
			// so future web UI / in-TUI config screen can persist user choice).
			// Fallback chain when the resolver isn't yet initialized (the CLI
			// doesn't always boot it): env var AGENTHIVE_COCKPIT_LAYOUT → "grid".
			let cockpitLayout: "grid" | "stacked" = "grid";
			try {
				cockpitLayout = await runtimeConfig.get(FlagKeys.TUI_COCKPIT_LAYOUT);
			} catch {
				const envVal = process.env.AGENTHIVE_COCKPIT_LAYOUT;
				if (envVal === "stacked" || envVal === "grid") {
					cockpitLayout = envVal;
				}
			}

			return new Promise<ViewResult>((resolve) => {
				let _result: ViewResult = "exit";

				const onTabPress = () => {
					_result = "switch";
				};

				const t3 = performance.now();
				renderCockpit(screen, {
					agents: [],
					proposals: [],
					ledger: [],
					messages: [],
					layout: cockpitLayout,
				});
				const t4 = performance.now();
				if (process.env.AGENTHIVE_TUI_PERF) {
					console.error(`[cockpit-perf] import=${(t1 - t0).toFixed(1)}ms createScreen=${(t2 - t1).toFixed(1)}ms renderEmpty=${(t4 - t3).toFixed(1)}ms total=${(t4 - t0).toFixed(1)}ms`);
				}

				const refresh = async () => {
					const refreshStart = performance.now();
					const fetchStart = performance.now();
					// Cockpit only needs status counts + 5 recent proposals + agent
					// roster + messages + ledger. Replaced the previous 6-second
					// `core.queryProposals()` (which hydrated all 613 rows) with
					// these small aggregations / LIMIT 5..50 queries (~10ms total).
					//
					// IMPORTANT: queries are awaited SEQUENTIALLY. Promise.all of
					// these same five queries hangs indefinitely after the first
					// resolves — the pool's writePoolAudit step (in
					// infra/postgres/pool.ts query()) seems to serialize badly
					// under parallel load. Sequential is fast enough; revisit if
					// the underlying pool is fixed.
					const pgrows = async <T = any>(text: string): Promise<T[]> => {
						return pgQuery(text, []).then((r) => r.rows as T[]).catch(() => [] as T[]);
					};
					const statusCountRows = await pgrows(
						`SELECT status, count(*)::int AS n
						 FROM roadmap_proposal.proposal
						 WHERE status NOT IN ('Abandoned','Replaced','Rejected','REJECTED')
						 GROUP BY status`,
					);
					const recentProposalRows = await pgrows(
						`SELECT display_id, title, status, modified_at
						 FROM roadmap_proposal.proposal
						 WHERE status NOT IN ('Abandoned','Replaced','Rejected','REJECTED')
						 ORDER BY modified_at DESC
						 LIMIT 5`,
					);
					// Query roadmap.agency directly — that's the canonical
					// provider@host record (e.g. claude@bot, codex@bot) with a
					// real presence_state. Joins squad_dispatch to surface what
					// each agency is currently working on. The previous
					// agent_registry.agent_type taxonomy ('agency','llm',
					// 'coordinator',…) was an internal classification that
					// confused operators.
					// Use roadmap_workforce.agent_registry as the stable source.
					// roadmap.agency holds live heartbeats but gets cleared when
					// heartbeats lapse — using it as primary made the panel go
					// blank during quiet periods. We overlay live presence from
					// roadmap.agency when available, otherwise fall back to
					// "unknown" presence.
					const agentRows = await pgrows(
						`SELECT ar.agent_identity AS display_name,
						        ar.preferred_provider AS provider,
						        COALESCE(NULLIF(ar.host_affinity, ''), 'bot') AS host_id,
						        ar.role,
						        COALESCE(a.presence_state, 'unknown') AS presence_state,
						        COALESCE(a.status, 'unknown')         AS agency_status,
						        a.throttled_until,
						        COALESCE(a.last_heartbeat_at, ar.updated_at) AS last_heartbeat_at,
						        sd.proposal_id,
						        p.display_id AS current_proposal,
						        p.title      AS current_title,
						        sd.dispatch_role,
						        ac.headroom_pct,
						        ac.throttle_action,
						        ac.reset_at
						 FROM roadmap_workforce.agent_registry ar
						 LEFT JOIN roadmap.agency a
						   ON a.display_name = ar.agent_identity
						 LEFT JOIN LATERAL (
						   SELECT proposal_id, dispatch_role, dispatch_status, assigned_at
						   FROM roadmap_workforce.squad_dispatch
						   WHERE (worker_identity = ar.agent_identity
						          OR agent_identity = ar.agent_identity)
						     AND dispatch_status IN ('assigned','active','running','pending','offered','claimed')
						   ORDER BY assigned_at DESC LIMIT 1
						 ) sd ON true
						 LEFT JOIN roadmap_proposal.proposal p ON p.id = sd.proposal_id
						 LEFT JOIN roadmap_workforce.agency_capacity ac
						   ON ac.provider = ar.preferred_provider
						   AND ac.agency_id = ar.agent_identity
						 WHERE ar.status = 'active'
						   AND ar.agent_type = 'agency'
						   AND ar.preferred_provider IS NOT NULL
						   AND ar.agent_identity NOT IN (
						     -- Legacy bootstrap-agency names that pre-date the P996
						     -- canonical naming convention (provider.<owner>.a /
						     -- provider.<owner>.l). Filter from operator-facing UI
						     -- until the rows are renamed or retired.
						     'codex-agency-bot', 'codex/agency-bot',
						     'copilot-agency-gary',
						     'gemini-agency-bot',
						     'agency-bot',
						     'codex-liaison'
						   )
						 ORDER BY (sd.proposal_id IS NOT NULL) DESC,
						          ar.preferred_provider, ar.agent_identity
						 LIMIT 100`,
					);
					const msgRows = await pgrows(
						`SELECT from_agent, message_content, created_at FROM roadmap.message_ledger
						 WHERE channel = 'public' ORDER BY created_at DESC LIMIT 30`,
					);
					const ledgerRows = await pgrows(
						`SELECT agent_identity,
						        COALESCE(SUM(CASE WHEN recorded_at::date = CURRENT_DATE THEN cost_usd ELSE 0 END), 0) AS spent_today,
						        COALESCE(SUM(cost_usd), 0) AS total_spent,
						        COALESCE(MAX(budget_allocated_usd), 0) AS daily_limit
						 FROM roadmap.agent_budget_ledger
						 WHERE recorded_at > NOW() - INTERVAL '7 days'
						 GROUP BY agent_identity
						 ORDER BY spent_today DESC
						 LIMIT 10`,
					);
					const fetchEnd = performance.now();

					// Aggregate status counts into a {STATUS_UPPER: count} map.
					const pipelineCounts: Record<string, number> = {};
					let pipelineTotal = 0;
					for (const row of statusCountRows as any[]) {
						const key = String(row.status ?? "").toUpperCase();
						pipelineCounts[key] = (pipelineCounts[key] || 0) + Number(row.n);
						pipelineTotal += Number(row.n);
					}

					const transformStart = performance.now();
					const nowMs = Date.now();
					const agentData: WorkforceAgent[] = (agentRows as any[]).map((row: any) => {
						const throttleUntilMs = row.throttled_until
							? new Date(row.throttled_until).getTime()
							: undefined;
						const isThrottled = row.agency_status === "throttled"
							|| (throttleUntilMs !== undefined && throttleUntilMs > nowMs);
						const isOfflinePresence = row.presence_state === "offline"
							|| row.presence_state === "away";
						const status: WorkforceAgent["status"] =
							isThrottled       ? "throttled"
							: isOfflinePresence ? "offline"
							:                    "active";
						// P1365-AC6: Extract capacity data
						const capacityResetMs = row.reset_at
							? new Date(row.reset_at).getTime()
							: null;
						const capacityHeadroom = row.headroom_pct !== null && row.headroom_pct !== undefined
							? parseFloat(row.headroom_pct)
							: null;
						return {
							id: row.display_name,
							name: row.display_name,
							role: `${row.provider}@${row.host_id}`,
							status,
							presenceOnline: row.presence_state === "online" || row.presence_state === "busy",
							throttledUntil: throttleUntilMs,
							currentProposal: row.current_proposal
								? `${row.current_proposal}: ${row.current_title ?? ""}`
								: undefined,
							statusMessage: row.presence_state ?? "",
							lastSeen: row.last_heartbeat_at ? new Date(row.last_heartbeat_at).getTime() : Date.now(),
							// P1365-AC6: Capacity fields
							capacityHeadroomPct: capacityHeadroom,
							capacityThrottleAction: row.throttle_action ?? null,
							capacityResetAt: capacityResetMs,
						};
					});

					const cockpitMessages = (msgRows as any[])
						.reverse()
						.map((row: any) => ({
							sender_identity: row.from_agent,
							content: row.message_content,
							timestamp: new Date(row.created_at).getTime(),
						}));

					const ledgerData: LedgerEntry[] = (ledgerRows as any[]).map((row: any) => ({
						agent: row.agent_identity,
						dailyLimit: Number(row.daily_limit) || 0,
						spentToday: Number(row.spent_today) || 0,
						totalSpent: Number(row.total_spent) || 0,
						isFrozen: false,
					}));
					const transformEnd = performance.now();

					const renderStart = performance.now();
					renderCockpit(screen, {
						agents: agentData,
						proposals: (recentProposalRows as any[]).map((row: any) => ({
							id: row.display_id,
							display_id: row.display_id,
							title: row.title ?? "(untitled)",
							status: row.status ?? "",
							priority: "none",
							proposal_type: "proposal",
						})),
						pipelineTotal,
						pipelineCounts,
						ledger: ledgerData,
						messages: cockpitMessages,
						layout: cockpitLayout,
					});
					const renderEnd = performance.now();
					if (process.env.AGENTHIVE_TUI_PERF) {
						console.error(`[cockpit-refresh] fetch=${(fetchEnd - fetchStart).toFixed(1)}ms transform=${(transformEnd - transformStart).toFixed(1)}ms render=${(renderEnd - renderStart).toFixed(1)}ms total=${(renderEnd - refreshStart).toFixed(1)}ms`);
					}
				};

				// Initial render
				void refresh();

				// 1.5s interval. All queries are now small aggregations / LIMITs
				// (~20ms total), so we can afford near-live updates. The
				// refreshing flag still skips a tick if a previous refresh is
				// somehow stuck — defensive against DB hiccups.
				let refreshing = false;
				const timer = setInterval(() => {
					if (refreshing) return;
					refreshing = true;
					void refresh().finally(() => { refreshing = false; });
				}, 1500);

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

				renderHeadlines(screen, {
					messages: [],
					projectName: config?.projectName || "Roadmap.md",
				});

				const refresh = async () => {
					// Use the same source as the board's Feed pane so the two views
					// stay in sync. The Headlines view previously pulled only
					// message_ledger + state_transitions, missing maturity changes,
					// agent runs, lease/decision events, and token/cache ledgers
					// that the board feed has been showing for months.
					const { getBoardLiveFeed } = await import("./live-feed.ts");
					const events = await getBoardLiveFeed(100);

					// live-feed.ts already substitutes legacy hash identities with the
					// agent_cli ('claude'/'codex'/'gemini') for the agent_id column,
					// so the sender column reads cleanly here.
					const allMessages = events.map((e) => ({
						id: e.id,
						sender_identity: e.agentId || "system",
						content: e.message,
						timestamp: e.timestamp,
						channel_name: e.type,
					}));

					renderHeadlines(screen, {
						messages: allMessages as any[],
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

			// Pick the most-recently-active channel as the default. 'public' was
			// hardcoded and almost always empty (no system writes to it), so the
			// chat view rendered blank. Fall back to 'public' if no channel has
			// any messages — preserves the existing send behavior.
			let initialChannel = "public";
			try {
				const r = await pgQuery(
					`SELECT channel
					 FROM roadmap.message_ledger
					 WHERE channel IS NOT NULL
					 GROUP BY channel
					 ORDER BY max(created_at) DESC NULLS LAST
					 LIMIT 1`,
					[],
				);
				if (r.rows.length > 0 && r.rows[0].channel) {
					initialChannel = r.rows[0].channel as string;
				}
			} catch {
				// keep 'public' default if the query fails
			}

			return new Promise<ViewResult>((resolve) => {
				let _result: ViewResult = "exit";

				const onTabPress = () => {
					_result = "switch";
				};

				// Mutable so the sidebar can switch channels. onSend reads the
				// current value at send time.
				let currentChannel = initialChannel;
				const onSend = async (content: string) => {
					await pgQuery(
						`INSERT INTO roadmap.message_ledger (from_agent, channel, message_content, message_type) VALUES ($1, $2, $3, 'text')`,
						["HUMAN", currentChannel, content],
					);
				};
				// refresh is defined below; we forward-declare via a ref so the
				// channel-select handler can trigger an immediate refresh.
				let refreshRef: (() => void) | null = null;
				const onChannelSelect = (next: string) => {
					if (next && next !== currentChannel) {
						currentChannel = next;
						// Trigger an immediate refresh so the new channel's
						// messages load without waiting for the next 1s tick.
						refreshRef?.();
					}
				};

				// Forward declaration: the chat input binds Ctrl+C to onExit, which
				// needs to clear the refresh timer + destroy the screen. Timer is
				// declared below; closure captures it.
				let timer: ReturnType<typeof setInterval> | undefined;
				const onExit = () => {
					if (timer) clearInterval(timer);
					delete (screen as any)._chatContainer;
					(screen as any).destroy();
					resolve("exit");
				};
				const onSwitchView = () => {
					onTabPress();
					if (timer) clearInterval(timer);
					delete (screen as any)._chatContainer;
					(screen as any).destroy();
					resolve("switch");
				};

				renderChat(screen, {
					messages: [],
					channels: [currentChannel],
					currentChannel,
					projectName: config?.projectName || "Roadmap.md",
					userSystemName: "HUMAN",
					onSend,
					onExit,
					onChannelSelect,
					onSwitchView,
				});

				const refresh = async () => {
					// Sequential awaits — Promise.all of two pgQueries hangs after
					// the first resolves under the current pool's writePoolAudit
					// codepath (same bug the cockpit refresh hit). Sequential is
					// fast enough for a chat refresh.
					const channelRows = await pgQuery(
						`SELECT DISTINCT channel FROM roadmap.message_ledger WHERE channel IS NOT NULL ORDER BY channel LIMIT 50`,
						[],
					).then((r) => r.rows).catch(() => [] as any[]);
					const messageRows = await pgQuery(
						`SELECT id, from_agent, message_content, created_at FROM roadmap.message_ledger
						 WHERE channel = $1 ORDER BY created_at DESC LIMIT 100`,
						[currentChannel],
					).then((r) => r.rows.reverse()).catch(() => [] as any[]);

					renderChat(screen, {
						messages: (messageRows as any[]).map((row: any, index: number) => ({
							id: `${row.id ?? index}`,
							sender_identity: row.from_agent,
							content: row.message_content,
							timestamp: new Date(row.created_at).getTime(),
							channel_name: currentChannel,
						})),
						channels: (channelRows as any[]).map((r: any) => r.channel),
						currentChannel,
						projectName: config?.projectName || "Roadmap.md",
						userSystemName: "HUMAN",
						onSend,
						onChannelSelect,
						onSwitchView,
					});
				};
				refreshRef = () => { void refresh(); };

				void refresh();
				timer = setInterval(() => {
					void refresh();
				}, 1000);

				// Set up key handlers (fire only when input box is NOT focused —
				// see chat.ts for the in-input C-c rebind and Esc defocus path).
				(screen as any).key(["tab"], () => {
					onTabPress();
					if (timer) clearInterval(timer);
					delete (screen as any)._chatContainer;
					(screen as any).destroy();
					resolve("switch");
				});
				(screen as any).key(["q", "C-c"], () => {
					onExit();
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

	// Force a clean process exit. proposal-list (line 424) and kanban
	// (line 482) views already call process.exit(0) on their q paths, but
	// cockpit/headlines/chat just resolve("exit") and let the loop drain —
	// which leaves the pg pool and other handles keeping Node's event loop
	// alive, and the user's shell never gets its prompt back.
	process.exit(0);
}
