export type ProposalStatus = string;

/**
 * Entity types in the roadmap system.
 * Used for ID generation and prefix resolution.
 */
export const EntityType = {
	Proposal: "proposal",
	Draft: "draft",
	Document: "document",
	Decision: "decision",
} as const;

export type EntityType = (typeof EntityType)[keyof typeof EntityType];

// Structured Acceptance Criterion (domain-level)
export interface AcceptanceCriterion {
	index: number; // 1-based
	text: string;
	checked: boolean;
	role?: string; // e.g. "builder", "peer-tester"
	evidence?: string; // e.g. "CLI output", "unit test"
}

export interface ProposalClaim {
	agent: string;
	created: string;
	expires: string;
	lastHeartbeat?: string;
	heartbeatIntervalMs?: number;
	message?: string;
}

export interface ActivityLogEntry {
	timestamp: string;
	actor: string;
	action: string;
	reason?: string;
}

export type ProofType = "link" | "test" | "commit" | "artifact" | "observation";

export interface ProofItem {
	type: ProofType;
	value: string;
	summary?: string;
}

export interface ProofItemInput {
	type?: ProofType | string;
	value: string;
	summary?: string;
}

export interface AcceptanceCriterionInput {
	text: string;
	checked?: boolean;
	role?: string;
	evidence?: string;
}

export interface Proposal {
	id: string;
	title: string;
	status: ProposalStatus;
	assignee: string[];
	reporter?: string;
	createdDate: string;
	updatedDate?: string;
	labels: string[];
	directive?: string;
	dependencies: string[];
	references?: string[];
	documentation?: string[];
	readonly rawContent?: string; // Raw markdown content without frontmatter (read-only: do not modify directly)
	summary?: string;
	motivation?: string;
	design?: string;
	drawbacks?: string;
	alternatives?: string;
	dependency_note?: string;
	description?: string;
	implementationPlan?: string;
	implementationNotes?: string;
	auditNotes?: string;
	finalSummary?: string;
	/** Verifiable evidence of arrival (URIs, commit hashes, test logs) */
	proof?: string[];
	/** Structured proof items parsed from body */
	proofItems?: ProofItem[];
	/** Synthesis of sub-roadmap progress and insights (populated by agents) */
	scopeSummary?: string;
	/** Structured acceptance criteria parsed from body (checked proposal + text + index) */
	acceptanceCriteriaItems?: AcceptanceCriterion[];
	/** Structured Verification Proposalments (Executable Assertions) checklist parsed from body */
	verificationProposalments?: AcceptanceCriterion[];
	parentProposalId?: string;
	parentProposalTitle?: string;
	subproposals?: string[];
	/** Depth level in the hierarchy (0 = top level) */
	depth?: number;
	type?: "terminal" | "transitional" | "operational" | "spike" | "incident";
	hype?: string;
	ready?: boolean;
	subproposalSummaries?: Array<{ id: string; title: string }>;
	/** Agent capabilities required to work on this proposal */
	needs_capabilities?: string[];
	required_capabilities?: string[];
	domainId?: string;
	proposalType?: string;
	category?: string;
	/** External resources or injections required (e.g. 3rd party approval) */
	external_injections?: string[];
	/** Capabilities this proposal unlocks for the product */
	unlocks?: string[];
	/** Activity log recording proposal transitions */
	activityLog?: ActivityLogEntry[];
	/** @deprecated Use needs_capabilities, external_injections, or unlocks instead */
	requires?: string[];
	/** Level of completeness/validation */
	maturity?: ProposalMaturity;
	/** The agent primarily responsible for implementation */
	builder?: string;
	/** The agent responsible for peer review and audit */
	auditor?: string;
	priority?: "high" | "medium" | "low";
	branch?: string;
	ordinal?: number;
	filePath?: string;
	claim?: ProposalClaim;
	/** The rationale or nature of the proposal (e.g. 'external' constraint, 'decision' consequence) */
	rationale?: string;
	// Metadata fields
	lastModified?: Date;
	/** Data provenance indicator (where the proposal was loaded from) */
	origin?: "local" | "remote" | "completed" | "local-branch";
	/** Source identifier for debug tracking (e.g. branch name, file path) */
	source?: string;
	/** Optional per-proposal callback command to run on status change (overrides global config) */
	onStatusChange?: string;
	/** Budget limit in USD for this proposal */
	budgetLimitUsd?: number;
	/**
	 * Live activity snapshot from roadmap.v_proposal_activity (P272).
	 * Populated only when the backend is Postgres and the view returns a row.
	 * All fields are optional — absent means no active lease / dispatch / heartbeat.
	 */
	liveActivity?: {
		/** Active lease holder (preferred "currently working" indicator) */
		leaseHolder?: string;
		/** Fallback: agent dispatched by the gate when no lease is held */
		gateDispatchAgent?: string;
		/** Gate dispatch role (e.g. reviewer/gater), when applicable */
		gateDispatchRole?: string;
		/** Dispatch status (assigned | active) */
		gateDispatchStatus?: string;
		/** Cubic the current worker is executing in (agent_health.current_cubic) */
		activeCubic?: string;
		/** Model the current worker is using (agent_health.active_model) */
		activeModel?: string;
		/** Seconds since the current worker's last heartbeat */
		heartbeatAgeSeconds?: number;
		/** Most recent proposal_event type (e.g. lease_claimed, stage_transition) */
		lastEventType?: string;
	};
}

