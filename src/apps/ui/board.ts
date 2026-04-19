import {
	type BoardLayout,
	buildKanbanStatusGroups,
	generateDirectiveGroupedBoard,
	generateKanbanBoardWithMetadata,
} from "../../board.ts";
import type { StreamEvent } from "../../core/messaging/event-stream.ts";
import { Core } from "../../core/roadmap.ts";
import type { Directive, Proposal } from "../../shared/types/index.ts";
import { collectAvailableLabels } from "../../shared/utils/label-filter.ts";
import {
	applySharedProposalFilters,
	createProposalSearchIndex,
} from "../../shared/utils/proposal-search.ts";
import { compareProposalIds } from "../../shared/utils/proposal-sorting.ts";
import {
	formatVersionLabel,
	getVersionInfo,
} from "../../shared/utils/version.ts";
import type { BoxInterface, ListInterface } from "./blessed.ts";
import { box, list } from "./blessed.ts";
import {
	createFilterHeader,
	type FilterHeader,
	type FilterProposal,
} from "./components/filter-header.ts";
import {
	openMultiSelectFilterPopup,
	openSingleSelectFilterPopup,
} from "./components/filter-popup.ts";
import { formatFooterContent } from "./footer-content.ts";
import { getBoardLiveFeed } from "./live-feed.ts";
import {
	createProposalPopup,
	resolveSearchExitTargetIndex,
	shouldMoveFromListBoundaryToSearch,
} from "./proposal-viewer-with-search.ts";
import {
	getMaturityIcon,
	getProposalAccentColor,
	getStatusIcon,
	getStatusStyle,
} from "./status-icon.ts";
import { createScreen } from "./tui.ts";

// Stub implementations for move/undo (to be fully implemented later)
function _pushUndo(_fn: () => Promise<void>): void {
	// TODO: implement undo stack
}
function _performProposalMove(): void {
	// TODO: implement proposal move
}
function _cancelMove(): void {
	// TODO: cancel move operation
}

export type ColumnData = {
	status: string;
	proposals: Proposal[];
};

type ColumnView = {
	status: string;
	proposals: Proposal[];
	list: ListInterface;
	box: BoxInterface;
};

export type WorkflowViewKey = "all" | "rfc" | "quick-fix" | "hotfix" | "obsolete";

export interface WorkflowViewDefinition {
	key: WorkflowViewKey;
	label: string;
	description: string;
	proposalTypes: string[];
	statuses: string[];
}

const WORKFLOW_VIEWS: WorkflowViewDefinition[] = [
	{
		key: "all",
		label: "All",
		description: "Combined workflow view",
		proposalTypes: [],
		statuses: [],
	},
	{
		key: "rfc",
		label: "RFC",
		description: "Standard RFC workflow",
		proposalTypes: ["product", "component", "feature"],
		statuses: ["Draft", "Review", "Develop", "Merge", "Complete"],
	},
	{
		key: "quick-fix",
		label: "Quick Fix",
		description: "Rapid fix workflow",
		proposalTypes: ["issue"],
		statuses: ["TRIAGE", "FIX", "DEPLOYED", "ESCALATE", "WONT_FIX"],
	},
	{
		key: "hotfix",
		label: "Hotfix",
		description: "Urgent operational workflow",
		proposalTypes: ["hotfix"],
		statuses: ["TRIAGE", "FIXING", "DONE"],
	},
	{
		key: "obsolete",
		label: "Obsolete",
		description: "Archived and obsolete proposals",
		proposalTypes: [],
		statuses: [],
	},
];

const WORKFLOW_BY_KEY = new Map(
	WORKFLOW_VIEWS.map((workflow) => [workflow.key, workflow]),
);
const RFC_TYPES = new Set(["product", "component", "feature"]);
const QUICK_FIX_TYPES = new Set(["issue"]);
const HOTFIX_TYPES = new Set(["hotfix"]);
const RFC_STATUSES = new Set([
	"draft",
	"review",
	"develop",
	"merge",
	"complete",
]);
const RFC_STATUS_ALIASES = new Map<string, string>([
	["todo", "Draft"],
	["new", "Draft"],
	["open", "Draft"],
	["proposal", "Draft"],
	["reviewing", "Review"],
	["accepted", "Develop"],
	["building", "Develop"],
	["active", "Develop"],
	["developing", "Develop"],
	["done", "Complete"],
	["completed", "Complete"],
	["closed", "Complete"],
]);
const QUICK_FIX_STATUS_ALIASES = new Map<string, string>([
	["draft", "TRIAGE"],
	["todo", "TRIAGE"],
	["new", "TRIAGE"],
	["open", "TRIAGE"],
	["proposal", "TRIAGE"],
	["triage", "TRIAGE"],
	["review", "FIX"],
	["reviewing", "FIX"],
	["develop", "FIX"],
	["developing", "FIX"],
	["merge", "FIX"],
	["accepted", "FIX"],
	["active", "FIX"],
	["building", "FIX"],
	["fix", "FIX"],
	["fixing", "FIX"],
	["done", "DEPLOYED"],
	["completed", "DEPLOYED"],
	["complete", "DEPLOYED"],
	["deployed", "DEPLOYED"],
	["closed", "DEPLOYED"],
	["wont_fix", "WONT_FIX"],
	["non_issue", "WONT_FIX"],
	["escalate", "ESCALATE"],
]);
const HOTFIX_STATUS_ALIASES = new Map<string, string>([
	["draft", "TRIAGE"],
	["todo", "TRIAGE"],
	["new", "TRIAGE"],
	["open", "TRIAGE"],
	["proposal", "TRIAGE"],
	["triage", "TRIAGE"],
	["review", "FIXING"],
	["reviewing", "FIXING"],
	["develop", "FIXING"],
	["developing", "FIXING"],
	["merge", "FIXING"],
	["accepted", "FIXING"],
	["active", "FIXING"],
	["building", "FIXING"],
	["fix", "FIXING"],
	["fixing", "FIXING"],
	["done", "DONE"],
	["completed", "DONE"],
	["complete", "DONE"],
	["deployed", "DONE"],
	["closed", "DONE"],
]);
const STATUS_ALIASES_BY_WORKFLOW: Record<
	WorkflowViewKey,
	Map<string, string>
> = {
	rfc: RFC_STATUS_ALIASES,
	"quick-fix": QUICK_FIX_STATUS_ALIASES,
	hotfix: HOTFIX_STATUS_ALIASES,
};
const QUICK_FIX_STATUSES = new Set([
	"triage",
	"fix",
	"deployed",
	"escalate",
	"wont_fix",
	"fixing",
	"done",
]);
const HOTFIX_STATUSES = new Set(["triage", "fixing", "done"]);

function isObsoleteProposal(proposal: Proposal): boolean {
	return (proposal.maturity ?? "").toLowerCase() === "obsolete";
}

function getCombinedWorkflowStatuses(proposals: Proposal[]): string[] {
	const canonicalStatuses = [
		...new Set(
			WORKFLOW_VIEWS.flatMap((workflow) =>
				workflow.key === "all" || workflow.key === "obsolete"
					? []
					: workflow.statuses,
			),
		),
	];
	const extraStatuses = new Set<string>();
	for (const proposal of proposals) {
		const workflow = getWorkflowViewForProposal(proposal);
		const status = normalizeWorkflowStatus(proposal.status, workflow.key);
		if (status && !canonicalStatuses.includes(status)) {
			extraStatuses.add(status);
		}
	}
	return [
		...canonicalStatuses,
		...Array.from(extraStatuses).sort((a, b) => a.localeCompare(b)),
	];
}

export function getWorkflowViewDefinition(
	key: WorkflowViewKey,
): WorkflowViewDefinition {
	return WORKFLOW_BY_KEY.get(key) ?? WORKFLOW_VIEWS[0];
}

function normalizeWorkflowStatus(
	status: string,
	workflowKey: WorkflowViewKey,
): string {
	const trimmed = status.trim();
	const workflow = getWorkflowViewDefinition(workflowKey);
	const canonical = workflow.statuses.find(
		(candidate) => candidate.toLowerCase() === trimmed.toLowerCase(),
	);
	if (canonical) return canonical;
	return (
		STATUS_ALIASES_BY_WORKFLOW[workflowKey].get(trimmed.toLowerCase()) ??
		trimmed
	);
}

export function getWorkflowViewForProposal(
	proposal: Proposal,
): WorkflowViewDefinition {
	const proposalType = proposal.proposalType?.trim().toLowerCase();
	if (proposalType && RFC_TYPES.has(proposalType)) {
		return getWorkflowViewDefinition("rfc");
	}
	if (proposalType && QUICK_FIX_TYPES.has(proposalType)) {
		return getWorkflowViewDefinition("quick-fix");
	}
	if (proposalType && HOTFIX_TYPES.has(proposalType)) {
		return getWorkflowViewDefinition("hotfix");
	}

	const status = proposal.status.trim().toLowerCase();
	if (RFC_STATUSES.has(status)) {
		return getWorkflowViewDefinition("rfc");
	}
	if (QUICK_FIX_STATUSES.has(status)) {
		return getWorkflowViewDefinition("quick-fix");
	}
	if (HOTFIX_STATUSES.has(status)) {
		return getWorkflowViewDefinition("hotfix");
	}

	return getWorkflowViewDefinition("rfc");
}

export function filterProposalsForWorkflow(
	proposals: Proposal[],
	workflowKey: WorkflowViewKey,
): Proposal[] {
	if (workflowKey === "all") {
		return proposals.filter((proposal) => !isObsoleteProposal(proposal));
	}
	if (workflowKey === "obsolete") {
		return proposals.filter((proposal) => isObsoleteProposal(proposal));
	}
	return proposals.filter(
		(proposal) =>
			getWorkflowViewForProposal(proposal).key === workflowKey &&
			!isObsoleteProposal(proposal),
	);
}

