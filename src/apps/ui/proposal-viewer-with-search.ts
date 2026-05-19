/* Proposal viewer with search/filter header UI */

import { stdout as output } from "node:process";
import { Core } from "../../core/roadmap.ts";
import { DEFAULT_STATUSES } from "../../shared/constants/index.ts";
import {
	buildAcceptanceCriteriaItems,
	formatDateForDisplay,
	formatProposalPlainText,
} from "../../formatters/proposal-plain-text.ts";
import type {
	Directive,
	Proposal,
	ProposalSearchResult,
} from "../../shared/types/index.ts";
import { collectAvailableLabels } from "../../shared/utils/label-filter.ts";
import { hasAnyPrefix } from "../../shared/utils/prefix-config.ts";
import {
	applyProposalFilters,
	createProposalSearchIndex,
} from "../../shared/utils/proposal-search.ts";
import { attachSubproposalSummaries } from "../../shared/utils/proposal-subproposals.ts";
import {
	formatVersionLabel,
	getVersionInfo,
} from "../../shared/utils/version.ts";
import type {
	BoxInterface,
	LineInterface,
	ScreenInterface,
	ScrollableTextInterface,
} from "./blessed.ts";
import { box, line, scrollabletext } from "./blessed.ts";
import { formatChecklistItem } from "./checklist.ts";
import { transformCodePaths } from "./code-path.ts";
import {
	createFilterHeader,
	type FilterControlId,
	type FilterHeader,
	type FilterProposal,
} from "./components/filter-header.ts";
import {
	openMultiSelectFilterPopup,
	openSingleSelectFilterPopup,
} from "./components/filter-popup.ts";
import {
	createGenericList,
	type GenericList,
} from "./components/generic-list.ts";
import { formatFooterContent } from "./footer-content.ts";
import { createLoadingScreen } from "./loading.ts";
import {
	formatStatusWithIcon,
	getMaturityColor,
	getMaturityIcon,
	getProposalAccentColor,
	getStatusColor,
} from "./status-icon.ts";
import { createScreen } from "./tui.ts";
import { query as pgQuery } from "../../infra/postgres/pool.ts";

type DecisionRow = {
	decision: string;
	authority: string;
	rationale: string | null;
	binding: boolean;
	decided_at: string;
};
type ReviewRow = {
	reviewer_identity: string;
	verdict: string;
	notes: string | null;
	findings: string | null;
	is_blocking: boolean;
	reviewed_at: string;
};
type DiscussionRow = {
	author_identity: string;
	context_prefix: string | null;
	body: string;
	created_at: string;
};

function getRoadmapWebUrl(): string {
	const explicit = process.env.AGENTHIVE_ROADMAP_URL?.trim();
	if (explicit) return explicit.replace(/\/$/, "");
	const port = process.env.AGENTHIVE_ROADMAP_PORT?.trim() || "6420";
	return `http://127.0.0.1:${port}`;
}

async function fetchProposalFromWeb(
	proposalId: string,
): Promise<Record<string, unknown> | null> {
	const baseUrl = getRoadmapWebUrl();
	const idForUrl = encodeURIComponent(proposalId);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1500);
	try {
		const res = await fetch(`${baseUrl}/api/proposals/${idForUrl}`, {
			signal: controller.signal,
		});
		if (!res.ok) return null;
		return (await res.json()) as Record<string, unknown>;
	} catch {
		// Web server not running — caller falls back to direct pg.
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

type ProposalExtrasBundle = {
	decisions: DecisionRow[];
	reviews: ReviewRow[];
	discussions: DiscussionRow[];
	acceptanceCriteriaItems: Array<{
		index: number;
		text: string;
		checked: boolean;
		role?: string;
		evidence?: string;
	}>;
	activityLog: Array<{
		timestamp: string;
		actor: string;
		action: string;
		reason?: string;
	}>;
};

const EMPTY_EXTRAS_BUNDLE: ProposalExtrasBundle = {
	decisions: [],
	reviews: [],
	discussions: [],
	acceptanceCriteriaItems: [],
	activityLog: [],
};

// Single-roundtrip aggregate query so the popup acquires ONE pool slot
// instead of 3-4 parallel ones (which used to time-out at 5 s when
// the per-process pg-Pool was contended).
async function fetchProposalExtrasFromPg(
	proposalId: string,
): Promise<ProposalExtrasBundle> {
	const idNum = parseInt(proposalId.replace(/^[A-Za-z-]+/, ""), 10);
	if (Number.isNaN(idNum)) return EMPTY_EXTRAS_BUNDLE;
	try {
		const { rows } = await pgQuery<{
			decisions: DecisionRow[] | null;
			reviews: ReviewRow[] | null;
			discussions: DiscussionRow[] | null;
			acceptance_criteria: ProposalExtrasBundle["acceptanceCriteriaItems"] | null;
			activity_log: ProposalExtrasBundle["activityLog"] | null;
		}>(
			`
			SELECT
				(SELECT COALESCE(jsonb_agg(d ORDER BY d.decided_at DESC), '[]'::jsonb)
				   FROM (SELECT decision, authority, rationale, binding, decided_at
				           FROM roadmap_proposal.proposal_decision
				          WHERE proposal_id = $1) d) AS decisions,
				(SELECT COALESCE(jsonb_agg(r ORDER BY r.reviewed_at DESC), '[]'::jsonb)
				   FROM (SELECT reviewer_identity, verdict, notes, findings,
				                is_blocking, reviewed_at
				           FROM roadmap_proposal.proposal_reviews
				          WHERE proposal_id = $1) r) AS reviews,
				(SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb)
				   FROM (SELECT author_identity, context_prefix,
				                COALESCE(body, body_markdown) AS body,
				                created_at
				           FROM roadmap_proposal.proposal_discussions
				          WHERE proposal_id = $1) x) AS discussions,
				(SELECT COALESCE(jsonb_agg(jsonb_build_object(
				          'index', ac.item_number,
				          'text', ac.criterion_text,
				          'checked', ac.status = 'pass',
				          'role', ac.verified_by,
				          'evidence', ac.verification_notes
				        ) ORDER BY ac.item_number ASC), '[]'::jsonb)
				   FROM roadmap_proposal.proposal_acceptance_criteria ac
				  WHERE ac.proposal_id = $1) AS acceptance_criteria,
				(SELECT COALESCE(jsonb_agg(
				          jsonb_build_object(
				            'timestamp', e->>'TS',
				            'actor', COALESCE(e->>'Agent', 'system'),
				            'action',
				              CASE
				                WHEN e->>'Activity' = 'Created' THEN 'created proposal'
				                WHEN e->>'Activity' = 'StatusChange' THEN
				                  'state ' || COALESCE(e->>'From', '?') ||
				                  ' → ' || COALESCE(e->>'To', '?')
				                WHEN e->>'Activity' = 'MaturityChange' THEN
				                  'maturity ' || COALESCE(e->>'From', 'new') ||
				                  ' → ' || COALESCE(e->>'To', '?')
				                WHEN e->>'Activity' = 'LeaseClaim' THEN 'lease claimed'
				                WHEN e->>'Activity' = 'LeaseRelease' THEN 'lease released'
				                WHEN e->>'Activity' = 'ReviewSubmitted' THEN 'review submitted'
				                ELSE COALESCE(e->>'Activity', '(unknown)')
				              END,
				            'reason', e->>'Reason'
				          )
				        ORDER BY ord), '[]'::jsonb)
				   FROM roadmap_proposal.proposal p,
				        LATERAL jsonb_array_elements(p.audit)
				          WITH ORDINALITY AS t(e, ord)
				  WHERE p.id = $1) AS activity_log
			`,
			[idNum],
		);
		const r = rows[0];
		if (!r) return EMPTY_EXTRAS_BUNDLE;
		return {
			decisions: r.decisions ?? [],
			reviews: r.reviews ?? [],
			discussions: r.discussions ?? [],
			acceptanceCriteriaItems: r.acceptance_criteria ?? [],
			activityLog: r.activity_log ?? [],
		};
	} catch (err) {
		console.error(
			`[popup] pg fetch for ${proposalId} failed: ${(err as Error).message}`,
		);
		return EMPTY_EXTRAS_BUNDLE;
	}
}

async function fetchProposalDetailExtras(proposalId: string): Promise<{
	decisions: DecisionRow[];
	reviews: ReviewRow[];
	discussions: DiscussionRow[];
}> {
	const baseUrl = getRoadmapWebUrl();
	const idForUrl = encodeURIComponent(proposalId);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 4000);

	try {
		const [decRes, revRes, noteRes] = await Promise.all([
			fetch(`${baseUrl}/api/proposals/${idForUrl}/decisions`, {
				signal: controller.signal,
			}),
			fetch(`${baseUrl}/api/proposals/${idForUrl}/reviews`, {
				signal: controller.signal,
			}),
			fetch(`${baseUrl}/api/proposals/${idForUrl}/notes`, {
				signal: controller.signal,
			}),
		]);
		if (!decRes.ok || !revRes.ok || !noteRes.ok) {
			console.error(
				`[popup] web service returned ${decRes.status}/${revRes.status}/${noteRes.status}`,
			);
			return { decisions: [], reviews: [], discussions: [] };
		}
		const decBody = (await decRes.json()) as { decisions?: DecisionRow[] };
		const revBody = (await revRes.json()) as { reviews?: ReviewRow[] };
		const noteBody = (await noteRes.json()) as {
			notes?: Array<DiscussionRow & { body_markdown?: string }>;
		};
		return {
			decisions: decBody.decisions ?? [],
			reviews: revBody.reviews ?? [],
			discussions: (noteBody.notes ?? []).map((n) => ({
				author_identity: n.author_identity,
				context_prefix: n.context_prefix,
				body: (n as { body?: string; body_markdown?: string }).body
					?? n.body_markdown
					?? "",
				created_at: n.created_at,
			})),
		};
	} catch (err) {
		// Service unreachable — show popup with empty extras rather than
		// hammering the per-process pg pool which is what caused
		// "timeout exceeded when trying to connect" in the first place.
		console.error(
			`[popup] failed to fetch extras for ${proposalId} via ${baseUrl}: ${(err as Error).message}`,
		);
		return { decisions: [], reviews: [], discussions: [] };
	} finally {
		clearTimeout(timeout);
	}
}


