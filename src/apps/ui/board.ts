import {
	type BoardLayout,
	buildKanbanStatusGroups,
	generateDirectiveGroupedBoard,
	generateKanbanBoardWithMetadata,
} from "../../board.ts";
import {
	getRecentEvents,
	type StreamEvent,
} from "../../core/messaging/event-stream.ts";
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
import {
	createProposalPopup,
	resolveSearchExitTargetIndex,
	shouldMoveFromListBoundaryToSearch,
} from "./proposal-viewer-with-search.ts";
import {
	getMaturityColor,
	getMaturityIcon,
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
	const assignee = proposal.assignee?.[0]
		? ` {cyan-fg}${proposal.assignee[0].startsWith("@") ? proposal.assignee[0] : `@${proposal.assignee[0]}`}{/}`
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

	// Maturity-based color coding (overrides status color for the ID part)
	const maturity = (proposal as Proposal & { maturity?: string }).maturity;
	const maturityColorName = getMaturityColor(maturity);
	const maturityColor = `{${maturityColorName}-fg}`;
	const maturityIcon = getMaturityIcon(maturity);

	// Use status color as base if no maturity color
	const baseColor = maturityColor || statusColor;

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
	const content = `${baseColor}${maturityIcon}{bold}${displayId}{/bold}${baseColor ? "{/}" : ""} - ${statusColor}${proposal.title}{/}${assignee}${labels}${branch}${mergeSuffix}`;
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
	" {cyan-fg}[Tab]{/} Switch View | {cyan-fg}[/]{/} Search | {cyan-fg}[P]{/} Priority | {cyan-fg}[F]{/} Labels | {cyan-fg}[~]{/} Hide Empty | {cyan-fg}[=]{/} Hide Archive | {cyan-fg}[←→]{/} Columns | {cyan-fg}[↑↓]{/} Proposals | {cyan-fg}[PgUp/PgDn]{/} Page | {cyan-fg}[Home/End]{/} First/Last | {cyan-fg}[Enter]{/} View | {cyan-fg}[X]{/} Export | {cyan-fg}[q/Esc]{/} Quit";

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

	let initialColumns = prepareBoardColumns(initialProposals, statuses);
	initialColumns = filterBoardColumns(initialColumns, {
		hiddenStatuses: hiddenStatusesFromConfig,
	});

	if (initialColumns.length === 0) {
		console.log("No active proposals available for the Kanban board.");
		return;
	}

	await new Promise<void>((resolve) => {
		const screen = createScreen({ title: `Roadmap Board - ${versionLabel}` });
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

		const boardArea = box({
			parent: container,
			top: 0,
			left: 0,
			width: "75%",
			height: "100%-1",
		});

		// Live event stream sidebar (right panel)
		const eventPanel = box({
			parent: container,
			top: 0,
			right: 0,
			width: "25%",
			height: "100%-1",
			border: { type: "line" },
			label: " 📰 Headlines ",
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
		let currentStatuses = currentColumnsData.map((column) => column.status);
		let currentCol = 0;
		let popupOpen = false;
		let currentFocus: "board" | "filters" = "board";
		let filterPopupOpen = false;
		let pendingSearchWrap: "to-first" | "to-last" | null = null;
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

		const columnWidthFor = (count: number) =>
			Math.max(1, Math.floor(100 / Math.max(1, count)));

		const getFormattedItems = (proposals: Proposal[]) => {
			return proposals.map((proposal) =>
				formatProposalListItem(proposal, moveOp?.proposalId === proposal.id),
			);
		};

		const createColumnViews = (data: ColumnData[]) => {
			clearColumns();
			const widthPercent = columnWidthFor(data.length);
			data.forEach((columnData, idx) => {
				const left = idx * widthPercent;
				const isLast = idx === data.length - 1;
				const width = isLast
					? `${Math.max(0, 100 - left)}%`
					: `${widthPercent}%`;
				const columnBox = box({
					parent: boardArea,
					left: `${left}%`,
					top: 0,
					width,
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
			parent: container,
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
			boardArea.height = `100%-${headerHeight + getFooterHeight()}`;
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
			if (currentFocus === "filters") {
				const filterFocus = filterHeader?.getCurrentFocus();
				if (filterFocus === "search") {
					setFooterContent(
						" {cyan-fg}[←/→]{/} Cursor (edge=Prev/Next) | {cyan-fg}[↑/↓]{/} Back to Board | {cyan-fg}[Esc]{/} Cancel | {gray-fg}(Live search){/}",
					);
					syncBoardAreaLayout();
					return;
				}
				setFooterContent(
					" {cyan-fg}[Enter/Space]{/} Open Picker | {cyan-fg}[←/→]{/} Prev/Next | {cyan-fg}[Esc]{/} Back",
				);
				syncBoardAreaLayout();
				return;
			}
			if (moveOp) {
				setFooterContent(
					" {green-fg}MOVE MODE{/} | {cyan-fg}[←→]{/} Change Column | {cyan-fg}[↑↓]{/} Reorder | {cyan-fg}[Enter/M]{/} Confirm | {cyan-fg}[Esc]{/} Cancel",
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
				const indicators = [posIndicator, ...filterIndicators].filter(Boolean);
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
			let projectedData = getProjectedColumns(getFilteredProposals(), moveOp);

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
			const filteredStatuses = statuses.filter((s) => !hiddenColumns.has(s));
			currentStatuses = filteredStatuses;
			rebuildColumns(currentColumnsData);
			renderView();
		};

		// V = show all columns
		screen.key(["v", "V"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			previousVisibility = [...currentStatuses]; // Save current proposal
			hiddenColumns.clear();
			applyColumnVisibility();
			showTransientFooter(
				" {green-fg}All columns shown{/} (V again to restore previous)",
			);
		});

		// Press V again to restore previous visibility
		let vPressCount = 0;
		screen.key(["v", "V"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			vPressCount++;
			if (vPressCount === 1 && previousVisibility) {
				// Restore previous proposal
				hiddenColumns.clear();
				statuses.forEach((s) => {
					if (!previousVisibility?.includes(s)) hiddenColumns.add(s);
				});
				applyColumnVisibility();
				showTransientFooter(
					" {green-fg}Previous column visibility restored{/}",
				);
			}
		});

		// H = hide current (focused) column
		screen.key(["h", "H"], () => {
			if (popupOpen || filterPopupOpen || moveOp) return;
			// Current column is the one we're on
			const focusedCol = columns[currentCol]?.status;
			if (!focusedCol) return;
			previousVisibility = statuses.filter((s) => !hiddenColumns.has(s));
			hiddenColumns.add(focusedCol);
			// Ensure current column index is valid after hiding
			if (currentCol >= statuses.filter((s) => !hiddenColumns.has(s)).length) {
				currentCol = Math.max(
					0,
					statuses.filter((s) => !hiddenColumns.has(s)).length - 1,
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
			previousVisibility = statuses.filter((s) => !hiddenColumns.has(s));
			hiddenColumns.clear();
			statuses.forEach((s) => {
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
				if (statusIdx >= statuses.length) return;
				const status = statuses[statusIdx];
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
			if (popupOpen || filterPopupOpen || currentFocus === "filters") return;
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
			}
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
		const updateEventPanel = () => {
			const events = getRecentEvents(30);
			if (events.length > 0) {
				_currentEvents = events;
				const lines = events.map((e) => {
					const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
						hour: "2-digit",
						minute: "2-digit",
						second: "2-digit",
					});
					const icon =
						{
							proposal_accepted: "📋",
							proposal_claimed: "✋",
							proposal_coding: "💻",
							review_requested: "👀",
							proposal_reviewing: "🔍",
							review_passed: "✅",
							review_failed: "❌",
							proposal_complete: "🎉",
							proposal_merged: "🔀",
							proposal_pushed: "🚀",
							agent_online: "🟢",
							agent_offline: "🔴",
							handoff: "🤝",
							heartbeat: "💓",
							cubic_phase_change: "🔄",
							custom: "📌",
							message: "💬",
						}[e.type] || "📌";
					return `{cyan-fg}${time}{/} ${icon} ${e.message}`;
				});
				eventPanel.setContent(lines.join("\n"));
			}
			screen.render();
		};
		updateEventPanel();
		const eventPanelTimer = setInterval(updateEventPanel, 3000);

		screen.on("destroy", () => {
			clearInterval(eventPanelTimer);
			clearFooterTimer();
		});

		screen.render();
	});
}
