import { execSync } from "node:child_process";
import fs from "node:fs";
import {
	rename as moveFile,
	readFile,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	DEFAULT_CLAIM_DURATION_MINUTES,
	DEFAULT_DIRECTORIES,
	DEFAULT_STATUSES,
	FALLBACK_STATUS,
} from "../constants/index.ts";
import { FileSystem } from "../file-system/operations.ts";
import { GitOperations } from "../git/operations.ts";
import * as pgPool from "../postgres/pool.ts";
import type {
	ProposalAcceptanceCriterionRow,
	ProposalDependency,
	ProposalRow,
	ProposalSummary,
} from "../postgres/proposal-storage-v2.ts";
import * as pg from "../postgres/proposal-storage-v2.ts";
import {
	type AcceptanceCriterion,
	type Agent,
	type Decision,
	type Directive,
	type Document,
	EntityType,
	isLocalEditableProposal,
	type Proposal,
	type ProposalClaim,
	type ProposalCreateInput,
	type ProposalListFilter,
	type ProposalUpdateInput,
	type PulseEvent,
	type PulseType,
	type RoadmapConfig,
	type SearchFilters,
	type Sequence,
} from "../types/index.ts";
import { normalizeAssignee } from "../utils/assignee.ts";
import { formatLocalDateTime } from "../utils/date-time.ts";
import { documentIdsEqual } from "../utils/document-id.ts";
import { openInEditor } from "../utils/editor.ts";
import { FileLock } from "../utils/file-lock.ts";
import {
	createDirectiveFilterValueResolver,
	normalizeDirectiveFilterValue,
	resolveClosestDirectiveFilterValue,
} from "../utils/milestone-filter.ts";
import {
	buildIdRegex,
	extractAnyPrefix,
	getPrefixForType,
	normalizeId,
} from "../utils/prefix-config.ts";
import {
	normalizeDependencies,
	normalizeStringList,
	stringArraysEqual,
	validateDependencies,
} from "../utils/proposal-builders.ts";
import {
	getProposalFilename,
	getProposalPath,
	normalizeProposalId,
	proposalIdsEqual,
} from "../utils/proposal-path.ts";
import { compareProposalIds } from "../utils/proposal-sorting.ts";
import { attachSubproposalSummaries } from "../utils/proposal-subproposals.ts";
import { upsertProposalUpdatedDate } from "../utils/proposal-updated-date.ts";
import {
	getCanonicalStatus as resolveCanonicalStatus,
	getValidStatuses as resolveValidStatuses,
} from "../utils/status.ts";
import { executeStatusCallback } from "../utils/status-callback.ts";
import {
	migrateConfig,
	needsMigration,
} from "./infrastructure/config-migration.ts";
import {
	createDaemonClientFromConfig,
	type DaemonClient,
} from "./infrastructure/daemon-client.ts";
import {
	migrateDraftPrefixes,
	needsDraftPrefixMigration,
} from "./infrastructure/prefix-migration.ts";
import { RateLimiter } from "./infrastructure/rate-limiter.ts";
import { SearchService } from "./infrastructure/search-service.ts";
import { getBlockingIssues, loadIssues } from "./pipeline/issue-tracker.ts";
import {
	isCompleteStatus,
	isReachedStatus,
	isReady,
} from "./proposal/directives.ts";
import {
	calculateNewOrdinal,
	DEFAULT_ORDINAL_STEP,
	resolveOrdinalConflicts,
} from "./proposal/reorder.ts";
import {
	computeSequences,
	planMoveToSequence,
	planMoveToUnsequenced,
} from "./proposal/sequences.ts";
import { ContentStore } from "./storage/content-store.ts";
import {
	type BranchProposalProposalEntry,
	findProposalInLocalBranches,
	findProposalInRemoteBranches,
	getProposalLoadingMessage,
	loadLocalBranchProposals,
	loadRemoteProposals,
	resolveProposalConflict,
} from "./storage/proposal-loader.ts";

interface BlessedScreen {
	program: {
		disableMouse(): void;
		enableMouse(): void;
		hideCursor(): void;
		showCursor(): void;
		input: NodeJS.EventEmitter;
		pause?: () => (() => void) | undefined;
		flush?: () => void;
		put?: {
			keypad_local?: () => void;
			keypad_xmit?: () => void;
		};
	};
	leave(): void;
	enter(): void;
	render(): void;
	clearRegion(x1: number, x2: number, y1: number, y2: number): void;
	width: number;
	height: number;
	emit(event: string): void;
}

interface ProposalQueryOptions {
	filters?: ProposalListFilter;
	query?: string;
	limit?: number;
	includeCrossBranch?: boolean;
	status?: string;
}

/** Local budget configuration (.roadmap/budget.json) */
interface BudgetConfig {
	agents?: Record<
		string,
		{
			dailyLimitUsd: number;
			totalSpentTodayUsd: number;
			isFrozen: boolean;
		}
	>;
}

export type TuiProposalEditFailureReason =
	| "not_found"
	| "read_only"
	| "editor_failed";

export interface TuiProposalEditResult {
	changed: boolean;
	proposal?: Proposal;
	reason?: TuiProposalEditFailureReason;
}

function buildLatestProposalMap(
	proposalEntries: BranchProposalProposalEntry[] = [],
	localProposals: Array<
		Proposal & { lastModified?: Date; updatedDate?: string }
	> = [],
	localArchivedProposals: Array<
		Proposal & { lastModified?: Date; updatedDate?: string }
	> = [],
): Map<string, BranchProposalProposalEntry> {
	const latest = new Map<string, BranchProposalProposalEntry>();
	const isAuthoritativeLocalTerminal = (
		entry?: BranchProposalProposalEntry,
	): boolean =>
		Boolean(
			entry &&
				entry.branch === "local" &&
				(entry.type === "archived" || entry.type === "completed"),
		);
	const update = (entry: BranchProposalProposalEntry) => {
		const existing = latest.get(entry.id);
		if (isAuthoritativeLocalTerminal(existing)) {
			return;
		}
		if (
			isAuthoritativeLocalTerminal(entry) ||
			!existing ||
			entry.lastModified > existing.lastModified
		) {
			latest.set(entry.id, entry);
		}
	};

	for (const entry of proposalEntries) {
		update(entry);
	}

	for (const proposal of localProposals) {
		if (!proposal.id) continue;
		const lastModified =
			proposal.lastModified ??
			(proposal.updatedDate ? new Date(proposal.updatedDate) : new Date(0));

		update({
			id: proposal.id,
			type: "proposal",
			branch: "local",
			path: "",
			lastModified,
		});
	}

	for (const proposal of localArchivedProposals) {
		if (!proposal.id) continue;
		const lastModified =
			proposal.lastModified ??
			(proposal.updatedDate ? new Date(proposal.updatedDate) : new Date(0));

		update({
			id: proposal.id,
			type: "archived",
			branch: "local",
			path: "",
			lastModified,
		});
	}

	return latest;
}

function filterProposalsByProposalSnapshots(
	proposals: Proposal[],
	latestProposal: Map<string, BranchProposalProposalEntry>,
): Proposal[] {
	return proposals.filter((proposal) => {
		const latest = latestProposal.get(proposal.id);
		if (!latest) return true;
		return latest.type === "proposal";
	});
}

/**
 * Extract IDs from proposal map where latest proposal is "proposal" or "completed" (not "archived" or "draft")
 * Used for ID generation to determine which IDs are in use.
 */
function getActiveAndCompletedIdsFromProposalMap(
	latestProposal: Map<string, BranchProposalProposalEntry>,
): string[] {
	const ids: string[] = [];
	for (const [id, entry] of latestProposal) {
		if (entry.type === "proposal" || entry.type === "completed") {
			ids.push(id);
		}
	}
	return ids;
}

export class Core {
	public fs: FileSystem;
	public git: GitOperations;
	private contentStore?: ContentStore;
	private searchService?: SearchService;
	private daemonClient?: DaemonClient | null;
	private daemonClientChecked = false;
	private readonly enableWatchers: boolean;
	// Channel subscriptions: agent -> set of channel names
	private subscriptions: Map<string, Set<string>> = new Map();
	private subscriptionsLoaded = false;
	// Push notification callbacks: agent -> callback for receiving messages
	private notificationCallbacks: Map<
		string,
		(msg: {
			channel: string;
			from: string;
			text: string;
			timestamp: string;
		}) => void
	> = new Map();
	// Rate Limiter (PROPOSAL-44): per-agent rate limiting with fair share
	private rateLimiter?: RateLimiter;
	// Preloaded proposals for listAgents() to avoid deadlock in buildSnapshot()
	private _preloadedProposalsForAgents?: Proposal[];

	constructor(projectRoot: string, options?: { enableWatchers?: boolean }) {
		this.fs = new FileSystem(projectRoot);
		this.git = new GitOperations(projectRoot);
		// Disable watchers by default for CLI commands (non-interactive)
		// Interactive modes (TUI, browser, MCP) should explicitly pass enableWatchers: true
		this.enableWatchers = options?.enableWatchers ?? false;
		// Note: Config is loaded lazily when needed since constructor can't be async
	}

	/**
	 * Preload proposals for listAgents() to avoid deadlock when called
	 * in parallel with loadProposals() (e.g., in buildSnapshot).
	 */
	setPreloadedProposalsForAgents(proposals: Proposal[]): void {
		this._preloadedProposalsForAgents = proposals;
	}

	/**
	 * Get the daemon client if configured and available.
	 * Returns null if no daemon is configured or reachable.
	 */
	async getDaemonClient(): Promise<DaemonClient | null> {
		if (this.daemonClientChecked) {
			return this.daemonClient ?? null;
		}

		this.daemonClientChecked = true;

		try {
			const config = await this.fs.loadConfig();
			const client = createDaemonClientFromConfig(config ?? undefined);
			if (client) {
				// Verify the daemon is actually reachable
				const available = await client.isAvailable();
				if (available) {
					this.daemonClient = client;
					return client;
				}
			}
		} catch {
			// Config might not exist yet, or other error - fall back to local
		}

		this.daemonClient = null;
		return null;
	}

	/**
	 * Check if daemon mode is active (configured and reachable).
	 */
	async isDaemonMode(): Promise<boolean> {
		const client = await this.getDaemonClient();
		return client !== null;
	}

	/**
	 * Get the Rate Limiter for per-agent fair share (PROPOSAL-44).
	 */
	getRateLimiter(): RateLimiter {
		if (!this.rateLimiter) {
			this.rateLimiter = new RateLimiter(this.fs.rootDir);
		}
		return this.rateLimiter;
	}

	/**
	 * Load budget configuration from .roadmap/budget.json (local agent spending limits).
	 * Returns null if no config exists (unlimited budget for local dev).
	 */
	async loadBudgetConfig(): Promise<BudgetConfig | null> {
		try {
			const budgetPath = join(this.fs.rootDir, ".roadmap", "budget.json");
			const content = await readFile(budgetPath, "utf-8");
			return JSON.parse(content) as BudgetConfig;
		} catch {
			return null; // No config = unlimited (safe default)
		}
	}

	async getContentStore(): Promise<ContentStore> {
		if (!this.contentStore) {
			this.contentStore = new ContentStore(
				this.fs,
				async () => {
					return await this.loadProposals();
				},
				this.enableWatchers,
			);
		}
		await this.contentStore.ensureInitialized();
		return this.contentStore;
	}

	async getSearchService(): Promise<SearchService> {
		if (!this.searchService) {
			const store = await this.getContentStore();
			this.searchService = new SearchService(store);
		}
		await this.searchService.ensureInitialized();
		return this.searchService;
	}

	private applyProposalFilters(
		proposals: Proposal[],
		filters?: ProposalListFilter,
		resolveDirectiveFilterValue?: (directiveValue: string) => string,
		allProposals?: Proposal[],
	): Proposal[] {
		// Ensure depth and subproposal summaries are attached before filtering (required for depth filtering)
		const referenceProposals =
			allProposals && allProposals.length > 0 ? allProposals : proposals;
		let result = proposals.map((proposal) =>
			attachSubproposalSummaries(proposal, referenceProposals),
		);

		if (filters) {
			if (filters.status) {
				const statusLower = filters.status.toLowerCase();
				result = result.filter(
					(proposal) => (proposal.status ?? "").toLowerCase() === statusLower,
				);
			}
			if (filters.assignee) {
				const assigneeLower = filters.assignee.toLowerCase();
				result = result.filter((proposal) =>
					(proposal.assignee ?? []).some(
						(value) => value.toLowerCase() === assigneeLower,
					),
				);
			}
			if (filters.priority) {
				const priorityLower = String(filters.priority).toLowerCase();
				result = result.filter(
					(proposal) =>
						(proposal.priority ?? "").toLowerCase() === priorityLower,
				);
			}
			if (filters.directive) {
				const directiveFilter = resolveClosestDirectiveFilterValue(
					filters.directive,
					result.map(
						(proposal) =>
							resolveDirectiveFilterValue?.(proposal.directive ?? "") ??
							proposal.directive ??
							"",
					),
				);
				result = result.filter(
					(proposal) =>
						normalizeDirectiveFilterValue(
							resolveDirectiveFilterValue?.(proposal.directive ?? "") ??
								proposal.directive ??
								"",
						) === directiveFilter,
				);
			}
			if (filters.parentProposalId) {
				const parentFilter = filters.parentProposalId;
				result = result.filter(
					(proposal) =>
						proposal.parentProposalId &&
						proposalIdsEqual(parentFilter, proposal.parentProposalId),
				);
			}
			if (filters.labels && filters.labels.length > 0) {
				const requiredLabels = filters.labels
					.map((label) => label.toLowerCase())
					.filter(Boolean);
				if (requiredLabels.length > 0) {
					result = result.filter((proposal) => {
						const proposalLabels =
							proposal.labels?.map((label) => label.toLowerCase()) || [];
						if (proposalLabels.length === 0) return false;
						const labelSet = new Set(proposalLabels);
						return requiredLabels.some((label) => labelSet.has(label));
					});
				}
			}
			if (filters.rationale) {
				const rationaleLower = filters.rationale.toLowerCase();
				result = result.filter((proposal) => {
					return (proposal.rationale ?? "").toLowerCase() === rationaleLower;
				});
			}
			if (filters.depth !== undefined) {
				result = result.filter((proposal) => proposal.depth === filters.depth);
			}
		}

		if (allProposals || filters?.ready) {
			const referenceProposals = allProposals || proposals;
			const doneIds = new Set(
				referenceProposals
					.filter((t) => isCompleteStatus(t.status))
					.map((t) => t.id),
			);

			result = result.map((proposal) => {
				const ready = isReady(proposal, doneIds, referenceProposals);
				return {
					...proposal,
					ready,
				};
			});

			if (filters?.ready) {
				result = result.filter((proposal) => proposal.ready);
			}
		}
		return result;
	}

	private filterLocalEditableProposals(proposals: Proposal[]): Proposal[] {
		return proposals.filter(isLocalEditableProposal);
	}

	private async requireCanonicalStatus(status: string): Promise<string> {
		const canonical = await resolveCanonicalStatus(status, this);
		if (canonical) {
			return canonical;
		}
		const validStatuses = await resolveValidStatuses(this);
		throw new Error(
			`Invalid status: ${status}. Valid statuses are: ${validStatuses.join(", ")}`,
		);
	}

	private normalizePriority(
		value: string | undefined,
	): ("high" | "medium" | "low") | undefined {
		if (value === undefined || value === "") {
			return undefined;
		}
		const normalized = value.toLowerCase();
		const allowed = ["high", "medium", "low"] as const;
		if (!allowed.includes(normalized as (typeof allowed)[number])) {
			throw new Error(
				`Invalid priority: ${value}. Valid values are: high, medium, low`,
			);
		}
		return normalized as "high" | "medium" | "low";
	}

	private isExactProposalReference(
		reference: string,
		proposalId: string,
	): boolean {
		const trimmed = reference.trim();
		if (!trimmed) {
			return false;
		}
		const proposalPrefix = extractAnyPrefix(proposalId);
		const referencePrefix = extractAnyPrefix(trimmed);
		if (!proposalPrefix || !referencePrefix) {
			return false;
		}
		if (proposalPrefix.toLowerCase() !== referencePrefix.toLowerCase()) {
			return false;
		}
		return (
			normalizeProposalId(trimmed, proposalPrefix).toLowerCase() ===
			normalizeProposalId(proposalId, proposalPrefix).toLowerCase()
		);
	}

	private sanitizeArchivedProposalLinks(
		proposals: Proposal[],
		archivedProposalId: string,
	): Proposal[] {
		const changedProposals: Proposal[] = [];

		for (const proposal of proposals) {
			const dependencies = proposal.dependencies ?? [];
			const references = proposal.references ?? [];

			const sanitizedDependencies = dependencies.filter(
				(dependency) => !proposalIdsEqual(dependency, archivedProposalId),
			);
			const sanitizedReferences = references.filter(
				(reference) =>
					!this.isExactProposalReference(reference, archivedProposalId),
			);

			const dependenciesChanged = !stringArraysEqual(
				dependencies,
				sanitizedDependencies,
			);
			const referencesChanged = !stringArraysEqual(
				references,
				sanitizedReferences,
			);
			if (!dependenciesChanged && !referencesChanged) {
				continue;
			}

			changedProposals.push({
				...proposal,
				dependencies: sanitizedDependencies,
				references: sanitizedReferences,
			});
		}

		return changedProposals;
	}

	private async isPostgresProposalBackend(
		config?: RoadmapConfig | null,
	): Promise<boolean> {
		const resolvedConfig = config ?? (await this.filesystem.loadConfig());
		return resolvedConfig?.database?.provider === "Postgres";
	}

	private getPgTagMetadata(
		tags: ProposalRow["tags"],
	): Record<string, unknown> | null {
		if (!tags || Array.isArray(tags) || typeof tags !== "object") {
			return null;
		}
		return tags as Record<string, unknown>;
	}

	private getPgTagString(
		tags: ProposalRow["tags"],
		key: string,
	): string | undefined {
		const metadata = this.getPgTagMetadata(tags);
		const value = metadata?.[key];
		return typeof value === "string" && value.trim().length > 0
			? value
			: undefined;
	}

	private getPgTagStringArray(
		tags: ProposalRow["tags"],
		key: string,
	): string[] | undefined {
		const metadata = this.getPgTagMetadata(tags);
		const value = metadata?.[key];
		if (!Array.isArray(value)) {
			return undefined;
		}
		const normalized = value.map((item) => String(item).trim()).filter(Boolean);
		return normalized.length > 0 ? normalized : undefined;
	}

	private buildPgTags(proposal: Proposal): Record<string, unknown> | null {
		const tags: Record<string, unknown> = {};

		if (proposal.labels.length > 0) tags.labels = [...proposal.labels];
		if (proposal.directive?.trim()) tags.directive = proposal.directive.trim();
		if (proposal.domainId?.trim()) tags.domainId = proposal.domainId.trim();
		if (proposal.category?.trim()) tags.category = proposal.category.trim();
		if (proposal.references && proposal.references.length > 0)
			tags.references = [...proposal.references];
		if (proposal.documentation && proposal.documentation.length > 0)
			tags.documentation = [...proposal.documentation];
		if (proposal.proof && proposal.proof.length > 0)
			tags.proof = [...proposal.proof];
		if (proposal.needs_capabilities && proposal.needs_capabilities.length > 0) {
			tags.needs_capabilities = [...proposal.needs_capabilities];
		}
		if (
			proposal.external_injections &&
			proposal.external_injections.length > 0
		) {
			tags.external_injections = [...proposal.external_injections];
		}
		if (proposal.unlocks && proposal.unlocks.length > 0)
			tags.unlocks = [...proposal.unlocks];
		if (proposal.rationale?.trim()) tags.rationale = proposal.rationale.trim();
		if (proposal.implementationNotes?.trim())
			tags.implementationNotes = proposal.implementationNotes.trim();
		if (proposal.auditNotes?.trim())
			tags.auditNotes = proposal.auditNotes.trim();
		if (proposal.finalSummary?.trim())
			tags.finalSummary = proposal.finalSummary.trim();
		if (proposal.scopeSummary?.trim())
			tags.scopeSummary = proposal.scopeSummary.trim();
		if (proposal.builder?.trim()) tags.builder = proposal.builder.trim();
		if (proposal.auditor?.trim()) tags.auditor = proposal.auditor.trim();
		if (proposal.rawContent?.trim())
			tags.rawContent = proposal.rawContent.trim();
		if (
			proposal.verificationProposalments &&
			proposal.verificationProposalments.length > 0
		) {
			tags.verificationProposalments = proposal.verificationProposalments.map(
				(item) => ({
					index: item.index,
					text: item.text,
					checked: item.checked,
					role: item.role,
					evidence: item.evidence,
				}),
			);
		}

		return Object.keys(tags).length > 0 ? tags : null;
	}

	private mapPgAcceptanceCriteria(
		rows: ProposalAcceptanceCriterionRow[],
	): AcceptanceCriterion[] {
		return rows.map((row) => ({
			index: row.item_number,
			text: row.criterion_text,
			checked: row.status === "pass",
			evidence: row.verification_notes ?? undefined,
			role: row.verified_by ?? undefined,
		}));
	}