function getPriorityDisplay(priority?: "high" | "medium" | "low"): string {
	switch (priority) {
		case "high":
			return " {red-fg}●{/}";
		case "medium":
			return " {yellow-fg}●{/}";
		case "low":
			return " {green-fg}●{/}";
		default:
			return "";
	}
}

function formatSectionHeading(title: string, color: string): string {
	return `{bold}{${color}-fg}▍ ${title}{/${color}-fg}{/bold}`;
}

function formatCurrentStateLine(proposal: Proposal): string {
	const statusColor = getStatusColor(proposal.status);
	const maturity = proposal.maturity ?? "unknown";
	const maturityColor = getMaturityColor(maturity);
	return [
		"{bold}Current:{/bold}",
		`{blink}{${statusColor}-fg}${proposal.status}{/}{/}`,
		"{gray-fg}·{/}",
		`{blink}{${maturityColor}-fg}${maturity}{/}{/}`,
	].join(" ");
}

function formatActivityThread(
	activityLog: Proposal["activityLog"],
): string[] {
	if (!activityLog || activityLog.length === 0) {
		return ["{gray-fg}No proposal activity yet{/}"];
	}

	const lines: string[] = [];
	const lastIndex = activityLog.length - 1;

	for (const [index, entry] of activityLog.entries()) {
		const branch = index === lastIndex ? "└" : "├";
		const reason = entry.reason ? ` {gray-fg}(${entry.reason}){/}` : "";
		lines.push(
			`  {cyan-fg}${branch}─{/} ${entry.timestamp} {gray-fg}|{/} {magenta-fg}${entry.actor}{/} {gray-fg}|{/} ${entry.action}${reason}`,
		);
	}

	return lines;
}

function escapeCodeBlockText(text: string): string {
	return text.replace(/[{}]/g, (ch) => (ch === "{" ? "{open}" : "{close}"));
}