export function resolveWorkflowStatuses(
	proposals: Proposal[],
	workflowKey: WorkflowViewKey,
): string[] {
	if (workflowKey === "all" || workflowKey === "obsolete") {
		return getCombinedWorkflowStatuses(
			filterProposalsForWorkflow(proposals, workflowKey),
		);
	}
	const workflow = getWorkflowViewDefinition(workflowKey);
	const canonicalStatuses = [...workflow.statuses];
	const extraStatuses = new Set<string>();
	for (const proposal of proposals) {
		if (getWorkflowViewForProposal(proposal).key !== workflowKey) {
			continue;
		}
		const status = normalizeWorkflowStatus(proposal.status, workflowKey);
		if (status && !canonicalStatuses.includes(status)) {
			extraStatuses.add(status);
		}
	}
	return [
		...canonicalStatuses,
		...Array.from(extraStatuses).sort((a, b) => a.localeCompare(b)),
	];
}

function normalizeProposalsForWorkflow(
	proposals: Proposal[],
	workflowKey: WorkflowViewKey,
): Proposal[] {
	if (workflowKey === "all" || workflowKey === "obsolete") {
		return proposals.map((proposal) => ({
			...proposal,
			status: normalizeWorkflowStatus(
				proposal.status,
				getWorkflowViewForProposal(proposal).key,
			),
		}));
	}
	return proposals.map((proposal) => ({
		...proposal,
		status: normalizeWorkflowStatus(proposal.status, workflowKey),
	}));
}

function isCompleteStatus(status: string): boolean {
	const normalized = status.trim().toLowerCase();
	return (
		normalized === "done" ||
		normalized === "completed" ||
		normalized === "complete"
	);
}

function buildColumnProposals(
	status: string,
	items: Proposal[],
	byId: Map<string, Proposal>,
): Proposal[] {
	const topLevel: Proposal[] = [];
	const childrenByParent = new Map<string, Proposal[]>();
	const sorted = items.slice().sort((a, b) => {
		// Use ordinal for custom sorting if available
		const aOrd = a.ordinal;
		const bOrd = b.ordinal;

		// If both have ordinals, compare them
		if (typeof aOrd === "number" && typeof bOrd === "number") {
			if (aOrd !== bOrd) return aOrd - bOrd;
		} else if (typeof aOrd === "number") {
			// Only A has ordinal -> A comes first
			return -1;
		} else if (typeof bOrd === "number") {
			// Only B has ordinal -> B comes first
			return 1;
		}

		const columnIsComplete = isCompleteStatus(status);
		if (columnIsComplete) {
			return compareProposalIds(b.id, a.id);
		}

		return compareProposalIds(a.id, b.id);
	});

	for (const proposal of sorted) {
		const parent = proposal.parentProposalId
			? byId.get(proposal.parentProposalId)
			: undefined;
		if (parent && parent.status === proposal.status) {
			const existing = childrenByParent.get(parent.id) ?? [];
			existing.push(proposal);
			childrenByParent.set(parent.id, existing);
			continue;
		}
		topLevel.push(proposal);
	}

	const ordered: Proposal[] = [];
	for (const proposal of topLevel) {
		ordered.push(proposal);
		const subs = childrenByParent.get(proposal.id) ?? [];
		subs.sort((a, b) => compareProposalIds(a.id, b.id));
		ordered.push(...subs);
	}

	return ordered;
}

function prepareBoardColumns(
	proposals: Proposal[],
	statuses: string[],
): ColumnData[] {
	const { orderedStatuses, groupedProposals } = buildKanbanStatusGroups(
		proposals,
		statuses,
	);
	const byId = new Map<string, Proposal>(
		proposals.map((proposal) => [proposal.id, proposal]),
	);

	return orderedStatuses.map((status) => {
		const items = groupedProposals.get(status) ?? [];
		const orderedProposals = buildColumnProposals(status, items, byId);
		return { status, proposals: orderedProposals };
	});
}

/**
 * Filter columns based on hideEmpty and hidden_statuses settings.
 */
export function filterBoardColumns(
	columns: ColumnData[],
	options: { hideEmpty?: boolean; hiddenStatuses?: string[] },
): ColumnData[] {
	const hidden = (options.hiddenStatuses || []).map((s) => s.toLowerCase());
	return columns.filter((column) => {
		if (options.hideEmpty && column.proposals.length === 0) {
			return false;
		}
		if (hidden.includes(column.status.toLowerCase())) {
			return false;
		}
		return true;
	});
}

export function formatProposalListItem(
	proposal: Proposal,
	isMoving = false,
): string {
	// P270: render assignee from live activity when available. Prefer lease
	// holder (cyan), fall back to gate dispatch agent (magenta + "gate"),
	// fall back to static proposal.assignee (plain cyan). Append cubic/model
	// in dim gray when agent_health reports them.
	const live = proposal.liveActivity;
	const rawAssignee = proposal.assignee?.[0];
	let assignee = "";
	if (rawAssignee) {
		const handle = rawAssignee.startsWith("@") ? rawAssignee : `@${rawAssignee}`;
		if (live?.leaseHolder && rawAssignee === live.leaseHolder) {
			assignee = ` {cyan-fg}●${handle}{/}`;
		} else if (
			live?.gateDispatchAgent &&
			rawAssignee === live.gateDispatchAgent
		) {
			assignee = ` {magenta-fg}◐${handle} (gate){/}`;
		} else {
			assignee = ` {cyan-fg}${handle}{/}`;
		}
	}
	const liveDetail =
		live?.activeCubic || live?.activeModel
			? ` {gray-fg}${live.activeCubic ? `⬢${live.activeCubic}` : ""}${
					live.activeCubic && live.activeModel ? " " : ""
				}${live.activeModel ? `✦${live.activeModel}` : ""}{/}`
			: "";
	const labels = proposal.labels?.length
		? ` {yellow-fg}[${proposal.labels.join(", ")}]{/}`
		: "";
	const isCrossBranch = Boolean(
		(proposal as Proposal & { branch?: string }).branch,
	);
	const branch = isCrossBranch
		? ` {green-fg}(${(proposal as Proposal & { branch?: string }).branch}){/}`
		: "";

	// Status-based color coding
	const status = proposal.status || "";
	const statusStyle = getStatusStyle(status);
	const statusColor = `{${statusStyle.color}-fg}`;

	// Maturity-based color coding keeps the ID and title on the same theme.
	const maturity = (proposal as Proposal & { maturity?: string }).maturity;
	const maturityColorName = getProposalAccentColor(status, maturity);
	const maturityColor = `{${maturityColorName}-fg}`;
	const maturityIcon = getMaturityIcon(maturity);

	// Merge status suffix for Complete proposals
	const isComplete = isCompleteStatus(status);
	let mergeSuffix = "";
	if (isComplete) {
		// Check if this proposal's changes are in main
		// For now: mature = merged (green), active = pending (yellow)
		if (maturity === "mature") {
			mergeSuffix = " {green-fg}✓ merged{/}";
		} else if (maturity === "active") {
			mergeSuffix = " {yellow-fg}⏳ pending{/}";
		}
	}

	// Cross-branch proposals are dimmed to indicate read-only status
	const displayId = proposal.id.replace(/^STATE-/, "STEP-");
	const content = `${statusColor}${statusStyle.icon}{/} ${maturityColor}${maturityIcon}{bold}${displayId} - ${proposal.title}{/bold}{/}${assignee}${liveDetail}${labels}${branch}${mergeSuffix}`;
	if (isMoving) {
		return `{magenta-fg}► ${content}{/}`;
	}
	if (isCrossBranch) {
		return `{gray-fg}${content}{/}`;
	}
	return content;
}

function formatColumnLabel(status: string, count: number): string {
	return `\u00A0${getStatusIcon(status)} ${status || "No Status"} (${count})\u00A0`;
}

const DEFAULT_FOOTER_CONTENT =
	" {cyan-fg}[W]{/} Workflow Menu | {cyan-fg}[Tab]{/} Switch View | {cyan-fg}[S]{/} Feed | {cyan-fg}[/]{/} Search | {cyan-fg}[P]{/} Priority | {cyan-fg}[F]{/} Labels | {cyan-fg}[~]{/} Hide Empty | {cyan-fg}[=]{/} Hide Archive | {cyan-fg}[←→]{/} Columns | {cyan-fg}[↑↓]{/} Proposals | {cyan-fg}[PgUp/PgDn]{/} Page | {cyan-fg}[Home/End]{/} First/Last | {cyan-fg}[Enter]{/} View | {cyan-fg}[X]{/} Export | {cyan-fg}[q/Esc]{/} Quit";

function _arraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