export type ProposalMaturity =
	| "new"
	| "active"
	| "mature"
	| "obsolete"
	| "skeleton"
	| "contracted"
	| "audited";

export type PulseType =
	| "proposal_created"
	| "proposal_complete"
	| "proposal_moved"
	| "decision_made"
	| "obstacle_discovered"
	| "scope_aggregated"
	| "proposal_claimed"
	| "tool_called";

export interface PulseEvent {
	type: PulseType;
	id: string;
	title: string;
	agent: string;
	timestamp: string;
	impact?: string;
}

export type AgentStatus = "active" | "idle" | "offline";

export interface Agent {
	name: string;
	identity?: string; // Email, GitHub handle, or unique URI
	capabilities: string[];
	trustScore: number;
	lastSeen: string;
	status: AgentStatus;
	costClass?: "low" | "medium" | "high";
	availability?: AgentStatus;
	claims?: Proposal[];
}

export interface DirectiveBucket {
	key: string;
	label: string;
	directive?: string;
	isNoDirective: boolean;
	isCompleted: boolean;
	proposals: Proposal[];
	statusCounts: Record<string, number>;
	total: number;
	doneCount: number;
	progress: number;
}

export interface DirectiveSummary {
	directives: string[];
	buckets: DirectiveBucket[];
}

/**
 * Check if a proposal is locally editable (not from a remote or other local branch)
 */
export function isLocalEditableProposal(proposal: Proposal): boolean {
	return (
		proposal.origin === undefined ||
		proposal.origin === "local" ||
		proposal.origin === "completed"
	);
}

export interface ProposalCreateInput {
	title: string;
	description?: string;
	status?: ProposalStatus;
	maturity?: ProposalMaturity;
	priority?: "high" | "medium" | "low";
	directive?: string;
	domainId?: string;
	proposalType?: string;
	category?: string;
	labels?: string[];
	assignee?: string[];
	builder?: string;
	auditor?: string;
	dependencies?: string[];
	references?: string[];
	documentation?: string[];
	needs_capabilities?: string[];
	external_injections?: string[];
	unlocks?: string[];
	parentProposalId?: string;
	summary?: string;
	motivation?: string;
	design?: string;
	drawbacks?: string;
	alternatives?: string;
	dependency_note?: string;
	implementationPlan?: string;
	implementationNotes?: string;
	auditNotes?: string;
	finalSummary?: string;
	scopeSummary?: string;
	proof?: string[];
	acceptanceCriteria?: AcceptanceCriterionInput[];
	verificationProposalmentsAdd?: string[];
	claim?: ProposalClaim;
	rationale?: string;
	rawContent?: string;
}