	private async hydratePgProposalRow(
		row: ProposalRow,
		options?: {
			summary?: ProposalSummary | null;
			dependencies?: ProposalDependency[];
			acceptanceCriteria?: ProposalAcceptanceCriterionRow[];
			parentProposalId?: string;
		},
	): Promise<Proposal> {
		const summary = options?.summary ?? (await pg.getProposalSummary(row.id));
		const dependencies = (options?.dependencies ?? []).filter(
			(dependency) =>
				dependency.from_proposal_id === row.id &&
				dependency.dependency_type === "blocks" &&
				!dependency.resolved,
		);
		const acceptanceCriteria = options?.acceptanceCriteria ?? [];
		const metadata = this.getPgTagMetadata(row.tags);

		const id = row.display_id || `#${row.id}`;
		const labels = this.mapPgLabels(row.tags);
		const rawContent = this.buildPgRawContent(row);
		const maturity = this.mapPgMaturity(row);
		const priority = this.mapPgPriority(row.priority);
		const leaseActive =
			Boolean(summary?.leased_by) &&
			(summary?.lease_expires === null ||
				summary?.lease_expires === undefined ||
				new Date(summary.lease_expires) > new Date());
		const assignee =
			summary?.leased_by && leaseActive ? [summary.leased_by] : [];
		const claimCreated = summary?.leased_at
			? formatLocalDateTime(new Date(summary.leased_at))
			: undefined;
		const claimExpires = summary?.lease_expires
			? formatLocalDateTime(new Date(summary.lease_expires))
			: claimCreated;
		const parentProposalId =
			options?.parentProposalId ??
			(row.parent_id !== null
				? ((await pg.getProposal(row.parent_id))?.display_id ?? undefined)
				: undefined);

		return {
			id,
			title: row.title || "(no title)",
			status: row.status,
			assignee,
			labels,
			dependencies: dependencies.map((dependency) => dependency.to_display_id),
			rawContent,
			description: row.summary || undefined,
			implementationPlan: row.design || undefined,
			implementationNotes: this.getPgTagString(row.tags, "implementationNotes"),
			auditNotes: this.getPgTagString(row.tags, "auditNotes"),
			finalSummary: this.getPgTagString(row.tags, "finalSummary"),
			scopeSummary: this.getPgTagString(row.tags, "scopeSummary"),
			createdDate: new Date(row.created_at)
				.toISOString()
				.slice(0, 16)
				.replace("T", " "),
			updatedDate: new Date(row.modified_at)
				.toISOString()
				.slice(0, 16)
				.replace("T", " "),
			proposalType: row.type,
			domainId: this.getPgTagString(row.tags, "domainId"),
			category: this.getPgTagString(row.tags, "category"),
			directive: this.getPgTagString(row.tags, "directive"),
			references: this.getPgTagStringArray(row.tags, "references"),
			documentation: this.getPgTagStringArray(row.tags, "documentation"),
			proof: this.getPgTagStringArray(row.tags, "proof"),
			needs_capabilities: this.getPgTagStringArray(
				row.tags,
				"needs_capabilities",
			),
			external_injections: this.getPgTagStringArray(
				row.tags,
				"external_injections",
			),
			unlocks: this.getPgTagStringArray(row.tags, "unlocks"),
			rationale: this.getPgTagString(row.tags, "rationale"),
			builder: this.getPgTagString(row.tags, "builder"),
			auditor: this.getPgTagString(row.tags, "auditor"),
			...(parentProposalId && { parentProposalId }),
			...(acceptanceCriteria.length > 0 && {
				acceptanceCriteriaItems:
					this.mapPgAcceptanceCriteria(acceptanceCriteria),
			}),
			...(summary?.leased_by && leaseActive && claimCreated && claimExpires
				? {
						claim: {
							agent: summary.leased_by,
							created: claimCreated,
							expires: claimExpires,
						},
					}
				: {}),
			...(maturity && { maturity }),
			...(priority && { priority }),
			...(metadata?.verificationProposalments &&
			Array.isArray(metadata.verificationProposalments) &&
			metadata.verificationProposalments.length > 0
				? {
						verificationProposalments: metadata.verificationProposalments.map(
							(item, index) => ({
								index:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { index?: unknown }).index === "number"
										? (item as { index: number }).index
										: index + 1,
								text:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { text?: unknown }).text === "string"
										? String((item as { text: string }).text)
										: String(item),
								checked:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { checked?: unknown }).checked === "boolean"
										? Boolean((item as { checked: boolean }).checked)
										: false,
								role:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { role?: unknown }).role === "string"
										? String((item as { role: string }).role)
										: undefined,
								evidence:
									typeof item === "object" &&
									item !== null &&
									typeof (item as { evidence?: unknown }).evidence === "string"
										? String((item as { evidence: string }).evidence)
										: undefined,
							}),
						),
					}
				: {}),
		};
	}

	private buildPgRawContent(row: ProposalRow): string {
		const rawContent = this.getPgTagString(row.tags, "rawContent");
		const sections = [
			["Summary", row.summary],
			["Motivation", row.motivation],
			["Design", row.design],
			["Drawbacks", row.drawbacks],
			["Alternatives", row.alternatives],
			["Dependency", row.dependency],
		].flatMap(([heading, value]) => {
			const content = value?.trim();
			return content ? [[heading, content] as [string, string]] : [];
		});

		if (sections.length === 0) {
			return rawContent ?? "";
		}

		if (sections.length === 1) {
			return sections[0][1].trim();
		}

		const built = sections
			.map(([heading, value]) => `## ${heading}\n\n${value.trim()}`)
			.join("\n\n");
		return rawContent && rawContent.trim().length > 0
			? `${built}\n\n${rawContent.trim()}`
			: built;
	}

	private mapPgLabels(tags: ProposalRow["tags"]): string[] {
		if (!tags) {
			return [];
		}

		const explicitLabels = this.getPgTagStringArray(tags, "labels");
		if (explicitLabels) {
			return explicitLabels;
		}

		if (Array.isArray(tags)) {
			return tags.map((tag) => String(tag));
		}

		if (typeof tags === "object") {
			return Object.entries(tags).flatMap(([key, value]) => {
				if (Array.isArray(value)) {
					return value.map((item) => String(item));
				}

				if (
					value === null ||
					value === undefined ||
					typeof value === "object"
				) {
					return [];
				}

				return [`${key}:${String(value)}`];
			});
		}

		return [String(tags)];
	}

	private mapPgMaturity(row: ProposalRow): Proposal["maturity"] | undefined {
		// maturity_state is now a direct TEXT column — no JSONB parsing needed
		const state = row.maturity_state;
		if (!state) return undefined;
		switch (state) {
			case "new":
			case "active":
			case "mature":
			case "obsolete":
				return state;
			default:
				return undefined;
		}
	}

	private mapPgPriority(
		priority: string | null,
	): Proposal["priority"] | undefined {
		switch (priority?.toLowerCase()) {
			case "high":
			case "medium":
			case "low":
				return priority.toLowerCase() as Proposal["priority"];
			default:
				return undefined;
		}
	}

	/** Ensure Postgres pool is initialised — needed when CLI has no PG_PASSWORD env from systemd. */
	private async ensurePgPool(): Promise<void> {
		try {
			const config = await this.filesystem.loadConfig();
			if (config?.database) {
				pgPool.initPoolFromConfig(config.database);
			}
			await pgPool.query("SELECT 1");
		} catch {
			// Ignore — fallthrough to query will surface the real error
		}
	}

	private async resolvePgProposalType(preferredType?: string): Promise<string> {
		if (preferredType && preferredType.trim().length > 0) {
			return preferredType.trim();
		}
		await this.ensurePgPool();
		const availableTypes = await pg.listProposalTypes();
		if (availableTypes.length === 0) {
			throw new Error("No roadmap proposal types are configured in Postgres.");
		}
		return availableTypes[0].type;
	}

	private async loadPgProposalById(
		proposalId: string,
	): Promise<Proposal | null> {
		await this.ensurePgPool();
		const row = await pg.getProposal(proposalId);
		if (!row) {
			return null;
		}
		const [summary, dependencies, acceptanceCriteria] = await Promise.all([
			pg.getProposalSummary(row.id),
			pg.listDependencies([row.id]),
			pg.listAcceptanceCriteria(row.id),
		]);
		return await this.hydratePgProposalRow(row, {
			summary,
			dependencies,
			acceptanceCriteria,
		});
	}

	/** Load proposals from Postgres, excluding any already present in the disk set. */
	private async loadProposalsFromPostgres(
		existing: Proposal[],
		pgFilters?: { status?: string; type?: string },
	): Promise<Proposal[]> {
		try {
			await this.ensurePgPool();
			const rows = await pg.listProposals(pgFilters);
			// Build a set of display_ids already present from disk to avoid duplicates
			const diskIds = new Set(existing.map((p) => p.id));
			const pgProposals = (
				await Promise.all(
					rows.map(async (row) => {
						const pgId = row.display_id || `#${row.id}`;
						if (diskIds.has(pgId)) {
							return null;
						}
						return await this.hydratePgProposalRow(row);
					}),
				)
			).filter((proposal): proposal is Proposal => proposal !== null);
			return pgProposals;
		} catch (err) {
			if (process.env.DEBUG) {
				console.error("[DEBUG] loadProposalsFromPostgres failed:", err);
			}
			return [];
		}
	}

	async queryProposals(
		options: ProposalQueryOptions = {},
	): Promise<Proposal[]> {
		const { query, limit } = options;
		const filters =
			options.filters ??
			(options.status ? { status: options.status } : undefined);
		const trimmedQuery = query?.trim();
		const includeCrossBranch = options.includeCrossBranch ?? true;
		const config = await this.fs.loadConfig();

		if (await this.isPostgresProposalBackend(config)) {
			await this.ensurePgPool();
			const directiveResolverPromise = filters?.directive
				? Promise.all([
						this.fs.listDirectives(),
						this.fs.listArchivedDirectives(),
					]).then(([activeDirectives, archivedDirectives]) =>
						createDirectiveFilterValueResolver([
							...activeDirectives,
							...archivedDirectives,
						]),
					)
				: undefined;
			const pgFilters: Parameters<typeof pg.listProposals>[0] = {
				status: filters?.status,
			};
			const rows = trimmedQuery
				? await pg.searchProposals(
						trimmedQuery,
						typeof limit === "number" ? Math.max(limit * 3, limit) : undefined,
					)
				: await pg.listProposals(pgFilters);
			const summaries = await pg.listProposalSummaries(pgFilters);
			const dependencyRows = await pg.listDependencies(
				rows.map((row) => row.id),
			);
			const summaryById = new Map(
				summaries.map((summary) => [summary.id, summary]),
			);
			const rowById = new Map(rows.map((row) => [row.id, row]));
			const proposals = await Promise.all(
				rows.map(async (row) =>
					this.hydratePgProposalRow(row, {
						summary: summaryById.get(row.id),
						dependencies: dependencyRows,
						parentProposalId:
							row.parent_id !== null
								? rowById.get(row.parent_id)?.display_id
								: undefined,
					}),
				),
			);

			const queue = await pg.getProposalQueue();
			const queuePositionById = new Map(
				queue.map((item) => [item.display_id, item.queue_position]),
			);
			proposals.sort((left, right) => {
				const leftQueuePosition = queuePositionById.get(left.id);
				const rightQueuePosition = queuePositionById.get(right.id);
				if (
					leftQueuePosition !== undefined &&
					rightQueuePosition !== undefined &&
					leftQueuePosition !== rightQueuePosition
				) {
					return leftQueuePosition - rightQueuePosition;
				}
				if (leftQueuePosition !== undefined) return -1;
				if (rightQueuePosition !== undefined) return 1;
				return compareProposalIds(left.id, right.id);
			});

			const resolveDirectiveFilterValue = directiveResolverPromise
				? await directiveResolverPromise
				: undefined;
			let filtered = this.applyProposalFilters(
				proposals,
				filters,
				resolveDirectiveFilterValue,
				proposals,
			);
			if (!includeCrossBranch) {
				filtered = this.filterLocalEditableProposals(filtered);
			}
			return typeof limit === "number" && limit >= 0
				? filtered.slice(0, limit)
				: filtered;
		}

		const directiveResolverPromise = filters?.directive
			? Promise.all([
					this.fs.listDirectives(),
					this.fs.listArchivedDirectives(),
				]).then(([activeDirectives, archivedDirectives]) =>
					createDirectiveFilterValueResolver([
						...activeDirectives,
						...archivedDirectives,
					]),
				)
			: undefined;

		const applyFiltersAndLimit = async (
			collection: Proposal[],
		): Promise<Proposal[]> => {
			const resolveDirectiveFilterValue = directiveResolverPromise
				? await directiveResolverPromise
				: undefined;
			const store = await this.getContentStore();
			await store.ensureInitialized();
			let allProposals = store.getProposals();
			if (allProposals.length === 0) {
				allProposals = await this.fs.listProposals();
			}
			// Complement disk proposals with Postgres proposals (dedup by display_id)
			const pgFilters: Parameters<typeof pg.listProposals>[0] = {
				status: filters?.status,
			};
			const pgProposals = await this.loadProposalsFromPostgres(
				allProposals,
				pgFilters,
			);
			const mergedProposals = [...allProposals, ...pgProposals];
			if (process.env.DEBUG) {
				console.error(
					`[DEBUG] queryProposals: ${allProposals.length} from disk, ${pgProposals.length} from Postgres, ${mergedProposals.length} total`,
				);
			}
			let filtered = this.applyProposalFilters(
				collection,
				filters,
				resolveDirectiveFilterValue,
				mergedProposals,
			);
			if (!includeCrossBranch) {
				filtered = this.filterLocalEditableProposals(filtered);
			}
			if (typeof limit === "number" && limit >= 0) {
				if (process.env.DEBUG) {
					console.error(
						"[DEBUG] queryProposals: returning",
						filtered.slice(0, limit).length,
						"proposals (sliced)",
					);
				}
				return filtered.slice(0, limit);
			}

			if (process.env.DEBUG) {
				console.error(
					"[DEBUG] queryProposals: returning",
					filtered.length,
					"proposals",
				);
			}
			return filtered;
		};

		if (!trimmedQuery) {
			const store = await this.getContentStore();
			await store.ensureInitialized();
			let proposals = store.getProposals();
			if (proposals.length === 0) {
				proposals = await this.fs.listProposals();
			}
			// Always complement disk proposals with Postgres (dedup by display_id)
			const pgFilters: Parameters<typeof pg.listProposals>[0] = {
				status: filters?.status,
			};
			const pgProposals = await this.loadProposalsFromPostgres(
				proposals,
				pgFilters,
			);
			proposals = [...proposals, ...pgProposals];
			if (process.env.DEBUG) {
				console.error(
					`[DEBUG] queryProposals entry: disk=${proposals.length - pgProposals.length}, Postgres=${pgProposals.length}, total=${proposals.length}`,
				);
			}
			return await applyFiltersAndLimit(proposals);
		}

		// Search path — also complement with Postgres
		const diskStore = await this.getContentStore();
		await diskStore.ensureInitialized();
		let diskSearchProposals = diskStore.getProposals();
		if (diskSearchProposals.length === 0) {
			diskSearchProposals = await this.fs.listProposals();
		}
		const searchPgFilters: Parameters<typeof pg.listProposals>[0] = {
			status: filters?.status,
		};
		const searchPgProposals = await this.loadProposalsFromPostgres(
			diskSearchProposals,
			searchPgFilters,
		);
		diskSearchProposals = [...diskSearchProposals, ...searchPgProposals];

		const searchService = await this.getSearchService();
		const searchFilters: SearchFilters = {};
		if (filters?.status) {
			searchFilters.status = filters.status;
		}
		if (filters?.priority) {
			searchFilters.priority = filters.priority;
		}
		if (filters?.assignee) {
			searchFilters.assignee = filters.assignee;
		}
		if (filters?.labels) {
			searchFilters.labels = filters.labels;
		}

		const searchResults = searchService.search({
			query: trimmedQuery,
			limit,
			types: ["proposal"],
			filters:
				Object.keys(searchFilters).length > 0 ? searchFilters : undefined,
		});

		const seen = new Set<string>();
		const proposals: Proposal[] = [];
		for (const result of searchResults) {
			if (result.type !== "proposal") continue;
			const proposal = result.proposal;
			if (seen.has(proposal.id)) continue;
			seen.add(proposal.id);
			proposals.push(proposal);
		}

		return await applyFiltersAndLimit(proposals);
	}

	async getProposal(proposalId: string): Promise<Proposal | null> {
		if (await this.isPostgresProposalBackend()) {
			const draft = await this.fs.loadDraft(proposalId);
			if (draft) {
				return draft;
			}
			return await this.loadPgProposalById(proposalId);
		}

		// Prefer the live content store cache, then fall back to direct filesystem reads.
		const store = await this.getContentStore();
		const proposals = store.getProposals();
		const match = proposals.find((proposal) =>
			proposalIdsEqual(proposalId, proposal.id),
		);
		if (match) {
			return match;
		}

		// FS mirror fallback — pass raw ID to loadProposal (handles prefix detection via getProposalPath)
		return await this.fs.loadProposal(proposalId);
	}

	async getProposalWithSubproposals(
		proposalId: string,
		localProposals?: Proposal[],
	): Promise<Proposal | null> {
		const proposal = await this.loadProposalById(proposalId);
		if (!proposal) {
			return null;
		}

		const proposals =
			localProposals ??
			((await this.isPostgresProposalBackend())
				? await this.queryProposals({ includeCrossBranch: false })
				: await this.fs.listProposals());
		return attachSubproposalSummaries(proposal, proposals);
	}

	async loadProposalById(proposalId: string): Promise<Proposal | null> {
		if (await this.isPostgresProposalBackend()) {
			const draft = await this.fs.loadDraft(proposalId);
			if (draft) {
				return draft;
			}
			return await this.loadPgProposalById(proposalId);
		}

		// First try direct filesystem load (source of truth for local work)
		let proposal = await this.fs.loadProposal(proposalId);
		if (proposal) return proposal;

		// Try normalized local
		const normalized = normalizeProposalId(proposalId);
		proposal = await this.fs.loadProposal(normalized);
		if (proposal) return proposal;

		// Try ContentStore
		const store = await this.getContentStore();
		const storeProposal = store
			.getProposals()
			.find((s) => proposalIdsEqual(s.id, proposalId));
		if (storeProposal) return await this.fs.loadProposal(storeProposal.id);

		// Check if it's a draft
		const localDraft = await this.fs.loadDraft(proposalId);
		if (localDraft) return localDraft;

		// Check config for remote operations
		const config = await this.fs.loadConfig();
		const sinceDays = config?.activeBranchDays ?? 30;
		const proposalPrefix = config?.prefixes?.proposal ?? "proposal";

		// For cross-branch search, normalize with configured prefix
		const canonicalId = normalizeProposalId(proposalId, proposalPrefix);

		// Try other local branches first (faster than remote)
		const localBranchProposal = await findProposalInLocalBranches(
			this.git,
			canonicalId,
			DEFAULT_DIRECTORIES.ROADMAP,
			sinceDays,
			proposalPrefix,
		);
		if (localBranchProposal) return localBranchProposal;

		// Skip remote if disabled
		if (config?.remoteOperations === false) return null;

		// Try remote branches
		return await findProposalInRemoteBranches(
			this.git,
			canonicalId,
			DEFAULT_DIRECTORIES.ROADMAP,
			sinceDays,
			proposalPrefix,
		);
	}

	async getProposalContent(proposalId: string): Promise<string | null> {
		if (await this.isPostgresProposalBackend()) {
			return (await this.loadPgProposalById(proposalId))?.rawContent ?? null;
		}

		const filePath = await getProposalPath(proposalId, this);
		if (!filePath) return null;
		return await readFile(filePath, "utf-8");
	}

	async getDocument(documentId: string): Promise<Document | null> {
		const documents = await this.fs.listDocuments();
		const match = documents.find((doc) => documentIdsEqual(documentId, doc.id));
		return match ?? null;
	}

	async getDocumentContent(documentId: string): Promise<string | null> {
		const document = await this.getDocument(documentId);
		if (!document) return null;

		const relativePath = document.path ?? `${document.id}.md`;
		const filePath = join(this.fs.docsDir, relativePath);
		try {
			return await readFile(filePath, "utf-8");
		} catch {
			return null;
		}
	}

	disposeSearchService(): void {
		if (this.searchService) {
			this.searchService.dispose();
			this.searchService = undefined;
		}
	}

	disposeContentStore(): void {
		if (this.contentStore) {
			this.contentStore.dispose();
			this.contentStore = undefined;
		}
	}

	// Backward compatibility aliases
	get filesystem() {
		return this.fs;
	}

	get gitOps() {
		return this.git;
	}

	async ensureConfigLoaded(): Promise<void> {
		try {
			const config = await this.fs.loadConfig();
			this.git.setConfig(config);
		} catch (error) {
			// Config loading failed, git operations will work with null config
			if (process.env.DEBUG) {
				console.warn("Failed to load config for git operations:", error);
			}
		}
	}

	private async getRoadmapDirectoryName(): Promise<string> {
		// Always use "roadmap" as the directory name
		return DEFAULT_DIRECTORIES.ROADMAP;
	}

	async shouldAutoCommit(overrideValue?: boolean): Promise<boolean> {
		// If override is explicitly provided, use it
		if (overrideValue !== undefined) {
			return overrideValue;
		}
		// Otherwise, check config (default to false for safety)
		const config = await this.fs.loadConfig();
		return config?.autoCommit ?? false;
	}

	async getGitOps() {
		await this.ensureConfigLoaded();
		return this.git;
	}

	// Config migration
	private parseLegacyInlineArray(value: string): string[] {
		const items: string[] = [];
		let current = "";
		let quote: '"' | "'" | null = null;

		const pushCurrent = () => {
			const normalized = current.trim().replace(/\\(['"])/g, "$1");
			if (normalized) {
				items.push(normalized);
			}
			current = "";
		};

		for (let i = 0; i < value.length; i += 1) {
			const ch = value[i];
			const prev = i > 0 ? value[i - 1] : "";
			if (quote) {
				if (ch === quote && prev !== "\\") {
					quote = null;
					continue;
				}
				current += ch;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === ",") {
				pushCurrent();
				continue;
			}
			current += ch;
		}
		pushCurrent();
		return items;
	}

	private stripYamlComment(value: string): string {
		let quote: '"' | "'" | null = null;
		for (let i = 0; i < value.length; i += 1) {
			const ch = value[i];
			const prev = i > 0 ? value[i - 1] : "";
			if (quote) {
				if (ch === quote && prev !== "\\") {
					quote = null;
				}
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === "#") {
				return value.slice(0, i).trimEnd();
			}
		}
		return value;
	}

	private parseLegacyYamlValue(value: string): string {
		const trimmed = this.stripYamlComment(value).trim();
		const singleQuoted = trimmed.match(/^'(.*)'$/);
		if (singleQuoted?.[1] !== undefined) {
			return singleQuoted[1].replace(/''/g, "'");
		}
		const doubleQuoted = trimmed.match(/^"(.*)"$/);
		if (doubleQuoted?.[1] !== undefined) {
			return doubleQuoted[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
		}
		return trimmed;
	}

	private async extractLegacyConfigDirectives(): Promise<string[]> {
		try {
			const configPath = this.fs.configFilePath;
			const content = await readFile(configPath, "utf-8");
			const lines = content.split("\n");
			for (let i = 0; i < lines.length; i += 1) {
				const line = lines[i] ?? "";
				const match = line.match(/^(\s*)directives\s*:\s*(.*)$/);
				if (!match) {
					continue;
				}

				const directiveIndent = (match[1] ?? "").length;
				const trailing = this.stripYamlComment(match[2] ?? "").trim();
				if (trailing.startsWith("[")) {
					let combined = trailing;
					let closed = trailing.endsWith("]");
					let j = i + 1;
					while (!closed && j < lines.length) {
						const segment = this.stripYamlComment(lines[j] ?? "").trim();
						combined += segment;
						if (segment.includes("]")) {
							closed = true;
							break;
						}
						j += 1;
					}
					if (closed) {
						const openIndex = combined.indexOf("[");
						const closeIndex = combined.lastIndexOf("]");
						if (openIndex !== -1 && closeIndex > openIndex) {
							const parsed = this.parseLegacyInlineArray(
								combined.slice(openIndex + 1, closeIndex),
							);
							return parsed
								.map((item) => this.parseLegacyYamlValue(item))
								.filter(Boolean);
						}
					}
				}
				if (trailing.length > 0) {
					const single = this.parseLegacyYamlValue(trailing);
					return single ? [single] : [];
				}

				const values: string[] = [];
				for (let j = i + 1; j < lines.length; j += 1) {
					const nextLine = lines[j] ?? "";
					if (!nextLine.trim()) {
						continue;
					}
					const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
					if (nextIndent <= directiveIndent) {
						break;
					}
					const trimmed = nextLine.trim();
					if (!trimmed.startsWith("-")) {
						continue;
					}
					const itemValue = this.parseLegacyYamlValue(trimmed.slice(1));
					if (itemValue) {
						values.push(itemValue);
					}
				}
				return values;
			}
			return [];
		} catch {
			return [];
		}
	}

	private async migrateLegacyConfigDirectivesToFiles(
		legacyDirectives: string[],
	): Promise<void> {
		if (legacyDirectives.length === 0) {
			return;
		}
		const existingDirectives = await this.fs.listDirectives();
		const existingKeys = new Set<string>();
		for (const directive of existingDirectives) {
			const idKey = directive.id.trim().toLowerCase();
			const titleKey = directive.title.trim().toLowerCase();
			if (idKey) {
				existingKeys.add(idKey);
			}
			if (titleKey) {
				existingKeys.add(titleKey);
			}
		}
		for (const name of legacyDirectives) {
			const normalized = name.trim();
			const key = normalized.toLowerCase();
			if (!normalized || existingKeys.has(key)) {
				continue;
			}
			const created = await this.fs.createDirective(normalized);
			const createdIdKey = created.id.trim().toLowerCase();
			const createdTitleKey = created.title.trim().toLowerCase();
			if (createdIdKey) {
				existingKeys.add(createdIdKey);
			}
			if (createdTitleKey) {
				existingKeys.add(createdTitleKey);
			}
		}
	}

	async ensureConfigMigrated(): Promise<void> {
		await this.ensureConfigLoaded();
		const legacyDirectives = await this.extractLegacyConfigDirectives();
		let config = await this.fs.loadConfig();
		const needsSchemaMigration = !config || needsMigration(config);

		if (needsSchemaMigration) {
			config = migrateConfig(config || {});
		}
		if (legacyDirectives.length > 0) {
			await this.migrateLegacyConfigDirectivesToFiles(legacyDirectives);
		}
		if (config && (needsSchemaMigration || legacyDirectives.length > 0)) {
			// Rewrite config to apply schema defaults and strip legacy directives key after successful migration.
			await this.fs.saveConfig(config);
		}

		// Run draft prefix migration if needed (one-time migration)
		// This renames proposal-*.md files in drafts/ to draft-*.md
		if (needsDraftPrefixMigration(config)) {
			await migrateDraftPrefixes(this.fs);
		}
	}

	// ID generation
	/**
	 * Generates the next ID for a given entity type.
	 *
	 * @param type - The entity type (Proposal, Draft, Document, Decision). Defaults to Proposal.
	 * @param parent - Optional parent ID for subproposal generation (only applicable for proposals).
	 * @returns The next available ID (e.g., "proposal-42", "draft-5", "doc-3")
	 *
	 * Folder scanning by type:
	 * - Proposal: /proposals, /completed, cross-branch (if enabled), remote (if enabled)
	 * - Draft: /drafts only
	 * - Document: /documents only
	 * - Decision: /decisions only
	 */
	async generateNextId(
		type: EntityType = EntityType.Proposal,
		parent?: string,
	): Promise<string> {
		const config = await this.fs.loadConfig();
		const prefix = getPrefixForType(type, config ?? undefined);

		// Collect existing IDs based on entity type
		const allIds = await this.getExistingIdsForType(type);

		if (parent) {
			// Subproposal generation (only applicable for proposals)
			const normalizedParent =
				allIds.find((id) => proposalIdsEqual(parent, id)) ??
				normalizeProposalId(parent);
			const upperParent = normalizedParent.toUpperCase();
			let max = 0;
			for (const id of allIds) {
				// Case-insensitive comparison to handle legacy lowercase IDs
				if (id.toUpperCase().startsWith(`${upperParent}.`)) {
					const rest = id.slice(normalizedParent.length + 1);
					const num = Number.parseInt(rest.split(".")[0] || "0", 10);
					if (num > max) max = num;
				}
			}
			const nextSubIdNumber = max + 1;
			const padding = config?.zeroPaddedIds;

			if (padding && padding > 0) {
				const paddedSubId = String(nextSubIdNumber).padStart(2, "0");
				return `${normalizedParent}.${paddedSubId}`;
			}

			return `${normalizedParent}.${nextSubIdNumber}`;
		}

		// Top-level ID generation using prefix-aware regex
		const regex = buildIdRegex(prefix);
		const upperPrefix = prefix.toUpperCase();

		// PROPOSAL-55: Try centralized ID registry first (prevents collisions)
		const daemon = await this.getDaemonClient();
		if (daemon && type === EntityType.Proposal) {
			const sessionId = `${process.env.USER || "agent"}-${process.pid}`;
			const allocation = await daemon.allocateProposalId({
				sessionId,
				count: 1,
				prefix: upperPrefix,
			});
			if (allocation && allocation.ids.length > 0) {
				return allocation.ids[0]!;
			}
		}
		let max = 0;
		for (const id of allIds) {
			const match = id.match(regex);
			if (match?.[1] && !match[1].includes(".")) {
				const num = Number.parseInt(match[1], 10);
				if (num > max) max = num;
			}
		}
		const nextIdNumber = max + 1;
		const padding = config?.zeroPaddedIds;

		if (padding && padding > 0) {
			const paddedId = String(nextIdNumber).padStart(padding, "0");
			return `${upperPrefix}-${paddedId}`;
		}

		return `${upperPrefix}-${nextIdNumber}`;
	}

	/**
	 * Gets all proposal IDs that are in use (active or completed) across all branches.
	 * Respects cross-branch config settings. Archived IDs are excluded (can be reused).
	 *
	 * This is used for ID generation to determine the next available ID.
	 */
	private async getActiveAndCompletedProposalIds(): Promise<string[]> {
		const config = await this.fs.loadConfig();

		// Load local active and completed proposals
		const localProposals = await this.listProposalsWithMetadata();
		const localCompletedProposals = await this.fs.listCompletedProposals();

		// Build initial proposal entries from local proposals
		const proposalEntries: BranchProposalProposalEntry[] = [];

		// Add local active proposals to proposal
		for (const proposal of localProposals) {
			if (!proposal.id) continue;
			const lastModified =
				proposal.lastModified ??
				(proposal.updatedDate ? new Date(proposal.updatedDate) : new Date(0));
			proposalEntries.push({
				id: proposal.id,
				type: "proposal",
				branch: "local",
				path: "",
				lastModified,
			});
		}

		// Add local completed proposals to proposal
		for (const proposal of localCompletedProposals) {
			if (!proposal.id) continue;
			const lastModified = proposal.updatedDate
				? new Date(proposal.updatedDate)
				: new Date(0);
			proposalEntries.push({
				id: proposal.id,
				type: "completed",
				branch: "local",
				path: "",
				lastModified,
			});
		}

		// If cross-branch checking is enabled, scan other branches for proposal proposals
		if (config?.checkActiveBranches !== false) {
			const branchProposalEntries: BranchProposalProposalEntry[] = [];

			// Load proposals from remote and local branches in parallel
			await Promise.all([
				loadRemoteProposals(
					this.git,
					config,
					undefined,
					localProposals,
					branchProposalEntries,
				),
				loadLocalBranchProposals(
					this.git,
					config,
					undefined,
					localProposals,
					branchProposalEntries,
				),
			]);

			// Add branch proposal entries
			proposalEntries.push(...branchProposalEntries);
		}

		// Build the latest proposal map and extract active + completed IDs
		const latestProposal = buildLatestProposalMap(proposalEntries, []);
		return getActiveAndCompletedIdsFromProposalMap(latestProposal);
	}

	/**
	 * Gets all existing IDs for a given entity type.
	 * Used internally by generateNextId to determine the next available ID.
	 *
	 * Note: Archived proposals are intentionally excluded - archived IDs can be reused.
	 * This makes archive act as a soft delete for ID purposes.
	 */
	private async getExistingIdsForType(type: EntityType): Promise<string[]> {
		switch (type) {
			case EntityType.Proposal: {
				// Get active + completed proposal IDs from all branches (respects config)
				// Archived IDs are excluded - they can be reused (soft delete behavior)
				return this.getActiveAndCompletedProposalIds();
			}
			case EntityType.Draft: {
				const drafts = await this.fs.listDrafts();
				return drafts.map((d) => d.id);
			}
			case EntityType.Document: {
				const documents = await this.fs.listDocuments();
				return documents.map((d) => d.id);
			}
			case EntityType.Decision: {
				const decisions = await this.fs.listDecisions();
				return decisions.map((d) => d.id);
			}
			default:
				return [];
		}
	}

	// High-level operations that combine filesystem and git
	async createProposalFromData(
		proposalData: {
			title: string;
			status?: string;
			assignee?: string[];
			labels?: string[];
			dependencies?: string[];
			parentProposalId?: string;
			priority?: "high" | "medium" | "low";
			// First-party structured fields from Web UI / CLI
			description?: string;
			acceptanceCriteriaItems?: import("../types/index.ts").AcceptanceCriterion[];
			implementationPlan?: string;
			implementationNotes?: string;
			finalSummary?: string;
			directive?: string;
		},
		autoCommit?: boolean,
	): Promise<Proposal> {
		// Determine entity type before generating ID - drafts get DRAFT-X, proposals get PROPOSAL-X
		const isDraft = proposalData.status?.toLowerCase() === "draft";
		const entityType = isDraft ? EntityType.Draft : EntityType.Proposal;
		const id = await this.generateNextId(
			entityType,
			isDraft ? undefined : proposalData.parentProposalId,
		);

		const proposal: Proposal = {
			id,
			title: proposalData.title,
			status: proposalData.status || "",
			assignee: proposalData.assignee || [],
			labels: proposalData.labels || [],
			dependencies: proposalData.dependencies || [],
			rawContent: "",
			createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
			...(proposalData.parentProposalId && {
				parentProposalId: proposalData.parentProposalId,
			}),
			...(proposalData.priority && { priority: proposalData.priority }),
			...(typeof proposalData.directive === "string" &&
				proposalData.directive.trim().length > 0 && {
					directive: proposalData.directive.trim(),
				}),
			...(typeof proposalData.description === "string" && {
				description: proposalData.description,
			}),
			...(Array.isArray(proposalData.acceptanceCriteriaItems) &&
				proposalData.acceptanceCriteriaItems.length > 0 && {
					acceptanceCriteriaItems: proposalData.acceptanceCriteriaItems,
				}),
			...(typeof proposalData.implementationPlan === "string" && {
				implementationPlan: proposalData.implementationPlan,
			}),
			...(typeof proposalData.implementationNotes === "string" && {
				implementationNotes: proposalData.implementationNotes,
			}),
			...(typeof proposalData.finalSummary === "string" && {
				finalSummary: proposalData.finalSummary,
			}),
		};

		// Save as draft or proposal based on status
		if (isDraft) {
			await this.createDraft(proposal, autoCommit);
		} else {
			await this.createProposal(proposal, autoCommit);
		}

		return proposal;
	}

	async createProposalFromInput(
		input: ProposalCreateInput,
		autoCommit?: boolean,
	): Promise<{ proposal: Proposal; filePath?: string }> {
		if (!input.title || input.title.trim().length === 0) {
			throw new Error("Title is required to create a proposal.");
		}

		// Determine if this is a draft BEFORE generating the ID
		const requestedStatus = input.status?.trim();
		const isDraft = requestedStatus?.toLowerCase() === "draft";

		if (!isDraft && (await this.isPostgresProposalBackend())) {
			const normalizedLabels = normalizeStringList(input.labels) ?? [];
			const normalizedAssignees = normalizeStringList(input.assignee) ?? [];
			const normalizedDependencies = normalizeDependencies(input.dependencies);
			const normalizedReferences = normalizeStringList(input.references) ?? [];
			const normalizedDocumentation =
				normalizeStringList(input.documentation) ?? [];

			const { valid: validDependencies, invalid: invalidDependencies } =
				await validateDependencies(normalizedDependencies, this);
			if (invalidDependencies.length > 0) {
				throw new Error(
					`The following dependencies do not exist: ${invalidDependencies.join(", ")}. Please create these proposals first or verify the IDs.`,
				);
			}

			const config = await this.fs.loadConfig();
			const status = requestedStatus
				? await this.requireCanonicalStatus(requestedStatus)
				: config?.defaultStatus || FALLBACK_STATUS;
			const priority = this.normalizePriority(input.priority);
			const createdDate = new Date()
				.toISOString()
				.slice(0, 16)
				.replace("T", " ");
			const acceptanceCriteriaItems = Array.isArray(input.acceptanceCriteria)
				? input.acceptanceCriteria
						.map((criterion, index) => ({
							index: index + 1,
							text: String(criterion.text ?? "").trim(),
							checked: Boolean(criterion.checked),
						}))
						.filter((criterion) => criterion.text.length > 0)
				: [];
			const verificationProposalments = Array.isArray(
				input.verificationProposalmentsAdd,
			)
				? input.verificationProposalmentsAdd
						.map((assertion, index) => ({
							index: index + 1,
							text: String(assertion ?? "").trim(),
							checked: false,
						}))
						.filter((assertion) => assertion.text.length > 0)
				: [];

			const proposal: Proposal = {
				id: "",
				title: input.title.trim(),
				status,
				assignee: normalizedAssignees,
				labels: normalizedLabels,
				dependencies: validDependencies,
				references: normalizedReferences,
				documentation: normalizedDocumentation,
				rawContent: input.rawContent ?? "",
				createdDate,
				...(input.parentProposalId && {
					parentProposalId: input.parentProposalId,
				}),
				...(priority && { priority }),
				...(typeof input.directive === "string" &&
					input.directive.trim().length > 0 && {
						directive: input.directive.trim(),
					}),
				...(typeof input.domainId === "string" && { domainId: input.domainId }),
				...(typeof input.proposalType === "string" && {
					proposalType: input.proposalType,
				}),
				...(typeof input.category === "string" && { category: input.category }),
				...(typeof input.description === "string" && {
					description: input.description,
				}),
				...(typeof input.implementationPlan === "string" && {
					implementationPlan: input.implementationPlan,
				}),
				...(typeof input.implementationNotes === "string" && {
					implementationNotes: input.implementationNotes,
				}),
				...(typeof input.finalSummary === "string" && {
					finalSummary: input.finalSummary,
				}),
				...(acceptanceCriteriaItems.length > 0 && { acceptanceCriteriaItems }),
				...(input.scopeSummary && { scopeSummary: input.scopeSummary }),
				...(input.rationale && { rationale: input.rationale }),
				...(input.maturity && { maturity: input.maturity }),
				...(input.needs_capabilities && {
					needs_capabilities: input.needs_capabilities,
				}),
				...(input.external_injections && {
					external_injections: input.external_injections,
				}),
				...(input.unlocks && { unlocks: input.unlocks }),
				...(input.builder && { builder: input.builder }),
				...(input.auditor && { auditor: input.auditor }),
				...(verificationProposalments.length > 0 && {
					verificationProposalments,
				}),
			};

			await this.createProposal(proposal, autoCommit);
			await this.recordPulse({
				type: proposal.rationale ? "obstacle_discovered" : "proposal_created",
				id: proposal.id,
				title: proposal.title,
				impact: proposal.rationale
					? `Rationale: ${proposal.rationale}`
					: proposal.description,
			});

			return { proposal };
		}

		// Generate ID with appropriate entity type - drafts get DRAFT-X, proposals get PROPOSAL-X
		const entityType = isDraft ? EntityType.Draft : EntityType.Proposal;
		const id = await this.generateNextId(
			entityType,
			isDraft ? undefined : input.parentProposalId,
		);

		const normalizedLabels = normalizeStringList(input.labels) ?? [];
		const normalizedAssignees = normalizeStringList(input.assignee) ?? [];
		const normalizedDependencies = normalizeDependencies(input.dependencies);
		const normalizedReferences = normalizeStringList(input.references) ?? [];
		const normalizedDocumentation =
			normalizeStringList(input.documentation) ?? [];

		const { valid: validDependencies, invalid: invalidDependencies } =
			await validateDependencies(normalizedDependencies, this);
		if (invalidDependencies.length > 0) {
			throw new Error(
				`The following dependencies do not exist: ${invalidDependencies.join(", ")}. Please create these proposals first or verify the IDs.`,
			);
		}

		let status = "";
		if (requestedStatus) {
			if (isDraft) {
				status = "Draft";
			} else {
				status = await this.requireCanonicalStatus(requestedStatus);
			}
		}

		const priority = this.normalizePriority(input.priority);
		const createdDate = new Date().toISOString().slice(0, 16).replace("T", " ");

		const acceptanceCriteriaItems = Array.isArray(input.acceptanceCriteria)
			? input.acceptanceCriteria
					.map((criterion, index) => ({
						index: index + 1,
						text: String(criterion.text ?? "").trim(),
						checked: Boolean(criterion.checked),
					}))
					.filter((criterion) => criterion.text.length > 0)
			: [];

		const verificationProposalments = Array.isArray(
			input.verificationProposalmentsAdd,
		)
			? input.verificationProposalmentsAdd
					.map((assertion, index) => ({
						index: index + 1,
						text: String(assertion ?? "").trim(),
						checked: false,
					}))
					.filter((assertion) => assertion.text.length > 0)
			: [];

		const proposal: Proposal = {
			id,
			title: input.title.trim(),
			status,
			assignee: normalizedAssignees,
			labels: normalizedLabels,
			dependencies: validDependencies,
			references: normalizedReferences,
			documentation: normalizedDocumentation,
			rawContent: input.rawContent ?? "",
			createdDate,
			...(input.parentProposalId && {
				parentProposalId: input.parentProposalId,
			}),
			...(priority && { priority }),
			...(typeof input.directive === "string" &&
				input.directive.trim().length > 0 && {
					directive: input.directive.trim(),
				}),
			...(typeof input.domainId === "string" && { domainId: input.domainId }),
			...(typeof input.proposalType === "string" && {
				proposalType: input.proposalType,
			}),
			...(typeof input.category === "string" && { category: input.category }),
			...(typeof input.description === "string" && {
				description: input.description,
			}),
			...(typeof input.implementationPlan === "string" && {
				implementationPlan: input.implementationPlan,
			}),
			...(typeof input.implementationNotes === "string" && {
				implementationNotes: input.implementationNotes,
			}),
			...(typeof input.finalSummary === "string" && {
				finalSummary: input.finalSummary,
			}),
			...(acceptanceCriteriaItems.length > 0 && { acceptanceCriteriaItems }),
			...(input.scopeSummary && { scopeSummary: input.scopeSummary }),
			...(input.rationale && { rationale: input.rationale }),
			...(input.maturity && { maturity: input.maturity }),
			...(input.needs_capabilities && {
				needs_capabilities: input.needs_capabilities,
			}),
			...(input.external_injections && {
				external_injections: input.external_injections,
			}),
			...(input.unlocks && { unlocks: input.unlocks }),
			...(input.builder && { builder: input.builder }),
			...(input.auditor && { auditor: input.auditor }),
			...(verificationProposalments.length > 0 && {
				verificationProposalments,
			}),
		};

		const filePath = isDraft
			? await this.createDraft(proposal, autoCommit)
			: await this.createProposal(proposal, autoCommit);

		// Load the saved proposal/draft to return updated data
		const savedProposal = isDraft
			? await this.fs.loadDraft(id)
			: await this.fs.loadProposal(id);

		// Record Pulse event
		await this.recordPulse({
			type: proposal.rationale ? "obstacle_discovered" : "proposal_created",
			id: proposal.id,
			title: proposal.title,
			impact: proposal.rationale
				? `Rationale: ${proposal.rationale}`
				: proposal.description,
		});

		return { proposal: savedProposal ?? proposal, filePath };
	}

	async createProposal(
		proposal: Proposal,
		autoCommit?: boolean,
	): Promise<string> {
		if (await this.isPostgresProposalBackend()) {
			if (!proposal.status) {
				const config = await this.fs.loadConfig();
				proposal.status = config?.defaultStatus || FALLBACK_STATUS;
			}

			normalizeAssignee(proposal);
			await this.ensurePgPool();

			const proposalType = await this.resolvePgProposalType(
				proposal.proposalType,
			);
			const parentId = proposal.parentProposalId
				? await pg.resolveProposalId(proposal.parentProposalId)
				: null;
			if (proposal.parentProposalId && parentId === null) {
				throw new Error(
					`Parent proposal not found: ${proposal.parentProposalId}`,
				);
			}

			const created = await pg.createProposal(
				{
					type: proposalType,
					status: proposal.status || FALLBACK_STATUS,
					title: proposal.title,
					parent_id: parentId,
					summary: proposal.description ?? null,
					design: proposal.implementationPlan ?? null,
					dependency:
						proposal.dependencies.length > 0
							? proposal.dependencies.join(", ")
							: null,
					priority: proposal.priority ?? null,
					tags: this.buildPgTags(proposal),
				},
				proposal.builder ??
					proposal.auditor ??
					proposal.assignee[0] ??
					"system",
			);

			if (proposal.dependencies.length > 0) {
				const dependencyIds = (
					await Promise.all(
						proposal.dependencies.map(
							async (dependency) => await pg.resolveProposalId(dependency),
						),
					)
				).filter(
					(dependencyId): dependencyId is number => dependencyId !== null,
				);
				await pg.replaceDependencies(created.id, dependencyIds);
			}

			if (
				proposal.acceptanceCriteriaItems &&
				proposal.acceptanceCriteriaItems.length > 0
			) {
				await pg.replaceAcceptanceCriteria(
					created.id,
					proposal.acceptanceCriteriaItems.map((criterion) => ({
						item_number: criterion.index,
						criterion_text: criterion.text,
						status: criterion.checked ? "pass" : "pending",
					})),
				);
			}

			if (proposal.assignee[0]) {
				await pg.claimLease(
					created.id,
					proposal.assignee[0],
					new Date(Date.now() + DEFAULT_CLAIM_DURATION_MINUTES * 60 * 1000),
				);
			}

			proposal.id = created.display_id || `#${created.id}`;
			proposal.createdDate = new Date(created.created_at)
				.toISOString()
				.slice(0, 16)
				.replace("T", " ");
			proposal.updatedDate = new Date(created.modified_at)
				.toISOString()
				.slice(0, 16)
				.replace("T", " ");
			proposal.proposalType = created.type;

			const savedProposal = await this.loadPgProposalById(proposal.id);
			if (savedProposal) {
				Object.assign(proposal, savedProposal);
			}

			if (this.contentStore && savedProposal) {
				this.contentStore.upsertProposal(savedProposal);
			}

			return `roadmap:postgres:${proposal.id}`;
		}

		if (!proposal.status) {
			const config = await this.fs.loadConfig();
			proposal.status = config?.defaultStatus || FALLBACK_STATUS;
		}

		normalizeAssignee(proposal);

		const filepath = await this.fs.saveProposal(proposal);

		// Sync ContentStore cache for immediate UI freshness
		if (this.contentStore) {
			const savedProposal = await this.fs.loadProposal(proposal.id);
			if (savedProposal) {
				this.contentStore.upsertProposal(savedProposal);
			}
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.git.addAndCommitProposalFile(proposal.id, filepath, "create");
		}

		return filepath;
	}

	async createDraft(proposal: Proposal, autoCommit?: boolean): Promise<string> {
		// Drafts always have status "Draft", regardless of config default
		proposal.status = "Draft";
		normalizeAssignee(proposal);

		const filepath = await this.fs.saveDraft(proposal);

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.git.addFile(filepath);
			await this.git.commitProposalChange(
				proposal.id,
				`Create draft ${proposal.id}`,
				filepath,
			);
		}

		return filepath;
	}

	async updateProposal(
		proposal: Proposal,
		autoCommit?: boolean,
		activityActor?: string,
	): Promise<void> {
		if (await this.isPostgresProposalBackend()) {
			normalizeAssignee(proposal);
			await this.ensurePgPool();

			const originalProposal = await this.loadPgProposalById(proposal.id);
			if (!originalProposal) {
				throw new Error(`Proposal not found: ${proposal.id}`);
			}

			const proposalId = await pg.resolveProposalId(proposal.id);
			if (proposalId === null) {
				throw new Error(`Proposal not found: ${proposal.id}`);
			}

			const oldStatus = originalProposal.status ?? "";
			const newStatus = proposal.status ?? oldStatus;
			const statusChanged = oldStatus !== newStatus;
			const parentId = proposal.parentProposalId
				? await pg.resolveProposalId(proposal.parentProposalId)
				: null;
			if (proposal.parentProposalId && parentId === null) {
				throw new Error(
					`Parent proposal not found: ${proposal.parentProposalId}`,
				);
			}

			await pg.updateProposal(proposalId, {
				title: proposal.title,
				type: await this.resolvePgProposalType(proposal.proposalType),
				parent_id: parentId,
				summary: proposal.description ?? null,
				design: proposal.implementationPlan ?? null,
				dependency:
					proposal.dependencies.length > 0
						? proposal.dependencies.join(", ")
						: null,
				priority: proposal.priority ?? null,
				tags: this.buildPgTags(proposal),
			});

			const dependencyIds = (
				await Promise.all(
					(proposal.dependencies ?? []).map(
						async (dependency) => await pg.resolveProposalId(dependency),
					),
				)
			).filter((dependencyId): dependencyId is number => dependencyId !== null);
			await pg.replaceDependencies(proposalId, dependencyIds);

			await pg.replaceAcceptanceCriteria(
				proposalId,
				(proposal.acceptanceCriteriaItems ?? []).map((criterion) => ({
					item_number: criterion.index,
					criterion_text: criterion.text,
					status: criterion.checked ? "pass" : "pending",
				})),
			);

			const currentSummary = await pg.getProposalSummary(proposalId);
			const currentLeaseActive =
				Boolean(currentSummary?.leased_by) &&
				(currentSummary?.lease_expires === null ||
					currentSummary?.lease_expires === undefined ||
					new Date(currentSummary.lease_expires) > new Date());
			if (!currentLeaseActive && currentSummary?.leased_by) {
				await pg.releaseLease(proposalId, currentSummary.leased_by, "expired");
			}
			const currentLeaseAgent = currentLeaseActive
				? (currentSummary?.leased_by ?? null)
				: null;
			const desiredClaim =
				proposal.claim ??
				(proposal.assignee[0]
					? {
							agent: proposal.assignee[0],
							created: proposal.createdDate,
							expires: formatLocalDateTime(
								new Date(
									Date.now() + DEFAULT_CLAIM_DURATION_MINUTES * 60 * 1000,
								),
							),
						}
					: null);

			if (desiredClaim?.agent) {
				const desiredExpiry = new Date(desiredClaim.expires.replace(" ", "T"));
				if (currentLeaseAgent && currentLeaseAgent !== desiredClaim.agent) {
					await pg.releaseLease(proposalId, currentLeaseAgent, "reassigned");
				}
				if (!currentLeaseAgent || currentLeaseAgent !== desiredClaim.agent) {
					await pg.claimLease(proposalId, desiredClaim.agent, desiredExpiry);
				} else {
					await pg.renewLease(proposalId, desiredClaim.agent, desiredExpiry);
				}
			} else if (currentLeaseAgent) {
				await pg.releaseLease(proposalId, currentLeaseAgent, "released");
			}

			if (statusChanged) {
				await pg.transitionProposal(
					proposalId,
					newStatus,
					activityActor ??
						proposal.builder ??
						proposal.auditor ??
						desiredClaim?.agent ??
						"system",
					"Updated via core.updateProposal",
				);
			}

			const refreshed = await this.loadPgProposalById(proposal.id);
			const savedProposal = refreshed ?? proposal;

			if (isCompleteStatus(newStatus) && !isCompleteStatus(oldStatus)) {
				await this.recordPulse({
					type: "proposal_complete",
					id: savedProposal.id,
					title: savedProposal.title,
					impact: savedProposal.hype || savedProposal.finalSummary,
				});
			}

			if (
				savedProposal.scopeSummary &&
				savedProposal.scopeSummary !== originalProposal.scopeSummary
			) {
				await this.recordPulse({
					type: "scope_aggregated",
					id: savedProposal.id,
					title: savedProposal.title,
					impact: savedProposal.scopeSummary,
				});
			}

			if (refreshed && this.contentStore) {
				this.contentStore.upsertProposal(refreshed);
			}

			if (statusChanged) {
				await this.executeStatusChangeCallback(
					savedProposal,
					oldStatus,
					newStatus,
				);
			}

			return;
		}

		normalizeAssignee(proposal);

		// Load original proposal to detect status changes for callbacks
		const originalProposal = await this.fs.loadProposal(proposal.id);
		const oldStatus = originalProposal?.status ?? "";
		const newStatus = proposal.status ?? "";
		const statusChanged = oldStatus !== newStatus;

		// Always set updatedDate when updating a proposal
		proposal.updatedDate = new Date()
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");

		await this.fs.saveProposal(proposal);

		// Record Pulse: Proposal Complete
		if (isCompleteStatus(newStatus) && !isCompleteStatus(oldStatus)) {
			await this.recordPulse({
				type: "proposal_complete",
				id: proposal.id,
				title: proposal.title,
				impact: proposal.hype || proposal.finalSummary,
			});
		}

		// Record Pulse: Scope Aggregated (Smart summary update)
		if (
			proposal.scopeSummary &&
			proposal.scopeSummary !== originalProposal?.scopeSummary
		) {
			await this.recordPulse({
				type: "scope_aggregated",
				id: proposal.id,
				title: proposal.title,
				impact: proposal.scopeSummary,
			});
		}

		// Sync the ContentStore cache so the UI sees the saved proposal immediately.
		if (this.contentStore) {
			const savedProposal = await this.fs.loadProposal(proposal.id);
			if (savedProposal) {
				this.contentStore.upsertProposal(savedProposal);
			}
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			const filePath = await getProposalPath(proposal.id, this);
			if (filePath) {
				await this.git.addAndCommitProposalFile(
					proposal.id,
					filePath,
					"update",
				);
			}
		}

		// Fire status change callback if status changed
		if (statusChanged) {
			await this.executeStatusChangeCallback(proposal, oldStatus, newStatus);
		}
	}

	/**
	 * Add an entry to the proposal's activity log
	 */
	private addActivityLog(
		proposal: Proposal,
		actor: string,
		action: string,
		reason?: string,
	): void {
		if (!proposal.activityLog) {
			proposal.activityLog = [];
		}
		proposal.activityLog.push({
			timestamp: new Date().toISOString().slice(0, 19).replace("T", " "),
			actor,
			action,
			reason,
		});
	}

	private async applyProposalUpdateInput(
		proposal: Proposal,
		input: ProposalUpdateInput,
		statusResolver: (status: string) => Promise<string>,
	): Promise<{ proposal: Proposal; mutated: boolean }> {
		let mutated = false;

		const applyStringField = (
			value: string | undefined,
			current: string | undefined,
			assign: (next: string) => void,
		) => {
			if (typeof value === "string") {
				const next = value;
				if ((current ?? "") !== next) {
					assign(next);
					mutated = true;
				}
			}
		};

		if (input.title !== undefined) {
			const trimmed = input.title.trim();
			if (trimmed.length === 0) {
				throw new Error("Title cannot be empty.");
			}
			if (proposal.title !== trimmed) {
				proposal.title = trimmed;
				mutated = true;
			}
		}

		applyStringField(input.description, proposal.description, (next) => {
			proposal.description = next;
		});

		applyStringField(input.domainId, proposal.domainId, (next) => {
			proposal.domainId = next;
		});

		applyStringField(input.proposalType, proposal.proposalType, (next) => {
			proposal.proposalType = next;
		});

		applyStringField(input.category, proposal.category, (next) => {
			proposal.category = next;
		});

		applyStringField(input.builder, proposal.builder, (next) => {
			proposal.builder = next;
		});

		applyStringField(input.auditor, proposal.auditor, (next) => {
			proposal.auditor = next;
		});

		applyStringField(input.rationale, proposal.rationale, (next) => {
			proposal.rationale = next;
		});

		// Handle needs_capabilities
		if (input.needs_capabilities !== undefined) {
			if (
				!stringArraysEqual(
					proposal.needs_capabilities ?? [],
					input.needs_capabilities,
				)
			) {
				proposal.needs_capabilities = [...input.needs_capabilities];
				mutated = true;
			}
		}
		if (input.addNeedsCapabilities && input.addNeedsCapabilities.length > 0) {
			const current = proposal.needs_capabilities ?? [];
			proposal.needs_capabilities = [
				...new Set([...current, ...input.addNeedsCapabilities]),
			];
			mutated = true;
		}
		if (
			input.removeNeedsCapabilities &&
			input.removeNeedsCapabilities.length > 0
		) {
			const current = proposal.needs_capabilities ?? [];
			const toRemove = new Set(input.removeNeedsCapabilities);
			proposal.needs_capabilities = current.filter(
				(_, i) => !toRemove.has(i + 1),
			);
			mutated = true;
		}

		// Handle external_injections
		if (input.external_injections !== undefined) {
			if (
				!stringArraysEqual(
					proposal.external_injections ?? [],
					input.external_injections,
				)
			) {
				proposal.external_injections = [...input.external_injections];
				mutated = true;
			}
		}
		if (input.addExternalInjections && input.addExternalInjections.length > 0) {
			const current = proposal.external_injections ?? [];
			proposal.external_injections = [
				...new Set([...current, ...input.addExternalInjections]),
			];
			mutated = true;
		}
		if (
			input.removeExternalInjections &&
			input.removeExternalInjections.length > 0
		) {
			const current = proposal.external_injections ?? [];
			const toRemove = new Set(input.removeExternalInjections);
			proposal.external_injections = current.filter(
				(_, i) => !toRemove.has(i + 1),
			);
			mutated = true;
		}

		// Handle unlocks
		if (input.unlocks !== undefined) {
			if (!stringArraysEqual(proposal.unlocks ?? [], input.unlocks)) {
				proposal.unlocks = [...input.unlocks];
				mutated = true;
			}
		}
		if (input.addUnlocks && input.addUnlocks.length > 0) {
			const current = proposal.unlocks ?? [];
			proposal.unlocks = [...new Set([...current, ...input.addUnlocks])];
			mutated = true;
		}
		if (input.removeUnlocks && input.removeUnlocks.length > 0) {
			const current = proposal.unlocks ?? [];
			const toRemove = new Set(input.removeUnlocks);
			proposal.unlocks = current.filter((_, i) => !toRemove.has(i + 1));
			mutated = true;
		}

		// Handle proof
		if (input.proof !== undefined) {
			if (!stringArraysEqual(proposal.proof ?? [], input.proof)) {
				proposal.proof = [...input.proof];
				mutated = true;
			}
		}
		if (input.addProof && input.addProof.length > 0) {
			const current = proposal.proof ?? [];
			proposal.proof = [...new Set([...current, ...input.addProof])];
			mutated = true;
		}
		if (input.removeProof && input.removeProof.length > 0) {
			const current = proposal.proof ?? [];
			const toRemove = new Set(input.removeProof);
			proposal.proof = current.filter((_, i) => !toRemove.has(i + 1));
			mutated = true;
		}

		if (input.status !== undefined) {
			const canonicalStatus = await statusResolver(input.status);
			if ((proposal.status ?? "") !== canonicalStatus) {
				// AC#1-4, AC#7: Hard gates (maturity, proof of arrival, final summary, peer audit) removed.
				// Complete transition is now trust-based with visibility (activity log).
				// Only machine gate remaining: blocking test issues prevent completion.
				if (isCompleteStatus(canonicalStatus)) {
					this.assertNoBlockingTestIssues(proposal.id, "mark as Complete");
				}
				proposal.status = canonicalStatus;
				mutated = true;
				// AC#5: Activity log records who marked proposal Complete and when
				const actor = input.activityActor ?? input.builder ?? "unknown";
				this.addActivityLog(
					proposal,
					actor,
					"status_change",
					`Changed to ${canonicalStatus}`,
				);
			}
		}

		if (input.priority !== undefined) {
			const normalizedPriority = this.normalizePriority(String(input.priority));
			if (proposal.priority !== normalizedPriority) {
				proposal.priority = normalizedPriority;
				mutated = true;
			}
		}

		if (input.directive !== undefined) {
			const normalizedDirective =
				input.directive === null
					? undefined
					: input.directive.trim().length > 0
						? input.directive.trim()
						: undefined;
			if ((proposal.directive ?? undefined) !== normalizedDirective) {
				if (normalizedDirective === undefined) {
					delete proposal.directive;
				} else {
					proposal.directive = normalizedDirective;
				}
				mutated = true;
			}
		}

		if (input.parentProposalId !== undefined) {
			const normalizedParent =
				input.parentProposalId === null
					? undefined
					: input.parentProposalId.trim().length > 0
						? input.parentProposalId.trim()
						: undefined;
			if ((proposal.parentProposalId ?? undefined) !== normalizedParent) {
				if (normalizedParent === undefined) {
					delete proposal.parentProposalId;
				} else {
					proposal.parentProposalId = normalizedParent;
				}
				mutated = true;
			}
		}

		if (input.ordinal !== undefined) {
			if (Number.isNaN(input.ordinal) || input.ordinal < 0) {
				throw new Error("Ordinal must be a non-negative number.");
			}
			if (proposal.ordinal !== input.ordinal) {
				proposal.ordinal = input.ordinal;
				mutated = true;
			}
		}

		if (input.assignee !== undefined) {
			const sanitizedAssignee = normalizeStringList(input.assignee) ?? [];
			if (!stringArraysEqual(sanitizedAssignee, proposal.assignee ?? [])) {
				proposal.assignee = sanitizedAssignee;
				mutated = true;
			}
		}

		const resolveLabelChanges = (): void => {
			let currentLabels = [...(proposal.labels ?? [])];
			if (input.labels !== undefined) {
				const sanitizedLabels = normalizeStringList(input.labels) ?? [];
				if (!stringArraysEqual(sanitizedLabels, currentLabels)) {
					proposal.labels = sanitizedLabels;
					mutated = true;
				}
				currentLabels = sanitizedLabels;
			}

			const labelsToAdd = normalizeStringList(input.addLabels) ?? [];
			if (labelsToAdd.length > 0) {
				const labelSet = new Set(
					currentLabels.map((label) => label.toLowerCase()),
				);
				for (const label of labelsToAdd) {
					if (!labelSet.has(label.toLowerCase())) {
						currentLabels.push(label);
						labelSet.add(label.toLowerCase());
						mutated = true;
					}
				}
				proposal.labels = currentLabels;
			}

			const labelsToRemove = normalizeStringList(input.removeLabels) ?? [];
			if (labelsToRemove.length > 0) {
				const removalSet = new Set(
					labelsToRemove.map((label) => label.toLowerCase()),
				);
				const filtered = currentLabels.filter(
					(label) => !removalSet.has(label.toLowerCase()),
				);
				if (!stringArraysEqual(filtered, currentLabels)) {
					proposal.labels = filtered;
					mutated = true;
				}
			}
		};

		resolveLabelChanges();

		const resolveDependencies = async (): Promise<void> => {
			let currentDependencies = [...(proposal.dependencies ?? [])];

			if (input.dependencies !== undefined) {
				const normalized = normalizeDependencies(input.dependencies);
				const { valid, invalid } = await validateDependencies(normalized, this);
				if (invalid.length > 0) {
					throw new Error(
						`The following dependencies do not exist: ${invalid.join(", ")}. Please create these proposals first or verify the IDs.`,
					);
				}
				if (!stringArraysEqual(valid, currentDependencies)) {
					currentDependencies = valid;
					mutated = true;
				}
			}

			if (input.addDependencies && input.addDependencies.length > 0) {
				const additions = normalizeDependencies(input.addDependencies);
				const { valid, invalid } = await validateDependencies(additions, this);
				if (invalid.length > 0) {
					throw new Error(
						`The following dependencies do not exist: ${invalid.join(", ")}. Please create these proposals first or verify the IDs.`,
					);
				}
				const depSet = new Set(currentDependencies);
				for (const dep of valid) {
					if (!depSet.has(dep)) {
						currentDependencies.push(dep);
						depSet.add(dep);
						mutated = true;
					}
				}
			}

			if (input.removeDependencies && input.removeDependencies.length > 0) {
				const removals = new Set(
					normalizeDependencies(input.removeDependencies),
				);
				const filtered = currentDependencies.filter(
					(dep) => !removals.has(dep),
				);
				if (!stringArraysEqual(filtered, currentDependencies)) {
					currentDependencies = filtered;
					mutated = true;
				}
			}

			proposal.dependencies = currentDependencies;
		};

		await resolveDependencies();

		const resolveReferences = (): void => {
			let currentReferences = [...(proposal.references ?? [])];
			if (input.references !== undefined) {
				const sanitizedReferences = normalizeStringList(input.references) ?? [];
				if (!stringArraysEqual(sanitizedReferences, currentReferences)) {
					proposal.references = sanitizedReferences;
					mutated = true;
				}
				currentReferences = sanitizedReferences;
			}

			const referencesToAdd = normalizeStringList(input.addReferences) ?? [];
			if (referencesToAdd.length > 0) {
				const refSet = new Set(currentReferences);
				for (const ref of referencesToAdd) {
					if (!refSet.has(ref)) {
						currentReferences.push(ref);
						refSet.add(ref);
						mutated = true;
					}
				}
				proposal.references = currentReferences;
			}

			const referencesToRemove =
				normalizeStringList(input.removeReferences) ?? [];
			if (referencesToRemove.length > 0) {
				const removalSet = new Set(referencesToRemove);
				const filtered = currentReferences.filter(
					(ref) => !removalSet.has(ref),
				);
				if (!stringArraysEqual(filtered, currentReferences)) {
					proposal.references = filtered;
					mutated = true;
				}
			}
		};

		resolveReferences();

		const resolveDocumentation = (): void => {
			let currentDocumentation = [...(proposal.documentation ?? [])];
			if (input.documentation !== undefined) {
				const sanitizedDocumentation =
					normalizeStringList(input.documentation) ?? [];
				if (!stringArraysEqual(sanitizedDocumentation, currentDocumentation)) {
					proposal.documentation = sanitizedDocumentation;
					mutated = true;
				}
				currentDocumentation = sanitizedDocumentation;
			}

			const documentationToAdd =
				normalizeStringList(input.addDocumentation) ?? [];
			if (documentationToAdd.length > 0) {
				const docSet = new Set(currentDocumentation);
				for (const doc of documentationToAdd) {
					if (!docSet.has(doc)) {
						currentDocumentation.push(doc);
						docSet.add(doc);
						mutated = true;
					}
				}
				proposal.documentation = currentDocumentation;
			}

			const documentationToRemove =
				normalizeStringList(input.removeDocumentation) ?? [];
			if (documentationToRemove.length > 0) {
				const removalSet = new Set(documentationToRemove);
				const filtered = currentDocumentation.filter(
					(doc) => !removalSet.has(doc),
				);
				if (!stringArraysEqual(filtered, currentDocumentation)) {
					proposal.documentation = filtered;
					mutated = true;
				}
			}
		};

		resolveDocumentation();

		const resolveRequires = (): void => {
			let currentRequires = [...(proposal.requires ?? [])];
			if (input.requires !== undefined) {
				const sanitizedRequires = normalizeStringList(input.requires) ?? [];
				if (!stringArraysEqual(sanitizedRequires, currentRequires)) {
					proposal.requires = sanitizedRequires;
					mutated = true;
				}
				currentRequires = sanitizedRequires;
			}

			const requiresToAdd = normalizeStringList(input.addRequires) ?? [];
			if (requiresToAdd.length > 0) {
				const reqSet = new Set(currentRequires);
				for (const req of requiresToAdd) {
					if (!reqSet.has(req)) {
						currentRequires.push(req);
						reqSet.add(req);
						mutated = true;
					}
				}
				proposal.requires = currentRequires;
			}

			if (input.clearRequires) {
				if (currentRequires.length > 0) {
					proposal.requires = [];
					mutated = true;
				}
				currentRequires = [];
			}

			const requiresToRemove = input.removeRequires ?? [];
			if (requiresToRemove.length > 0) {
				const filtered = currentRequires.filter(
					(_, idx) => !requiresToRemove.includes(idx + 1),
				);
				if (!stringArraysEqual(filtered, currentRequires)) {
					proposal.requires = filtered;
					mutated = true;
				}
			}
		};

		resolveRequires();

		const sanitizeAppendInput = (values: string[] | undefined): string[] => {
			if (!values) return [];
			return values
				.map((value) => String(value).trim())
				.filter((value) => value.length > 0);
		};

		const appendBlock = (
			existing: string | undefined,
			additions: string[] | undefined,
		): { value?: string; changed: boolean } => {
			const sanitizedAdditions = (additions ?? [])
				.map((value) => String(value).trim())
				.filter((value) => value.length > 0);
			if (sanitizedAdditions.length === 0) {
				return { value: existing, changed: false };
			}
			const current = (existing ?? "").trim();
			const additionBlock = sanitizedAdditions.join("\n\n");
			if (current.length === 0) {
				return { value: additionBlock, changed: true };
			}
			return { value: `${current}\n\n${additionBlock}`, changed: true };
		};

		if (input.clearImplementationPlan) {
			if (proposal.implementationPlan !== undefined) {
				delete proposal.implementationPlan;
				mutated = true;
			}
		}

		applyStringField(
			input.implementationPlan,
			proposal.implementationPlan,
			(next) => {
				proposal.implementationPlan = next;
			},
		);

		const planAppends = sanitizeAppendInput(input.appendImplementationPlan);
		if (planAppends.length > 0) {
			const { value, changed } = appendBlock(
				proposal.implementationPlan,
				planAppends,
			);
			if (changed) {
				proposal.implementationPlan = value;
				mutated = true;
			}
		}

		if (input.clearImplementationNotes) {
			if (proposal.implementationNotes !== undefined) {
				delete proposal.implementationNotes;
				mutated = true;
			}
		}

		applyStringField(
			input.implementationNotes,
			proposal.implementationNotes,
			(next) => {
				proposal.implementationNotes = next;
			},
		);

		const notesAppends = sanitizeAppendInput(input.appendImplementationNotes);
		if (notesAppends.length > 0) {
			const { value, changed } = appendBlock(
				proposal.implementationNotes,
				notesAppends,
			);
			if (changed) {
				proposal.implementationNotes = value;
				mutated = true;
			}
		}

		if (input.clearAuditNotes) {
			if (proposal.auditNotes !== undefined) {
				delete proposal.auditNotes;
				mutated = true;
			}
		}

		applyStringField(input.auditNotes, proposal.auditNotes, (next) => {
			proposal.auditNotes = next;
		});

		const auditAppends = sanitizeAppendInput(input.appendAuditNotes);
		if (auditAppends.length > 0) {
			const { value, changed } = appendBlock(proposal.auditNotes, auditAppends);
			if (changed) {
				proposal.auditNotes = value;
				mutated = true;
			}
		}

		if (input.clearFinalSummary) {
			if (proposal.finalSummary !== undefined) {
				proposal.finalSummary = "";
				mutated = true;
			}
		}

		applyStringField(input.finalSummary, proposal.finalSummary, (next) => {
			proposal.finalSummary = next;
		});

		const finalSummaryAppends = sanitizeAppendInput(input.appendFinalSummary);
		if (finalSummaryAppends.length > 0) {
			const { value, changed } = appendBlock(
				proposal.finalSummary,
				finalSummaryAppends,
			);
			if (changed) {
				proposal.finalSummary = value;
				mutated = true;
			}
		}

		if (input.claim !== undefined) {
			if (input.claim === null) {
				if (proposal.claim !== undefined) {
					proposal.claim = undefined;
					mutated = true;
				}
			} else {
				const current = JSON.stringify(proposal.claim);
				const next = JSON.stringify(input.claim);
				if (current !== next) {
					proposal.claim = input.claim;
					mutated = true;
				}
			}
		}

		let acceptanceCriteria = Array.isArray(proposal.acceptanceCriteriaItems)
			? proposal.acceptanceCriteriaItems.map((criterion) => ({ ...criterion }))
			: [];

		const rebuildIndices = () => {
			acceptanceCriteria = acceptanceCriteria.map((criterion, index) => ({
				...criterion,
				index: index + 1,
			}));
		};

		if (input.acceptanceCriteria !== undefined) {
			const sanitized = input.acceptanceCriteria
				.map((criterion) => ({
					text: String(criterion.text ?? "").trim(),
					checked: Boolean(criterion.checked),
				}))
				.filter((criterion) => criterion.text.length > 0)
				.map((criterion, index) => ({
					index: index + 1,
					text: criterion.text,
					checked: criterion.checked,
				}));
			acceptanceCriteria = sanitized;
			mutated = true;
		}

		if (input.addAcceptanceCriteria && input.addAcceptanceCriteria.length > 0) {
			const additions = input.addAcceptanceCriteria
				.map((criterion) =>
					typeof criterion === "string"
						? criterion.trim()
						: String(criterion.text ?? "").trim(),
				)
				.filter((text) => text.length > 0);
			let index =
				acceptanceCriteria.length > 0
					? Math.max(
							...acceptanceCriteria.map((criterion) => criterion.index),
						) + 1
					: 1;
			for (const text of additions) {
				acceptanceCriteria.push({ index: index++, text, checked: false });
				mutated = true;
			}
		}

		if (
			input.removeAcceptanceCriteria &&
			input.removeAcceptanceCriteria.length > 0
		) {
			const removalSet = new Set(input.removeAcceptanceCriteria);
			const beforeLength = acceptanceCriteria.length;
			acceptanceCriteria = acceptanceCriteria.filter(
				(criterion) => !removalSet.has(criterion.index),
			);
			if (acceptanceCriteria.length === beforeLength) {
				throw new Error(
					`Acceptance criterion ${Array.from(removalSet)
						.map((index) => `#${index}`)
						.join(", ")} not found`,
				);
			}
			mutated = true;
			rebuildIndices();
		}

		const toggleCriteria = (
			indices: number[] | undefined,
			checked: boolean,
		) => {
			if (!indices || indices.length === 0) return;
			const missing: number[] = [];
			for (const index of indices) {
				const criterion = acceptanceCriteria.find(
					(item) => item.index === index,
				);
				if (!criterion) {
					missing.push(index);
					continue;
				}
				if (criterion.checked !== checked) {
					criterion.checked = checked;
					mutated = true;
				}
			}
			if (missing.length > 0) {
				const label = missing.map((index) => `#${index}`).join(", ");
				throw new Error(`Acceptance criterion ${label} not found`);
			}
		};

		toggleCriteria(input.checkAcceptanceCriteria, true);
		toggleCriteria(input.uncheckAcceptanceCriteria, false);

		proposal.acceptanceCriteriaItems = acceptanceCriteria;

		// Handle verificationProposalments
		if (input.verificationProposalments !== undefined) {
			if (
				!stringArraysEqual(
					(proposal.verificationProposalments ?? []).map((c) => c.text),
					input.verificationProposalments.map((c) => c.text),
				)
			) {
				proposal.verificationProposalments =
					input.verificationProposalments.map((c, i) => ({
						index: i + 1,
						text: c.text,
						checked: !!c.checked,
						role: c.role,
						evidence: c.evidence,
					}));
				mutated = true;
			}
		}

		let verificationProposalments = proposal.verificationProposalments ?? [];
		const rebuildVerificationIndices = (): void => {
			verificationProposalments = verificationProposalments.map((c, i) => ({
				...c,
				index: i + 1,
			}));
		};

		if (
			input.addVerificationProposalments &&
			input.addVerificationProposalments.length > 0
		) {
			const current = verificationProposalments;
			let nextIndex =
				current.length > 0 ? Math.max(...current.map((c) => c.index)) + 1 : 1;
			for (const item of input.addVerificationProposalments) {
				if (typeof item === "string") {
					verificationProposalments.push({
						text: item,
						checked: false,
						index: nextIndex++,
					});
				} else {
					verificationProposalments.push({
						text: item.text,
						checked: !!item.checked,
						role: item.role,
						evidence: item.evidence,
						index: nextIndex++,
					});
				}
			}
			mutated = true;
		}

		const toggleVerificationItems = (
			indices: number[] | undefined,
			checked: boolean,
		): void => {
			if (!indices || indices.length === 0) return;
			const missing: number[] = [];
			for (const index of indices) {
				const criterion = verificationProposalments.find(
					(item) => item.index === index,
				);
				if (!criterion) {
					missing.push(index);
					continue;
				}
				if (criterion.checked !== checked) {
					criterion.checked = checked;
					mutated = true;
				}
			}
			if (missing.length > 0) {
				const label = missing.map((index) => `#${index}`).join(", ");
				throw new Error(`Verification proposalment ${label} not found`);
			}
		};

		toggleVerificationItems(input.checkVerificationProposalments, true);
		toggleVerificationItems(input.uncheckVerificationProposalments, false);

		if (
			input.removeVerificationProposalments &&
			input.removeVerificationProposalments.length > 0
		) {
			const removalSet = new Set(input.removeVerificationProposalments);
			const beforeLength = verificationProposalments.length;
			verificationProposalments = verificationProposalments.filter(
				(criterion) => !removalSet.has(criterion.index),
			);
			if (verificationProposalments.length === beforeLength) {
				throw new Error(
					`Verification proposalment ${Array.from(removalSet)
						.map((index) => `#${index}`)
						.join(", ")} not found`,
				);
			}
			mutated = true;
			rebuildVerificationIndices();
		}

		proposal.verificationProposalments = verificationProposalments;

		// --- MATURITY VALIDATION (Final Gate) ---

		// Handle maturity
		if (input.maturity) {
			const maturity = input.maturity.toLowerCase() as any;
			if (proposal.maturity !== maturity) {
				// Audit Transition Gate: Cannot move to audited without builder, auditor, and checked proposalments
				if (maturity === "audited") {
					if (!proposal.builder && !input.builder) {
						throw new Error(
							`Verification Gate: Proposal ${proposal.id} cannot be marked as 'audited' without a builder.`,
						);
					}
					if (!proposal.auditor && !input.auditor) {
						throw new Error(
							`Verification Gate: Proposal ${proposal.id} cannot be marked as 'audited' without an auditor.`,
						);
					}

					if (!proposal.auditNotes && !input.auditNotes) {
						throw new Error(
							`Verification Gate: Proposal ${proposal.id} cannot be marked as 'audited' without audit notes.`,
						);
					}

					const currentAuditor = input.auditor || proposal.auditor;
					const currentBuilder = input.builder || proposal.builder;
					if (currentAuditor === currentBuilder) {
						throw new Error(
							`Verification Gate: Peer Audit requires distinct agents. Auditor '${currentAuditor}' cannot be the same as Builder '${currentBuilder}'.`,
						);
					}

					const proposalments = proposal.verificationProposalments ?? [];
					if (proposalments.length > 0) {
						const unchecked = proposalments.filter((s) => !s.checked);
						if (unchecked.length > 0) {
							throw new Error(
								`Verification Gate: Proposal ${proposal.id} has ${unchecked.length} unchecked verification proposalments. Peer audit must verify all assertions.`,
							);
						}
					}
				}
				proposal.maturity = maturity;
				mutated = true;
			}
		}

		// Automatic maturity transition: skeleton -> contracted
		// If ACs or Plan are added, move to contracted
		if (proposal.maturity === "skeleton" || !proposal.maturity) {
			const hasACs =
				proposal.acceptanceCriteriaItems &&
				proposal.acceptanceCriteriaItems.length > 0;
			const hasProposalments =
				proposal.verificationProposalments &&
				proposal.verificationProposalments.length > 0;
			const hasPlan = !!proposal.implementationPlan;

			if (hasACs || hasPlan || hasProposalments) {
				proposal.maturity = "contracted";
				mutated = true;
			}
		}

		return { proposal, mutated };
	}

	async updateProposalFromInput(
		proposalId: string,
		input: ProposalUpdateInput,
		autoCommit?: boolean,
	): Promise<Proposal> {
		const proposal = await this.loadProposalById(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		if (
			(await this.isPostgresProposalBackend()) &&
			!proposal.id.startsWith("DRAFT-")
		) {
			const requestedStatus = input.status?.trim().toLowerCase();
			if (requestedStatus === "draft") {
				throw new Error(
					"Postgres-backed proposals cannot be demoted to filesystem drafts.",
				);
			}

			const { mutated } = await this.applyProposalUpdateInput(
				proposal,
				input,
				async (status) => this.requireCanonicalStatus(status),
			);
			if (!mutated) {
				return proposal;
			}

			await this.updateProposal(proposal, autoCommit, input.activityActor);
			const refreshed = await this.loadProposalById(proposal.id);
			return refreshed ?? proposal;
		}

		const requestedStatus = input.status?.trim().toLowerCase();
		if (requestedStatus === "draft" && !proposal.id.startsWith("DRAFT-")) {
			return await this.demoteProposalWithUpdates(proposal, input, autoCommit);
		}

		const { mutated } = await this.applyProposalUpdateInput(
			proposal,
			input,
			async (status) => this.requireCanonicalStatus(status),
		);

		if (!mutated) {
			return proposal;
		}

		if (proposal.id.startsWith("DRAFT-")) {
			if (proposal.status && proposal.status.toLowerCase() !== "draft") {
				// Promotion: status changed from Draft
				const draftId = proposal.id;

				// Promote to proper proposal
				const success = await this.fs.promoteDraft(draftId);
				if (!success) {
					throw new Error(`Failed to promote draft ${draftId} to proposal.`);
				}

				// Find the promoted proposal
				const localProposals = await this.fs.listProposals();
				const promotedProposal = localProposals.find(
					(s) => s.title === proposal.title,
				);
				if (promotedProposal) {
					// Apply all original updates to the promoted proposal
					return await this.updateProposalFromInput(
						promotedProposal.id,
						input,
						autoCommit,
					);
				}
				throw new Error(
					`Draft ${draftId} promoted but new proposal not found.`,
				);
			}

			await this.updateDraft(proposal, autoCommit);
			const refreshed = await this.fs.loadDraft(proposal.id);
			return refreshed ?? proposal;
		}

		await this.updateProposal(proposal, autoCommit);
		const refreshed = await this.fs.loadProposal(proposal.id);
		return refreshed ?? proposal;
	}

	async updateDraft(proposal: Proposal, autoCommit?: boolean): Promise<void> {
		// Drafts always keep status Draft
		proposal.status = "Draft";
		normalizeAssignee(proposal);
		proposal.updatedDate = new Date()
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");

		const filepath = await this.fs.saveDraft(proposal);

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.git.addFile(filepath);
			await this.git.commitProposalChange(
				proposal.id,
				`Update draft ${proposal.id}`,
				filepath,
			);
		}
	}

	async updateDraftFromInput(
		draftId: string,
		input: ProposalUpdateInput,
		autoCommit?: boolean,
	): Promise<Proposal> {
		const draft = await this.fs.loadDraft(draftId);
		if (!draft) {
			throw new Error(`Draft not found: ${draftId}`);
		}

		const { mutated } = await this.applyProposalUpdateInput(
			draft,
			input,
			async (status) => {
				if (status.trim().toLowerCase() !== "draft") {
					throw new Error("Drafts must use status Draft.");
				}
				return "Draft";
			},
		);

		if (!mutated) {
			return draft;
		}

		await this.updateDraft(draft, autoCommit);
		const refreshed = await this.fs.loadDraft(draftId);
		return refreshed ?? draft;
	}

	async editProposalOrDraft(
		proposalId: string,
		input: ProposalUpdateInput,
		autoCommit?: boolean,
	): Promise<Proposal> {
		const draft = await this.fs.loadDraft(proposalId);
		if (draft) {
			const requestedStatus = input.status?.trim();
			const wantsDraft = requestedStatus?.toLowerCase() === "draft";
			if (requestedStatus && !wantsDraft) {
				return await this.promoteDraftWithUpdates(draft, input, autoCommit);
			}
			return await this.updateDraftFromInput(draft.id, input, autoCommit);
		}

		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		const requestedStatus = input.status?.trim();
		const wantsDraft = requestedStatus?.toLowerCase() === "draft";
		if (wantsDraft) {
			return await this.demoteProposalWithUpdates(proposal, input, autoCommit);
		}

		return await this.updateProposalFromInput(proposal.id, input, autoCommit);
	}

	private async promoteDraftWithUpdates(
		draft: Proposal,
		input: ProposalUpdateInput,
		autoCommit?: boolean,
	): Promise<Proposal> {
		const targetStatus = input.status?.trim();
		if (!targetStatus || targetStatus.toLowerCase() === "draft") {
			throw new Error("Promoting a draft requires a non-draft status.");
		}

		const { mutated } = await this.applyProposalUpdateInput(
			draft,
			{ ...input, status: undefined },
			async (status) => {
				if (status.trim().toLowerCase() !== "draft") {
					throw new Error("Drafts must use status Draft.");
				}
				return "Draft";
			},
		);

		const canonicalStatus = await this.requireCanonicalStatus(targetStatus);
		const newProposalId = await this.generateNextId(
			EntityType.Proposal,
			draft.parentProposalId,
		);
		const draftPath = draft.filePath;

		const promotedProposal: Proposal = {
			...draft,
			id: newProposalId,
			status: canonicalStatus,
			filePath: undefined,
			...(mutated || draft.status !== canonicalStatus
				? {
						updatedDate: new Date()
							.toISOString()
							.slice(0, 16)
							.replace("T", " "),
					}
				: {}),
		};

		normalizeAssignee(promotedProposal);
		const savedPath = await this.fs.saveProposal(promotedProposal);

		if (draftPath) {
			await unlink(draftPath);
		}

		if (this.contentStore) {
			const savedProposal = await this.fs.loadProposal(promotedProposal.id);
			if (savedProposal) {
				this.contentStore.upsertProposal(savedProposal);
			}
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Promote draft ${normalizeId(draft.id, "draft")}`,
				repoRoot,
			);
		}

		return (
			(await this.fs.loadProposal(promotedProposal.id)) ?? {
				...promotedProposal,
				filePath: savedPath,
			}
		);
	}

	private async demoteProposalWithUpdates(
		proposal: Proposal,
		input: ProposalUpdateInput,
		autoCommit?: boolean,
	): Promise<Proposal> {
		const { mutated } = await this.applyProposalUpdateInput(
			proposal,
			{ ...input, status: undefined },
			async (status) => {
				if (status.trim().toLowerCase() === "draft") {
					return "Draft";
				}
				return this.requireCanonicalStatus(status);
			},
		);

		const newDraftId = await this.generateNextId(EntityType.Draft);
		const proposalPath = proposal.filePath;

		const demotedDraft: Proposal = {
			...proposal,
			id: newDraftId,
			status: "Draft",
			filePath: undefined,
			...(mutated || proposal.status !== "Draft"
				? {
						updatedDate: new Date()
							.toISOString()
							.slice(0, 16)
							.replace("T", " "),
					}
				: {}),
		};

		normalizeAssignee(demotedDraft);
		const savedPath = await this.fs.saveDraft(demotedDraft);

		if (proposalPath) {
			await unlink(proposalPath);
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Demote proposal ${normalizeProposalId(proposal.id)}`,
				repoRoot,
			);
		}

		return (
			(await this.fs.loadDraft(demotedDraft.id)) ?? {
				...demotedDraft,
				filePath: savedPath,
			}
		);
	}

	/**
	 * Execute the onStatusChange callback if configured.
	 * Per-proposal callback takes precedence over global config.
	 * Failures are logged but don't block the status change.
	 */
	private async executeStatusChangeCallback(
		proposal: Proposal,
		oldStatus: string,
		newStatus: string,
	): Promise<void> {
		const config = await this.fs.loadConfig();

		// Per-proposal callback takes precedence over global config
		const callbackCommand = proposal.onStatusChange ?? config?.onStatusChange;
		if (!callbackCommand) {
			return;
		}

		try {
			const result = await executeStatusCallback({
				command: callbackCommand,
				proposalId: proposal.id,
				oldStatus,
				newStatus,
				proposalTitle: proposal.title,
				cwd: this.fs.rootDir,
			});

			if (!result.success) {
				console.error(
					`Status change callback failed for ${proposal.id}: ${result.error ?? "Unknown error"}`,
				);
				if (result.output) {
					console.error(`Callback output: ${result.output}`);
				}
			} else if (process.env.DEBUG && result.output) {
				console.log(
					`Status change callback output for ${proposal.id}: ${result.output}`,
				);
			}
		} catch (error) {
			console.error(
				`Failed to execute status change callback for ${proposal.id}:`,
				error,
			);
		}
	}

	private assertNoBlockingTestIssues(
		proposalId: string,
		action: "mark as Complete" | "complete",
	): void {
		const blockingIssues = getBlockingIssues(
			loadIssues(this.fs.rootDir),
			proposalId,
		);
		if (blockingIssues.length === 0) {
			return;
		}

		const details = blockingIssues
			.map((issue) => `${issue.id}: ${issue.title} (${issue.severity})`)
			.join("; ");
		throw new Error(
			`Test Issue Gate: Proposal ${proposalId} cannot ${action} because it has ${blockingIssues.length} open blocking issue(s): ${details}`,
		);
	}

	async editProposal(
		proposalId: string,
		input: ProposalUpdateInput,
		autoCommit?: boolean,
	): Promise<Proposal> {
		return await this.updateProposalFromInput(proposalId, input, autoCommit);
	}

	/**
	 * Remove claims that have exceeded their heartbeat timeout.
	 * Returns the list of recovered proposal IDs.
	 */
	async pruneClaims(options?: {
		timeoutMinutes?: number;
		autoCommit?: boolean;
	}): Promise<string[]> {
		if (await this.isPostgresProposalBackend()) {
			await this.ensurePgPool();
			const releasedProposalIds = await pg.releaseExpiredLeases();
			const recoveredIds = (
				await Promise.all(
					releasedProposalIds.map(
						async (proposalId) =>
							(
								await pg.getProposal(proposalId)
							)?.display_id,
					),
				)
			).filter((proposalId): proposalId is string => Boolean(proposalId));
			return recoveredIds;
		}

		const config = await this.fs.loadConfig();
		const timeout = options?.timeoutMinutes ?? config?.activeBranchDays ?? 30; // Fallback to activeBranchDays or 30
		const now = new Date();
		const recoveredIds: string[] = [];

		const proposals = await this.queryProposals({ includeCrossBranch: false });
		const claimedProposals = proposals.filter((s) => s.claim);

		for (const proposal of claimedProposals) {
			if (!proposal.claim) continue;

			const lastHeartbeat = proposal.claim.lastHeartbeat
				? new Date(proposal.claim.lastHeartbeat.replace(" ", "T"))
				: new Date(proposal.claim.created.replace(" ", "T"));

			const diffMinutes = (now.getTime() - lastHeartbeat.getTime()) / 60000;

			if (diffMinutes > timeout) {
				await this.releaseClaim(proposal.id, proposal.claim.agent, {
					force: true,
					autoCommit: false,
				});
				recoveredIds.push(proposal.id);

				await this.recordPulse({
					type: "proposal_created",
					id: proposal.id,
					title: proposal.title,
					impact: `STALE LEASE RECOVERED: Agent ${proposal.claim.agent} missed heartbeat for ${Math.round(
						diffMinutes,
					)} minutes.`,
				});
			}
		}

		if (
			recoveredIds.length > 0 &&
			(await this.shouldAutoCommit(options?.autoCommit))
		) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Recovered ${recoveredIds.length} stale leases: ${recoveredIds.join(", ")}`,
				repoRoot,
			);
		}

		return recoveredIds;
	}

	async updateProposalsBulk(
		proposals: Proposal[],
		commitMessage?: string,
		autoCommit?: boolean,
	): Promise<void> {
		// Update all proposals without committing individually
		for (const proposal of proposals) {
			await this.updateProposal(proposal, false); // Don't auto-commit each one
		}

		// Commit all changes at once if auto-commit is enabled
		if (await this.shouldAutoCommit(autoCommit)) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				commitMessage || `Update ${proposals.length} proposals`,
				repoRoot,
			);
		}
	}

	/**
	 * Claim a proposal for an agent with a short-lived lease.
	 * Throws if the proposal is already claimed by another agent and the claim has not expired.
	 * Also checks rate limits (STATE-44) unless force=true.
	 */
	async claimProposal(
		proposalId: string,
		agent: string,
		options?: {
			durationMinutes?: number;
			message?: string;
			force?: boolean;
			autoCommit?: boolean;
		},
	): Promise<Proposal> {
		if (await this.isPostgresProposalBackend()) {
			const proposal = await this.loadPgProposalById(proposalId);
			if (!proposal) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			if (!options?.force) {
				const priority = proposal.priority ?? "medium";
				const rateLimiter = this.getRateLimiter();
				const check = rateLimiter.canClaim(agent, proposal.id, priority);

				if (!check.allowed) {
					throw new Error(
						check.reason ??
							`Rate limited: too many claims. Retry after ${check.retryAfter}.`,
					);
				}

				rateLimiter.recordClaim(agent, proposal.id, priority);
			}

			await this.ensurePgPool();
			const resolvedProposalId = await pg.resolveProposalId(proposalId);
			if (resolvedProposalId === null) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			const currentSummary = await pg.getProposalSummary(resolvedProposalId);
			const activeLeaseHeld =
				Boolean(currentSummary?.leased_by) &&
				(currentSummary?.lease_expires === null ||
					currentSummary?.lease_expires === undefined ||
					new Date(currentSummary.lease_expires) > new Date());
			const expiresAt = new Date(
				Date.now() +
					(options?.durationMinutes ?? DEFAULT_CLAIM_DURATION_MINUTES) *
						60 *
						1000,
			);

			if (!activeLeaseHeld && currentSummary?.leased_by) {
				await pg.releaseLease(
					resolvedProposalId,
					currentSummary.leased_by,
					"expired",
				);
			}

			if (
				activeLeaseHeld &&
				currentSummary?.leased_by &&
				currentSummary.leased_by !== agent
			) {
				if (!options?.force) {
					throw new Error(
						`Proposal ${proposalId} is already claimed by ${currentSummary.leased_by}${currentSummary.lease_expires ? ` until ${currentSummary.lease_expires.toISOString()}` : ""}`,
					);
				}
				await pg.releaseLease(
					resolvedProposalId,
					currentSummary.leased_by,
					"reassigned",
				);
			}

			if (activeLeaseHeld && currentSummary?.leased_by === agent) {
				await pg.renewLease(resolvedProposalId, agent, expiresAt);
			} else {
				const claimed = await pg.claimLease(
					resolvedProposalId,
					agent,
					expiresAt,
				);
				if (!claimed) {
					throw new Error(`Proposal ${proposalId} could not be claimed.`);
				}
			}

			const refreshed = await this.loadPgProposalById(proposalId);
			if (!refreshed) {
				throw new Error(`Proposal not found after claim: ${proposalId}`);
			}

			await this.recordPulse({
				type: "proposal_claimed",
				id: refreshed.id,
				title: refreshed.title,
				agent,
			});

			return refreshed;
		}

		// Check budget before claiming (unless force=true)
		if (!options?.force) {
			const proposal = await this.fs.loadProposal(proposalId);

			// Budget guard: check if proposal has a budget limit and agent can afford it
			if (proposal?.budgetLimitUsd && proposal.budgetLimitUsd > 0) {
				const budgetConfig = await this.loadBudgetConfig();
				if (budgetConfig) {
					const agentBudget = budgetConfig.agents?.[agent];
					if (agentBudget?.isFrozen) {
						throw new Error(`Budget: Agent '${agent}' spending is frozen`);
					}
					if (agentBudget && agentBudget.dailyLimitUsd > 0) {
						const remaining =
							agentBudget.dailyLimitUsd - agentBudget.totalSpentTodayUsd;
						if (proposal.budgetLimitUsd > remaining) {
							throw new Error(
								`Budget exceeded for '${agent}': $${agentBudget.totalSpentTodayUsd.toFixed(2)} spent of $${agentBudget.dailyLimitUsd.toFixed(2)} daily limit (need $${proposal.budgetLimitUsd.toFixed(2)})`,
							);
						}
					}
				}
			}

			// STATE-44: Check rate limit before claiming
			const priority = proposal?.priority ?? "medium";
			const rateLimiter = this.getRateLimiter();
			const check = rateLimiter.canClaim(agent, proposalId, priority);

			if (!check.allowed) {
				throw new Error(
					check.reason ??
						`Rate limited: too many claims. Retry after ${check.retryAfter}.`,
				);
			}

			// Record the claim for rate limiting
			rateLimiter.recordClaim(agent, proposalId, priority);
		}

		return await FileLock.withLock(
			this.fs.rootDir,
			"coordination",
			async () => await this.executeClaimProposal(proposalId, agent, options),
		);
	}

	/**
	 * Internal claim logic without lock acquisition (must be called within a lock).
	 */
	private async executeClaimProposal(
		proposalId: string,
		agent: string,
		options?: {
			durationMinutes?: number;
			message?: string;
			force?: boolean;
			autoCommit?: boolean;
		},
	): Promise<Proposal> {
		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

		const now = new Date();
		if (!options?.force && proposal.claim && proposal.claim.agent !== agent) {
			const expires = new Date(proposal.claim.expires.replace(" ", "T"));
			if (expires > now) {
				throw new Error(
					`Proposal ${proposalId} is already claimed by ${proposal.claim.agent} until ${proposal.claim.expires}`,
				);
			}
		}

		const duration = options?.durationMinutes || DEFAULT_CLAIM_DURATION_MINUTES;
		const expiresAt = new Date(now.getTime() + duration * 60000);

		const claim: ProposalClaim = {
			agent,
			created: formatLocalDateTime(now),
			expires: formatLocalDateTime(expiresAt),
			lastHeartbeat: formatLocalDateTime(now),
			message: options?.message,
		};

		return await this.updateProposalFromInput(
			proposalId,
			{
				claim,
				assignee: [agent],
			},
			options?.autoCommit,
		);
	}
	/**
	 * Release a claim on a proposal.
	 * Throws if the claim is held by another agent unless force is used.
	 */
	async releaseClaim(
		proposalId: string,
		agent: string,
		options?: { force?: boolean; autoCommit?: boolean },
	): Promise<Proposal> {
		if (await this.isPostgresProposalBackend()) {
			const proposal = await this.loadPgProposalById(proposalId);
			if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

			const resolvedProposalId = await pg.resolveProposalId(proposalId);
			if (resolvedProposalId === null) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			const summary = await pg.getProposalSummary(resolvedProposalId);
			const activeLeaseHeld =
				Boolean(summary?.leased_by) &&
				(summary?.lease_expires === null ||
					summary?.lease_expires === undefined ||
					new Date(summary.lease_expires) > new Date());
			if (!activeLeaseHeld || !summary?.leased_by) {
				return proposal;
			}

			if (!options?.force && summary.leased_by !== agent) {
				throw new Error(
					`Proposal ${proposalId} claim is held by ${summary.leased_by}, not ${agent}`,
				);
			}

			const released = await pg.releaseLease(
				resolvedProposalId,
				options?.force ? summary.leased_by : agent,
				options?.force ? "force-released" : "released",
			);
			if (!released) {
				throw new Error(`Proposal ${proposalId} claim could not be released.`);
			}

			return (await this.loadPgProposalById(proposalId)) ?? proposal;
		}

		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

		if (!proposal.claim) {
			return proposal;
		}

		if (!options?.force && proposal.claim.agent !== agent) {
			throw new Error(
				`Proposal ${proposalId} claim is held by ${proposal.claim.agent}, not ${agent}`,
			);
		}

		return await this.updateProposalFromInput(
			proposalId,
			{ claim: null },
			options?.autoCommit,
		);
	}

	/**
	 * Renew an existing claim, extending its expiration.
	 */
	async renewClaim(
		proposalId: string,
		agent: string,
		options?: { durationMinutes?: number; autoCommit?: boolean },
	): Promise<Proposal> {
		if (await this.isPostgresProposalBackend()) {
			const proposal = await this.loadPgProposalById(proposalId);
			if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

			const resolvedProposalId = await pg.resolveProposalId(proposalId);
			if (resolvedProposalId === null) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			const summary = await pg.getProposalSummary(resolvedProposalId);
			const activeLeaseHeld =
				Boolean(summary?.leased_by) &&
				(summary?.lease_expires === null ||
					summary?.lease_expires === undefined ||
					new Date(summary.lease_expires) > new Date());
			if (!activeLeaseHeld || !summary?.leased_by) {
				throw new Error(`Proposal ${proposalId} has no active claim to renew`);
			}
			if (summary.leased_by !== agent) {
				throw new Error(
					`Proposal ${proposalId} claim is held by ${summary.leased_by}, not ${agent}`,
				);
			}

			const renewed = await pg.renewLease(
				resolvedProposalId,
				agent,
				new Date(
					Date.now() +
						(options?.durationMinutes || DEFAULT_CLAIM_DURATION_MINUTES) *
							60000,
				),
			);
			if (!renewed) {
				throw new Error(`Proposal ${proposalId} claim could not be renewed.`);
			}

			return (await this.loadPgProposalById(proposalId)) ?? proposal;
		}

		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

		if (!proposal.claim) {
			throw new Error(`Proposal ${proposalId} has no active claim to renew`);
		}

		if (proposal.claim.agent !== agent) {
			throw new Error(
				`Proposal ${proposalId} claim is held by ${proposal.claim.agent}, not ${agent}`,
			);
		}

		const now = new Date();
		const duration = options?.durationMinutes || DEFAULT_CLAIM_DURATION_MINUTES;
		const expiresAt = new Date(now.getTime() + duration * 60000);

		const claim: ProposalClaim = {
			...proposal.claim,
			expires: formatLocalDateTime(expiresAt),
			lastHeartbeat: formatLocalDateTime(now),
		};
		return await this.updateProposalFromInput(
			proposalId,
			{ claim },
			options?.autoCommit,
		);
	}

	async reorderProposal(params: {
		proposalId: string;
		targetStatus: string;
		orderedProposalIds: string[];
		targetDirective?: string | null;
		commitMessage?: string;
		autoCommit?: boolean;
		defaultStep?: number;
	}): Promise<{ updatedProposal: Proposal; changedProposals: Proposal[] }> {
		const rawProposalId = String(params.proposalId || "").trim();
		const targetStatus = String(params.targetStatus || "").trim();
		const rawOrderedProposalIds = params.orderedProposalIds
			.map((id) => String(id || "").trim())
			.filter(Boolean);
		const usePostgresBackend = await this.isPostgresProposalBackend();
		const proposalId = usePostgresBackend
			? rawProposalId
			: normalizeProposalId(rawProposalId);
		const orderedProposalIds = usePostgresBackend
			? rawOrderedProposalIds
			: rawOrderedProposalIds
					.map((id) => normalizeProposalId(id))
					.filter(Boolean);
		const defaultStep = params.defaultStep ?? DEFAULT_ORDINAL_STEP;

		if (!proposalId) throw new Error("proposalId is required");
		if (!targetStatus) throw new Error("targetStatus is required");
		if (orderedProposalIds.length === 0)
			throw new Error("orderedProposalIds must include at least one proposal");
		if (!orderedProposalIds.includes(proposalId)) {
			throw new Error(
				"orderedProposalIds must include the proposal being moved",
			);
		}

		if (usePostgresBackend) {
			const movedProposal = await this.loadProposalById(proposalId);
			if (!movedProposal) {
				throw new Error(`Proposal ${proposalId} not found while reordering`);
			}

			const updateInput: ProposalUpdateInput = {};
			if (movedProposal.status !== targetStatus) {
				updateInput.status = targetStatus;
			}
			if (params.targetDirective !== undefined) {
				updateInput.directive =
					params.targetDirective === null ? null : params.targetDirective;
			}

			if (Object.keys(updateInput).length === 0) {
				return { updatedProposal: movedProposal, changedProposals: [] };
			}

			const updatedProposal = await this.updateProposalFromInput(
				proposalId,
				updateInput,
				params.autoCommit,
			);
			return { updatedProposal, changedProposals: [updatedProposal] };
		}

		const seen = new Set<string>();
		for (const id of orderedProposalIds) {
			if (seen.has(id)) {
				throw new Error(`Duplicate proposal id ${id} in orderedProposalIds`);
			}
			seen.add(id);
		}

		// Load all proposals from the ordered list - use getProposal to include cross-branch proposals from the store
		const loadedProposals = await Promise.all(
			orderedProposalIds.map(async (id) => {
				const proposal = await this.getProposal(id);
				return proposal;
			}),
		);

		// Filter out any proposals that couldn't be loaded (may have been moved/deleted)
		const validProposals = loadedProposals.filter(
			(t): t is Proposal => t !== null,
		);

		// Verify the moved proposal itself exists
		const movedProposal = validProposals.find((t) => t.id === proposalId);
		if (!movedProposal) {
			throw new Error(`Proposal ${proposalId} not found while reordering`);
		}

		// Reject reordering proposals from other branches - they can only be modified in their source branch
		if (movedProposal.branch) {
			throw new Error(
				`Proposal ${proposalId} exists in branch "${movedProposal.branch}" and cannot be reordered from the current branch. Switch to that branch to modify it.`,
			);
		}

		const hasTargetDirective = params.targetDirective !== undefined;
		const normalizedTargetDirective =
			params.targetDirective === null
				? undefined
				: typeof params.targetDirective === "string" &&
						params.targetDirective.trim().length > 0
					? params.targetDirective.trim()
					: undefined;

		// Calculate target index within the valid proposals list
		const validOrderedIds = orderedProposalIds.filter((id) =>
			validProposals.some((t) => t.id === id),
		);
		const targetIndex = validOrderedIds.indexOf(proposalId);

		if (targetIndex === -1) {
			throw new Error(
				"Implementation error: Proposal found in validProposals but index missing",
			);
		}

		const previousProposal =
			targetIndex > 0 ? validProposals[targetIndex - 1] : null;
		const nextProposal =
			targetIndex < validProposals.length - 1
				? validProposals[targetIndex + 1]
				: null;

		const { ordinal: newOrdinal, requiresRebalance } = calculateNewOrdinal({
			previous: previousProposal as
				| Pick<Proposal, "id" | "ordinal">
				| null
				| undefined,
			next: nextProposal as Pick<Proposal, "id" | "ordinal"> | null | undefined,
			defaultStep,
		});

		const updatedMoved: Proposal = {
			...movedProposal,
			status: targetStatus,
			...(hasTargetDirective ? { directive: normalizedTargetDirective } : {}),
			ordinal: newOrdinal,
		};

		const proposalsInOrder: Proposal[] = validProposals.map(
			(proposal, index) => (index === targetIndex ? updatedMoved : proposal),
		);
		const resolutionUpdates = resolveOrdinalConflicts(proposalsInOrder, {
			defaultStep,
			startOrdinal: defaultStep,
			forceSequential: requiresRebalance,
		});

		const updatesMap = new Map<string, Proposal>();
		for (const update of resolutionUpdates) {
			updatesMap.set(update.id, update);
		}
		if (!updatesMap.has(updatedMoved.id)) {
			updatesMap.set(updatedMoved.id, updatedMoved);
		}

		const originalMap = new Map(
			validProposals.map((proposal) => [proposal.id, proposal]),
		);
		const changedProposals = Array.from(updatesMap.values()).filter(
			(proposal) => {
				const original = originalMap.get(proposal.id);
				if (!original) return true;
				return (
					(original.ordinal ?? null) !== (proposal.ordinal ?? null) ||
					(original.status ?? "") !== (proposal.status ?? "") ||
					(original.directive ?? "") !== (proposal.directive ?? "")
				);
			},
		);

		if (changedProposals.length > 0) {
			await this.updateProposalsBulk(
				changedProposals,
				params.commitMessage ?? `Reorder proposals in ${targetStatus}`,
				params.autoCommit,
			);
		}

		const updatedProposal = updatesMap.get(proposalId) ?? updatedMoved;
		return { updatedProposal, changedProposals };
	}

	// Sequences operations (business logic lives in core, not server)
	async listActiveSequences(): Promise<{
		unsequenced: Proposal[];
		sequences: Sequence[];
	}> {
		const all = await this.fs.listProposals();
		const active = all.filter((t) => (t.status || "").toLowerCase() !== "done");
		return computeSequences(active);
	}

	async moveProposalInSequences(params: {
		proposalId: string;
		unsequenced?: boolean;
		targetSequenceIndex?: number;
	}): Promise<{ unsequenced: Proposal[]; sequences: Sequence[] }> {
		const proposalId = String(params.proposalId || "").trim();
		if (!proposalId) throw new Error("proposalId is required");

		const allProposals = await this.fs.listProposals();
		const exists = allProposals.some((t) => t.id === proposalId);
		if (!exists) throw new Error(`Proposal ${proposalId} not found`);

		const active = allProposals.filter(
			(t) => (t.status || "").toLowerCase() !== "done",
		);
		const { sequences } = computeSequences(active);

		if (params.unsequenced) {
			const res = planMoveToUnsequenced(allProposals, proposalId);
			if (!res.ok) throw new Error(res.error);
			await this.updateProposalsBulk(
				res.changed,
				`Move ${proposalId} to Unsequenced`,
			);
		} else {
			const targetSequenceIndex = params.targetSequenceIndex;
			if (
				targetSequenceIndex === undefined ||
				Number.isNaN(targetSequenceIndex)
			) {
				throw new Error("targetSequenceIndex must be a number");
			}
			if (targetSequenceIndex < 1)
				throw new Error("targetSequenceIndex must be >= 1");
			const changed = planMoveToSequence(
				allProposals,
				sequences,
				proposalId,
				targetSequenceIndex,
			);
			if (changed.length > 0)
				await this.updateProposalsBulk(
					changed,
					`Update deps/order for ${proposalId}`,
				);
		}

		// Return updated sequences
		const afterAll = await this.fs.listProposals();
		const afterActive = afterAll.filter(
			(t) => (t.status || "").toLowerCase() !== "done",
		);
		return computeSequences(afterActive);
	}

	async archiveProposal(
		proposalId: string,
		autoCommit?: boolean,
	): Promise<boolean> {
		const proposalToArchive = await this.fs.loadProposal(proposalId);
		if (!proposalToArchive) {
			return false;
		}
		const normalizedProposalId = proposalToArchive.id;

		// Get paths before moving the file
		const proposalPath =
			proposalToArchive.filePath ??
			(await getProposalPath(normalizedProposalId, this));
		const proposalFilename = await getProposalFilename(
			normalizedProposalId,
			this,
		);

		if (!proposalPath || !proposalFilename) return false;

		const fromPath = proposalPath;
		const toPath = join(
			await this.fs.getArchiveProposalsDir(),
			proposalFilename,
		);

		const success = await this.fs.archiveProposal(normalizedProposalId);
		if (!success) {
			return false;
		}

		const activeProposals = await this.fs.listProposals();
		const sanitizedProposals = this.sanitizeArchivedProposalLinks(
			activeProposals,
			normalizedProposalId,
		);
		if (sanitizedProposals.length > 0) {
			await this.updateProposalsBulk(sanitizedProposals, undefined, false);
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			// Stage the file move for proper Git tracking
			const repoRoot = await this.git.stageFileMove(fromPath, toPath);
			for (const sanitizedProposal of sanitizedProposals) {
				if (sanitizedProposal.filePath) {
					await this.git.addFile(sanitizedProposal.filePath);
				}
			}
			await this.git.commitChanges(
				`roadmap: Archive proposal ${normalizedProposalId}`,
				repoRoot,
			);
		}

		return true;
	}

	async archiveDirective(
		identifier: string,
		autoCommit?: boolean,
	): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		directive?: Directive;
	}> {
		const result = await this.fs.archiveDirective(identifier);

		if (
			result.success &&
			result.sourcePath &&
			result.targetPath &&
			(await this.shouldAutoCommit(autoCommit))
		) {
			const repoRoot = await this.git.stageFileMove(
				result.sourcePath,
				result.targetPath,
			);
			const label = result.directive?.id ? ` ${result.directive.id}` : "";
			const commitPaths = [result.sourcePath, result.targetPath];
			try {
				await this.git.commitFiles(
					`roadmap: Archive directive${label}`,
					commitPaths,
					repoRoot,
				);
			} catch (error) {
				await this.git.resetPaths(commitPaths, repoRoot);
				try {
					await moveFile(result.targetPath, result.sourcePath);
				} catch {
					// Ignore rollback failure and propagate original commit error.
				}
				throw error;
			}
		}

		return {
			success: result.success,
			sourcePath: result.sourcePath,
			targetPath: result.targetPath,
			directive: result.directive,
		};
	}

	async renameDirective(
		identifier: string,
		title: string,
		autoCommit?: boolean,
	): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		directive?: Directive;
		previousTitle?: string;
	}> {
		const result = await this.fs.renameDirective(identifier, title);
		if (!result.success) {
			return result;
		}

		if (
			result.sourcePath &&
			result.targetPath &&
			(await this.shouldAutoCommit(autoCommit))
		) {
			const repoRoot = await this.git.stageFileMove(
				result.sourcePath,
				result.targetPath,
			);
			const label = result.directive?.id ? ` ${result.directive.id}` : "";
			const commitPaths = [result.sourcePath, result.targetPath];
			try {
				await this.git.commitFiles(
					`roadmap: Rename directive${label}`,
					commitPaths,
					repoRoot,
				);
			} catch (error) {
				await this.git.resetPaths(commitPaths, repoRoot);
				const rollbackTitle = result.previousTitle ?? title;
				await this.fs.renameDirective(
					result.directive?.id ?? identifier,
					rollbackTitle,
				);
				throw error;
			}
		}

		return result;
	}

	async completeProposal(
		proposalId: string,
		autoCommit?: boolean,
	): Promise<boolean> {
		const proposal = await this.fs.loadProposal(proposalId);

		// Get paths before moving the file
		const completedDir = this.fs.completedDir;
		const proposalPath = await getProposalPath(proposalId, this);
		const proposalFilename = await getProposalFilename(proposalId, this);

		if (!proposal || !proposalPath || !proposalFilename) return false;

		this.assertNoBlockingTestIssues(proposal.id, "complete");

		const fromPath = proposalPath;
		const toPath = join(completedDir, proposalFilename);

		const success = await this.fs.completeProposal(proposalId);

		if (success && (await this.shouldAutoCommit(autoCommit))) {
			// Stage the file move for proper Git tracking
			const repoRoot = await this.git.stageFileMove(fromPath, toPath);
			await this.git.commitChanges(
				`roadmap: Complete proposal ${normalizeProposalId(proposalId)}`,
				repoRoot,
			);
		}

		return success;
	}

	async getCompleteProposalsByAge(olderThanDays: number): Promise<Proposal[]> {
		const proposals = await this.fs.listProposals();
		const cutoffDate = new Date();
		cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

		return proposals.filter((proposal) => {
			if (!isCompleteStatus(proposal.status)) return false;

			// Check updatedDate first, then createdDate as fallback
			const proposalDate = proposal.updatedDate || proposal.createdDate;
			if (!proposalDate) return false;

			const date = new Date(proposalDate);
			return date < cutoffDate;
		});
	}

	/**
	 * Get proposals that have reached a terminal status and are older than the specified age.
	 * Used for cleanup operations.
	 */
	async getReachedProposalsByAge(ageDays: number): Promise<Proposal[]> {
		const proposals = await this.loadProposals();
		const cutoff = new Date();
		cutoff.setDate(cutoff.getDate() - ageDays);
		return proposals.filter((p) => {
			if (!isReachedStatus(p.status)) return false;
			const dateStr = p.updatedDate || p.createdDate;
			if (!dateStr) return false;
			const date = new Date(dateStr);
			return date < cutoff;
		});
	}

	async archiveDraft(draftId: string, autoCommit?: boolean): Promise<boolean> {
		const success = await this.fs.archiveDraft(draftId);

		if (success && (await this.shouldAutoCommit(autoCommit))) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Archive draft ${normalizeId(draftId, "draft")}`,
				repoRoot,
			);
		}

		return success;
	}

	async promoteDraft(draftId: string, autoCommit?: boolean): Promise<boolean> {
		const success = await this.fs.promoteDraft(draftId);

		if (success && (await this.shouldAutoCommit(autoCommit))) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Promote draft ${normalizeId(draftId, "draft")}`,
				repoRoot,
			);
		}

		return success;
	}

	async demoteProposal(
		proposalId: string,
		autoCommit?: boolean,
	): Promise<boolean> {
		const success = await this.fs.demoteProposal(proposalId);

		if (success && (await this.shouldAutoCommit(autoCommit))) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Demote proposal ${normalizeProposalId(proposalId)}`,
				repoRoot,
			);
		}

		return success;
	}

	/**
	 * Add acceptance criteria to a proposal
	 */
	async addAcceptanceCriteria(
		proposalId: string,
		criteria: string[],
		autoCommit?: boolean,
	): Promise<void> {
		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		// Get existing criteria or initialize empty array
		const current = Array.isArray(proposal.acceptanceCriteriaItems)
			? [...proposal.acceptanceCriteriaItems]
			: [];

		// Calculate next index (1-based)
		let nextIndex =
			current.length > 0 ? Math.max(...current.map((c) => c.index)) + 1 : 1;

		// Append new criteria
		const newCriteria = criteria.map((text) => ({
			index: nextIndex++,
			text,
			checked: false,
		}));
		proposal.acceptanceCriteriaItems = [...current, ...newCriteria];

		// Save the proposal
		await this.updateProposal(proposal, autoCommit);
	}

	/**
	 * Remove acceptance criteria by indices (supports batch operations)
	 * @returns Array of removed indices
	 */
	async removeAcceptanceCriteria(
		proposalId: string,
		indices: number[],
		autoCommit?: boolean,
	): Promise<number[]> {
		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		let list = Array.isArray(proposal.acceptanceCriteriaItems)
			? [...proposal.acceptanceCriteriaItems]
			: [];
		const removed: number[] = [];

		// Sort indices in descending order to avoid index shifting issues
		const sortedIndices = [...indices].sort((a, b) => b - a);

		for (const idx of sortedIndices) {
			const before = list.length;
			list = list.filter((c) => c.index !== idx);
			if (list.length < before) {
				removed.push(idx);
			}
		}

		if (removed.length === 0) {
			throw new Error(
				"No criteria were removed. Check that the specified indices exist.",
			);
		}

		// Re-index remaining items (1-based)
		list = list.map((c, i) => ({ ...c, index: i + 1 }));
		proposal.acceptanceCriteriaItems = list;

		// Save the proposal
		await this.updateProposal(proposal, autoCommit);

		return removed.sort((a, b) => a - b); // Return in ascending order
	}

	/**
	 * Check or uncheck acceptance criteria by indices (supports batch operations)
	 * Silently ignores invalid indices and only updates valid ones.
	 * @returns Array of updated indices
	 */
	async checkAcceptanceCriteria(
		proposalId: string,
		indices: number[],
		checked: boolean,
		autoCommit?: boolean,
	): Promise<number[]> {
		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		let list = Array.isArray(proposal.acceptanceCriteriaItems)
			? [...proposal.acceptanceCriteriaItems]
			: [];
		const updated: number[] = [];

		// Filter to only valid indices and update them
		for (const idx of indices) {
			if (list.some((c) => c.index === idx)) {
				list = list.map((c) => {
					if (c.index === idx) {
						updated.push(idx);
						return { ...c, checked };
					}
					return c;
				});
			}
		}

		if (updated.length === 0) {
			throw new Error("No criteria were updated.");
		}

		proposal.acceptanceCriteriaItems = list;

		// Save the proposal
		await this.updateProposal(proposal, autoCommit);

		return updated.sort((a, b) => a - b);
	}

	/**
	 * List all acceptance criteria for a proposal
	 */
	async listAcceptanceCriteria(
		proposalId: string,
	): Promise<AcceptanceCriterion[]> {
		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) {
			throw new Error(`Proposal not found: ${proposalId}`);
		}

		return proposal.acceptanceCriteriaItems || [];
	}

	async createDecision(
		decision: Decision,
		autoCommit?: boolean,
	): Promise<void> {
		await this.fs.saveDecision(decision);

		// Record Pulse event
		await this.recordPulse({
			type: "decision_made",
			id: decision.id,
			title: decision.title,
			impact: `Status: ${decision.status}`,
		});

		if (await this.shouldAutoCommit(autoCommit)) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Add decision ${decision.id}`,
				repoRoot,
			);
		}
	}

	async updateDecisionFromContent(
		decisionId: string,
		content: string,
		autoCommit?: boolean,
	): Promise<void> {
		const existingDecision = await this.fs.loadDecision(decisionId);
		if (!existingDecision) {
			throw new Error(`Decision ${decisionId} not found`);
		}

		// Parse the markdown content to extract the decision data
		const matter = await import("gray-matter");
		const { data } = matter.default(content);

		const extractSection = (
			content: string,
			sectionName: string,
		): string | undefined => {
			const regex = new RegExp(
				`## ${sectionName}\\s*([\\s\\S]*?)(?=## |$)`,
				"i",
			);
			const match = content.match(regex);
			return match ? match[1]?.trim() : undefined;
		};

		const updatedDecision = {
			...existingDecision,
			title: data.title || existingDecision.title,
			status: data.status || existingDecision.status,
			date: data.date || existingDecision.date,
			context: extractSection(content, "Context") || existingDecision.context,
			decision:
				extractSection(content, "Decision") || existingDecision.decision,
			consequences:
				extractSection(content, "Consequences") ||
				existingDecision.consequences,
			alternatives:
				extractSection(content, "Alternatives") ||
				existingDecision.alternatives,
		};

		await this.createDecision(updatedDecision, autoCommit);
	}

	async createDecisionWithTitle(
		title: string,
		autoCommit?: boolean,
	): Promise<Decision> {
		// Import the generateNextDecisionId function from CLI
		const { generateNextDecisionId } = await import("../cli.js");
		const id = await generateNextDecisionId(this);

		const decision: Decision = {
			id,
			title,
			date: new Date().toISOString().slice(0, 16).replace("T", " "),
			status: "proposed",
			context: "[Describe the context and problem that needs to be addressed]",
			decision: "[Describe the decision that was made]",
			consequences: "[Describe the consequences of this decision]",
			alternatives: "[Describe the alternatives considered]",
			rawContent: "",
		};

		await this.createDecision(decision, autoCommit);
		return decision;
	}

	async createDocument(
		doc: Document,
		autoCommit?: boolean,
		subPath = "",
	): Promise<void> {
		const relativePath = await this.fs.saveDocument(doc, subPath);
		doc.path = relativePath;

		if (await this.shouldAutoCommit(autoCommit)) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(`roadmap: Add document ${doc.id}`, repoRoot);
		}
	}

	async updateDocument(
		existingDoc: Document,
		content: string,
		autoCommit?: boolean,
	): Promise<void> {
		const updatedDoc = {
			...existingDoc,
			rawContent: content,
			updatedDate: new Date().toISOString().slice(0, 16).replace("T", " "),
		};

		let normalizedSubPath = "";
		if (existingDoc.path) {
			const segments = existingDoc.path.split(/[\\/]/).slice(0, -1);
			if (segments.length > 0) {
				normalizedSubPath = segments.join("/");
			}
		}

		await this.createDocument(updatedDoc, autoCommit, normalizedSubPath);
	}

	async createDocumentWithId(
		title: string,
		content: string,
		autoCommit?: boolean,
	): Promise<Document> {
		// Import the generateNextDocId function from CLI
		const { generateNextDocId } = await import("../cli.js");
		const id = await generateNextDocId(this);

		const document: Document = {
			id,
			title,
			type: "other" as const,
			createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
			rawContent: content,
		};

		await this.createDocument(document, autoCommit);
		return document;
	}

	async initializeProject(
		projectName: string,
		autoCommit = false,
	): Promise<void> {
		await this.fs.ensureRoadmapStructure();

		const config: RoadmapConfig = {
			projectName: projectName,
			statuses: [...DEFAULT_STATUSES],
			labels: [],
			defaultStatus: DEFAULT_STATUSES[0], // Use first status as default
			dateFormat: "yyyy-mm-dd",
			maxColumnWidth: 20, // Default for terminal display
			autoCommit: false, // Default to false for user control
			prefixes: {
				proposal: "proposal",
			},
		};

		await this.fs.saveConfig(config);
		// Update git operations with the new config
		await this.ensureConfigLoaded();

		if (autoCommit) {
			const roadmapDir = await this.getRoadmapDirectoryName();
			const repoRoot = await this.git.stageRoadmapDirectory(roadmapDir);
			await this.git.commitChanges(
				`roadmap: Initialize roadmap project: ${projectName}`,
				repoRoot,
			);
		}
	}

	async listProposalsWithMetadata(
		includeBranchMeta = false,
	): Promise<Array<Proposal & { lastModified?: Date; branch?: string }>> {
		const proposals = await this.fs.listProposals();
		const results = await Promise.all(
			proposals.map(async (proposal) => {
				try {
					const filePath = await getProposalPath(proposal.id, this);

					if (filePath) {
						const stats = await stat(filePath);
						return {
							...proposal,
							lastModified: new Date(stats.mtime),
							// Only include branch if explicitly requested
							...(includeBranchMeta && {
								branch:
									(await this.git.getFileLastModifiedBranch(filePath)) ||
									undefined,
							}),
						};
					}
					return proposal;
				} catch (error) {
					if (process.env.DEBUG) {
						console.warn(
							`[Core] Failed to load metadata for proposal ${proposal.id}:`,
							error,
						);
					}
					return proposal; // Return proposal without metadata rather than crashing
				}
			}),
		);
		return results.filter(
			(s): s is Proposal & { lastModified?: Date; branch?: string } =>
				Boolean(s),
		);
	}

	/**
	 * Open a file in the configured editor with minimal interference
	 * @param filePath - Path to the file to edit
	 * @param screen - Optional blessed screen to suspend (for TUI contexts)
	 */
	async editProposalInTui(
		proposalId: string,
		screen: BlessedScreen,
		selectedProposal?: Proposal,
	): Promise<TuiProposalEditResult> {
		const contextualProposal =
			selectedProposal && proposalIdsEqual(selectedProposal.id, proposalId)
				? selectedProposal
				: undefined;

		if (
			contextualProposal &&
			(!isLocalEditableProposal(contextualProposal) ||
				contextualProposal.branch)
		) {
			return {
				changed: false,
				proposal: contextualProposal,
				reason: "read_only",
			};
		}

		const resolvedProposal =
			contextualProposal ?? (await this.getProposal(proposalId));
		if (!resolvedProposal) {
			return { changed: false, reason: "not_found" };
		}
		if (!isLocalEditableProposal(resolvedProposal) || resolvedProposal.branch) {
			return {
				changed: false,
				proposal: resolvedProposal,
				reason: "read_only",
			};
		}

		const localProposal = await this.fs.loadProposal(resolvedProposal.id);
		const editableProposal = localProposal ?? resolvedProposal;

		const filePath = await getProposalPath(editableProposal.id, this);
		if (!filePath) {
			return {
				changed: false,
				proposal: editableProposal,
				reason: "not_found",
			};
		}

		let beforeContent: string;
		try {
			beforeContent = await readFile(filePath, "utf-8");
		} catch {
			return {
				changed: false,
				proposal: editableProposal,
				reason: "not_found",
			};
		}

		const opened = await this.openEditor(filePath, screen);
		if (!opened) {
			return {
				changed: false,
				proposal: editableProposal,
				reason: "editor_failed",
			};
		}

		let afterContent: string;
		try {
			afterContent = await readFile(filePath, "utf-8");
		} catch {
			return {
				changed: false,
				proposal: editableProposal,
				reason: "not_found",
			};
		}

		if (afterContent === beforeContent) {
			const refreshedProposal = await this.fs.loadProposal(editableProposal.id);
			return {
				changed: false,
				proposal: refreshedProposal ?? editableProposal,
			};
		}

		const now = new Date().toISOString().slice(0, 16).replace("T", " ");
		const withUpdatedDate = upsertProposalUpdatedDate(afterContent, now);
		await writeFile(filePath, withUpdatedDate, "utf-8");

		const refreshedProposal = await this.fs.loadProposal(editableProposal.id);
		if (refreshedProposal && this.contentStore) {
			this.contentStore.upsertProposal(refreshedProposal);
		}

		return {
			changed: true,
			proposal: refreshedProposal ?? { ...editableProposal, updatedDate: now },
		};
	}

	async openEditor(filePath: string, screen?: BlessedScreen): Promise<boolean> {
		const config = await this.fs.loadConfig();

		// If no screen provided, use simple editor opening
		if (!screen) {
			return await openInEditor(filePath, config);
		}

		const program = screen.program;

		// Leave alternate screen buffer FIRST
		screen.leave();

		// Reset keypad/cursor mode using terminfo if available
		if (typeof program.put?.keypad_local === "function") {
			program.put.keypad_local();
			if (typeof program.flush === "function") {
				program.flush();
			}
		}

		// Send escape sequences directly as reinforcement
		// ESC[0m   = Reset all SGR attributes (fixes white background in nano)
		// ESC[?25h = Show cursor (ensure cursor is visible)
		// ESC[?1l  = Reset DECCKM (cursor keys send CSI sequences)
		// ESC>     = DECKPNM (numeric keypad mode)
		const fs = await import("node:fs");
		fs.writeSync(1, "\u001b[0m\u001b[?25h\u001b[?1l\u001b>");

		// Pause the terminal AFTER leaving alt buffer (disables raw mode, releases terminal)
		const resume =
			typeof program.pause === "function" ? program.pause() : undefined;
		try {
			return await openInEditor(filePath, config);
		} finally {
			// Resume terminal proposal FIRST (re-enables raw mode)
			if (typeof resume === "function") {
				resume();
			}
			// Re-enter alternate screen buffer
			screen.enter();
			// Restore application cursor mode
			if (typeof program.put?.keypad_xmit === "function") {
				program.put.keypad_xmit();
				if (typeof program.flush === "function") {
					program.flush();
				}
			}
			// Full redraw
			screen.render();
		}
	}

	/**
	 * Load and process all proposals with the same logic as CLI overview
	 * This method extracts the common proposal loading logic for reuse
	 */
	async loadAllProposalsForStatistics(
		progressCallback?: (msg: string) => void,
	): Promise<{
		proposals: Proposal[];
		drafts: Proposal[];
		statuses: string[];
	}> {
		const config = await this.fs.loadConfig();

		const statuses = (config?.statuses || DEFAULT_STATUSES) as string[];
		const resolutionStrategy =
			config?.proposalResolutionStrategy || "most_progressed";

		// Load local and completed proposals first
		progressCallback?.("Loading local proposals...");
		const [localProposals, completedProposals, archivedProposals] =
			await Promise.all([
				this.listProposalsWithMetadata(),
				this.fs.listCompletedProposals(),
				this.fs.listArchivedProposals(),
			]);

		// Load remote proposals and local branch proposals in parallel
		const branchProposalEntries: BranchProposalProposalEntry[] | undefined =
			config?.checkActiveBranches === false ? undefined : [];
		const [remoteProposals, localBranchProposals] = await Promise.all([
			loadRemoteProposals(
				this.git,
				config,
				progressCallback,
				localProposals,
				branchProposalEntries,
			),
			loadLocalBranchProposals(
				this.git,
				config,
				progressCallback,
				localProposals,
				branchProposalEntries,
			),
		]);
		progressCallback?.("Loaded proposals");

		// Create map with local proposals
		const proposalsById = new Map<string, Proposal>(
			localProposals.map((t) => [t.id, { ...t, origin: "local" }]),
		);

		if (process.env.DEBUG) {
			console.error(
				"[DEBUG] loadProposals: localProposals count=",
				localProposals.length,
				"origin set to local",
			);
		}
		// Add completed proposals to the map
		for (const completedProposal of completedProposals) {
			if (!proposalsById.has(completedProposal.id)) {
				proposalsById.set(completedProposal.id, {
					...completedProposal,
					origin: "completed",
				});
			}
		}

		// Merge proposals from other local branches
		progressCallback?.("Merging proposals...");
		for (const branchProposal of localBranchProposals) {
			const existing = proposalsById.get(branchProposal.id);
			if (!existing) {
				proposalsById.set(branchProposal.id, branchProposal);
			} else {
				const resolved = resolveProposalConflict(
					existing,
					branchProposal,
					statuses,
					resolutionStrategy,
				);
				proposalsById.set(branchProposal.id, resolved);
			}
		}

		// Merge remote proposals with local proposals
		for (const remoteProposal of remoteProposals) {
			const existing = proposalsById.get(remoteProposal.id);
			if (!existing) {
				proposalsById.set(remoteProposal.id, remoteProposal);
			} else {
				const resolved = resolveProposalConflict(
					existing,
					remoteProposal,
					statuses,
					resolutionStrategy,
				);
				proposalsById.set(remoteProposal.id, resolved);
			}
		}

		// Get all proposals as array
		const proposals = Array.from(proposalsById.values());
		let activeProposals: Proposal[];

		if (config?.checkActiveBranches === false) {
			activeProposals = proposals;
		} else {
			progressCallback?.(
				"Applying latest proposal proposals from branch scans...",
			);
			activeProposals = filterProposalsByProposalSnapshots(
				proposals,
				buildLatestProposalMap(
					branchProposalEntries || [],
					localProposals,
					archivedProposals,
				),
			);
		}

		// Load drafts
		progressCallback?.("Loading drafts...");
		const drafts = await this.fs.listDrafts();

		return {
			proposals: activeProposals,
			drafts,
			statuses: statuses as string[],
		};
	}

	/**
	 * Load all proposals with cross-branch support
	 * This is the single entry point for loading proposals across all interfaces
	 */
	async loadProposals(
		progressCallback?: (msg: string) => void,
		abortSignal?: AbortSignal,
		options?: { includeCompleted?: boolean },
	): Promise<Proposal[]> {
		const config = await this.fs.loadConfig();

		if (await this.isPostgresProposalBackend(config)) {
			progressCallback?.("Loading roadmap data from Postgres...");
			if (abortSignal?.aborted) {
				throw new Error("Loading cancelled");
			}
			return await this.queryProposals({ includeCrossBranch: false });
		}

		const statuses = config?.statuses || [...DEFAULT_STATUSES];
		const resolutionStrategy =
			config?.proposalResolutionStrategy || "most_progressed";
		const includeCompleted = options?.includeCompleted ?? false;

		// Check for cancellation
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		// Load local filesystem proposals first (needed for optimization)
		const [localProposals, completedProposals, archivedProposals] =
			await Promise.all([
				this.listProposalsWithMetadata(),
				includeCompleted
					? this.fs.listCompletedProposals()
					: Promise.resolve([]),
				this.fs.listArchivedProposals(),
			]);

		// Check for cancellation
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		// Load proposals from remote branches and other local branches in parallel
		progressCallback?.(getProposalLoadingMessage(config));

		const branchProposalEntries: BranchProposalProposalEntry[] | undefined =
			config?.checkActiveBranches === false ? undefined : [];
		const [remoteProposals, localBranchProposals] = await Promise.all([
			loadRemoteProposals(
				this.git,
				config,
				progressCallback,
				localProposals,
				branchProposalEntries,
				includeCompleted,
			),
			loadLocalBranchProposals(
				this.git,
				config,
				progressCallback,
				localProposals,
				branchProposalEntries,
				includeCompleted,
			),
		]);

		// Check for cancellation after loading
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		// Create map with local proposals (current branch filesystem)
		const proposalsById = new Map<string, Proposal>(
			localProposals.map((t) => [t.id, { ...t, origin: "local" }]),
		);

		// Add local completed proposals when requested
		if (includeCompleted) {
			for (const completedProposal of completedProposals) {
				proposalsById.set(completedProposal.id, {
					...completedProposal,
					origin: "completed",
				});
			}
		}

		// Merge proposals from other local branches
		for (const branchProposal of localBranchProposals) {
			if (abortSignal?.aborted) {
				throw new Error("Loading cancelled");
			}

			const existing = proposalsById.get(branchProposal.id);
			if (!existing) {
				proposalsById.set(branchProposal.id, branchProposal);
			} else {
				const resolved = resolveProposalConflict(
					existing,
					branchProposal,
					statuses,
					resolutionStrategy,
				);
				proposalsById.set(branchProposal.id, resolved);
			}
		}

		// Merge remote proposals with local proposals
		for (const remoteProposal of remoteProposals) {
			// Check for cancellation during merge
			if (abortSignal?.aborted) {
				throw new Error("Loading cancelled");
			}

			const existing = proposalsById.get(remoteProposal.id);
			if (!existing) {
				proposalsById.set(remoteProposal.id, remoteProposal);
			} else {
				const resolved = resolveProposalConflict(
					existing,
					remoteProposal,
					statuses,
					resolutionStrategy,
				);
				proposalsById.set(remoteProposal.id, resolved);
			}
		}

		// Check for cancellation before cross-branch checking
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		// Get the latest directory location of each proposal across all branches
		const proposals = Array.from(proposalsById.values());

		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		let filteredProposals: Proposal[];

		if (config?.checkActiveBranches === false) {
			filteredProposals = proposals;
		} else {
			progressCallback?.(
				"Applying latest proposal proposals from branch scans...",
			);
			if (!includeCompleted) {
				filteredProposals = filterProposalsByProposalSnapshots(
					proposals,
					buildLatestProposalMap(
						branchProposalEntries || [],
						localProposals,
						archivedProposals,
					),
				);
			} else {
				const proposalEntries = branchProposalEntries || [];
				for (const completedProposal of completedProposals) {
					if (!completedProposal.id) continue;
					const lastModified = completedProposal.updatedDate
						? new Date(completedProposal.updatedDate)
						: new Date(0);
					proposalEntries.push({
						id: completedProposal.id,
						type: "completed",
						branch: "local",
						path: "",
						lastModified,
					});
				}

				const latestProposal = buildLatestProposalMap(
					proposalEntries,
					localProposals,
					archivedProposals,
				);
				const completedIds = new Set<string>();
				for (const [id, entry] of latestProposal) {
					if (entry.type === "completed") {
						completedIds.add(id);
					}
				}

				filteredProposals = proposals
					.filter((proposal) => {
						const latest = latestProposal.get(proposal.id);
						if (!latest) return true;
						return latest.type === "proposal" || latest.type === "completed";
					})
					.map((proposal) => {
						if (!completedIds.has(proposal.id)) {
							return proposal;
						}
						return { ...proposal, origin: "completed" };
					});
			}
		}

		return filteredProposals;
	}

	/**
	 * Resolve the shared messages directory (handles worktrees)
	 */
	async getMessagesDir(): Promise<string> {
		let sharedRoadmapDir = join(this.filesystem.rootDir, "roadmap");
		try {
			const { execSync } = await import("node:child_process");
			const gitRoot = execSync("git rev-parse --show-toplevel", {
				cwd: this.filesystem.rootDir,
				encoding: "utf-8",
				stdio: "pipe",
			}).trim();
			if (gitRoot) sharedRoadmapDir = join(gitRoot, "roadmap");
		} catch {
			// Fallback to local project root
		}
		const messagesDir = join(sharedRoadmapDir, "messages");
		if (!fs.existsSync(messagesDir))
			fs.mkdirSync(messagesDir, { recursive: true });
		return messagesDir;
	}

	/**
	 * List available message channels
	 */
	async listChannels(): Promise<
		{ name: string; fileName: string; type: "group" | "private" | "public" }[]
	> {
		const messagesDir = await this.getMessagesDir();
		if (!fs.existsSync(messagesDir)) return [];
		const files: string[] = fs
			.readdirSync(messagesDir)
			.filter((f: string) => f.endsWith(".md"));
		return files.map((fileName: string) => {
			if (fileName === "PUBLIC.md")
				return { name: "public", fileName, type: "public" as const };
			if (fileName.startsWith("private-")) {
				const name = fileName.replace("private-", "").replace(".md", "");
				return { name, fileName, type: "private" as const };
			}
			const name = fileName.replace("group-", "").replace(".md", "");
			return { name, fileName, type: "group" as const };
		});
	}

	/**
	 * Read messages from a channel, optionally filtered by a since timestamp (ISO string)
	 */
	async readMessages(params: { channel: string; since?: string }): Promise<{
		channel: string;
		messages: {
			timestamp: string;
			from: string;
			text: string;
			mentions: string[];
		}[];
	}> {
		const { channel, since } = params;
		const messagesDir = await this.getMessagesDir();

		let fileName: string;
		if (channel === "public") {
			fileName = "PUBLIC.md";
		} else if (channel.startsWith("private-")) {
			fileName = `${channel}.md`;
		} else {
			fileName = `group-${channel.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`;
		}

		const filePath = join(messagesDir, fileName);
		if (!fs.existsSync(filePath)) {
			return { channel, messages: [] };
		}

		const raw: string = fs.readFileSync(filePath, "utf-8");
		const sinceDate = since ? new Date(since) : null;

		const messages: {
			timestamp: string;
			from: string;
			text: string;
			mentions: string[];
		}[] = [];
		for (const line of raw.split("\n")) {
			const parsed = Core.parseLine(line);
			if (!parsed) continue;
			if (sinceDate && new Date(parsed.timestamp) <= sinceDate) continue;
			messages.push(parsed);
		}

		return { channel, messages };
	}

	/**
	 * Resolve the file path for a channel name
	 */
	async resolveChannelFile(channel: string): Promise<string> {
		const messagesDir = await this.getMessagesDir();
		if (channel === "public") return join(messagesDir, "PUBLIC.md");
		if (channel.startsWith("private-"))
			return join(messagesDir, `${channel}.md`);
		return join(
			messagesDir,
			`group-${channel.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`,
		);
	}

	private static readonly MULTILINE_MESSAGE_PREFIX = "__roadmap_msg_b64__:";

	private static decodeStoredMessageText(text: string): string {
		if (!text.startsWith(Core.MULTILINE_MESSAGE_PREFIX)) {
			return text;
		}

		try {
			return Buffer.from(
				text.slice(Core.MULTILINE_MESSAGE_PREFIX.length),
				"base64",
			).toString("utf-8");
		} catch {
			return text;
		}
	}

	private static encodeStoredMessageText(text: string): string {
		const normalized = text.replace(/\r\n?/g, "\n");
		if (!normalized.includes("\n")) {
			return normalized;
		}
		return `${Core.MULTILINE_MESSAGE_PREFIX}${Buffer.from(normalized, "utf-8").toString("base64")}`;
	}

	/**
	 * Parse a single log line into a structured message (or null if not a message line)
	 */
	static parseLine(line: string): {
		timestamp: string;
		from: string;
		text: string;
		mentions: string[];
	} | null {
		const match = line.match(
			/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ([^:]+): (.+)$/,
		);
		if (!match) return null;
		const text = Core.decodeStoredMessageText(match[3] as string);
		const mentions = [...text.matchAll(/@([a-zA-Z0-9_-]+)/g)]
			.map((match) => match[1]?.toLowerCase())
			.filter((mention): mention is string => Boolean(mention));
		return {
			timestamp: match[1] as string,
			from: match[2] as string,
			text,
			mentions,
		};
	}

	/**
	 * Watch a channel for new messages. Calls `onMessage` for each new message.
	 * Returns an unsubscribe function to stop watching.
	 *
	 * Optionally replays messages after `since` timestamp before starting the live watch.
	 */
	async watchMessages(params: {
		channel: string;
		identity?: string;
		mention?: string;
		since?: string;
		onMessage: (msg: {
			timestamp: string;
			from: string;
			text: string;
			mentions: string[];
			channel: string;
		}) => void;
	}): Promise<() => void> {
		const { channel, identity, mention, since, onMessage } = params;
		const filePath = await this.resolveChannelFile(channel);
		const mentionLower = mention?.toLowerCase();

		const shouldEmit = (parsed: { from: string; mentions: string[] }) => {
			if (identity && parsed.from.toLowerCase() === identity.toLowerCase())
				return false;
			if (mentionLower && !parsed.mentions.includes(mentionLower)) return false;
			return true;
		};

		// Track character offset to detect new appended content
		let knownLength = 0;
		if (fs.existsSync(filePath)) {
			const existing: string = fs.readFileSync(filePath, "utf-8");
			knownLength = existing.length;
			const sinceDate = since ? new Date(since) : null;

			if (since) {
				for (const line of existing.split("\n")) {
					const parsed = Core.parseLine(line);
					if (!parsed) continue;
					if (sinceDate && new Date(parsed.timestamp) <= sinceDate) continue;
					if (!shouldEmit(parsed)) continue;
					onMessage({ ...parsed, channel });
				}
			}
		}

		// Watch for file changes and emit new content beyond known offset
		let debounce: ReturnType<typeof setTimeout> | null = null;
		const watcher = fs.watch(filePath, { persistent: true }, () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				try {
					const content: string = fs.readFileSync(filePath, "utf-8");
					if (content.length <= knownLength) return;

					const newContent = content.slice(knownLength);
					for (const line of newContent.split("\n")) {
						const parsed = Core.parseLine(line);
						if (!parsed) continue;
						if (!shouldEmit(parsed)) continue;
						onMessage({ ...parsed, channel });
					}
					knownLength = content.length;
				} catch {
					// File may have been deleted/moved; ignore
				}
			}, 50);
		});

		return () => {
			watcher.close();
			if (debounce) clearTimeout(debounce);
		};
	}

	/**
	 * Get a list of all known users (agents and humans) in the project
	 */
	async getKnownUsers(): Promise<string[]> {
		const users = new Set<string>();

		// 1. From worktrees
		const worktreesDir = join(this.filesystem.rootDir, "worktrees");
		if (fs.existsSync(worktreesDir)) {
			try {
				const dirs = fs.readdirSync(worktreesDir);
				for (const dir of dirs) {
					if (fs.statSync(join(worktreesDir, dir)).isDirectory()) {
						users.add(dir);
					}
				}
			} catch (_e) {
				// Ignore
			}
		}

		// 2. From proposals (assignees)
		try {
			const proposals = await this.queryProposals();
			for (const proposal of proposals) {
				if (proposal.assignee) {
					for (const a of proposal.assignee) {
						users.add(a.replace("@", ""));
					}
				}
			}
		} catch (_e) {
			// Ignore
		}

		// 3. From message history
		try {
			const messagesDir = await this.getMessagesDir();
			if (fs.existsSync(messagesDir)) {
				const files = fs.readdirSync(messagesDir);
				for (const file of files) {
					if (file.endsWith(".md")) {
						const content = fs.readFileSync(join(messagesDir, file), "utf-8");
						const lines = content.split("\n");
						for (const line of lines) {
							const parsed = Core.parseLine(line);
							if (parsed) {
								users.add(parsed.from);
							}
						}
					}
				}
			}
		} catch (_e) {
			// Ignore
		}

		return Array.from(users).sort();
	}

	/**
	 * Format a message for pretty display (Discord-style)
	 */
	static formatMessagePretty(
		msg: { timestamp: string; from: string; text: string; mentions: string[] },
		options: { color?: boolean; markdown?: boolean } = {},
	): string {
		const { timestamp, from, text, mentions } = msg;
		const { color = true, markdown = false } = options;

		const date = new Date(timestamp.replace(" ", "T"));
		const now = new Date();
		const isToday = date.toDateString() === now.toDateString();
		const yesterday = new Date(now);
		yesterday.setDate(now.getDate() - 1);
		const isYesterday = date.toDateString() === yesterday.toDateString();

		const timeStr = date.toLocaleTimeString([], {
			hour: "numeric",
			minute: "2-digit",
		});
		let dateStr = "";
		if (isToday) dateStr = "Today";
		else if (isYesterday) dateStr = "Yesterday";
		else dateStr = date.toLocaleDateString();

		const fullTimestamp = `${dateStr} at ${timeStr}`;

		// ANSI colors
		const cyan = (s: string) => (color ? `\x1b[1;36m${s}\x1b[0m` : s);
		const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
		const gray = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
		let header = "";
		if (markdown) {
			header = `**${from}** — ${fullTimestamp}`;
		} else {
			header = `${cyan(from)} ${gray(`— ${fullTimestamp}`)}`;
		}

		let body = text;
		// Highlight mentions
		for (const mention of mentions) {
			const regex = new RegExp(`@${mention}\\b`, "gi");
			if (markdown) {
				body = body.replace(regex, `**@${mention}**`);
			} else {
				body = body.replace(regex, green(`@${mention}`));
			}
		}

		return `${header}\n${body}\n`;
	}

	/**
	 * Find the best ready proposal and claim it atomically.
	 * Returns the claimed proposal and a summary of why it was chosen.
	 */
	async heartbeat(
		proposalId: string,
		agent: string,
		autoCommit?: boolean,
	): Promise<Proposal> {
		if (await this.isPostgresProposalBackend()) {
			return await this.renewClaim(proposalId, agent, {
				durationMinutes: DEFAULT_CLAIM_DURATION_MINUTES,
				autoCommit,
			});
		}

		const proposal = await this.fs.loadProposal(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

		if (!proposal.claim) {
			throw new Error(
				`Proposal ${proposalId} has no active claim to heartbeat`,
			);
		}

		if (proposal.claim.agent !== agent) {
			throw new Error(
				`Proposal ${proposalId} claim is held by ${proposal.claim.agent}, not ${agent}`,
			);
		}

		const now = new Date();
		const claim: ProposalClaim = {
			...proposal.claim,
			lastHeartbeat: formatLocalDateTime(now),
		};

		return await this.updateProposalFromInput(
			proposalId,
			{ claim },
			autoCommit,
		);
	}

	/**
	 * Find the best ready proposal and claim it atomically.
	 * Returns the claimed proposal and a summary of why it was chosen.
	 */
	async pickupProposal(params: {
		agent: string;
		dryRun?: boolean;
		durationMinutes?: number;
	}): Promise<{ proposal: Proposal; explanation: string } | null> {
		if (await this.isPostgresProposalBackend()) {
			const readyProposals = (
				await this.queryProposals({
					filters: { ready: true },
					includeCrossBranch: false,
				})
			).filter(
				(proposal) =>
					!proposal.external_injections ||
					proposal.external_injections.length === 0,
			);

			if (readyProposals.length === 0) {
				return null;
			}

			const bestProposal = readyProposals[0];
			if (!bestProposal) {
				return null;
			}

			const queue = await pg.getProposalQueue();
			const queueItem = queue.find(
				(item) => item.display_id === bestProposal.id,
			);
			const explanation = `Chosen ${bestProposal.id} ("${bestProposal.title}") from the Postgres queue${queueItem ? ` at queue position ${queueItem.queue_position}` : ""}.`;

			if (params.dryRun) {
				return { proposal: bestProposal, explanation };
			}

			const claimedProposal = await this.claimProposal(
				bestProposal.id,
				params.agent,
				{
					durationMinutes: params.durationMinutes,
				},
			);
			return {
				proposal: claimedProposal,
				explanation,
			};
		}

		return await FileLock.withLock(
			this.fs.rootDir,
			"coordination",
			async () => {
				const { agent, dryRun, durationMinutes } = params;

				// 1. Get all ready proposals
				let readyProposals = (
					await this.queryProposals({
						filters: { ready: true },
						includeCrossBranch: false,
					})
				).filter(
					(proposal) =>
						!proposal.external_injections ||
						proposal.external_injections.length === 0,
				);
				// Consider only proposals that have a file on disk (filesystem-backed) for claim operations.
				readyProposals = readyProposals.filter((p) => !!p.filePath);

				if (readyProposals.length === 0) {
					return null;
				}

				// 2. Sort by priority (High > Medium > Low) and then by ID
				const priorityMap = { high: 0, medium: 1, low: 2 };
				const sorted = readyProposals.sort((a, b) => {
					const pA = priorityMap[a.priority || "low"];
					const pB = priorityMap[b.priority || "low"];
					if (pA !== pB) return pA - pB;
					return a.id.localeCompare(b.id, undefined, { numeric: true });
				});

				const bestProposal = sorted[0];
				if (!bestProposal) {
					return null;
				}
				const explanation = `Chosen ${bestProposal.id} ("${
					bestProposal.title
				}") based on priority '${bestProposal.priority || "low"}' and readiness (unblocked and unassigned).`;

				if (dryRun) {
					return { proposal: bestProposal, explanation };
				}

				// 3. Claim the proposal (calling internal method because we already hold the lock)
				await this.executeClaimProposal(bestProposal.id, agent, {
					durationMinutes,
				});

				// Refresh proposal to include claim metadata
				const claimedProposal = await this.getProposal(bestProposal.id);

				return {
					proposal: claimedProposal || bestProposal,
					explanation,
				};
			},
		);
	}
	/**
	 * Analyze the forward impact of a proposal change.
	 * Returns all downstream proposals that depend on this proposal (recursively).
	 */
	async getImpact(proposalId: string): Promise<Proposal[]> {
		const allProposals = await this.queryProposals({
			includeCrossBranch: false,
		});
		const impact = new Set<string>();
		const queue = [proposalId];

		while (queue.length > 0) {
			const currentId = queue.shift()!;
			const dependents = allProposals.filter((s) =>
				s.dependencies?.includes(currentId),
			);

			for (const dep of dependents) {
				if (!impact.has(dep.id)) {
					impact.add(dep.id);
					queue.push(dep.id);
				}
			}
		}

		return allProposals.filter((s) => impact.has(s.id));
	}

	/**
	 * Scans for stale leases based on heartbeats and automatically reclaims them.
	 */
	async checkLeaseHealth(options?: {
		timeoutMinutes?: number;
		autoCommit?: boolean;
	}): Promise<string[]> {
		const recoveredIds = await this.pruneClaims(options);
		return recoveredIds;
	}

	/**
	 * Get the path to the agents registry file
	 */
	async getAgentsFilePath(): Promise<string> {
		return join(this.fs.rootDir, DEFAULT_DIRECTORIES.ROADMAP, "agents.yml");
	}

	/**
	 * Register or update an agent in the registry
	 */
	async registerAgent(
		agent: Omit<Agent, "lastSeen" | "trustScore">,
	): Promise<Agent> {
		const agentsPath = await this.getAgentsFilePath();
		let agents: Agent[] = [];

		try {
			const content = await fs.promises.readFile(agentsPath, "utf-8");
			agents = JSON.parse(content) as Agent[];
		} catch {
			// File doesn't exist yet
		}

		const now = new Date().toISOString();
		const existingIndex = agents.findIndex((a) => a.name === agent.name);

		const updatedAgent: Agent = {
			name: agent.name,
			identity: agent.identity,
			capabilities: agent.capabilities || [],
			trustScore: existingIndex >= 0 ? agents[existingIndex]?.trustScore : 100, // Default trust
			lastSeen: now,
			status: agent.status || "idle",
			availability: agent.availability,
			costClass: agent.costClass,
		};

		if (existingIndex >= 0) {
			agents[existingIndex] = updatedAgent;
		} else {
			agents.push(updatedAgent);
		}

		await fs.promises.writeFile(agentsPath, JSON.stringify(agents, null, 2));
		return updatedAgent;
	}

	/**
	 * Attempt to load an agent profile from a workspace (worktree) directory
	 */
	async getAgentProfileFromWorkspace(
		agentName: string,
	): Promise<Partial<Agent> | null> {
		const worktreeDir = join(this.fs.rootDir, "worktrees", agentName);
		const profilePath = join(worktreeDir, "roadmap-agent.json");

		try {
			if (fs.existsSync(profilePath)) {
				const content = await fs.promises.readFile(profilePath, "utf-8");
				const profile = JSON.parse(content);
				return {
					name: agentName,
					identity: profile.identity,
					capabilities: profile.capabilities,
					costClass: profile.costClass,
					availability: profile.availability || profile.status,
				};
			}
		} catch (error) {
			if (process.env.DEBUG) {
				console.warn(
					`Failed to load agent profile from ${profilePath}:`,
					error,
				);
			}
		}
		return null;
	}

	/**
	 * List all registered agents, merging with any discovered in worktrees
	 */
	async listAgents(): Promise<Agent[]> {
		const agentsPath = await this.getAgentsFilePath();
		let registeredAgents: Agent[] = [];
		try {
			const content = await fs.promises.readFile(agentsPath, "utf-8");
			registeredAgents = JSON.parse(content) as Agent[];
		} catch {
			// File doesn't exist yet
		}

		// Also scan worktrees for un-registered or updated profiles
		const worktreesDir = join(this.fs.rootDir, "worktrees");
		if (fs.existsSync(worktreesDir)) {
			try {
				const dirs = await fs.promises.readdir(worktreesDir);
				for (const dir of dirs) {
					if ((await fs.promises.stat(join(worktreesDir, dir))).isDirectory()) {
						const workspaceProfile =
							await this.getAgentProfileFromWorkspace(dir);
						if (workspaceProfile) {
							const existingIndex = registeredAgents.findIndex(
								(a) => a.name === dir || a.name === `@${dir}`,
							);
							if (existingIndex >= 0) {
								// Merge workspace profile into registered agent (workspace takes precedence for dynamic fields)
								registeredAgents[existingIndex] = {
									...registeredAgents[existingIndex],
									...workspaceProfile,
									name: registeredAgents[existingIndex]?.name, // Keep registered name
								} as Agent;
							} else {
								// Add as a new discovered agent
								registeredAgents.push({
									name: dir,
									capabilities: workspaceProfile.capabilities || [],
									status:
										workspaceProfile.status ||
										workspaceProfile.availability ||
										"idle",
									availability: workspaceProfile.availability,
									costClass: workspaceProfile.costClass,
									trustScore: 100,
									lastSeen: new Date().toISOString(),
									...workspaceProfile,
								} as Agent);
							}
						}
					}
				}
			} catch (error) {
				if (process.env.DEBUG) {
					console.warn("Failed to scan worktrees for agent profiles:", error);
				}
			}
		}

		// Attach current claims to agents — use preloaded proposals when
		// available (set by buildSnapshot) to avoid deadlock from re-loading
		// all proposals in parallel with loadProposals().
		let allProposals = this._preloadedProposalsForAgents;
		if (allProposals) {
			this._preloadedProposalsForAgents = undefined;
		} else {
			allProposals = await this.fs.listProposals();
		}
		for (const agent of registeredAgents) {
			const agentNameLower = agent.name.toLowerCase();
			const agentNameNoAtLower = agentNameLower.startsWith("@")
				? agentNameLower.slice(1)
				: agentNameLower;

			agent.claims = allProposals.filter((proposal) => {
				const assignees = proposal.assignee?.map((a) => a.toLowerCase()) || [];
				return assignees.some(
					(a) =>
						a === agentNameLower ||
						a === agentNameNoAtLower ||
						(a.startsWith("@") && a.slice(1) === agentNameNoAtLower),
				);
			});
		}

		return registeredAgents;
	}

	/**
	 * List all recorded project change events from the pulse log
	 */
	async listPulse(limit = 100): Promise<PulseEvent[]> {
		const logPath = await this.getPulseLogPath();
		if (!fs.existsSync(logPath)) {
			return [];
		}

		try {
			const content = await fs.promises.readFile(logPath, "utf-8");
			const lines = content.trim().split("\n");
			const events: PulseEvent[] = [];

			// Parse events from the end (most recent first)
			for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
				const line = lines[i]?.trim();
				if (line) {
					try {
						events.push(JSON.parse(line) as PulseEvent);
					} catch {
						// Skip malformed lines
					}
				}
			}

			return events;
		} catch (error) {
			console.error("Failed to read pulse log:", error);
			return [];
		}
	}

	/**
	 * Get the path to the pulse log file
	 */
	async getPulseLogPath(): Promise<string> {
		return join(this.fs.rootDir, DEFAULT_DIRECTORIES.ROADMAP, "pulse.log");
	}

	/**
	 * Record a project change event to the pulse log
	 */
	async recordPulse(params: {
		type: PulseType;
		id: string;
		title: string;
		impact?: string;
		agent?: string;
	}): Promise<void> {
		const { type, id, title, impact } = params;
		let agent = params.agent;

		if (!agent) {
			try {
				const nameResult = execSync("git config user.name", {
					cwd: this.fs.rootDir,
					encoding: "utf-8",
					stdio: "pipe",
				});
				agent = nameResult.trim() || "agent";
			} catch {
				agent = "agent";
			}
		}

		const event: PulseEvent = {
			type,
			id,
			title,
			agent,
			impact,
			timestamp: new Date().toISOString(),
		};

		const logPath = await this.getPulseLogPath();
		const entry = `${JSON.stringify(event)}\n`;

		// Append to JSONL log
		await fs.promises.appendFile(logPath, entry);

		// Also broadcast to #pulse group channel
		const message = `**[${type.replace("_", " ")}]** ${id} - ${title}${impact ? `\n> ${impact}` : ""}`;
		await this.sendMessage({
			from: "System",
			message,
			type: "group",
			group: "pulse",
		});
	}

	/**
	 * Get proposals related to a given proposal (neighborhood) for pulse filtering
	 */
	async getPulseNeighborhood(proposalId: string): Promise<Set<string>> {
		const neighborhood = new Set<string>([proposalId]);
		const proposal = await this.getProposal(proposalId);
		if (!proposal) return neighborhood;

		if (proposal.parentProposalId) {
			neighborhood.add(proposal.parentProposalId);
		}

		if (proposal.subproposals) {
			for (const sub of proposal.subproposals) {
				neighborhood.add(sub);
			}
		}

		return neighborhood;
	}

	/**
	 * Send a message to a communication channel
	 */
	async sendMessage(params: {
		from: string;
		message: string;
		type: "public" | "group" | "private";
		to?: string;
		group?: string;
	}): Promise<string> {
		const { from, message, type, to, group } = params;
		const messagesDir = await this.getMessagesDir();

		let fileName = "PUBLIC.md";
		let channelName = "Public Announcement";

		if (type === "group" && group) {
			fileName = `group-${group.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`;
			channelName = `Group Chat: #${group}`;
		} else if (type === "private" && to) {
			const fromName = from.replace("@", "").toLowerCase();
			const toName = to.replace("@", "").toLowerCase();
			const agents = [fromName, toName].sort();
			fileName = `private-${agents[0]}-${agents[1]}.md`;
			channelName = `Private DM: ${from} <-> ${to}`;
		}

		const filePath = join(messagesDir, fileName);
		const timestamp = formatLocalDateTime(new Date(), true);
		const normalizedMessage = message.replace(/\r\n?/g, "\n");
		const encodedMessage = Core.encodeStoredMessageText(normalizedMessage);
		const logEntry = `[${timestamp}] ${from}: ${encodedMessage}\n`;

		// Check if file exists, if not add header
		let content = "";
		if (fs.existsSync(filePath)) {
			content = fs.readFileSync(filePath, "utf-8");
		} else {
			content = `# ${channelName}\n\n`;
		}

		content += logEntry;
		fs.writeFileSync(filePath, content);

		// Commit if auto-commit is enabled
		await this.ensureConfigLoaded();
		const config = await this.fs.loadConfig();
		if (config?.autoCommit) {
			try {
				await this.git.addFile(filePath);
				await this.git.commitChanges(
					`${from} sent a message to ${channelName}`,
					dirname(filePath),
				);
			} catch (_e) {
				// Ignore if commit fails
			}
		}

		// Notify subscribed agents (push notification)
		const channelIdentifier =
			type === "group" && group ? group : type === "public" ? "public" : null;
		if (channelIdentifier) {
			await this.notifySubscribedAgents(
				channelIdentifier,
				from,
				normalizedMessage,
				timestamp,
			);
		}

		return filePath;
	}

	// --- Channel Subscriptions ---

	private getSubscriptionsPath(): string {
		return join(this.fs.rootDir, "roadmap", "local", "subscriptions.json");
	}

	private async ensureSubscriptionsLoaded(): Promise<void> {
		if (this.subscriptionsLoaded) return;
		this.subscriptionsLoaded = true;

		const path = this.getSubscriptionsPath();
		if (!fs.existsSync(path)) return;

		try {
			const content = fs.readFileSync(path, "utf-8");
			const data = JSON.parse(content) as Record<string, string[]>;
			for (const [agent, channels] of Object.entries(data)) {
				this.subscriptions.set(agent, new Set(channels));
			}
		} catch {
			// Ignore corrupt file
		}
	}

	private async saveSubscriptions(): Promise<void> {
		const path = this.getSubscriptionsPath();
		const dir = join(this.fs.rootDir, "roadmap", "local");
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}

		const data: Record<string, string[]> = {};
		for (const [agent, channels] of this.subscriptions) {
			data[agent] = Array.from(channels);
		}
		fs.writeFileSync(path, JSON.stringify(data, null, 2));
	}

	/**
	 * Subscribe an agent to a channel.
	 */
	async subscribeToChannel(agent: string, channel: string): Promise<void> {
		await this.ensureSubscriptionsLoaded();

		let channels = this.subscriptions.get(agent);
		if (!channels) {
			channels = new Set();
			this.subscriptions.set(agent, channels);
		}
		channels.add(channel);
		await this.saveSubscriptions();
	}

	/**
	 * Unsubscribe an agent from a channel.
	 */
	async unsubscribeFromChannel(agent: string, channel: string): Promise<void> {
		await this.ensureSubscriptionsLoaded();

		const channels = this.subscriptions.get(agent);
		if (channels) {
			channels.delete(channel);
			if (channels.size === 0) {
				this.subscriptions.delete(agent);
			}
			await this.saveSubscriptions();
		}
	}

	/**
	 * Get all channel subscriptions for an agent.
	 */
	async getSubscriptions(agent: string): Promise<string[]> {
		await this.ensureSubscriptionsLoaded();
		return Array.from(this.subscriptions.get(agent) ?? []);
	}

	/**
	 * Get all subscribed agents for a channel.
	 */
	async getSubscribedAgents(channel: string): Promise<string[]> {
		await this.ensureSubscriptionsLoaded();
		const agents: string[] = [];
		for (const [agent, channels] of this.subscriptions) {
			if (channels.has(channel)) {
				agents.push(agent);
			}
		}
		return agents;
	}

	/**
	 * Register a callback to receive push notifications when messages arrive on subscribed channels.
	 * Returns an unsubscribe function to stop receiving notifications.
	 */
	registerNotificationCallback(
		agent: string,
		callback: (msg: {
			channel: string;
			from: string;
			text: string;
			timestamp: string;
		}) => void,
	): () => void {
		this.notificationCallbacks.set(agent, callback);
		return () => {
			this.notificationCallbacks.delete(agent);
		};
	}

	/**
	 * Notify subscribed agents when a new message is sent.
	 */
	private async notifySubscribedAgents(
		channel: string,
		from: string,
		text: string,
		timestamp: string,
	): Promise<void> {
		const agents = await this.getSubscribedAgents(channel);
		for (const agent of agents) {
			// Don't notify the sender
			if (agent.toLowerCase() === from.toLowerCase()) continue;

			const callback = this.notificationCallbacks.get(agent);
			if (callback) {
				try {
					callback({ channel, from, text, timestamp });
				} catch (_err) {
					// Ignore callback errors
				}
			}
		}
	}

	/**
	 * Emit a pulse event for real-time monitoring.
	 */
	async emitPulse(event: PulseEvent): Promise<void> {
		const pulsePath = join(this.fs.rootDir, "roadmap", "pulse.log");
		const line = `${JSON.stringify(event)}\n`;
		fs.appendFileSync(pulsePath, line);
	}

	/**
	 * Record a lightweight event in the pulse log.
	 */
	async emitEvent(
		actor: string,
		action: string,
		proposalId?: string,
		payload?: string,
	): Promise<void> {
		if (action !== "proposal_moved") {
			return;
		}
		const pulsePath = join(this.fs.rootDir, "roadmap", "pulse.log");
		const event: PulseEvent = {
			type: "proposal_moved",
			id: proposalId || action,
			title: payload || action,
			agent: actor,
			timestamp: new Date().toISOString(),
			impact: payload,
		};
		fs.appendFileSync(pulsePath, `${JSON.stringify(event)}\n`);
	}

	/**
	 * Promote a proposal to the next status level.
	 */
	async promoteProposal(
		idInput: string,
		agentId = "agent",
		autoCommit?: boolean,
	): Promise<Proposal> {
		const proposal = await this.loadProposalById(idInput);
		if (!proposal) throw new Error(`Proposal ${idInput} not found`);

		const config = await this.fs.loadConfig();
		const statuses = config?.statuses || DEFAULT_STATUSES;
		const currentIndex = statuses.indexOf(proposal.status as any);

		if (currentIndex === -1 || currentIndex === statuses.length - 1) {
			throw new Error(
				`Cannot promote proposal ${proposal.id} from status ${proposal.status}`,
			);
		}

		const newStatus = statuses[currentIndex + 1];
		return await this.updateProposalFromInput(
			proposal.id,
			{ status: newStatus, activityActor: agentId },
			autoCommit,
		);
	}

	/**
	 * Demote a proposal to the previous status level.
	 */
	async demoteProposalProper(
		idInput: string,
		agentId = "agent",
		autoCommit?: boolean,
	): Promise<Proposal> {
		const proposal = await this.loadProposalById(idInput);
		if (!proposal) throw new Error(`Proposal ${idInput} not found`);

		const config = await this.fs.loadConfig();
		const statuses = config?.statuses || DEFAULT_STATUSES;
		const currentIndex = statuses.indexOf(proposal.status as any);

		if (currentIndex <= 0) {
			throw new Error(
				`Cannot demote proposal ${proposal.id} from status ${proposal.status}`,
			);
		}

		const newStatus = statuses[currentIndex - 1];
		return await this.updateProposalFromInput(
			proposal.id,
			{ status: newStatus, activityActor: agentId },
			autoCommit,
		);
	}

	/**
	 * Update proposal priority.
	 */
	async updatePriority(
		idInput: string,
		priority: "high" | "medium" | "low" | "none",
		agentId = "agent",
		autoCommit?: boolean,
	): Promise<Proposal> {
		const proposal = await this.loadProposalById(idInput);
		if (!proposal) throw new Error(`Proposal ${idInput} not found`);
		return await this.updateProposalFromInput(
			proposal.id,
			{ priority: priority as any, activityActor: agentId },
			autoCommit,
		);
	}

	/**
	 * Merge one proposal into another.
	 */
	async mergeProposals(
		sourceInput: string,
		targetInput: string,
		agentId = "agent",
		autoCommit?: boolean,
	): Promise<Proposal> {
		const source = await this.loadProposalById(sourceInput);
		const target = await this.loadProposalById(targetInput);

		if (!source || !target)
			throw new Error("Source or target proposal not found");

		// Append source content to target notes
		const mergedNotes = `${target.implementationNotes || ""}\n\n--- MERGED FROM ${source.id} ---\n${source.description || ""}\n${source.implementationNotes || ""}`;

		const updatedTarget = await this.updateProposalFromInput(
			target.id,
			{
				implementationNotes: mergedNotes,
				activityActor: agentId,
			},
			autoCommit,
		);

		// Archive/Delete source
		await this.fs.archiveProposal(source.id);

		await this.emitPulse({
			type: "proposal_complete", // Using complete as a proxy for 'merged'
			id: target.id,
			title: `Merged ${source.id} into ${target.id}`,
			agent: agentId,
			timestamp: new Date().toISOString(),
		});

		return updatedTarget;
	}

	/**
	 * Move a proposal within its column or to a different column.
	 */
	async moveProposal(
		idInput: string,
		targetStatus: string,
		targetIndex: number,
		agentId = "agent",
		autoCommit?: boolean,
	): Promise<Proposal> {
		const proposal = await this.loadProposalById(idInput);
		if (!proposal) throw new Error(`Proposal ${idInput} not found`);

		if (await this.isPostgresProposalBackend()) {
			if (proposal.status === targetStatus) {
				return proposal;
			}
			const updatedProposal = await this.updateProposalFromInput(
				proposal.id,
				{ status: targetStatus, activityActor: agentId },
				autoCommit,
			);
			await this.emitEvent(
				agentId,
				"proposal_moved",
				proposal.id,
				`Moved to ${targetStatus} (queue ordering is database-derived)`,
			);
			return updatedProposal;
		}

		const proposals = await this.queryProposals({ status: targetStatus });
		const orderedIds = proposals.map((s) => s.id);

		// Insert at target index
		const existingIdx = orderedIds.indexOf(proposal.id);
		if (existingIdx !== -1) orderedIds.splice(existingIdx, 1);
		orderedIds.splice(targetIndex, 0, proposal.id);

		const result = await this.reorderProposal({
			proposalId: proposal.id,
			targetStatus,
			orderedProposalIds: orderedIds,
			autoCommit,
		});

		await this.emitEvent(
			agentId,
			"proposal_moved",
			proposal.id,
			`Moved to ${targetStatus} at index ${targetIndex}`,
		);

		return result.updatedProposal;
	}
}