export function shouldRebuildColumns(
	current: ColumnData[],
	next: ColumnData[],
): boolean {
	if (current.length !== next.length) {
		return true;
	}
	for (let index = 0; index < next.length; index += 1) {
		const nextColumn = next[index];
		if (!nextColumn) return true;
		const prevColumn = current[index];
		if (!prevColumn) return true;
		if (prevColumn.status !== nextColumn.status) return true;
		if (prevColumn.proposals.length !== nextColumn.proposals.length)
			return true;
		for (
			let proposalIdx = 0;
			proposalIdx < nextColumn.proposals.length;
			proposalIdx += 1
		) {
			const prevProposal = prevColumn.proposals[proposalIdx];
			const nextProposal = nextColumn.proposals[proposalIdx];
			if (!prevProposal || !nextProposal) {
				return true;
			}
			if (prevProposal.id !== nextProposal.id) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Render proposals in an interactive TUI when stdout is a TTY.
 * Falls back to plain-text board when not in a terminal
 * (e.g. piping output to a file or running in CI).
 */
export async function renderBoardTui(
	initialProposals: Proposal[],
	statuses: string[],
	_layout: BoardLayout,
	_maxColumnWidth: number,
	options?: {
		viewSwitcher?: import("./view-switcher.ts").ViewSwitcher;
		onProposalSelect?: (proposal: Proposal) => void;
		onTabPress?: () => Promise<void>;
		subscribeUpdates?: (
			update: (nextProposals: Proposal[], nextStatuses: string[]) => void,
		) => void;
		filters?: {
			searchQuery: string;
			priorityFilter: string;
			labelFilter: string[];
			directiveFilter: string;
		};
		availableLabels?: string[];
		availableDirectives?: string[];
		onFilterChange?: (filters: {
			searchQuery: string;
			priorityFilter: string;
			labelFilter: string[];
			directiveFilter: string;
		}) => void;
		directiveMode?: boolean;
		directiveEntities?: Directive[];
		projectRoot?: string;
	},
): Promise<void> {
	if (!process.stdout.isTTY) {
		if (options?.directiveMode) {
			console.log(
				generateDirectiveGroupedBoard(
					initialProposals,
					statuses,
					options.directiveEntities ?? [],
					"Project",
				),
			);
		} else {
			console.log(
				generateKanbanBoardWithMetadata(initialProposals, statuses, "Project"),
			);
		}
		return;
	}

	const core = new Core(options?.projectRoot ?? process.cwd());
	const config = await core.filesystem.loadConfig();

	const versionInfo = await getVersionInfo();
	const versionLabel = formatVersionLabel(versionInfo);

	const hiddenStatusesFromConfig = (config as any)?.hidden_statuses || [
		"Rejected",
		"Discard",
		"Replaced",
	];

	let currentWorkflowViewIndex = 0;
	const getCurrentWorkflowView = () =>
		WORKFLOW_VIEWS[currentWorkflowViewIndex] ?? WORKFLOW_VIEWS[0];
	const initialWorkflowView = getCurrentWorkflowView();
	const initialVisibleProposals = filterProposalsForWorkflow(
		initialProposals,
		initialWorkflowView.key,
	);
	let currentStatuses = resolveWorkflowStatuses(
		initialVisibleProposals,
		initialWorkflowView.key,
	);
	let initialColumns = prepareBoardColumns(
		initialVisibleProposals,
		currentStatuses,
	);
	initialColumns = filterBoardColumns(initialColumns, {
		hiddenStatuses: hiddenStatusesFromConfig,
	});

	await new Promise<void>((resolve) => {
		const screen = createScreen({
			title: `Roadmap Board - ${initialWorkflowView.label} - ${versionLabel}`,
		});
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

		const boardPane = box({
			parent: container,
			top: 0,
			left: 0,
			width: "75%",
			height: "100%-1",
		});

		const boardArea = box({
			parent: boardPane,
			top: 0,
			left: 0,
			width: "100%",
			height: "100%",
		});

		// Live event stream sidebar (right panel)
		const eventPanel = box({
			parent: container,
			top: 0,
			right: 0,
			width: "25%",
			height: "100%-1",
			border: { type: "line" },
			label: " 📰 Feed ",
			style: { border: { fg: "cyan" } },
			tags: true,
			scrollable: true,
			alwaysScroll: true,
			keys: true,
			vi: true,
		});

		let currentProposals = initialProposals;
		let columns: ColumnView[] = [];
		let currentColumnsData = initialColumns;
		let currentCol = 0;
		let popupOpen = false;
		let currentFocus: "board" | "filters" = "board";
		let filterPopupOpen = false;
		let pendingSearchWrap: "to-first" | "to-last" | null = null;
		let feedOnlyMode = false;
		const sharedFilters = {
			searchQuery: options?.filters?.searchQuery ?? "",
			priorityFilter: options?.filters?.priorityFilter ?? "",
			labelFilter: [...(options?.filters?.labelFilter ?? [])],
			directiveFilter: options?.filters?.directiveFilter ?? "",
		};
		let configuredLabels = collectAvailableLabels(
			initialProposals,
			options?.availableLabels ?? [],
		);
		let availableDirectives = [...(options?.availableDirectives ?? [])];
		const directiveLabelByKey = new Map<string, string>();
		for (const directive of options?.directiveEntities ?? []) {
			const normalizedId = directive.id.trim();
			const normalizedTitle = directive.title.trim();
			if (!normalizedId || !normalizedTitle) continue;
			directiveLabelByKey.set(normalizedId.toLowerCase(), normalizedTitle);
			const idMatch = normalizedId.match(/^m-(\d+)$/i);
			if (idMatch?.[1]) {
				const numericAlias = String(Number.parseInt(idMatch[1], 10));
				directiveLabelByKey.set(`m-${numericAlias}`, normalizedTitle);
				directiveLabelByKey.set(numericAlias, normalizedTitle);
			}
			directiveLabelByKey.set(normalizedTitle.toLowerCase(), normalizedTitle);
		}
		const resolveDirectiveLabel = (directive: string) => {
			const normalized = directive.trim();
			if (!normalized) return directive;
			return directiveLabelByKey.get(normalized.toLowerCase()) ?? directive;
		};
		availableDirectives = Array.from(
			new Set([
				...availableDirectives,
				...initialProposals
					.map((proposal) => proposal.directive?.trim())
					.filter((directive): directive is string =>
						Boolean(directive && directive.length > 0),
					)
					.map((directive) => resolveDirectiveLabel(directive)),
			]),
		).sort((a, b) => a.localeCompare(b));

		let filterHeader: FilterHeader | null = null;
		let hideEmptyColumns = false;
		const hiddenStatusesFromConfig = (config as any)?.hidden_statuses || [
			"Rejected",
			"Discard",
			"Replaced",
		];
		let hiddenStatuses = [...hiddenStatusesFromConfig];
		let hiddenStatusesToggle = true;
		const hasActiveSharedFilters = () =>
			Boolean(
				sharedFilters.searchQuery.trim() ||
					sharedFilters.priorityFilter ||
					sharedFilters.labelFilter.length > 0 ||
					sharedFilters.directiveFilter,
			);
		const emitFilterChange = () => {
			options?.onFilterChange?.({
				searchQuery: sharedFilters.searchQuery,
				priorityFilter: sharedFilters.priorityFilter,
				labelFilter: [...sharedFilters.labelFilter],
				directiveFilter: sharedFilters.directiveFilter,
			});
		};
		const getFilteredProposals = (): Proposal[] => {
			if (!hasActiveSharedFilters()) {
				return [...currentProposals];
			}
			const searchIndex = createProposalSearchIndex(currentProposals);
			return applySharedProposalFilters(
				currentProposals,
				{
					query: sharedFilters.searchQuery,
					priority: sharedFilters.priorityFilter as
						| "high"
						| "medium"
						| "low"
						| undefined,
					labels: sharedFilters.labelFilter,
					directive: sharedFilters.directiveFilter || undefined,
					resolveDirectiveLabel,
				},
				searchIndex,
			);
		};

		const getVisibleWorkflowProposals = (): Proposal[] => {
			const workflowKey = getCurrentWorkflowView().key;
			return normalizeProposalsForWorkflow(
				filterProposalsForWorkflow(getFilteredProposals(), workflowKey),
				workflowKey,
			);
		};

		// Move mode proposal
		type MoveOperation = {
			proposalId: string;
			originalStatus: string;
			originalIndex: number;
			targetStatus: string;
			targetIndex: number;
		};
		let moveOp: MoveOperation | null = null;
		const undoStack: Array<() => Promise<void>> = [];
		const pushUndo = (undo: () => Promise<void>): void => {
			undoStack.push(undo);
			if (undoStack.length > 25) {
				undoStack.shift();
			}
		};
		const startMove = (): void => {
			const column = columns[currentCol];
			if (!column) return;
			const selectedIndex = column.list.selected ?? 0;
			const proposal = column.proposals[selectedIndex];
			if (!proposal) return;
			moveOp = {
				proposalId: proposal.id,
				originalStatus: column.status,
				originalIndex: selectedIndex,
				targetStatus: column.status,
				targetIndex: selectedIndex,
			};
			renderView();
		};
		const cancelMove = (): void => {
			if (!moveOp) return;
			moveOp = null;
			renderView();
		};
		const performProposalMove = async (): Promise<void> => {
			if (!moveOp) return;
			const operation = moveOp;
			moveOp = null;
			try {
				const updatedProposal = await core.moveProposal(
					operation.proposalId,
					operation.targetStatus,
					operation.targetIndex,
					"user",
					true,
				);
				pushUndo(async () => {
					await core.moveProposal(
						operation.proposalId,
						operation.originalStatus,
						operation.originalIndex,
						"user",
						true,
					);
				});
				currentProposals = currentProposals.map((proposal) =>
					proposal.id === updatedProposal.id ? updatedProposal : proposal,
				);
				currentProposals = await core.queryProposals({
					includeCrossBranch: false,
				});
				showTransientFooter(
					` {green-fg}Moved ${updatedProposal.id} to ${operation.targetStatus}{/}`,
				);
				renderView();
			} catch (error) {
				moveOp = operation;
				showTransientFooter(
					` {red-fg}Failed to move ${operation.proposalId}: ${String(error)}{/}`,
				);
				renderView();
			}
		};

		const footerBox = box({
			parent: screen,
			bottom: 0,
			left: 0,
			height: 1,
			width: "100%",
			tags: true,
			wrap: true,
			content: "",
		});
		let transientFooterContent: string | null = null;
		let footerRestoreTimer: ReturnType<typeof setTimeout> | null = null;
		const clearFooterTimer = () => {
			if (!footerRestoreTimer) return;
			clearTimeout(footerRestoreTimer);
			footerRestoreTimer = null;
		};
		const getTerminalWidth = () =>
			typeof screen.width === "number" ? screen.width : 80;
		const getFooterHeight = () =>
			typeof footerBox.height === "number" ? footerBox.height : 1;
		const setFooterContent = (content: string) => {
			const formatted = formatFooterContent(content, getTerminalWidth());
			footerBox.height = formatted.height;
			footerBox.setContent(formatted.content);
		};

		const clearColumns = () => {
			for (const column of columns) {
				column.box.destroy();
			}
			columns = [];
		};

		const getBoardAreaWidth = () => {
			const rawWidth =
				typeof boardArea.width === "number"
					? boardArea.width
					: Math.floor(getTerminalWidth() * 0.75);
			return Math.max(1, rawWidth);
		};

		const getColumnLayout = (count: number) => {
			const totalWidth = getBoardAreaWidth();
			const safeCount = Math.max(1, count);
			const baseWidth = Math.floor(totalWidth / safeCount);
			const extraWidth = totalWidth % safeCount;
			let left = 0;

			return Array.from({ length: safeCount }, (_, idx) => {
				const width = baseWidth + (idx < extraWidth ? 1 : 0);
				const layout = {
					left,
					width: Math.max(1, width),
				};
				left += layout.width;
				return layout;
			});
		};

		const getFormattedItems = (proposals: Proposal[]) => {
			return proposals.map((proposal) =>
				formatProposalListItem(proposal, moveOp?.proposalId === proposal.id),
			);
		};

		const createColumnViews = (data: ColumnData[]) => {
			clearColumns();
			const layouts = getColumnLayout(data.length);
			data.forEach((columnData, idx) => {
				const layout = layouts[idx];
				if (!layout) return;
				const columnBox = box({
					parent: boardArea,
					left: layout.left,
					top: 0,
					width: layout.width,
					height: "100%",
					border: { type: "line" },
					style: { border: { fg: "gray" } },
					label: formatColumnLabel(
						columnData.status,
						columnData.proposals.length,
					),
				});

				const proposalList = list({
					parent: columnBox,
					top: 1,
					left: 1,
					width: "100%-4",
					height: "100%-3",
					keys: false,
					mouse: true,
					scrollable: true,
					tags: true,
					style: { selected: { fg: "white" } },
				});

				proposalList.setItems(getFormattedItems(columnData.proposals));
				columns.push({
					status: columnData.status,
					proposals: columnData.proposals,
					list: proposalList,
					box: columnBox,
				});

				proposalList.on("focus", () => {
					if (popupOpen || filterPopupOpen) return;
					if (currentCol !== idx) {
						setColumnActiveProposal(columns[currentCol], false);
						currentCol = idx;
					}
					setColumnActiveProposal(columns[currentCol], true);
					currentFocus = "board";
					filterHeader?.setBorderColor("cyan");
					updateFooter();
					screen.render();
				});
			});
		};

		const setColumnActiveProposal = (
			column: ColumnView | undefined,
			active: boolean,
		) => {
			if (!column) return;
			const listStyle = column.list.style as { selected?: { bg?: string } };
			// In move mode, use green highlight for the moving proposal
			if (listStyle.selected)
				listStyle.selected.bg =
					moveOp && active ? "green" : active ? "blue" : undefined;
			const boxStyle = column.box.style as { border?: { fg?: string } };
			if (boxStyle.border) boxStyle.border.fg = active ? "yellow" : "gray";
		};

		const getSelectedProposalId = (): string | undefined => {
			const column = columns[currentCol];
			if (!column) return undefined;
			const selectedIndex = column.list.selected ?? 0;
			return column.proposals[selectedIndex]?.id;
		};

		const focusColumn = (
			idx: number,
			preferredRow?: number,
			activate = true,
		) => {
			if (popupOpen) return;
			if (idx < 0 || idx >= columns.length) return;
			const previous = columns[currentCol];
			setColumnActiveProposal(previous, false);

			currentCol = idx;
			const current = columns[currentCol];
			if (!current) return;

			const total = current.proposals.length;
			if (total > 0) {
				const previousSelected =
					typeof previous?.list.selected === "number"
						? previous.list.selected
						: 0;
				const target =
					preferredRow !== undefined
						? preferredRow
						: Math.min(previousSelected, total - 1);
				current.list.select(Math.max(0, target));
			}

			if (activate) {
				current.list.focus();
				setColumnActiveProposal(current, true);
				currentFocus = "board";
			} else {
				setColumnActiveProposal(current, false);
			}
			screen.render();
		};

		const restoreSelection = (proposalId?: string) => {
			const activate = currentFocus !== "filters";
			if (columns.length === 0) return;
			if (proposalId) {
				for (let colIdx = 0; colIdx < columns.length; colIdx += 1) {
					const column = columns[colIdx];
					if (!column) continue;
					const proposalIndex = column.proposals.findIndex(
						(proposal) => proposal.id === proposalId,
					);
					if (proposalIndex !== -1) {
						focusColumn(colIdx, proposalIndex, activate);
						return;
					}
				}
			}
			const safeIndex = Math.min(columns.length - 1, Math.max(0, currentCol));
			focusColumn(safeIndex, undefined, activate);
		};

		const applyColumnData = (
			data: ColumnData[],
			selectedProposalId?: string,
		) => {
			currentColumnsData = data;
			data.forEach((columnData, idx) => {
				const column = columns[idx];
				if (!column) return;
				column.status = columnData.status;
				column.proposals = columnData.proposals;
				column.list.setItems(getFormattedItems(columnData.proposals));
				column.box.setLabel?.(
					formatColumnLabel(columnData.status, columnData.proposals.length),
				);
			});
			restoreSelection(selectedProposalId);
		};

		const rebuildColumns = (
			data: ColumnData[],
			selectedProposalId?: string,
		) => {
			currentColumnsData = data;
			currentStatuses = data.map((column) => column.status);
			createColumnViews(data);
			restoreSelection(selectedProposalId);
		};

		// Pure function to calculate the projected board proposal
		const getProjectedColumns = (
			allProposals: Proposal[],
			operation: MoveOperation | null,
		): ColumnData[] => {
			if (!operation) {
				return prepareBoardColumns(allProposals, currentStatuses);
			}

			// 1. Filter out the moving proposal from the source
			const proposalsWithoutMoving = allProposals.filter(
				(t) => t.id !== operation.proposalId,
			);
			const movingProposal = allProposals.find(
				(t) => t.id === operation.proposalId,
			);

			if (!movingProposal) {
				return prepareBoardColumns(allProposals, currentStatuses);
			}

			// 2. Prepare columns without the moving proposal
			const columns = prepareBoardColumns(
				proposalsWithoutMoving,
				currentStatuses,
			);

			// 3. Insert the moving proposal into the target column at the target index
			const targetColumn = columns.find(
				(c) => c.status === operation.targetStatus,
			);
			if (targetColumn) {
				// Create a "ghost" proposal with updated status
				const ghostProposal = {
					...movingProposal,
					status: operation.targetStatus,
				};

				// Clamp index to valid bounds
				const safeIndex = Math.max(
					0,
					Math.min(operation.targetIndex, targetColumn.proposals.length),
				);
				targetColumn.proposals.splice(safeIndex, 0, ghostProposal);
			}

			return columns;
		};

		const focusFilterControl = (
			filterId: "search" | "priority" | "directive" | "labels",
		) => {
			if (!filterHeader) return;
			switch (filterId) {
				case "search":
					filterHeader.focusSearch();
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
			filterId: "priority" | "directive" | "labels",
		) => {
			if (filterPopupOpen || moveOp || !filterHeader) {
				return;
			}
			filterPopupOpen = true;
			try {
				if (filterId === "labels") {
					const nextLabels = await openMultiSelectFilterPopup({
						screen,
						title: "Label Filter",
						items: [...configuredLabels].sort((a, b) => a.localeCompare(b)),
						selectedItems: sharedFilters.labelFilter,
					});
					if (nextLabels !== null) {
						sharedFilters.labelFilter = nextLabels;
						filterHeader.setFilters({ labels: nextLabels });
						emitFilterChange();
						renderView();
					}
					return;
				}

				if (filterId === "priority") {
					const priorities = ["high", "medium", "low"];
					const selected = await openSingleSelectFilterPopup({
						screen,
						title: "Priority Filter",
						selectedValue: sharedFilters.priorityFilter,
						choices: [
							{ label: "All", value: "" },
							...priorities.map((priority) => ({
								label: priority,
								value: priority,
							})),
						],
					});
					if (selected !== null) {
						sharedFilters.priorityFilter = selected;
						filterHeader.setFilters({ priority: selected });
						emitFilterChange();
						renderView();
					}
					return;
				}

				const selected = await openSingleSelectFilterPopup({
					screen,
					title: "Directive Filter",
					selectedValue: sharedFilters.directiveFilter,
					choices: [
						{ label: "All", value: "" },
						...availableDirectives.map((value) => ({ label: value, value })),
					],
				});
				if (selected !== null) {
					sharedFilters.directiveFilter = selected;
					filterHeader.setFilters({ directive: selected });
					emitFilterChange();
					renderView();
				}
			} finally {
				filterPopupOpen = false;
				focusFilterControl(filterId);
				screen.render();
			}
		};

		filterHeader = createFilterHeader({
			parent: boardPane,
			statuses: [],
			availableLabels: configuredLabels,
			availableDirectives,
			visibleFilters: ["search", "priority", "directive", "labels"],
			initialFilters: {
				search: sharedFilters.searchQuery,
				priority: sharedFilters.priorityFilter,
				labels: sharedFilters.labelFilter,
				directive: sharedFilters.directiveFilter,
			},
			onFilterChange: (filters: FilterProposal) => {
				sharedFilters.searchQuery = filters.search;
				sharedFilters.priorityFilter = filters.priority;
				sharedFilters.labelFilter = filters.labels;
				sharedFilters.directiveFilter = filters.directive;
				emitFilterChange();
				renderView();
			},
			onFilterPickerOpen: (filterId) => {
				if (filterId === "status") {
					return;
				}
				void openFilterPicker(filterId);
			},
		});
		filterHeader.setFocusChangeHandler((focus) => {
			if (focus !== null) {
				currentFocus = "filters";
				setColumnActiveProposal(columns[currentCol], false);
				updateFooter();
				screen.render();
			}
		});
		filterHeader.setExitRequestHandler((direction) => {
			const currentColumn = columns[currentCol];
			const selected = currentColumn?.list.selected;
			const currentIndex = typeof selected === "number" ? selected : undefined;
			const totalProposals = currentColumn?.proposals.length ?? 0;
			const targetIndex = resolveSearchExitTargetIndex(
				direction,
				pendingSearchWrap,
				totalProposals,
				currentIndex,
			);
			pendingSearchWrap = null;
			focusColumn(currentCol, targetIndex);
			updateFooter();
		});
		const syncBoardAreaLayout = () => {
			const headerHeight = filterHeader?.getHeight() ?? 0;
			boardArea.top = headerHeight;
			boardArea.height = `100%-${headerHeight}`;
			boardPane.height = `100%-${getFooterHeight()}`;
			boardPane.hidden = feedOnlyMode;
			if (feedOnlyMode) {
				eventPanel.left = 0;
				eventPanel.right = undefined;
				eventPanel.width = "100%";
			} else {
				eventPanel.left = undefined;
				eventPanel.right = 0;
				eventPanel.width = "25%";
			}
		};
		syncBoardAreaLayout();

		// Build scroll position indicator showing current item position
		const getScrollPositionIndicator = (): string => {
			const column = columns[currentCol];
			if (!column || column.proposals.length === 0) return "";
			const selected = (column.list.selected ?? 0) + 1; // 1-based display
			const total = column.proposals.length;
			const pct = Math.round((selected / total) * 100);
			return ` {gray-fg}${selected}/${total} (${pct}%){/}`;
		};

		const updateFooter = () => {
			if (transientFooterContent) {
				setFooterContent(transientFooterContent);
				syncBoardAreaLayout();
				return;
			}
			const workflowView = getCurrentWorkflowView();
			if (currentFocus === "filters") {
				const filterFocus = filterHeader?.getCurrentFocus();
				if (filterFocus === "search") {
					setFooterContent(
						` {magenta-fg}${workflowView.label}{/} | {cyan-fg}[←/→]{/} Cursor (edge=Prev/Next) | {cyan-fg}[↑/↓]{/} Back to Board | {cyan-fg}[Esc]{/} Cancel | {gray-fg}(Live search){/}`,
					);
					syncBoardAreaLayout();
					return;
				}
				setFooterContent(
					` {magenta-fg}${workflowView.label}{/} | {cyan-fg}[Enter/Space]{/} Open Picker | {cyan-fg}[←/→]{/} Prev/Next | {cyan-fg}[Esc]{/} Back`,
				);
				syncBoardAreaLayout();
				return;
			}
			if (feedOnlyMode) {
				setFooterContent(
					` {magenta-fg}${workflowView.label}{/} | {cyan-fg}[PgUp/PgDn]{/} Scroll | {cyan-fg}[S]{/} Board | {cyan-fg}[Tab]{/} Switch View | {cyan-fg}[q/Esc]{/} Quit`,
				);
				syncBoardAreaLayout();
				return;
			}
			if (moveOp) {
				setFooterContent(
					` {magenta-fg}${workflowView.label}{/} | {green-fg}MOVE MODE{/} | {cyan-fg}[←→]{/} Change Column | {cyan-fg}[↑↓]{/} Reorder | {cyan-fg}[Enter/M]{/} Confirm | {cyan-fg}[Esc]{/} Cancel`,
				);
			} else {
				const base = DEFAULT_FOOTER_CONTENT;
				const posIndicator = getScrollPositionIndicator();
				const filterIndicators = [];
				if (hasActiveSharedFilters())
					filterIndicators.push("{yellow-fg}Filtered{/}");
				if (hideEmptyColumns) filterIndicators.push("{yellow-fg}~Empty{/}");
				if (hiddenStatuses.length > 0)
					filterIndicators.push(`{yellow-fg}~${hiddenStatuses.join(",")}{/}`);
				const indicators = [
					`{magenta-fg}${workflowView.label}{/}`,
					posIndicator,
					...filterIndicators,
				].filter(Boolean);
				setFooterContent(
					indicators.length > 0 ? `${indicators.join(" | ")} ${base}` : base,
				);
			}
			syncBoardAreaLayout();
		};

		const showTransientFooter = (message: string, durationMs = 3000) => {
			transientFooterContent = message;
			clearFooterTimer();
			updateFooter();
			screen.render();
			footerRestoreTimer = setTimeout(() => {
				transientFooterContent = null;
				footerRestoreTimer = null;
				updateFooter();
				screen.render();
			}, durationMs);
		};

		const renderView = () => {
			const workflowView = getCurrentWorkflowView();
			const visibleWorkflowProposals = getVisibleWorkflowProposals();
			currentStatuses = resolveWorkflowStatuses(
				visibleWorkflowProposals,
				workflowView.key,
			);

			let projectedData = getProjectedColumns(visibleWorkflowProposals, moveOp);

			// Apply column visibility filters
			projectedData = filterBoardColumns(projectedData, {
				hideEmpty: hideEmptyColumns,
				hiddenStatuses,
			});

			// If we are moving, we want to select the moving proposal
			const selectedId = moveOp ? moveOp.proposalId : getSelectedProposalId();

			if (projectedData.length === 0) {
				const fallbackStatus = currentStatuses[0] ?? "No Status";
				rebuildColumns([{ status: fallbackStatus, proposals: [] }], selectedId);
			} else if (shouldRebuildColumns(currentColumnsData, projectedData)) {
				rebuildColumns(projectedData, selectedId);
			} else {
				applyColumnData(projectedData, selectedId);
			}

			screen.title = `Roadmap Board - ${workflowView.label} - ${versionLabel}`;
			updateFooter();
			screen.render();
		};

		rebuildColumns(initialColumns);
		const firstColumn = columns[0];
		if (firstColumn) {
			currentCol = 0;
			setColumnActiveProposal(firstColumn, true);
			if (firstColumn.proposals.length > 0) {
				firstColumn.list.select(0);
			}
			firstColumn.list.focus();
		}

		const updateBoard = (nextProposals: Proposal[], nextStatuses: string[]) => {
			// Update source of truth
			currentProposals = nextProposals;
			// Only update statuses if they changed (rare in TUI)
			if (nextStatuses.length > 0) currentStatuses = nextStatuses;
			configuredLabels = collectAvailableLabels(
				currentProposals,
				options?.availableLabels ?? [],
			);
			availableDirectives = Array.from(
				new Set([
					...(options?.availableDirectives ?? []),
					...currentProposals
						.map((proposal) => proposal.directive?.trim())
						.filter((directive): directive is string =>
							Boolean(directive && directive.length > 0),
						)
						.map((directive) => resolveDirectiveLabel(directive)),
				]),
			).sort((a, b) => a.localeCompare(b));

			renderView();
		};

		options?.subscribeUpdates?.(updateBoard);

		screen.on("resize", () => {
			filterHeader?.rebuild();
			syncBoardAreaLayout();
			renderView();
		});

		// Helper to get target column size (excluding the moving proposal if it's currently there)
		const getTargetColumnSize = (status: string): number => {
			const columnData = currentColumnsData.find((c) => c.status === status);
			if (!columnData) return 0;
			// If the moving proposal is currently in this column, we need to account for it
			if (moveOp && moveOp.targetStatus === status) {
				// The proposal is already "in" this column in the projected view
				return columnData.proposals.length;
			}
			// Otherwise, the proposal will be added to this column
			return columnData.proposals.length;
		};

		screen.key(["/", "C-f"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			pendingSearchWrap = null;
			focusFilterControl("search");
			updateFooter();
		});

		screen.key(["w", "W"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			popupOpen = true;
			void (async () => {
				try {
					const currentView = getCurrentWorkflowView();
					const selected = await openSingleSelectFilterPopup({
						screen,
						title: "Workflow View",
						selectedValue: currentView.key,
						choices: WORKFLOW_VIEWS.filter(
							(workflow) => workflow.key !== "all",
						).map((workflow) => ({
							label: workflow.label,
							value: workflow.key,
						})),
						helpText:
							" {cyan-fg}[↑↓]{/} Navigate | {cyan-fg}[Enter]{/} Select | {cyan-fg}[Esc]{/} Cancel",
					});
					if (selected === null) {
						return;
					}
					const nextIndex = WORKFLOW_VIEWS.findIndex(
						(workflow) => workflow.key === selected,
					);
					if (nextIndex >= 0) {
						currentWorkflowViewIndex = nextIndex;
						showTransientFooter(
							` {magenta-fg}Workflow: ${getCurrentWorkflowView().label}{/}`,
						);
						renderView();
					}
				} finally {
					popupOpen = false;
					screen.render();
				}
			})();
		});

		screen.key(["s", "S"], () => {
			if (popupOpen || filterPopupOpen || moveOp || currentFocus === "filters")
				return;
			feedOnlyMode = !feedOnlyMode;
			if (feedOnlyMode) {
				feedPinnedToLatest = true;
				feedWindowStart = getFeedMaxWindowStart();
				renderFeedPanel();
			}
			showTransientFooter(
				feedOnlyMode
					? " {cyan-fg}Feed view enabled{/}"
					: " {cyan-fg}Board view enabled{/}",
			);
			syncBoardAreaLayout();
			updateFooter();
			screen.render();
		});

		screen.key(["t", "T"], () => {
			if (popupOpen || filterPopupOpen || moveOp || currentFocus === "filters")
				return;
			if (!feedOnlyMode) return; // t is for title edit in board mode
			feedThreadMode = !feedThreadMode;
			if (feedThreadMode) {
				// Rebuild feed as threads from accumulated events
				feedLines = buildThreadLines(_allFeedEvents);
			} else {
				// Rebuild as flat chronological list
				feedLines = _allFeedEvents.map(formatEventLine);
			}
			feedPinnedToLatest = true;
			feedWindowStart = getFeedMaxWindowStart();
			renderFeedPanel();
			showTransientFooter(
				feedThreadMode
					? " {cyan-fg}Thread mode: grouped by proposal{/}"
					: " {cyan-fg}Chronological mode{/}",
			);
			screen.render();
		});

		screen.key(["p", "P"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			void openFilterPicker("priority");
		});

		screen.key(["f", "F"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			void openFilterPicker("labels");
		});

		// Toggle hide empty columns
		screen.key(["~"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			hideEmptyColumns = !hideEmptyColumns;
			showTransientFooter(
				hideEmptyColumns
					? " {green-fg}Empty columns hidden{/}"
					: " {green-fg}Empty columns shown{/}",
			);
			renderView();
		});

		// Toggle hidden terminal columns
		screen.key(["="], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			hiddenStatusesToggle = !hiddenStatusesToggle;
			hiddenStatuses = hiddenStatusesToggle ? hiddenStatusesFromConfig : [];
			showTransientFooter(
				hiddenStatusesToggle
					? " {green-fg}Terminal columns hidden{/}"
					: " {green-fg}Terminal columns shown{/}",
			);
			renderView();
		});

		// Column visibility toggle with proposal memory
		const hiddenColumns = new Set<string>();
		let previousVisibility: string[] | null = null; // For restoring previous proposal

		const applyColumnVisibility = () => {
			const filteredStatuses = currentStatuses.filter(
				(s) => !hiddenColumns.has(s),
			);
			currentStatuses = filteredStatuses;
			rebuildColumns(currentColumnsData);
			renderView();
		};

	// V = show all columns / toggle restore
	let vPressCount = 0;
	screen.key(["v", "V"], () => {
		if (popupOpen || filterPopupOpen || moveOp) return;
		vPressCount++;
		if (vPressCount === 1 && previousVisibility) {
			// Restore previous visibility
			hiddenColumns.clear();
			currentStatuses.forEach((s) => {
				if (!previousVisibility?.includes(s)) hiddenColumns.add(s);
			});
			applyColumnVisibility();
			showTransientFooter(
				" {green-fg}Previous column visibility restored{/}",
			);
		} else {
			// Save current and show all
			previousVisibility = [...currentStatuses];
			hiddenColumns.clear();
			applyColumnVisibility();
			vPressCount = 0;
			showTransientFooter(
				" {green-fg}All columns shown{/} (V again to restore previous)",
			);
		}
	});

		// H = hide current (focused) column
		screen.key(["h", "H"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			// Current column is the one we're on
			const focusedCol = columns[currentCol]?.status;
			if (!focusedCol) return;
			previousVisibility = currentStatuses.filter((s) => !hiddenColumns.has(s));
			hiddenColumns.add(focusedCol);
			// Ensure current column index is valid after hiding
			if (
				currentCol >=
				currentStatuses.filter((s) => !hiddenColumns.has(s)).length
			) {
				currentCol = Math.max(
					0,
					currentStatuses.filter((s) => !hiddenColumns.has(s)).length - 1,
				);
			}
			applyColumnVisibility();
			showTransientFooter(
				` {red-fg}${focusedCol} column hidden{/} | press V to restore all`,
			);
		});

		// O = show only current column
		screen.key(["o", "O"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			const focusedCol = columns[currentCol]?.status;
			if (!focusedCol) return;
			previousVisibility = currentStatuses.filter((s) => !hiddenColumns.has(s));
			hiddenColumns.clear();
			currentStatuses.forEach((s) => {
				if (s !== focusedCol) hiddenColumns.add(s);
			});
			applyColumnVisibility();
			showTransientFooter(
				` {green-fg}Showing only: ${focusedCol}{/} | press V to restore all`,
			);
		});

		// Number keys toggle individual columns
		for (let i = 1; i <= 9; i++) {
			screen.key([String(i)], () => {
				if (popupOpen || filterPopupOpen || moveOp) return;
				// Only intercept if V was pressed (column mode)
				const statusIdx = i - 1;
				if (statusIdx >= currentStatuses.length) return;
				const status = currentStatuses[statusIdx];
				if (!status) return;
				if (hiddenColumns.has(status)) {
					hiddenColumns.delete(status);
					showTransientFooter(` {green-fg}${status} column shown{/}`);
				} else {
					hiddenColumns.add(status);
					showTransientFooter(` {red-fg}${status} column hidden{/}`);
				}
				applyColumnVisibility();
			});
		}

		screen.key(["left", "h"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;
			if (moveOp) {
				const currentStatusIndex = currentStatuses.indexOf(moveOp.targetStatus);
				if (currentStatusIndex > 0) {
					const prevStatus = currentStatuses[currentStatusIndex - 1];
					if (prevStatus) {
						const prevColumnSize = getTargetColumnSize(prevStatus);
						moveOp.targetStatus = prevStatus;
						// Clamp index to valid range for new column (0 to size, where size means append at end)
						moveOp.targetIndex = Math.min(moveOp.targetIndex, prevColumnSize);
						renderView();
					}
				}
			} else {
				focusColumn(currentCol - 1);
			}
		});

		screen.key(["right", "l"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;
			if (moveOp) {
				const currentStatusIndex = currentStatuses.indexOf(moveOp.targetStatus);
				if (currentStatusIndex < currentStatuses.length - 1) {
					const nextStatus = currentStatuses[currentStatusIndex + 1];
					if (nextStatus) {
						const nextColumnSize = getTargetColumnSize(nextStatus);
						moveOp.targetStatus = nextStatus;
						// Clamp index to valid range for new column
						moveOp.targetIndex = Math.min(moveOp.targetIndex, nextColumnSize);
						renderView();
					}
				}
			} else {
				focusColumn(currentCol + 1);
			}
		});

		screen.key(["up", "k"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;

			if (moveOp) {
				if (moveOp.targetIndex > 0) {
					moveOp.targetIndex--;
					renderView();
				}
			} else {
				const column = columns[currentCol];
				if (!column) return;
				const listWidget = column.list;
				const selected = listWidget.selected ?? 0;
				const total = column.proposals.length;
				if (total === 0) {
					pendingSearchWrap = null;
					focusFilterControl("search");
					updateFooter();
					screen.render();
					return;
				}
				if (shouldMoveFromListBoundaryToSearch("up", selected, total)) {
					pendingSearchWrap = "to-last";
					focusFilterControl("search");
					updateFooter();
					screen.render();
					return;
				}
				const nextIndex = selected - 1;
				listWidget.select(nextIndex);
				screen.render();
			}
		});

		screen.key(["down", "j"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;

			if (moveOp) {
				const column = columns[currentCol];
				// We need to check the projected length to know if we can move down
				// The current rendered column has the correct length including the ghost proposal
				if (column && moveOp.targetIndex < column.proposals.length - 1) {
					moveOp.targetIndex++;
					renderView();
				}
			} else {
				const column = columns[currentCol];
				if (!column) return;
				const listWidget = column.list;
				const selected = listWidget.selected ?? 0;
				const total = column.proposals.length;
				if (total === 0) {
					pendingSearchWrap = null;
					focusFilterControl("search");
					updateFooter();
					screen.render();
					return;
				}
				if (shouldMoveFromListBoundaryToSearch("down", selected, total)) {
					pendingSearchWrap = "to-first";
					focusFilterControl("search");
					updateFooter();
					screen.render();
					return;
				}
				const nextIndex = selected + 1;
				listWidget.select(nextIndex);
				screen.render();
			}
		});

		// S129: Ctrl+Arrows for Reordering and Transitions
		screen.key(["C-up"], async () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			const proposalId = getSelectedProposalId();
			if (!proposalId) return;
			const column = columns[currentCol];
			if (!column) return;
			const idx = column.list.selected ?? 0;
			if (idx > 0) {
				const targetStatus = column.status;
				await core.moveProposal(
					proposalId,
					targetStatus,
					idx - 1,
					"user",
					true,
				);
				renderView();
			}
		});

		screen.key(["C-down"], async () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			const proposalId = getSelectedProposalId();
			if (!proposalId) return;
			const column = columns[currentCol];
			if (!column) return;
			const idx = column.list.selected ?? 0;
			if (idx < column.proposals.length - 1) {
				const targetStatus = column.status;
				await core.moveProposal(
					proposalId,
					targetStatus,
					idx + 1,
					"user",
					true,
				);
				renderView();
			}
		});

		screen.key(["C-left"], async () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			const proposalId = getSelectedProposalId();
			if (!proposalId) return;
			try {
				const proposal = await core.getProposal(proposalId);
				if (!proposal) return;
				const oldStatus = proposal.status;
				await core.demoteProposalProper(proposalId, "user", true);
				pushUndo(async () => {
					await core.updateProposalFromInput(
						proposalId,
						{ status: oldStatus },
						true,
					);
				});
				renderView();
			} catch (_e) {
				/* ignore */
			}
		});

		screen.key(["C-right"], async () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			const proposalId = getSelectedProposalId();
			if (!proposalId) return;
			try {
				const proposal = await core.getProposal(proposalId);
				if (!proposal) return;
				const oldStatus = proposal.status;
				await core.promoteProposal(proposalId, "user", true);
				pushUndo(async () => {
					await core.updateProposalFromInput(
						proposalId,
						{ status: oldStatus },
						true,
					);
				});
				renderView();
			} catch (_e) {
				/* ignore */
			}
		});

		// S129: Alt+Arrows for Hierarchy Management
		screen.key(["M-up"], async () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			const proposalId = getSelectedProposalId();
			if (!proposalId) return;
			const column = columns[currentCol];
			if (!column) return;
			const idx = column.list.selected ?? 0;
			if (idx > 0) {
				const parentCandidate = column.proposals[idx - 1];
				if (parentCandidate) {
					await core.updateProposalFromInput(
						proposalId,
						{ parentProposalId: parentCandidate.id },
						true,
					);
					showTransientFooter(
						` {green-fg}Set parent of ${proposalId} to ${parentCandidate.id}{/}`,
					);
					renderView();
				}
			}
		});

		screen.key(["M-left"], async () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			const proposalId = getSelectedProposalId();
			if (!proposalId) return;
			await core.updateProposalFromInput(
				proposalId,
				{ parentProposalId: null as any },
				true,
			);
			showTransientFooter(` {yellow-fg}Released parent of ${proposalId}{/}`);
			renderView();
		});

		// Helper to get the visible page size (number of items that fit on screen)
		const getPageSize = (): number => {
			const column = columns[currentCol];
			if (!column) return 10; // default fallback
			// Get the actual rendered height of the list widget
			const height = column.list.height;
			const h = typeof height === "number" ? height : 20;
			// Each item takes roughly 1 row, so page size is the visible height
			return Math.max(1, h - 1); // Subtract 1 for some breathing room
		};

		// Page Down - scroll forward by one screen height
		screen.key(["pagedown"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;

			if (feedOnlyMode) {
				feedPinnedToLatest = false;
				const pageSize = getFeedPageSize();
				feedWindowStart = Math.min(
					feedWindowStart + pageSize,
					Math.max(feedLines.length - pageSize, 0),
				);
				renderFeedPanel();
				screen.render();
				return;
			}

			const column = columns[currentCol];
			if (!column) return;
			const listWidget = column.list;
			const selected = listWidget.selected ?? 0;
			const total = column.proposals.length;
			if (total === 0) return;

			const pageSize = getPageSize();
			const nextIndex = Math.min(selected + pageSize, total - 1);
			listWidget.select(nextIndex);
			updateFooter();
			screen.render();
		});

		// Page Up - scroll backward by one screen height
		screen.key(["pageup"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;

			if (feedOnlyMode) {
				feedPinnedToLatest = false;
				const pageSize = getFeedPageSize();
				feedWindowStart = Math.max(feedWindowStart - pageSize, 0);
				renderFeedPanel();
				screen.render();
				return;
			}

			const column = columns[currentCol];
			if (!column) return;
			const listWidget = column.list;
			const selected = listWidget.selected ?? 0;
			const total = column.proposals.length;
			if (total === 0) return;

			const pageSize = getPageSize();
			const nextIndex = Math.max(selected - pageSize, 0);
			listWidget.select(nextIndex);
			updateFooter();
			screen.render();
		});

		// Home - jump to first item
		screen.key(["home"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;

			const column = columns[currentCol];
			if (!column) return;
			const listWidget = column.list;
			const total = column.proposals.length;
			if (total === 0) return;

			listWidget.select(0);
			updateFooter();
			screen.render();
		});

		// End - jump to last item
		screen.key(["end"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;

			const column = columns[currentCol];
			if (!column) return;
			const listWidget = column.list;
			const total = column.proposals.length;
			if (total === 0) return;

			listWidget.select(total - 1);
			updateFooter();
			screen.render();
		});

		const _openProposalEditor = async (proposal: Proposal) => {
			try {
				const core = new Core(process.cwd(), { enableWatchers: true });
				const result = await core.editProposalInTui(
					proposal.id,
					screen,
					proposal,
				);
				if (result.reason === "read_only") {
					const branchInfo = result.proposal?.branch
						? ` from branch "${result.proposal.branch}"`
						: "";
					showTransientFooter(` {red-fg}Cannot edit proposal${branchInfo}.{/}`);
					return;
				}
				if (result.reason === "editor_failed") {
					showTransientFooter(
						" {red-fg}Editor exited with an error; proposal was not modified.{/}",
					);
					return;
				}
				if (result.reason === "not_found") {
					showTransientFooter(
						` {red-fg}Proposal ${proposal.id} not found on this branch.{/}`,
					);
					return;
				}

				if (result.proposal) {
					currentProposals = currentProposals.map((existingProposal) =>
						existingProposal.id === proposal.id
							? result.proposal || existingProposal
							: existingProposal,
					);
				}

				if (result.changed) {
					renderView();
					showTransientFooter(
						` {green-fg}Proposal ${result.proposal?.id ?? proposal.id} marked modified.{/}`,
					);
					return;
				}

				renderView();
				showTransientFooter(
					` {gray-fg}No changes detected for ${result.proposal?.id ?? proposal.id}.{/}`,
				);
			} catch (_error) {
				showTransientFooter(" {red-fg}Failed to open editor.{/}");
			}
		};

		screen.key(["enter"], async () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;

			// In move mode, Enter confirms the move
			if (moveOp) {
				await performProposalMove();
				return;
			}

			const column = columns[currentCol];
			if (!column) return;
			const idx = column.list.selected ?? 0;
			if (idx < 0 || idx >= column.proposals.length) return;
			const proposal = column.proposals[idx];
			if (!proposal) return;
			popupOpen = true;

			const popup = await createProposalPopup(
				screen,
				proposal,
				resolveDirectiveLabel,
			);
			if (!popup) {
				popupOpen = false;
				return;
			}

			const { contentArea, close } = popup;
			contentArea.key(["escape", "q"], () => {
				popupOpen = false;
				close();
				focusColumn(currentCol);
				return false;
			});

			screen.render();
		});

		const openQuickEdit = async (
			proposal: Proposal,
			field: "title" | "assignee" | "labels",
		) => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters" || moveOp)
				return;

			const { promptText } = await import("./tui.ts");
			let message = "";
			let defaultValue = "";

			if (field === "title") {
				message = "New Title:";
				defaultValue = proposal.title;
			} else if (field === "assignee") {
				message = "Assignee (comma-separated):";
				defaultValue = proposal.assignee?.join(", ") ?? "";
			} else if (field === "labels") {
				message = "Labels (comma-separated):";
				defaultValue = proposal.labels?.join(", ") ?? "";
			}

			// Suspend screen to allow promptText (readline) to work
			screen.leave();
			const newValue = await promptText(message, defaultValue);
			screen.enter();

			if (newValue === defaultValue) {
				renderView();
				return;
			}

			try {
				const core = new Core(process.cwd());
				const updateInput: any = {};
				if (field === "title") updateInput.title = newValue;
				else if (field === "assignee")
					updateInput.assignee = newValue
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);
				else if (field === "labels")
					updateInput.labels = newValue
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean);

				const updated = await core.editProposal(proposal.id, updateInput);
				currentProposals = currentProposals.map((s) =>
					s.id === proposal.id ? updated : s,
				);
				showTransientFooter(
					` {green-fg}Updated ${field} for ${proposal.id}{/}`,
				);
				renderView();
			} catch (error) {
				showTransientFooter(` {red-fg}Failed to update ${field}: ${error}{/}`);
				renderView();
			}
		};

		screen.key(["t", "T"], async () => {
			if (feedOnlyMode) return; // t is for thread mode in feed view
			const column = columns[currentCol];
			if (!column) return;
			const idx = column.list.selected ?? 0;
			const proposal = column.proposals[idx];
			if (proposal) await openQuickEdit(proposal, "title");
		});

		screen.key(["l", "L"], async () => {
			const column = columns[currentCol];
			if (!column) return;
			const idx = column.list.selected ?? 0;
			const proposal = column.proposals[idx];
			if (proposal) await openQuickEdit(proposal, "labels");
		});

		screen.key(["x", "X"], async () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters" || moveOp)
				return;
			const proposalId = getSelectedProposalId();
			if (!proposalId) return;
			const proposal = await core.getProposal(proposalId);
			if (!proposal) return;
			const { generateProposalMarkdown } = await import(
				"../../shared/utils/proposal-markdown-generator.ts"
			);
			const md = generateProposalMarkdown(proposal);
			const { join } = await import("node:path");
			const fs = await import("node:fs");
			const exportDir = join(process.cwd(), "export");
			if (!fs.existsSync(exportDir)) {
				fs.mkdirSync(exportDir, { recursive: true });
			}
			const exportPath = join(exportDir, `export-${proposalId}.md`);
			fs.writeFileSync(exportPath, md);
			showTransientFooter(` {green-fg}Exported to ${exportPath}{/}`);
		});

		screen.key(["tab"], async () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters" || moveOp) return;
			const column = columns[currentCol];
			if (column) {
				const idx = column.list.selected ?? 0;
				if (idx >= 0 && idx < column.proposals.length) {
					const proposal = column.proposals[idx];
					if (proposal) options?.onProposalSelect?.(proposal);
				}
			}

			if (options?.onTabPress) {
				clearFooterTimer();
				screen.destroy();
				await options.onTabPress();
				resolve();
				return;
			}

			if (options?.viewSwitcher) {
				clearFooterTimer();
				screen.destroy();
				await options.viewSwitcher.switchView();
				resolve();
				return;
			}

			currentWorkflowViewIndex =
				(currentWorkflowViewIndex + 1) % WORKFLOW_VIEWS.length;
			showTransientFooter(
				` {magenta-fg}Workflow: ${getCurrentWorkflowView().label}{/}`,
			);
			renderView();
			screen.render();
			return;
		});

		screen.key(["m"], () => {
			if (popupOpen || filterPopupOpen || currentFocus === "filters" || moveOp)
				return;
			startMove();
		});

		screen.key(["q", "C-c"], () => {
			if (popupOpen || filterPopupOpen) return;
			clearFooterTimer();
			screen.destroy();
			resolve();
		});

		screen.key(["escape"], () => {
			if (popupOpen || filterPopupOpen) return;
			if (currentFocus === "filters") {
				focusColumn(currentCol);
				updateFooter();
				return;
			}
			// In move mode, ESC cancels and restores original position
			if (moveOp) {
				cancelMove();
				return;
			}

			if (!popupOpen) {
				clearFooterTimer();
				screen.destroy();
				resolve();
			}
		});

		// Poll for new events and update event panel
		let _currentEvents: StreamEvent[] = [];
		const seenFeedEventIds = new Set<string>();
		let feedLines: string[] = [];
		const FEED_HISTORY_LIMIT = 500;
		let feedWindowStart = 0;
		let feedPinnedToLatest = true;
		let feedThreadMode = false;
		let _allFeedEvents: StreamEvent[] = []; // kept for thread mode rebuild
		const getFeedPageSize = () => {
			// Use screen rows minus overhead (header=1, footer=2, borders=2)
			return Math.max((screen.rows as number) - 5, 5);
		};
		const getFeedMaxWindowStart = () =>
			Math.max(feedLines.length - getFeedPageSize(), 0);
		const renderFeedPanel = () => {
			if (feedPinnedToLatest) {
				feedWindowStart = getFeedMaxWindowStart();
			}
			const pageSize = getFeedPageSize();
			const visibleLines = feedLines.slice(
				feedWindowStart,
				feedWindowStart + pageSize,
			);
			eventPanel.setContent(
				visibleLines.length > 0
					? visibleLines.join("\n")
					: "{gray-fg}No recent feed items{/}",
			);
		};
		// Board-style icons matching status-icon.ts
		const stateIconMap: Record<string, string> = {
			draft: "○", review: "◆", develop: "◒", merge: "▣", complete: "✓",
			rejected: "✖", discard: "●", replaced: "⇄", building: "◒",
			accepted: "▣", abandoned: "●", obsolete: "✖", blocked: "●",
		};
		const maturityIconMap: Record<string, string> = {
			new: "○", active: "▶", mature: "✓", obsolete: "✖",
		};
		const stateColorMap: Record<string, string> = {
			draft: "white", review: "yellow", develop: "cyan", merge: "magenta", complete: "green",
			rejected: "red", discard: "gray", replaced: "blue", building: "cyan",
		};
		const maturityColorMap: Record<string, string> = {
			new: "white", active: "cyan", mature: "green", obsolete: "red",
		};
		const getFeedIcon = (e: StreamEvent): string => {
			// State transition: "P289 state draft -> review"
			if (e.message.includes(" state ")) {
				const m = e.message.match(/state\s+\S+\s+->\s+(\S+)/);
				if (m) {
					const state = m[1].toLowerCase();
					const icon = stateIconMap[state] ?? "S";
					const color = stateColorMap[state] ?? "white";
					return `{${color}-fg}${icon}{/}`;
				}
				return "S";
			}
			// Maturity transition: "P289 maturity new -> active"
			if (e.message.includes(" maturity ")) {
				const m = e.message.match(/maturity\s+\S+\s+->\s+(\S+)/);
				if (m) {
					const mat = m[1].toLowerCase();
					const icon = maturityIconMap[mat] ?? "M";
					const color = maturityColorMap[mat] ?? "white";
					return `{${color}-fg}${icon}{/}`;
				}
				return "M";
			}
			// Other event types with colors
			const typeMap: Record<string, [string, string]> = {
				proposal_accepted: ["▣", "green"], proposal_claimed: ["◆", "yellow"],
				proposal_coding: ["◒", "cyan"], review_requested: ["?", "yellow"],
				proposal_reviewing: ["◆", "yellow"], review_passed: ["✓", "green"],
				review_failed: ["✖", "red"], proposal_complete: ["✓", "green"],
				proposal_merged: ["▣", "magenta"], proposal_pushed: ["P", "cyan"],
				agent_online: ["+", "green"], agent_offline: ["-", "red"],
				heartbeat: ["$", "gray"], cubic_phase_change: ["~", "blue"],
				custom: [".", "white"], message: ["@", "cyan"],
			};
			const entry = typeMap[e.type];
			if (entry) return `{${entry[1]}-fg}${entry[0]}{/}`;
			return `{white-fg}.{/}`;
		};

		const buildThreadLines = (events: StreamEvent[]): string[] => {
			const byProposal = new Map<string, StreamEvent[]>();
			const global: StreamEvent[] = [];
			for (const e of events) {
				if (e.proposalId) {
					const arr = byProposal.get(e.proposalId);
					if (arr) arr.push(e);
					else byProposal.set(e.proposalId, [e]);
				} else {
					global.push(e);
				}
			}
			const lines: string[] = [];
			// Sort proposals by most recent event first
			const sortedEntries = [...byProposal.entries()].sort((a, b) => {
				const lastA = Math.max(...a[1].map((e) => e.timestamp));
				const lastB = Math.max(...b[1].map((e) => e.timestamp));
				return lastB - lastA;
			});
			for (const [pid, evts] of sortedEntries) {
				// Proposal header with latest state icon
				const latestState = evts.reduce((best, e) => {
					if (e.message.includes(" state ")) {
						const m = e.message.match(/state\s+\S+\s+->\s+(\S+)/);
						if (m && e.timestamp > best.ts) return { state: m[1], ts: e.timestamp };
					}
					return best;
				}, { state: "", ts: 0 });
				const headerIcon = latestState.state
					? (stateIconMap[latestState.state.toLowerCase()] ?? "○")
					: "○";
				lines.push(
					`{white-bg}{black-fg} ${headerIcon} ${pid} {/} {gray-fg}(${evts.length} events){/}`,
				);
				for (const e of evts) {
					const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
						hour: "2-digit", minute: "2-digit", second: "2-digit",
					});
					const icon = getFeedIcon(e);
					// Indent thread items
					lines.push(`  {cyan-fg}${time}{/} ${icon} ${e.message}`);
				}
				lines.push(""); // blank line between threads
			}
			if (global.length > 0) {
				lines.push(
					"{white-bg}{black-fg} $ global {/} {gray-fg}(" + global.length + " events){/}",
				);
				for (const e of global) {
					const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
						hour: "2-digit", minute: "2-digit", second: "2-digit",
					});
					const icon = getFeedIcon(e);
					lines.push(`  {cyan-fg}${time}{/} ${icon} ${e.message}`);
				}
			}
			return lines;
		};

		const formatEventLine = (e: StreamEvent): string => {
			const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
				hour: "2-digit", minute: "2-digit", second: "2-digit",
			});
			const icon = getFeedIcon(e);
			return `{cyan-fg}${time}{/} ${icon} ${e.message}`;
		};

		const updateEventPanel = async () => {
			const events = await getBoardLiveFeed(30);
			_currentEvents = events;
			const unseenEvents = events.filter((event) => !seenFeedEventIds.has(event.id));
			if (unseenEvents.length === 0 && feedLines.length > 0) {
				return;
			}

			for (const event of unseenEvents) {
				seenFeedEventIds.add(event.id);
			}

			// Accumulate all events for thread mode rebuild
			for (const e of unseenEvents) {
				if (!_allFeedEvents.find((x) => x.id === e.id)) {
					_allFeedEvents.push(e);
				}
			}
			_allFeedEvents.sort((a, b) => a.timestamp - b.timestamp);
			if (_allFeedEvents.length > FEED_HISTORY_LIMIT) {
				_allFeedEvents = _allFeedEvents.slice(-FEED_HISTORY_LIMIT);
			}

			if (feedThreadMode) {
				// Rebuild entire thread view from accumulated events
				feedLines = buildThreadLines(_allFeedEvents);
			} else {
				const newLines = unseenEvents
					.slice()
					.reverse()
					.map(formatEventLine);
				feedLines = [...feedLines, ...newLines].slice(-FEED_HISTORY_LIMIT);
			}
			if (feedPinnedToLatest) {
				feedWindowStart = getFeedMaxWindowStart();
			} else {
				feedWindowStart = Math.min(feedWindowStart, getFeedMaxWindowStart());
			}
			renderFeedPanel();
			screen.render();
		};
		void updateEventPanel();
		const eventPanelTimer = setInterval(() => {
			void updateEventPanel();
		}, 3000);

		// Auto-refresh proposals from DB every 5s
		const proposalRefreshTimer = setInterval(async () => {
			try {
				const fresh = await core.queryProposals({
					includeCrossBranch: false,
				});
				currentProposals = fresh;
				renderView();
				screen.render();
			} catch {}
		}, 5000);

		screen.on("destroy", () => {
			clearInterval(eventPanelTimer);
			clearInterval(proposalRefreshTimer);
			clearFooterTimer();
		});

		screen.render();
	});
}