export interface ProposalUpdateInput {
	title?: string;
	description?: string;
	status?: ProposalStatus;
	maturity?: ProposalMaturity;
	/** Actor to use in activity log */
	activityActor?: string;
	priority?: "high" | "medium" | "low";
	directive?: string | null;
	domainId?: string;
	proposalType?: string;
	category?: string;
	parentProposalId?: string | null;
	labels?: string[];
	addLabels?: string[];
	removeLabels?: string[];
	assignee?: string[];
	builder?: string;
	auditor?: string;
	ordinal?: number;
	dependencies?: string[];
	addDependencies?: string[];
	removeDependencies?: string[];
	references?: string[];
	addReferences?: string[];
	removeReferences?: string[];
	documentation?: string[];
	addDocumentation?: string[];
	removeDocumentation?: string[];
	needs_capabilities?: string[];
	required_capabilities?: string[];
	addNeedsCapabilities?: string[];
	removeNeedsCapabilities?: number[];
	external_injections?: string[];
	addExternalInjections?: string[];
	removeExternalInjections?: number[];
	unlocks?: string[];
	addUnlocks?: string[];
	removeUnlocks?: number[];
	summary?: string;
	motivation?: string;
	design?: string;
	drawbacks?: string;
	alternatives?: string;
	dependency_note?: string;
	implementationPlan?: string;
	appendImplementationPlan?: string[];
	clearImplementationPlan?: boolean;
	implementationNotes?: string;
	appendImplementationNotes?: string[];
	clearImplementationNotes?: boolean;
	finalSummary?: string;
	appendFinalSummary?: string[];
	clearFinalSummary?: boolean;
	scopeSummary?: string;
	proof?: string[];
	proofItems?: ProofItemInput[];
	addProof?: string[];
	addProofItems?: ProofItemInput[];
	removeProof?: number[];
	acceptanceCriteria?: AcceptanceCriterionInput[];
	verificationProposalments?: AcceptanceCriterionInput[];
	addAcceptanceCriteria?: Array<AcceptanceCriterionInput | string>;
	removeAcceptanceCriteria?: number[];
	checkAcceptanceCriteria?: number[];
	uncheckAcceptanceCriteria?: number[];
	addVerificationProposalments?: Array<AcceptanceCriterionInput | string>;
	removeVerificationProposalments?: number[];
	checkVerificationProposalments?: number[];
	uncheckVerificationProposalments?: number[];
	requires?: string[];
	addRequires?: string[];
	removeRequires?: number[];
	clearRequires?: boolean;
	claim?: ProposalClaim | null;
	rationale?: string;
	rawContent?: string;
	auditNotes?: string;
	appendAuditNotes?: string[];
	clearAuditNotes?: boolean;
}

export interface ProposalListFilter {
	status?: string;
	maturity?: ProposalMaturity;
	assignee?: string;
	priority?: "high" | "medium" | "low";
	directive?: string;
	parentProposalId?: string;
	labels?: string[];
	rationale?: string;
	depth?: number;
	/** Filter for proposals that are ready for pickup (unblocked and unassigned) */
	ready?: boolean;
}

export interface Decision {
	id: string;
	title: string;
	date: string;
	status: "proposed" | "accepted" | "rejected" | "superseded";
	context: string;
	decision: string;
	consequences: string;
	alternatives?: string;
	readonly rawContent: string; // Raw markdown content without frontmatter
}

export interface Directive {
	id: string;
	title: string;
	description: string;
	readonly rawContent: string; // Raw markdown content without frontmatter
}

export interface Document {
	id: string;
	title: string;
	type: "readme" | "guide" | "specification" | "other";
	createdDate: string;
	updatedDate?: string;
	rawContent: string; // Raw markdown content without frontmatter
	tags?: string[];
	// Web UI specific fields
	name?: string;
	path?: string;
	relativeFilePath?: string;
	lastModified?: string;
}

export type SearchResultType = "proposal" | "document" | "decision";

export type SearchPriorityFilter = "high" | "medium" | "low";

export interface SearchMatch {
	key?: string;
	indices: Array<[number, number]>;
	value?: unknown;
}

export interface SearchFilters {
	status?: string | string[];
	priority?: SearchPriorityFilter | SearchPriorityFilter[];
	assignee?: string | string[];
	labels?: string | string[];
}

export interface SearchOptions {
	query?: string;
	limit?: number;
	types?: SearchResultType[];
	filters?: SearchFilters;
}

export interface ProposalSearchResult {
	type: "proposal";
	score: number | null;
	proposal: Proposal;
	matches?: SearchMatch[];
}

export interface DocumentSearchResult {
	type: "document";
	score: number | null;
	document: Document;
	matches?: SearchMatch[];
}

export interface DecisionSearchResult {
	type: "decision";
	score: number | null;
	decision: Decision;
	matches?: SearchMatch[];
}