function formatMarkdownBody(text: string): string {
	if (!text) return "";

	const rendered: string[] = [];
	let inCodeBlock = false;
	let codeLanguage = "code";

	for (const line of text.split("\n")) {
		const fenceMatch = line.match(/^\s*```([\w-]+)?\s*$/);
		if (fenceMatch) {
			if (!inCodeBlock) {
				inCodeBlock = true;
				codeLanguage = fenceMatch[1] || "code";
				rendered.push(`{gray-fg}┌─ ${codeLanguage} ─{/}`);
			} else {
				inCodeBlock = false;
				rendered.push("{gray-fg}└───────────────{/}");
			}
			continue;
		}

		if (inCodeBlock) {
			rendered.push(`{cyan-fg}│{/} ${escapeCodeBlockText(line)}`);
			continue;
		}

		rendered.push(transformCodePaths(line));
	}

	return rendered.join("\n");
}

function createDirectiveLabelResolver(
	directives: Directive[],
): (directive: string) => string {
	const directiveLabelsByKey = new Map<string, string>();
	for (const directive of directives) {
		const normalizedId = directive.id.trim();
		const normalizedTitle = directive.title.trim();
		if (!normalizedId || !normalizedTitle) continue;
		directiveLabelsByKey.set(normalizedId.toLowerCase(), normalizedTitle);
		const idMatch = normalizedId.match(/^m-(\d+)$/i);
		if (idMatch?.[1]) {
			const numericAlias = String(Number.parseInt(idMatch[1], 10));
			directiveLabelsByKey.set(`m-${numericAlias}`, normalizedTitle);
			directiveLabelsByKey.set(numericAlias, normalizedTitle);
		}
		directiveLabelsByKey.set(normalizedTitle.toLowerCase(), normalizedTitle);
	}

	return (directive: string) => {
		const normalized = directive.trim();
		if (!normalized) return directive;
		return directiveLabelsByKey.get(normalized.toLowerCase()) ?? directive;
	};
}

export function buildProposalViewerDirectiveFilterModel(
	activeDirectives: Directive[],
): {
	availableDirectiveTitles: string[];
	resolveDirectiveLabel: (directive: string) => string;
} {
	return {
		availableDirectiveTitles: activeDirectives.map(
			(directive) => directive.title,
		),
		resolveDirectiveLabel: createDirectiveLabelResolver(activeDirectives),
	};
}

export type ProposalListBoundaryDirection = "up" | "down";
export type PendingSearchWrap = "to-first" | "to-last" | null;
type PaneFocus = "list" | "detail";

export function shouldMoveFromListBoundaryToSearch(
	direction: ProposalListBoundaryDirection,
	selectedIndex: number,
	totalProposals: number,
): boolean {
	if (totalProposals <= 0) {
		return false;
	}
	if (direction === "up") {
		return selectedIndex <= 0;
	}
	return selectedIndex >= totalProposals - 1;
}

export function shouldMoveFromDetailBoundaryToSearch(
	direction: ProposalListBoundaryDirection,
	scrollOffset: number,
): boolean {
	if (direction !== "up") {
		return false;
	}
	return scrollOffset <= 0;
}

export function resolveSearchExitTargetIndex(
	direction: "up" | "down" | "escape",
	pendingWrap: PendingSearchWrap,
	totalProposals: number,
	currentIndex: number | undefined,
): number | undefined {
	if (totalProposals <= 0) {
		return undefined;
	}
	if (direction === "up" && pendingWrap === "to-last") {
		return totalProposals - 1;
	}
	if (direction === "down" && pendingWrap === "to-first") {
		return 0;
	}
	return currentIndex;
}

export function resolveFilterExitPane(
	preferredPane: PaneFocus,
	hasProposalList: boolean,
	hasDetailPane: boolean,
): PaneFocus | null {
	if (preferredPane === "detail" && hasDetailPane) {
		return "detail";
	}
	if (hasProposalList) {
		return "list";
	}
	if (hasDetailPane) {
		return "detail";
	}
	return null;
}

/**
 * Display proposal details with search/filter header UI
 */
export async function viewProposalEnhanced(
	proposal: Proposal,
	options: {
		proposals?: Proposal[];
		core?: Core;
		title?: string;
		filterDescription?: string;
		searchQuery?: string;
		statusFilter?: string;
		priorityFilter?: string;
		directiveFilter?: string;
		labelFilter?: string[];
		startWithDetailFocus?: boolean;
		startWithSearchFocus?: boolean;
		viewSwitcher?: import("./view-switcher.ts").ViewSwitcher;
		onProposalChange?: (proposal: Proposal) => void;
		onTabPress?: () => Promise<void>;
		onFilterChange?: (filters: {
			searchQuery: string;
			statusFilter: string;
			priorityFilter: string;
			labelFilter: string[];
			directiveFilter: string;
		}) => void;
	} = {},
): Promise<void> {
	if (output.isTTY === false) {
		console.log(formatProposalPlainText(proposal));
		return;
	}

	// Get project root and setup services
	const cwd = process.cwd();
	const core = options.core || new Core(cwd, { enableWatchers: true });

	// Show loading screen while loading proposals (can be slow with cross-branch loading)
	let allProposals: Proposal[];
	let statuses: string[];
	let labels: string[];
	let availableLabels: string[] = [];
	// When proposals are provided, use in-memory search; otherwise use ContentStore-backed search
	let proposalSearchIndex: ReturnType<typeof createProposalSearchIndex> | null =
		null;
	let searchService: Awaited<ReturnType<typeof core.getSearchService>> | null =
		null;
	let contentStore: Awaited<ReturnType<typeof core.getContentStore>> | null =
		null;
	const directiveEntities = await core.filesystem.listDirectives();
	const { availableDirectiveTitles, resolveDirectiveLabel } =
		buildProposalViewerDirectiveFilterModel(directiveEntities);

	if (options.proposals) {
		// Proposals already provided - use in-memory search (no ContentStore loading)
		allProposals = options.proposals.filter(
			(t) => t.id && t.id.trim() !== "" && hasAnyPrefix(t.id),
		);
		const config = await core.filesystem.loadConfig();
		statuses = config?.statuses || [...DEFAULT_STATUSES];
		labels = config?.labels || [];
		proposalSearchIndex = createProposalSearchIndex(allProposals);
	} else {
		// Need to load proposals - show loading screen
		const loadingScreen = await createLoadingScreen("Loading proposals");
		try {
			loadingScreen?.update("Loading configuration...");
			const config = await core.filesystem.loadConfig();
			statuses = config?.statuses || [...DEFAULT_STATUSES];
			labels = config?.labels || [];

			loadingScreen?.update("Loading proposals from branches...");
			contentStore = await core.getContentStore();
			searchService = await core.getSearchService();

			loadingScreen?.update("Preparing proposal list...");
			const proposals = await core.queryProposals();
			allProposals = proposals.filter(
				(t) => t.id && t.id.trim() !== "" && hasAnyPrefix(t.id),
			);
		} finally {
			await loadingScreen?.close();
		}
	}

	// Collect available labels from config and proposals
	availableLabels = collectAvailableLabels(allProposals, labels);

	// Proposal for filtering - normalize filters to match configured values
	let searchQuery = options.searchQuery || "";

	// Find the canonical status value from configured statuses (case-insensitive)
	let statusFilter = "";
	if (options.statusFilter) {
		const lowerFilter = options.statusFilter.toLowerCase();
		const matchedStatus = statuses.find((s) => s.toLowerCase() === lowerFilter);
		statusFilter = matchedStatus || "";
	}

	// Priority is already lowercase
	let priorityFilter = options.priorityFilter || "";
	let labelFilter: string[] = [];
	let directiveFilter = options.directiveFilter || "";
	let filteredProposals = [...allProposals];

	if (options.labelFilter && options.labelFilter.length > 0) {
		const availableSet = new Set(
			availableLabels.map((label) => label.toLowerCase()),
		);
		labelFilter = options.labelFilter.filter((label) =>
			availableSet.has(label.toLowerCase()),
		);
	}

	const versionInfo = await getVersionInfo();
	const versionLabel = formatVersionLabel(versionInfo);

	const filtersActive = Boolean(
		searchQuery ||
			statusFilter ||
			priorityFilter ||
			labelFilter.length > 0 ||
			directiveFilter,
	);
	let requireInitialFilterSelection = filtersActive;

	const enrichProposal = (candidate: Proposal | null): Proposal | null => {
		if (!candidate) return null;
		return attachSubproposalSummaries(candidate, allProposals);
	};

	// Find the initial selected proposal
	let currentSelectedProposal = enrichProposal(proposal) ?? proposal;
	let selectionRequestId = 0;
	let noResultsMessage: string | null = null;

	const screen = createScreen({
		title: `${options.title || "Roadmap Proposals"} - ${versionLabel}`,
	});

	// Main container
	const container = box({
		parent: screen,
		width: "100%",
		height: "100%",
	});

	// Version indicator at top right
	box({
		parent: container,
		top: 0,
		right: 1,
		width: "shrink",
		height: 1,
		content: `{gray-fg}Roadmap.md ${versionLabel}{/}`,
		tags: true,
		zIndex: 100,
	});

	// Proposal for tracking focus
	let currentFocus: "filters" | "list" | "detail" = "list";
	let filterPopupOpen = false;
	let pendingSearchWrap: PendingSearchWrap = null;
	let filterExitPane: PaneFocus = "list";

	// Create filter header component
	let filterHeader: FilterHeader;

	const focusFilterControl = (filterId: FilterControlId) => {
		switch (filterId) {
			case "search":
				filterHeader.focusSearch();
				break;
			case "status":
				filterHeader.focusStatus();
				break;
			case "priority":
				filterHeader.focusPriority();
				break;
			case "directive":
				filterHeader.focusDirective();
				break;
			case "labels":
				filterHeader.focusLabels();
				break;
		}
	};

	const openFilterPicker = async (
		filterId: Exclude<FilterControlId, "search">,
	) => {
		if (filterPopupOpen) {
			return;
		}
		filterPopupOpen = true;

		try {
			if (filterId === "labels") {
				const nextLabels = await openMultiSelectFilterPopup({
					screen,
					title: "Label Filter",
					items: [...availableLabels].sort((a, b) => a.localeCompare(b)),
					selectedItems: labelFilter,
				});
				if (nextLabels !== null) {
					labelFilter = nextLabels;
					filterHeader.setFilters({ labels: nextLabels });
					applyFilters();
					notifyFilterChange();
				}
				return;
			}

			if (filterId === "status") {
				const selected = await openSingleSelectFilterPopup({
					screen,
					title: "Status Filter",
					selectedValue: statusFilter,
					choices: [
						{ label: "All", value: "" },
						...statuses.map((status) => ({ label: status, value: status })),
					],
				});
				if (selected !== null) {
					statusFilter = selected;
					filterHeader.setFilters({ status: selected });
					applyFilters();
					notifyFilterChange();
				}
				return;
			}

			if (filterId === "priority") {
				const priorities = ["high", "medium", "low"];
				const selected = await openSingleSelectFilterPopup({
					screen,
					title: "Priority Filter",
					selectedValue: priorityFilter,
					choices: [
						{ label: "All", value: "" },
						...priorities.map((priority) => ({
							label: priority,
							value: priority,
						})),
					],
				});
				if (selected !== null) {
					priorityFilter = selected;
					filterHeader.setFilters({ priority: selected });
					applyFilters();
					notifyFilterChange();
				}
				return;
			}

			const selected = await openSingleSelectFilterPopup({
				screen,
				title: "Directive Filter",
				selectedValue: directiveFilter,
				choices: [
					{ label: "All", value: "" },
					...availableDirectiveTitles.map((directive) => ({
						label: directive,
						value: directive,
					})),
				],
			});
			if (selected !== null) {
				directiveFilter = selected;
				filterHeader.setFilters({ directive: selected });
				applyFilters();
				notifyFilterChange();
			}
		} finally {
			filterPopupOpen = false;
			focusFilterControl(filterId);
			screen.render();
		}
	};

	filterHeader = createFilterHeader({
		parent: container,
		statuses,
		availableLabels,
		availableDirectives: availableDirectiveTitles,
		initialFilters: {
			search: searchQuery,
			status: statusFilter,
			priority: priorityFilter,
			labels: labelFilter,
			directive: directiveFilter,
		},
		onFilterChange: (filters: FilterProposal) => {
			searchQuery = filters.search;
			statusFilter = filters.status;
			priorityFilter = filters.priority;
			labelFilter = filters.labels;
			directiveFilter = filters.directive;
			applyFilters();
			notifyFilterChange();
		},
		onFilterPickerOpen: (filterId) => {
			void openFilterPicker(filterId);
		},
	});

	// Handle focus changes from filter header
	filterHeader.setFocusChangeHandler((focus) => {
		if (focus !== null) {
			if (currentFocus !== "filters") {
				filterExitPane = currentFocus === "detail" ? "detail" : "list";
			}
			currentFocus = "filters";
			setActivePane("none");
			updateHelpBar();
		}
	});
	filterHeader.setExitRequestHandler((direction) => {
		filterHeader.setBorderColor("cyan");
		const targetPane = resolveFilterExitPane(
			filterExitPane,
			Boolean(proposalList),
			Boolean(descriptionBox),
		);
		if (targetPane === "list" && proposalList) {
			const selected = proposalList.getSelectedIndex();
			const currentIndex = Array.isArray(selected) ? selected[0] : selected;
			const targetIndex = resolveSearchExitTargetIndex(
				direction,
				pendingSearchWrap,
				filteredProposals.length,
				currentIndex,
			);
			focusProposalList(targetIndex);
		} else if (targetPane === "detail" && descriptionBox) {
			focusDetailPane();
		}
		pendingSearchWrap = null;
	});

	// Get dynamic header height
	const getHeaderHeight = () => filterHeader.getHeight();

	// Proposal list pane (left 40%)
	const proposalListPane = box({
		parent: container,
		top: getHeaderHeight(),
		left: 0,
		width: "40%",
		height: `100%-${getHeaderHeight() + 1}`,
		border: { type: "line" },
		style: { border: { fg: "gray" } },
		label: `\u00A0Proposals (${filteredProposals.length})\u00A0`,
	});

	// Detail pane - use right: 0 to ensure it extends to window edge
	const detailPane = box({
		parent: container,
		top: getHeaderHeight(),
		left: "40%",
		right: 0,
		height: `100%-${getHeaderHeight() + 1}`,
		border: { type: "line" },
		style: { border: { fg: "gray" } },
		label: "\u00A0Details\u00A0",
	});

	// Help bar at bottom
	const helpBar = box({
		parent: container,
		bottom: 0,
		left: 0,
		width: "100%",
		height: 1,
		tags: true,
		wrap: true,
		content: "",
	});
	let transientHelpContent: string | null = null;
	let helpRestoreTimer: ReturnType<typeof setTimeout> | null = null;

	function showTransientHelp(message: string, durationMs = 3000) {
		transientHelpContent = message;
		if (helpRestoreTimer) {
			clearTimeout(helpRestoreTimer);
			helpRestoreTimer = null;
		}
		updateHelpBar();
		helpRestoreTimer = setTimeout(() => {
			transientHelpContent = null;
			helpRestoreTimer = null;
			updateHelpBar();
		}, durationMs);
	}

	function getTerminalWidth(): number {
		return typeof screen.width === "number" ? screen.width : 80;
	}

	function syncPaneLayout() {
		const headerHeight = filterHeader.getHeight();
		const footerHeight =
			typeof helpBar.height === "number" ? helpBar.height : 1;
		proposalListPane.top = headerHeight;
		proposalListPane.height = `100%-${headerHeight + footerHeight}`;
		detailPane.top = headerHeight;
		detailPane.height = `100%-${headerHeight + footerHeight}`;
	}

	function setHelpBarContent(content: string) {
		const formatted = formatFooterContent(content, getTerminalWidth());
		helpBar.height = formatted.height;
		helpBar.setContent(formatted.content);
		syncPaneLayout();
	}

	function setActivePane(active: "list" | "detail" | "none") {
		const listBorder = proposalListPane.style as { border?: { fg?: string } };
		const detailBorder = detailPane.style as { border?: { fg?: string } };
		if (listBorder.border)
			listBorder.border.fg = active === "list" ? "yellow" : "gray";
		if (detailBorder.border)
			detailBorder.border.fg = active === "detail" ? "yellow" : "gray";
	}

	function focusProposalList(targetIndex?: number): void {
		if (!proposalList) {
			if (descriptionBox) {
				currentFocus = "detail";
				setActivePane("detail");
				descriptionBox.focus();
				updateHelpBar();
				screen.render();
			}
			return;
		}
		currentFocus = "list";
		setActivePane("list");
		if (typeof targetIndex === "number") {
			proposalList.setSelectedIndex(targetIndex);
		}
		proposalList.focus();
		updateHelpBar();
		screen.render();
	}

	function focusDetailPane(): void {
		if (!descriptionBox) return;
		currentFocus = "detail";
		setActivePane("detail");
		descriptionBox.focus();
		updateHelpBar();
		screen.render();
	}

	// Helper to notify filter changes
	function notifyFilterChange() {
		if (options.onFilterChange) {
			options.onFilterChange({
				searchQuery,
				statusFilter,
				priorityFilter,
				labelFilter,
				directiveFilter,
			});
		}
	}

	// Function to apply filters and refresh the proposal list
	function applyFilters() {
		const hasActiveFilters = Boolean(
			searchQuery.trim() ||
				statusFilter ||
				priorityFilter ||
				labelFilter.length > 0 ||
				directiveFilter,
		);
		if (!hasActiveFilters) {
			filteredProposals = [...allProposals];
		} else if (proposalSearchIndex) {
			filteredProposals = applyProposalFilters(
				allProposals,
				{
					query: searchQuery,
					status: statusFilter || undefined,
					priority: priorityFilter as "high" | "medium" | "low" | undefined,
					labels: labelFilter,
					directive: directiveFilter || undefined,
					resolveDirectiveLabel,
				},
				proposalSearchIndex,
			);
		} else if (searchService) {
			const searchResults = searchService.search({
				query: searchQuery,
				filters: {
					status: statusFilter || undefined,
					priority: priorityFilter as "high" | "medium" | "low" | undefined,
					labels: labelFilter.length > 0 ? labelFilter : undefined,
				},
				types: ["proposal"],
			});
			filteredProposals = searchResults
				.filter((r): r is ProposalSearchResult => r.type === "proposal")
				.map((r) => r.proposal);
			if (directiveFilter) {
				filteredProposals = filteredProposals.filter((proposal) => {
					if (!proposal.directive) return false;
					const proposalDirectiveTitle = resolveDirectiveLabel(
						proposal.directive,
					);
					return (
						proposalDirectiveTitle.toLowerCase() ===
						directiveFilter.toLowerCase()
					);
				});
			}
		} else {
			filteredProposals = [...allProposals];
		}

		// Update the proposal list label
		if (proposalListPane.setLabel) {
			proposalListPane.setLabel(
				`\u00A0Proposals (${filteredProposals.length})\u00A0`,
			);
		}

		if (filteredProposals.length === 0) {
			if (proposalList) {
				proposalList.destroy();
				proposalList = null;
			}
			const activeFilters: string[] = [];
			const trimmedQuery = searchQuery.trim();
			if (trimmedQuery) {
				activeFilters.push(`Search: {cyan-fg}${trimmedQuery}{/}`);
			}
			if (statusFilter) {
				activeFilters.push(`Status: {cyan-fg}${statusFilter}{/}`);
			}
			if (priorityFilter) {
				activeFilters.push(`Priority: {cyan-fg}${priorityFilter}{/}`);
			}
			if (labelFilter.length > 0) {
				activeFilters.push(`Labels: {yellow-fg}${labelFilter.join(", ")}{/}`);
			}
			if (directiveFilter) {
				activeFilters.push(`Directive: {magenta-fg}${directiveFilter}{/}`);
			}
			let listPaneMessage: string;
			if (activeFilters.length > 0) {
				noResultsMessage = `{bold}No proposals match your current filters{/bold}\n${activeFilters.map((f) => ` • ${f}`).join("\n")}\n\n{gray-fg}Try adjusting the search or clearing filters.{/}`;
				listPaneMessage = `{bold}No matching proposals{/bold}\n\n${activeFilters.map((f) => ` • ${f}`).join("\n")}`;
			} else {
				noResultsMessage =
					"{bold}No proposals available{/bold}\n{gray-fg}Create a proposal with {cyan-fg}roadmap proposal create{/cyan-fg}.{/}";
				listPaneMessage = "{bold}No proposals available{/bold}";
			}
			showListEmptyProposal(listPaneMessage);
			refreshDetailPane();
			screen.render();
			return;
		}

		noResultsMessage = null;
		hideListEmptyProposal();

		if (proposalList) {
			proposalList.destroy();
			proposalList = null;
		}
		const listController = createProposalList();
		proposalList = listController;
		if (listController) {
			const forceFirst = requireInitialFilterSelection;
			let desiredIndex = filteredProposals.findIndex(
				(t) => t.id === currentSelectedProposal.id,
			);
			if (forceFirst || desiredIndex < 0) {
				desiredIndex = 0;
			}
			const currentIndexRaw = listController.getSelectedIndex();
			const currentIndex = Array.isArray(currentIndexRaw)
				? (currentIndexRaw[0] ?? 0)
				: currentIndexRaw;
			if (forceFirst || currentIndex !== desiredIndex) {
				listController.setSelectedIndex(desiredIndex);
			}
			requireInitialFilterSelection = false;
		}

		// Ensure detail pane is refreshed when transitioning from no-results to results
		refreshDetailPane();
		screen.render();
	}

	// Proposal list component
	let proposalList: GenericList<Proposal> | null = null;
	let listEmptyProposalBox: BoxInterface | null = null;

	function showListEmptyProposal(message: string) {
		if (listEmptyProposalBox) {
			listEmptyProposalBox.destroy();
		}
		listEmptyProposalBox = box({
			parent: proposalListPane,
			top: 1,
			left: 1,
			width: "100%-4",
			height: "100%-3",
			content: message,
			tags: true,
			style: { fg: "gray" },
		});
	}

	function hideListEmptyProposal() {
		if (listEmptyProposalBox) {
			listEmptyProposalBox.destroy();
			listEmptyProposalBox = null;
		}
	}

	async function applySelection(selectedProposal: Proposal | null) {
		if (!selectedProposal) return;
		if (
			currentSelectedProposal &&
			selectedProposal.id === currentSelectedProposal.id
		) {
			return;
		}
		const requestId = ++selectionRequestId;
		const refreshed = await core.getProposalWithSubproposals(
			selectedProposal.id,
			allProposals,
		);
		if (requestId !== selectionRequestId) {
			return;
		}
		const nextSelected =
			refreshed ?? enrichProposal(selectedProposal) ?? selectedProposal;
		currentSelectedProposal = nextSelected;
		options.onProposalChange?.(nextSelected);
		refreshDetailPane();
		screen.render();
	}

	function createProposalList(): GenericList<Proposal> | null {
		const initialIndex = Math.max(
			0,
			filteredProposals.findIndex((t) => t.id === currentSelectedProposal.id),
		);

		proposalList = createGenericList<Proposal>({
			parent: proposalListPane,
			title: "",
			items: filteredProposals,
			selectedIndex: initialIndex,
			border: false,
			top: 1,
			left: 1,
			width: "100%-4",
			height: "100%-3",
			itemRenderer: (proposal: Proposal) => {
				const statusIcon = formatStatusWithIcon(proposal.status);
				const statusColor = getStatusColor(proposal.status);
				const maturityColor = getMaturityColor((proposal as any).maturity);
				const maturityIcon = getMaturityIcon((proposal as any).maturity);

				const assigneeText = proposal.assignee?.length
					? ` {cyan-fg}${proposal.assignee[0]?.startsWith("@") ? proposal.assignee[0] : `@${proposal.assignee[0]}`}{/}`
					: "";
				const labelsText = proposal.labels?.length
					? ` {yellow-fg}[${proposal.labels.join(", ")}]{/}`
					: "";
				const priorityText = getPriorityDisplay(proposal.priority);
				const isCrossBranch = Boolean(
					(proposal as Proposal & { branch?: string }).branch,
				);
				const branchText = isCrossBranch
					? ` {green-fg}(${(proposal as Proposal & { branch?: string }).branch}){/}`
					: "";

				const displayId = proposal.id.replace(/^STATE-/, "STEP-");
				const content = `{${maturityColor}-fg}${maturityIcon}{/}{${statusColor}-fg}${statusIcon}{/} {bold}${displayId}{/bold} - ${proposal.title}${priorityText}${assigneeText}${labelsText}${branchText}`;
				// Dim cross-branch proposals to indicate read-only status
				return isCrossBranch ? `{gray-fg}${content}{/}` : content;
			},
			onSelect: (selected: Proposal | Proposal[]) => {
				const selectedProposal = Array.isArray(selected)
					? selected[0]
					: selected;
				void applySelection(selectedProposal || null);
			},
			onHighlight: (selected: Proposal | null) => {
				void applySelection(selected);
			},
			onBoundaryNavigation: (direction, selectedIndex, total) => {
				if (
					!shouldMoveFromListBoundaryToSearch(direction, selectedIndex, total)
				) {
					return false;
				}
				pendingSearchWrap = direction === "up" ? "to-last" : "to-first";
				filterHeader.focusSearch();
				return true;
			},
			showHelp: false,
		});

		// Focus handler for proposal list
		if (proposalList) {
			const listBox = proposalList.getListBox();
			listBox.on("focus", () => {
				currentFocus = "list";
				setActivePane("list");
				screen.render();
				updateHelpBar();
			});
			listBox.on("blur", () => {
				setActivePane("none");
				screen.render();
			});
			listBox.key(["right", "l"], () => {
				focusDetailPane();
				return false;
			});
		}

		return proposalList;
	}

	// Detail pane refresh function
	let headerDetailBox: BoxInterface | undefined;
	let divider: LineInterface | undefined;
	let descriptionBox: ScrollableTextInterface | undefined;

	function refreshDetailPane() {
		if (headerDetailBox) headerDetailBox.destroy();
		if (divider) divider.destroy();
		if (descriptionBox) descriptionBox.destroy();

		const configureDetailBox = (boxInstance: ScrollableTextInterface) => {
			descriptionBox = boxInstance;
			const scrollable = boxInstance as unknown as {
				scroll?: (offset: number) => void;
				setScroll?: (offset: number) => void;
				setScrollPerc?: (perc: number) => void;
				getScroll?: () => number;
			};

			const pageAmount = () => {
				const h = boxInstance.height;
				const height = typeof h === "number" ? h : parseInt(String(h), 10) || 0;
				return height > 0 ? Math.max(1, height - 3) : 20; // fallback to 20 rows
			};

			boxInstance.key(["up", "k"], () => {
				if (
					!shouldMoveFromDetailBoundaryToSearch(
						"up",
						scrollable.getScroll?.() ?? 0,
					)
				) {
					return true;
				}
				pendingSearchWrap = null;
				filterHeader.focusSearch();
				return false;
			});

			boxInstance.key(["pageup", "pgup", "b"], () => {
				const delta = pageAmount();
				if (delta > 0) {
					scrollable.scroll?.(-delta);
					screen.render();
				}
				return false;
			});
			boxInstance.key(["pagedown", "pgdn", "space"], () => {
				const delta = pageAmount();
				if (delta > 0) {
					scrollable.scroll?.(delta);
					screen.render();
				}
				return false;
			});
			boxInstance.key(["home", "g"], () => {
				scrollable.setScroll?.(0);
				screen.render();
				return false;
			});
			boxInstance.key(["end", "G"], () => {
				scrollable.setScrollPerc?.(100);
				screen.render();
				return false;
			});
			boxInstance.on("focus", () => {
				currentFocus = "detail";
				setActivePane("detail");
				updateHelpBar();
				screen.render();
			});
			boxInstance.on("blur", () => {
				if (currentFocus !== "detail") {
					setActivePane(currentFocus === "list" ? "list" : "none");
					screen.render();
				}
			});
			boxInstance.key(["left", "h"], () => {
				focusProposalList();
				return false;
			});
			boxInstance.key(["escape"], () => {
				focusProposalList();
				return false;
			});
			if (currentFocus === "detail") {
				setImmediate(() => boxInstance.focus());
			}
		};

		if (noResultsMessage) {
			screen.title = options.title || "Roadmap Proposals";

			headerDetailBox = box({
				parent: detailPane,
				top: 0,
				left: 1,
				right: 1,
				height: "shrink",
				tags: true,
				wrap: true,
				scrollable: false,
				padding: { left: 1, right: 1 },
				content: "{bold}No proposals to display{/bold}",
			});

			descriptionBox = undefined;
			divider = undefined;
			const messageBox = scrollabletext({
				parent: detailPane,
				top:
					(typeof headerDetailBox.bottom === "number"
						? headerDetailBox.bottom
						: 0) + 1,
				left: 1,
				right: 1,
				bottom: 1,
				keys: true,
				vi: true,
				mouse: true,
				tags: true,
				wrap: true,
				padding: { left: 1, right: 1, top: 0, bottom: 0 },
				content: noResultsMessage,
			});

			configureDetailBox(messageBox);
			screen.render();
			return;
		}

		screen.title = `Proposal ${currentSelectedProposal.id} - ${currentSelectedProposal.title}`;

		const detailContent = generateDetailContent(
			currentSelectedProposal,
			resolveDirectiveLabel,
		);

		// Calculate header height based on content and available width
		const detailPaneWidth =
			typeof detailPane.width === "number" ? detailPane.width : 60;
		const availableWidth = detailPaneWidth - 6; // 2 for border, 2 for box padding, 2 for header padding

		let headerLineCount = 0;
		for (const detailLine of detailContent.headerContent) {
			const plainText = detailLine.replace(/\{[^}]+\}/g, "");
			const lineCount = Math.max(
				1,
				Math.ceil(plainText.length / availableWidth),
			);
			headerLineCount += lineCount;
		}

		headerDetailBox = box({
			parent: detailPane,
			top: 0,
			left: 1,
			right: 1,
			height: headerLineCount,
			tags: true,
			wrap: true,
			scrollable: false,
			padding: { left: 1, right: 1 },
			content: detailContent.headerContent.join("\n"),
		});

		divider = line({
			parent: detailPane,
			top: headerLineCount,
			left: 1,
			right: 1,
			orientation: "horizontal",
			style: { fg: "gray" },
		});

		const bodyContainer = scrollabletext({
			parent: detailPane,
			top: headerLineCount + 1,
			left: 1,
			right: 1,
			bottom: 1,
			keys: true,
			vi: true,
			mouse: true,
			tags: true,
			wrap: true,
			padding: { left: 1, right: 1, top: 0, bottom: 0 },
			content: detailContent.bodyContent.join("\n"),
		});

		configureDetailBox(bodyContainer);
	}

	// Dynamic help bar content
	function updateHelpBar() {
		if (transientHelpContent) {
			setHelpBarContent(transientHelpContent);
			screen.render();
			return;
		}

		let content = "";

		const filterFocus = filterHeader.getCurrentFocus();
		if (currentFocus === "filters" && filterFocus) {
			if (filterFocus === "search") {
				content =
					" {cyan-fg}[←/→]{/} Cursor (edge=Prev/Next) | {cyan-fg}[↑/↓]{/} Back to Proposals | {cyan-fg}[Esc]{/} Cancel | {gray-fg}(Live search){/}";
			} else {
				content =
					" {cyan-fg}[Enter/Space]{/} Open Picker | {cyan-fg}[←/→]{/} Prev/Next | {cyan-fg}[Esc]{/} Back";
			}
		} else if (currentFocus === "detail") {
			content =
				" {cyan-fg}[Tab]{/} Switch View | {cyan-fg}[←]{/} Proposal List | {cyan-fg}[↑↓]{/} Scroll | {cyan-fg}[q/Esc]{/} Quit";
		} else {
			// Proposal list help
			content =
				" {cyan-fg}[Tab]{/} Switch View | {cyan-fg}[/]{/} Search | {cyan-fg}[s]{/} Status | {cyan-fg}[p]{/} Priority | {cyan-fg}[l]{/} Labels | {cyan-fg}[↑↓]{/} Navigate | {cyan-fg}[q/Esc]{/} Quit";
		}

		setHelpBarContent(content);
		screen.render();
	}

	const _openCurrentProposalInEditor = async () => {
		if (filterPopupOpen || currentFocus === "filters" || noResultsMessage) {
			return;
		}
		const selectedProposal = currentSelectedProposal;

		try {
			const result = await core.editProposalInTui(
				selectedProposal.id,
				screen,
				selectedProposal,
			);
			if (result.reason === "read_only") {
				const branchInfo = result.proposal?.branch
					? ` in branch ${result.proposal.branch}`
					: "";
				showTransientHelp(` {red-fg}Proposal is read-only${branchInfo}.{/}`);
				return;
			}
			if (result.reason === "editor_failed") {
				showTransientHelp(
					" {red-fg}Editor exited with an error; proposal was not modified.{/}",
				);
				return;
			}
			if (result.reason === "not_found") {
				showTransientHelp(
					` {red-fg}Proposal ${selectedProposal.id} was not found on this branch.{/}`,
				);
				return;
			}

			if (result.proposal) {
				const index = allProposals.findIndex(
					(proposalItem) => proposalItem.id === selectedProposal.id,
				);
				if (index >= 0) {
					allProposals[index] = result.proposal;
				}
				const enhancedProposal =
					enrichProposal(result.proposal) ?? result.proposal;
				currentSelectedProposal = enhancedProposal;
				options.onProposalChange?.(enhancedProposal);
				if (proposalSearchIndex) {
					proposalSearchIndex = createProposalSearchIndex(allProposals);
				}
			}

			applyFilters();
			if (result.changed) {
				showTransientHelp(
					` {green-fg}Proposal ${result.proposal?.id ?? selectedProposal.id} marked modified.{/}`,
				);
				return;
			}
			showTransientHelp(
				` {gray-fg}No changes detected for ${result.proposal?.id ?? selectedProposal.id}.{/}`,
			);
		} catch (_error) {
			showTransientHelp(" {red-fg}Failed to open editor.{/}");
		}
	};

	// Handle resize
	screen.on("resize", () => {
		filterHeader.rebuild();
		updateHelpBar();
	});

	// Keyboard shortcuts
	screen.key(["/"], () => {
		pendingSearchWrap = null;
		filterHeader.focusSearch();
	});

	screen.key(["C-f"], () => {
		pendingSearchWrap = null;
		filterHeader.focusSearch();
	});

	screen.key(["s", "S"], () => {
		void openFilterPicker("status");
	});

	screen.key(["p", "P"], () => {
		void openFilterPicker("priority");
	});

	screen.key(["l", "L"], () => {
		void openFilterPicker("labels");
	});

	screen.key(["escape"], () => {
		if (filterPopupOpen) {
			return;
		}
		if (currentFocus === "filters") {
			filterHeader.setBorderColor("cyan");
			const targetPane = resolveFilterExitPane(
				filterExitPane,
				Boolean(proposalList),
				Boolean(descriptionBox),
			);
			if (targetPane === "list" && proposalList) {
				focusProposalList();
			} else if (targetPane === "detail" && descriptionBox) {
				focusDetailPane();
			}
		} else if (currentFocus !== "list") {
			if (proposalList) {
				focusProposalList();
			}
		} else {
			// If already in proposal list, quit
			searchService?.dispose();
			contentStore?.dispose();
			filterHeader.destroy();
			screen.destroy();
			process.exit(0);
		}
	});

	// Tab key handling for view switching - only when in proposal list
	if (options.onTabPress) {
		screen.key(["tab"], async () => {
			// Keep tab as filter-navigation while filters are focused.
			if (filterPopupOpen || currentFocus === "filters") {
				return;
			}
			if (currentFocus === "list" || currentFocus === "detail") {
				// Cleanup before switching
				searchService?.dispose();
				contentStore?.dispose();
				filterHeader.destroy();
				screen.destroy();
				await options.onTabPress?.();
			}
		});
	}

	// Quit handlers
	screen.key(["q", "C-c"], () => {
		if (filterPopupOpen) {
			return;
		}
		searchService?.dispose();
		contentStore?.dispose();
		filterHeader.destroy();
		screen.destroy();
		process.exit(0);
	});

	// Initial setup
	updateHelpBar();

	// Apply filters first if any are set
	if (filtersActive) {
		applyFilters();
	} else {
		proposalList = createProposalList();
	}
	refreshDetailPane();

	if (options.startWithSearchFocus) {
		filterHeader.focusSearch();
	} else if (options.startWithDetailFocus) {
		if (descriptionBox) {
			focusDetailPane();
		}
	} else {
		// Focus the proposal list initially and highlight it
		if (proposalList) {
			focusProposalList();
		}
	}

	screen.render();

	// Wait for screen to close
	return new Promise<void>((resolve) => {
		screen.on("destroy", () => {
			if (helpRestoreTimer) {
				clearTimeout(helpRestoreTimer);
				helpRestoreTimer = null;
			}
			searchService?.dispose();
			contentStore?.dispose();
			resolve();
		});
	});
}

export function generateDetailContent(
	proposal: Proposal,
	resolveDirectiveLabel?: (directive: string) => string,
	extraData?: {
		decisions?: Array<{ decision: string; authority: string; rationale: string | null; binding: boolean; decided_at: string }>;
		reviews?: Array<{ reviewer_identity: string; verdict: string; notes: string | null; findings: string | null; is_blocking: boolean; reviewed_at: string }>;
		discussions?: Array<{ author_identity: string; context_prefix: string | null; body: string; created_at: string }>;
	},
): { headerContent: string[]; bodyContent: string[] } {
	const dvId = proposal.id.replace(/^STATE-/, "STEP-");
	const statusColor = getStatusColor(proposal.status);
	const maturityColor = getMaturityColor((proposal as any).maturity);
	const maturityIcon = getMaturityIcon((proposal as any).maturity);
	const accentColor = getProposalAccentColor(
		proposal.status,
		(proposal as any).maturity,
	);

	const headerContent = [
		` {${statusColor}-fg}${formatStatusWithIcon(proposal.status)}{/} {${accentColor}-fg}${maturityIcon}{bold}${dvId} - ${proposal.title}{/bold}{/}`,
	];

	// Add cross-branch indicator if proposal is from another branch
	const isCrossBranch = Boolean(
		(proposal as Proposal & { branch?: string }).branch,
	);
	if (isCrossBranch) {
		const branchName = (proposal as Proposal & { branch?: string }).branch;
		headerContent.push(
			` {yellow-fg}⚠ Read-only:{/} This proposal exists in branch {green-fg}${branchName}{/}. Switch to that branch to edit it.`,
		);
	}

	const bodyContent: string[] = [];
	bodyContent.push(formatSectionHeading("Details", "cyan"));

	const metadata: string[] = [];
	metadata.push(formatCurrentStateLine(proposal));
	metadata.push(
		`{bold}Created:{/bold} ${formatDateForDisplay(proposal.createdDate)}`,
	);
	if (proposal.updatedDate && proposal.updatedDate !== proposal.createdDate) {
		metadata.push(
			`{bold}Updated:{/bold} ${formatDateForDisplay(proposal.updatedDate)}`,
		);
	}
	if (proposal.priority) {
		const priorityDisplay = getPriorityDisplay(proposal.priority);
		const priorityText =
			proposal.priority.charAt(0).toUpperCase() + proposal.priority.slice(1);
		metadata.push(`{bold}Priority:{/bold} ${priorityText}${priorityDisplay}`);
	}
	if ((proposal as any).maturity) {
		const maturityText =
			(proposal as any).maturity.charAt(0).toUpperCase() +
			(proposal as any).maturity.slice(1);
		metadata.push(
			`{bold}Maturity:{/bold} {${getMaturityColor((proposal as any).maturity)}-fg}${maturityText}{/}`,
		);
	}
	if (proposal.assignee?.length) {
		const assigneeList = proposal.assignee
			.map((a) => (a.startsWith("@") ? a : `@${a}`))
			.join(", ");
		metadata.push(`{bold}Assignee:{/bold} {cyan-fg}${assigneeList}{/}`);
	}
	if (proposal.labels?.length) {
		metadata.push(
			`{bold}Labels:{/bold} ${proposal.labels.map((l) => `{yellow-fg}[${l}]{/}`).join(" ")}`,
		);
	}
	if (proposal.reporter) {
		const reporterText = proposal.reporter.startsWith("@")
			? proposal.reporter
			: `@${proposal.reporter}`;
		metadata.push(`{bold}Reporter:{/bold} {cyan-fg}${reporterText}{/}`);
	}
	if (proposal.directive) {
		const directiveLabel = resolveDirectiveLabel
			? resolveDirectiveLabel(proposal.directive)
			: proposal.directive;
		metadata.push(`{bold}Directive:{/bold} {magenta-fg}${directiveLabel}{/}`);
	}
	if (proposal.parentProposalId) {
		const parentLabel = proposal.parentProposalTitle
			? `${proposal.parentProposalId} - ${proposal.parentProposalTitle}`
			: proposal.parentProposalId;
		metadata.push(`{bold}Parent:{/bold} {blue-fg}${parentLabel}{/}`);
	}
	if (proposal.subproposals?.length) {
		metadata.push(
			`{bold}Subproposals:{/bold} ${proposal.subproposals.length} proposal${proposal.subproposals.length > 1 ? "s" : ""}`,
		);
	}
	if (proposal.dependencies?.length) {
		metadata.push(
			`{bold}Dependencies:{/bold} ${proposal.dependencies.join(", ")}`,
		);
	}

	bodyContent.push(metadata.join("\n"));
	bodyContent.push("");

	bodyContent.push(formatSectionHeading("Description", "green"));
	const descriptionText = proposal.description?.trim();
	const descriptionContent = descriptionText
		? formatMarkdownBody(descriptionText)
		: "{gray-fg}No description provided{/}";
	bodyContent.push(descriptionContent);
	bodyContent.push("");

	if (proposal.references?.length) {
		bodyContent.push(formatSectionHeading("References", "magenta"));
		const formattedRefs = proposal.references.map((ref) => {
			// Color URLs differently from file paths
			if (ref.startsWith("http://") || ref.startsWith("https://")) {
				return `  {cyan-fg}${ref}{/}`;
			}
			return `  {yellow-fg}${ref}{/}`;
		});
		bodyContent.push(formattedRefs.join("\n"));
		bodyContent.push("");
	}

	if (proposal.documentation?.length) {
		bodyContent.push(formatSectionHeading("Documentation", "blue"));
		const formattedDocs = proposal.documentation.map((doc) => {
			if (doc.startsWith("http://") || doc.startsWith("https://")) {
				return `  {cyan-fg}${doc}{/}`;
			}
			return `  {yellow-fg}${doc}{/}`;
		});
		bodyContent.push(formattedDocs.join("\n"));
		bodyContent.push("");
	}

	bodyContent.push(formatSectionHeading("Acceptance Criteria", "yellow"));
	const checklistItems = buildAcceptanceCriteriaItems(proposal);
	if (checklistItems.length > 0) {
		const formattedCriteria = checklistItems.map((item) =>
			formatChecklistItem(
				{
					text: transformCodePaths(item.text),
					checked: item.checked,
				},
				{
					padding: " ",
					checkedSymbol: "{green-fg}✓{/}",
					uncheckedSymbol: "{gray-fg}○{/}",
				},
			),
		);
		bodyContent.push(formattedCriteria.join("\n"));
	} else {
		bodyContent.push("{gray-fg}No acceptance criteria defined{/}");
	}
	bodyContent.push("");

	const implementationPlan = proposal.implementationPlan?.trim();
	if (implementationPlan) {
		bodyContent.push(formatSectionHeading("Implementation Plan", "cyan"));
		bodyContent.push(formatMarkdownBody(implementationPlan));
		bodyContent.push("");
	}

	const implementationNotes = proposal.implementationNotes?.trim();
	if (implementationNotes) {
		bodyContent.push(formatSectionHeading("Implementation Notes", "magenta"));
		bodyContent.push(formatMarkdownBody(implementationNotes));
		bodyContent.push("");
	}

	const finalSummary = proposal.finalSummary?.trim();
	if (finalSummary) {
		bodyContent.push(formatSectionHeading("Final Summary", "green"));
		bodyContent.push(formatMarkdownBody(finalSummary));
		bodyContent.push("");
	}

	// Decisions section
	if (extraData?.decisions && extraData.decisions.length > 0) {
		bodyContent.push(formatSectionHeading(`Decisions (${extraData.decisions.length})`, "magenta"));
		for (const d of extraData.decisions) {
			const bindingTag = d.binding ? " {yellow-fg}[binding]{/}" : "";
			bodyContent.push(`  {bold}{magenta-fg}${d.decision}{/magenta-fg}{/bold}${bindingTag}`);
			bodyContent.push(`    {gray-fg}by ${d.authority} · ${formatDateForDisplay(d.decided_at)}{/}`);
			if (d.rationale) {
				bodyContent.push(`    ${d.rationale.slice(0, 200)}${d.rationale.length > 200 ? "..." : ""}`);
			}
			bodyContent.push("");
		}
	}

	// Reviews section
	if (extraData?.reviews && extraData.reviews.length > 0) {
		bodyContent.push(formatSectionHeading(`Reviews (${extraData.reviews.length})`, "cyan"));
		const verdictColor: Record<string, string> = {
			approve: "green",
			request_changes: "yellow",
			reject: "red",
		};
		for (const r of extraData.reviews) {
			const color = verdictColor[r.verdict] || "white";
			const blockTag = r.is_blocking ? " {red-fg}[blocking]{/}" : "";
			bodyContent.push(`  {${color}-fg}${r.verdict}{/}${blockTag} {gray-fg}by ${r.reviewer_identity} · ${formatDateForDisplay(r.reviewed_at)}{/}`);
			if (r.notes) {
				bodyContent.push(`    ${r.notes.slice(0, 200)}${r.notes.length > 200 ? "..." : ""}`);
			}
			bodyContent.push("");
		}
	}

	// Discussions section
	if (extraData?.discussions && extraData.discussions.length > 0) {
		bodyContent.push(formatSectionHeading(`Discussions (${extraData.discussions.length})`, "blue"));
		for (const disc of extraData.discussions.slice(0, 10)) {
			const prefix = disc.context_prefix ? `{yellow-fg}[${disc.context_prefix}]{/} ` : "";
			bodyContent.push(`  ${prefix}{cyan-fg}${disc.author_identity}{/} {gray-fg}· ${formatDateForDisplay(disc.created_at)}{/}`);
			const body = disc.body.length > 150 ? `${disc.body.slice(0, 150)}...` : disc.body;
			bodyContent.push(`    ${body}`);
			bodyContent.push("");
		}
		if (extraData.discussions.length > 10) {
			bodyContent.push(`  {gray-fg}... and ${extraData.discussions.length - 10} more{/}`);
		}
	}

	bodyContent.push(formatSectionHeading("Activity Thread", "blue"));
	bodyContent.push(formatActivityThread(proposal.activityLog).join("\n"));
	bodyContent.push("");

	return { headerContent, bodyContent };
}

export async function createProposalPopup(
	screen: ScreenInterface,
	proposal: Proposal,
	resolveDirectiveLabel?: (directive: string) => string,
): Promise<{
	background: BoxInterface;
	popup: BoxInterface;
	contentArea: ScrollableTextInterface;
	close: () => void;
} | null> {
	if (output.isTTY === false) return null;

	// Hydrate AC + activity + decisions/reviews/discussions for the popup.
	// Strategy: try the web service first (1 round-trip, no local pool
	// pressure), but if it isn't running (TUI must work standalone), fall
	// back to ONE aggregate pg query that uses a single pool slot.
	const webProposal = await fetchProposalFromWeb(proposal.id);
	let extras: ProposalExtrasBundle;
	if (
		webProposal &&
		Array.isArray(
			(webProposal as { acceptanceCriteriaItems?: unknown })
				.acceptanceCriteriaItems,
		)
	) {
		const webExtras = await fetchProposalDetailExtras(proposal.id);
		extras = {
			decisions: webExtras.decisions,
			reviews: webExtras.reviews,
			discussions: webExtras.discussions,
			acceptanceCriteriaItems:
				(webProposal.acceptanceCriteriaItems as ProposalExtrasBundle["acceptanceCriteriaItems"]) ??
				[],
			activityLog:
				((webProposal as { activityLog?: unknown }).activityLog as
					| ProposalExtrasBundle["activityLog"]
					| undefined) ?? [],
		};
		const merged = { ...proposal } as Proposal & Record<string, unknown>;
		if (typeof webProposal.implementationPlan === "string") {
			(merged as Proposal & { implementationPlan?: string }).implementationPlan =
				webProposal.implementationPlan as string;
		}
		if (typeof webProposal.implementationNotes === "string") {
			(merged as Proposal & { implementationNotes?: string }).implementationNotes =
				webProposal.implementationNotes as string;
		}
		if (typeof webProposal.finalSummary === "string") {
			(merged as Proposal & { finalSummary?: string }).finalSummary =
				webProposal.finalSummary as string;
		}
		proposal = merged as Proposal;
	} else {
		extras = await fetchProposalExtrasFromPg(proposal.id);
	}
	const merged2 = { ...proposal } as Proposal & Record<string, unknown>;
	merged2.acceptanceCriteriaItems = extras.acceptanceCriteriaItems;
	(merged2 as Proposal & { activityLog?: unknown }).activityLog =
		extras.activityLog;
	proposal = merged2 as Proposal;
	const decisions = extras.decisions;
	const reviews = extras.reviews;
	const discussions = extras.discussions;

	const { headerContent, bodyContent } = generateDetailContent(
		proposal,
		resolveDirectiveLabel,
		{ decisions, reviews, discussions },
	);

	const popup = box({
		parent: screen,
		top: "center",
		left: "center",
		width: "85%",
		height: "80%",
		border: "line",
		style: {
			bg: "black",
			fg: "white",
			border: { fg: "gray" },
		},
		keys: true,
		tags: true,
		autoPadding: true,
	});

	// Tiny invisible "background" placeholder so the existing close()
	// API (popup.background.destroy()) keeps working without leaking widgets.
	const background = box({
		parent: popup,
		top: 0,
		left: 0,
		width: 0,
		height: 0,
		hidden: true,
	});

	popup.setFront?.();

	// Calculate header height based on content and available width
	const popupWidth = typeof popup.width === "number" ? popup.width : 80;
	const availableWidth = popupWidth - 6;

	let headerLineCount = 0;
	for (const headerLine of headerContent) {
		const plainText = headerLine.replace(/\{[^}]+\}/g, "");
		const lineCount = Math.max(1, Math.ceil(plainText.length / availableWidth));
		headerLineCount += lineCount;
	}

	box({
		parent: popup,
		top: 0,
		left: 1,
		right: 1,
		height: headerLineCount,
		tags: true,
		wrap: true,
		scrollable: false,
		padding: { left: 1, right: 1 },
		content: headerContent.join("\n"),
	});

	line({
		parent: popup,
		top: headerLineCount,
		left: 1,
		right: 1,
		orientation: "horizontal",
		style: { fg: "gray" },
	});

	box({
		parent: popup,
		content: " Esc ",
		top: -1,
		right: 1,
		width: 5,
		height: 1,
		style: { fg: "white", bg: "blue" },
	});

	const contentArea = scrollabletext({
		parent: popup,
		top: headerLineCount + 1,
		left: 1,
		right: 1,
		bottom: 1,
		keys: true,
		vi: true,
		mouse: true,
		tags: true,
		wrap: true,
		padding: { left: 1, right: 1, top: 0, bottom: 0 },
		content: bodyContent.join("\n"),
	});

	const popupScrollable = contentArea as unknown as {
		scroll?: (offset: number) => void;
		setScroll?: (offset: number) => void;
		setScrollPerc?: (perc: number) => void;
		getScroll?: () => number;
	};
	const popupPageAmount = () => {
		const height =
			typeof contentArea.height === "number"
				? contentArea.height
				: parseInt(String(contentArea.height), 10) || 0;
		return height > 0 ? Math.max(1, height - 3) : 20;
	};

	const closePopup = () => {
		popup.destroy();
		background.destroy();
		screen.render();
	};

	popup.key(["escape", "q", "C-c"], () => {
		closePopup();
		return false;
	});

	contentArea.on("focus", () => {
		const popupStyle = popup.style as { border?: { fg?: string } };
		popupStyle.border = { ...(popupStyle.border ?? {}), fg: "yellow" };
		screen.render();
	});

	contentArea.on("blur", () => {
		const popupStyle = popup.style as { border?: { fg?: string } };
		popupStyle.border = { ...(popupStyle.border ?? {}), fg: "gray" };
		screen.render();
	});

	contentArea.key(["escape"], () => {
		closePopup();
		return false;
	});
	contentArea.key(["pageup", "pgup", "b"], () => {
		const delta = popupPageAmount();
		if (delta > 0) {
			popupScrollable.scroll?.(-delta);
			screen.render();
		}
		return false;
	});
	contentArea.key(["pagedown", "pgdn", "space"], () => {
		const delta = popupPageAmount();
		if (delta > 0) {
			popupScrollable.scroll?.(delta);
			screen.render();
		}
		return false;
	});
	contentArea.key(["home", "g"], () => {
		popupScrollable.setScroll?.(0);
		screen.render();
		return false;
	});
	contentArea.key(["end", "G"], () => {
		popupScrollable.setScrollPerc?.(100);
		screen.render();
		return false;
	});

	setImmediate(() => {
		contentArea.focus();
	});

	screen.render();

	return {
		background,
		popup,
		contentArea,
		close: closePopup,
	};
}