export type SearchResult =
	| ProposalSearchResult
	| DocumentSearchResult
	| DecisionSearchResult;

export interface Channel {
	name: string;
	fileName: string;
	type: "group" | "private" | "public";
}

export interface Message {
	timestamp: string;
	from: string;
	text: string;
	mentions: string[];
}

export interface Sequence {
	/** 1-based sequence index */
	index: number;
	/** Proposals that can be executed in parallel within this sequence */
	proposals: Proposal[];
}

/**
 * Configuration for ID prefixes used in proposal files.
 * Allows customization of proposal prefix (e.g., "JIRA-", "issue-", "bug-").
 * Note: Draft prefix is always "draft" and not configurable.
 */
export interface PrefixConfig {
	/** Prefix for proposal IDs (default: "proposal") - produces IDs like PROPOSAL-1, PROPOSAL-2 */
	proposal: string;
}

export interface RoadmapConfig {
	projectName: string;
	defaultAssignee?: string;
	defaultReporter?: string;
	statuses: string[];
	labels: string[];
	/** @deprecated Directives are sourced from directive files, not config. */
	directives?: string[];
	defaultStatus?: string;
	dateFormat: string;
	maxColumnWidth?: number;
	proposalResolutionStrategy?: "most_recent" | "most_progressed";
	defaultEditor?: string;
	autoOpenBrowser?: boolean;
	defaultPort?: number;
	remoteOperations?: boolean;
	autoCommit?: boolean;
	zeroPaddedIds?: number;
	includeDateTimeInDates?: boolean; // Whether to include time in new dates
	bypassGitHooks?: boolean;
	checkActiveBranches?: boolean; // Check proposal statuses across active branches (default: true)
	activeBranchDays?: number; // How many days a branch is considered active (default: 30)
	/** Global callback command to run on any proposal status change. Supports $PROPOSAL_ID, $OLD_STATUS, $NEW_STATUS, $PROPOSAL_TITLE variables. */
	onStatusChange?: string;
	/** ID prefix configuration for proposals and drafts. Defaults to { proposal: "proposal", draft: "draft" } */
	prefixes?: PrefixConfig;
	/** Schema version of the roadmap layout. 1 = legacy (nodes/), 2 = current (proposals/). */
	schemaVersion?: number;
	/** URL of the daemon to route operations through (e.g., "${getDaemonUrl()}"). When set, CLI/MCP tools use HTTP API instead of direct filesystem access. */
	daemonUrl?: string;
	/** When true, worktree setup creates HTTP client config instead of roadmap/ symlinks. */
	daemonMode?: boolean;
	/** Optional database connection configuration */
	database?: DatabaseConfig;
	/** Default export path (relative to project root). Defaults to "export" */
	exportPath?: string;
	mcp?: {
		url?: string;
		healthEndpoint?: string;
		toolsCount?: number;
		port?: number;
		transport?: string;
		http?: {
			host?: string;
			port?: number;
			auth?: {
				type?: "bearer" | "basic" | "none";
				token?: string;
				username?: string;
				password?: string;
			};
			cors?: {
				origin?: string | string[];
				credentials?: boolean;
			};
			enableDnsRebindingProtection?: boolean;
			allowedHosts?: string[];
			allowedOrigins?: string[];
		};
	};
	git?: {
		remote?: string;
		defaultBranch?: string;
		worktreePath?: string;
	};
	paths?: {
		proposals?: string;
		archive?: string;
		docs?: string;
	};
	components?: Record<
		string,
		{
			enabled?: boolean;
			maturity?: number;
			description?: string;
			port?: number;
			url?: string;
			[key: string]: unknown;
		}
	>;
	relay?: RelayConfig;
	coordination?: {
		heartbeatIntervalMs?: number;
		claimExpiryMs?: number;
	};
}

export interface DatabaseConfig {
	provider: "Postgres" | "postgres" | "markdown";
	host?: string;
	port?: number;
	user?: string;
	password?: string;
	name?: string;
	schema?: string;
	uri?: string;
}

export interface RelayConfig {
	enabled: boolean;
	webhook_url?: string;
	bot_token?: string;
	channel_id?: string;
	interval_ms?: number;
	ignored_agents?: string[];
}

export interface ParsedMarkdown {
	frontmatter: Record<string, unknown>;
	content: string;
}
