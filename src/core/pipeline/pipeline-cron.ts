/**
 * Compatibility worker for legacy transition_queue rows.
 *
 * P240 makes proposal maturity the implicit gate queue. This worker no longer
 * creates transition_queue rows from mature proposals; it only drains legacy
 * rows that already exist while the orchestrator handles proposal_gate_ready.
 */

import { basename } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getPool, query } from "../../infra/postgres/pool.ts";
import {
	type AgentProfile,
	scoreProposal,
	type ScorableProposal,
} from "../orchestration/pickup-scorer.ts";

const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:6421/sse";

const MATURITY_CHANGED_CHANNEL = "proposal_maturity_changed";
const TRANSITION_QUEUED_CHANNEL = "transition_queued";
const GATE_READY_CHANNEL = "proposal_gate_ready";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_OFFER_REAP_INTERVAL_MS = 60_000;
const WORKTREE_PREFIXES = ["claude", "gemini", "copilot", "openclaw"] as const;

type TransitionQueueId = number | string;
type JsonRecord = Record<string, unknown>;
type Logger = Pick<Console, "log" | "warn" | "error">;
type SpawnAgentRequest = {
	worktree: string;
	task: string;
	proposalId: number | string;
	stage: string;
	model?: string;
	timeoutMs?: number;
};
type SpawnAgentResult = {
	agentRunId: string;
	worktree: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
};
type McpClientLike = {
	callTool(args: {
		name: string;
		arguments: Record<string, unknown>;
	}): Promise<unknown>;
	close(): Promise<void>;
};
type McpClientFactory = (url: string) => McpClientLike;

export interface NotificationMessage {
	channel: string;
	payload?: string;
}

type NotificationHandler = (message: NotificationMessage) => void;
type ListenerErrorHandler = (error: Error) => void;

export interface ListenerClient {
	query(text: string, params?: unknown[]): Promise<unknown>;
	on(event: "notification", handler: NotificationHandler): unknown;
	on(event: "error", handler: ListenerErrorHandler): unknown;
	removeListener(event: "notification", handler: NotificationHandler): unknown;
	removeListener(event: "error", handler: ListenerErrorHandler): unknown;
	release?(): void;
}

interface TransitionQueueRow {
	id: TransitionQueueId;
	proposal_id: number | string;
	from_stage: string;
	to_stage: string;
	triggered_by: string;
	attempt_count: number;
	max_attempts: number;
	metadata: JsonRecord | null;
}

export interface PipelineCronDeps {
	queryFn?: typeof query;
	connectListener?: () => Promise<ListenerClient>;
	spawnAgentFn?: (request: SpawnAgentRequest) => Promise<SpawnAgentResult>;
	mcpClientFactory?: McpClientFactory;
	mcpUrl?: string;
	logger?: Logger;
	defaultWorktree?: string;
	pollIntervalMs?: number;
	batchSize?: number;
	offerReapIntervalMs?: number;
	useOfferDispatch?: boolean;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

function mcpResultText(result: unknown): string {
	const content = (
		result as { content?: Array<{ type?: string; text?: string }> }
	).content;
	const first = content?.[0];
	return first?.type === "text" && typeof first.text === "string"
		? first.text
		: "";
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMetadata(value: unknown): JsonRecord | null {
	if (isRecord(value)) {
		return value;
	}

	if (typeof value === "string" && value.trim().length > 0) {
		try {
			const parsed = JSON.parse(value);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	return null;
}

type DispatchMode = "prep" | "gate" | "noop";

type DispatchRoleSet = {
	prep: string[];
	gate: string[];
};

type ProposalDispatchContext = {
	id: number;
	displayId: string;
	status: string;
	maturity: string;
	title: string;
	priority: string | null;
	summary: string | null;
	design: string | null;
	alternatives: string | null;
	drawbacks: string | null;
	dependency: string | null;
	unresolvedDependencies: number;
	totalAcceptanceCriteria: number;
	blockingAcceptanceCriteria: number;
	passedAcceptanceCriteria: number;
	latestDecision: string | null;
};

type ProposalDispatchRow = {
	id: number;
	display_id: string;
	status: string;
	maturity: string;
	title: string;
	priority: string | null;
	summary: string | null;
	design: string | null;
	alternatives: string | null;
	drawbacks: string | null;
	dependency: string | null;
	unresolved_dependencies: number;
	total_acceptance_criteria: number;
	blocking_acceptance_criteria: number;
	passed_acceptance_criteria: number;
	latest_decision: string | null;
};

type AgentDispatchCandidate = {
	agent_identity: string;
	agent_type: string;
	role: string | null;
	preferred_model: string | null;
	active_model: string | null;
	status: string | null;
	active_leases: number;
	context_load: number;
	cpu_percent: number | null;
	memory_mb: number | null;
	daily_limit_usd: number | null;
	daily_spend_usd: number | null;
	is_frozen: boolean;
	capabilities: string[];
	cost_per_1k_input: number | null;
};

type DispatchPlan = {
	mode: DispatchMode;
	phase: string;
	stage: string;
	agentIdentity: string | null;
	modelHint: string | null;
	timeoutMs: number;
	task: string;
	reasons: string[];
	roles: string[];
	requiredCapabilities: string[];
};

const STAGE_DISPATCH_ROLES: Record<string, DispatchRoleSet> = {
	DRAFT: {
		prep: ["researcher", "architect"],
		gate: ["architect", "reviewer"],
	},
	REVIEW: {
		prep: ["architect", "skeptic"],
		gate: ["skeptic", "reviewer", "architect"],
	},
	DEVELOP: {
		prep: ["developer", "engineer"],
		gate: ["developer", "qa", "integration"],
	},
	MERGE: {
		prep: ["qa", "integration"],
		gate: ["qa", "maintainer", "gate-agent"],
	},
	COMPLETE: {
		prep: [],
		gate: [],
	},
};

function normalizeStage(value: string | null | undefined): string {
	return (value ?? "").trim().toUpperCase();
}

function parsePriority(
	value: string | null | undefined,
): "high" | "medium" | "low" {
	const normalized = (value ?? "").trim().toLowerCase();
	if (
		normalized === "high" ||
		normalized === "urgent" ||
		normalized === "critical"
	) {
		return "high";
	}
	if (normalized === "low") return "low";
	return "medium";
}

function deriveCostClass(
	costPer1kInput: number | null,
): "low" | "medium" | "high" {
	if (costPer1kInput === null || !Number.isFinite(costPer1kInput)) {
		return "medium";
	}
	if (costPer1kInput <= 0.002) return "low";
	if (costPer1kInput <= 0.02) return "medium";
	return "high";
}

function buildScorableProposal(
	context: ProposalDispatchContext,
): ScorableProposal {
	return {
		id: context.displayId,
		title: context.title,
		priority: parsePriority(context.priority),
		labels: [normalizeStage(context.status), context.maturity],
		needs_capabilities: [],
		acceptanceCriteriaCount: context.totalAcceptanceCriteria,
		dependencyDepth: context.unresolvedDependencies,
		downstreamCount: context.blockingAcceptanceCriteria,
	};
}

function gateTaskForStage(
	context: ProposalDispatchContext,
	stage: string,
	gate: string,
	reasons: string[],
): string {
	const nextStage = normalizeStage(stage);
	const readinessSummary =
		reasons.length > 0
			? `Blocking items: ${reasons.join(", ")}.`
			: "Ready to gate.";

	return [
		`You are the ${gate} gate agent for ${context.displayId} (${context.title}).`,
		`Current state: ${normalizeStage(context.status)}.`,
		`Target next state: ${nextStage}.`,
		readinessSummary,
		"",
		"Decide whether the proposal is ready to advance. If not, return concrete missing work.",
	].join("\n");
}

function prepTaskForStage(
	context: ProposalDispatchContext,
	stage: string,
	reasons: string[],
): string {
	return [
		`You are the preparation agent for ${context.displayId} (${context.title}).`,
		`Current state: ${normalizeStage(context.status)}.`,
		`Target next state: ${normalizeStage(stage)}.`,
		reasons.length > 0
			? `Prepare the proposal by addressing: ${reasons.join(", ")}.`
			: "Enhance the proposal until it is ready for the next gate.",
		"",
		"Focus on research, clarity, acceptance criteria, and any missing evidence.",
	].join("\n");
}

function assessReadiness(context: ProposalDispatchContext): {
	mode: DispatchMode;
	reasons: string[];
} {
	const stage = normalizeStage(context.status);
	const missing: string[] = [];

	if (stage === "COMPLETE") {
		return { mode: "noop", reasons: ["terminal state"] };
	}

	if (!context.summary?.trim()) missing.push("summary");
	if (!context.design?.trim()) missing.push("design");
	if (!context.totalAcceptanceCriteria) missing.push("acceptance criteria");
	if (context.unresolvedDependencies > 0) missing.push("blocking dependencies");

	const acPending = context.blockingAcceptanceCriteria > 0;
	if (acPending) missing.push("open acceptance criteria");

	if (stage === "DRAFT") {
		return missing.length > 0
			? { mode: "prep", reasons: missing }
			: { mode: "gate", reasons: [] };
	}

	if (stage === "REVIEW") {
		return missing.length > 0
			? { mode: "prep", reasons: missing }
			: { mode: "gate", reasons: [] };
	}

	if (stage === "DEVELOP") {
		return missing.length > 0
			? { mode: "prep", reasons: missing }
			: { mode: "gate", reasons: [] };
	}

	if (stage === "MERGE") {
		return missing.length > 0 || context.latestDecision !== "approved"
			? {
					mode: "prep",
					reasons: [
						...missing,
						context.latestDecision !== "approved"
							? "merge approval evidence"
							: "",
					].filter(Boolean),
				}
			: { mode: "gate", reasons: [] };
	}

	return { mode: "noop", reasons: ["unsupported stage"] };
}

function readString(
	source: JsonRecord | null,
	...keys: string[]
): string | null {
	if (!source) return null;

	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}

	return null;
}

function readNumber(
	source: JsonRecord | null,
	...keys: string[]
): number | null {
	if (!source) return null;

	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === "string" && value.trim().length > 0) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}

	return null;
}

function looksLikeWorktreeName(
	value: string | null | undefined,
): value is string {
	if (!value) return false;
	return WORKTREE_PREFIXES.some(
		(prefix) => value.startsWith(`${prefix}-`) || value === prefix,
	);
}

function buildDefaultTask(transition: TransitionQueueRow): string {
	const lines = [
		"Process the queued AgentHive proposal transition below.",
		"",
		`Transition queue row: ${transition.id}`,
		`Proposal ID: ${transition.proposal_id}`,
		`From stage: ${transition.from_stage}`,
		`To stage: ${transition.to_stage}`,
		`Triggered by: ${transition.triggered_by}`,
	];

	if (transition.metadata && Object.keys(transition.metadata).length > 0) {
		lines.push(
			"",
			"Queue metadata:",
			JSON.stringify(transition.metadata, null, 2),
		);
	}

	lines.push(
		"",
		"Read the current proposal state from the roadmap schema, perform the work required for this transition, and persist any resulting updates through the normal application paths.",
	);

	return lines.join("\n");
}

async function loadProposalDispatchContext(
	queryFn: typeof query,
	proposalId: number,
): Promise<ProposalDispatchContext | null> {
	const { rows } = await queryFn<ProposalDispatchRow>(
		`SELECT
		    p.id AS id,
		    p.display_id AS display_id,
		    p.status AS status,
		    p.maturity AS maturity,
		    p.title AS title,
		    p.priority AS priority,
		    p.summary AS summary,
		    p.design AS design,
		    p.alternatives AS alternatives,
		    p.drawbacks AS drawbacks,
		    p.dependency_note AS dependency,
		    COALESCE(dep.unresolved_dependencies, 0) AS unresolved_dependencies,
		    COALESCE(ac.total_acceptance_criteria, 0) AS total_acceptance_criteria,
		    COALESCE(ac.blocking_acceptance_criteria, 0) AS blocking_acceptance_criteria,
		    COALESCE(ac.passed_acceptance_criteria, 0) AS passed_acceptance_criteria,
		    dec.latest_decision AS latest_decision
		 FROM roadmap_proposal.proposal p
		 LEFT JOIN LATERAL (
		    SELECT COUNT(*) FILTER (WHERE dependency_type = 'blocks' AND resolved = false) AS unresolved_dependencies
		    FROM roadmap_proposal.proposal_dependencies
		    WHERE from_proposal_id = p.id
		 ) dep ON true
		 LEFT JOIN LATERAL (
		    SELECT
		      COUNT(*) AS total_acceptance_criteria,
		      COUNT(*) FILTER (WHERE status IN ('pending', 'fail')) AS blocking_acceptance_criteria,
		      COUNT(*) FILTER (WHERE status = 'pass') AS passed_acceptance_criteria
		    FROM roadmap_proposal.proposal_acceptance_criteria
		    WHERE proposal_id = p.id
		 ) ac ON true
		 LEFT JOIN LATERAL (
		    SELECT decision AS latest_decision
		    FROM roadmap_proposal.proposal_decision
		    WHERE proposal_id = p.id
		    ORDER BY decided_at DESC
		    LIMIT 1
		 ) dec ON true
		 WHERE p.id = $1
		 LIMIT 1`,
		[proposalId],
	);

	if (!rows[0]) {
		return null;
	}

	const row = rows[0];
	return {
		id: row.id,
		displayId: row.display_id,
		status: row.status,
		maturity: row.maturity,
		title: row.title,
		priority: row.priority ?? null,
		summary: row.summary ?? null,
		design: row.design ?? null,
		alternatives: row.alternatives ?? null,
		drawbacks: row.drawbacks ?? null,
		dependency: row.dependency ?? null,
		unresolvedDependencies: row.unresolved_dependencies ?? 0,
		totalAcceptanceCriteria: row.total_acceptance_criteria ?? 0,
		blockingAcceptanceCriteria: row.blocking_acceptance_criteria ?? 0,
		passedAcceptanceCriteria: row.passed_acceptance_criteria ?? 0,
		latestDecision: row.latest_decision ?? null,
	};
}

async function loadDispatchCandidates(
	queryFn: typeof query,
	roles: string[],
): Promise<AgentDispatchCandidate[]> {
	if (!roles.length) return [];

	const normalizedRoles = roles.map((role) => role.toLowerCase());
	const { rows } = await queryFn<
		AgentDispatchCandidate & {
			capability: string;
		}
	>(
		`
		SELECT
		  v.agent_identity,
		  ar.agent_type,
		  ar.role,
		  ar.preferred_model,
		  ah.active_model,
		  ah.status,
		  COALESCE(v.active_leases, 0) AS active_leases,
		  COALESCE(v.context_load, 0) AS context_load,
		  ah.cpu_percent,
		  ah.memory_mb,
		  sc.daily_limit_usd,
		  ds.total_usd AS daily_spend_usd,
		  COALESCE(sc.is_frozen, false) AS is_frozen,
		  mm.cost_per_1k_input,
		  v.capability
		FROM roadmap.v_capable_agents v
		JOIN roadmap_workforce.agent_registry ar ON ar.id = v.id
		LEFT JOIN roadmap_workforce.agent_health ah ON ah.agent_identity = v.agent_identity
		LEFT JOIN roadmap_efficiency.spending_caps sc ON sc.agent_identity = v.agent_identity
		LEFT JOIN roadmap.v_daily_spend ds
		  ON ds.agent_identity = v.agent_identity AND ds.spend_date = CURRENT_DATE
		LEFT JOIN roadmap.model_metadata mm
		  ON mm.model_name = COALESCE(ah.active_model, ar.preferred_model)
		WHERE LOWER(v.capability) = ANY($1)
		   OR LOWER(COALESCE(ar.role, '')) = ANY($1)
		ORDER BY v.active_leases ASC, v.context_load ASC, COALESCE(ah.cpu_percent, 0) ASC
	`,
		[normalizedRoles],
	);

	const grouped = new Map<string, AgentDispatchCandidate>();

	for (const row of rows) {
		const existing = grouped.get(row.agent_identity);
		const capabilities = new Set(existing?.capabilities ?? []);
		capabilities.add(row.capability);

		grouped.set(row.agent_identity, {
			agent_identity: row.agent_identity,
			agent_type: row.agent_type,
			role: row.role ?? null,
			preferred_model: row.preferred_model ?? null,
			active_model: row.active_model ?? null,
			status: row.status ?? null,
			active_leases: row.active_leases ?? 0,
			context_load: row.context_load ?? 0,
			cpu_percent: row.cpu_percent ?? null,
			memory_mb: row.memory_mb ?? null,
			daily_limit_usd: row.daily_limit_usd ?? null,
			daily_spend_usd: row.daily_spend_usd ?? null,
			is_frozen: Boolean(row.is_frozen),
			capabilities: Array.from(capabilities),
			cost_per_1k_input:
				typeof row.cost_per_1k_input === "number"
					? row.cost_per_1k_input
					: row.cost_per_1k_input
						? Number(row.cost_per_1k_input)
						: null,
		});
	}

	return Array.from(grouped.values());
}

function scoreDispatchAgent(
	context: ProposalDispatchContext,
	candidate: AgentDispatchCandidate,
	roles: string[],
): number {
	const proposal: ScorableProposal = {
		...buildScorableProposal(context),
		needs_capabilities: roles,
	};

	const agent: AgentProfile = {
		name: candidate.agent_identity,
		capabilities: candidate.capabilities,
		costClass: deriveCostClass(candidate.cost_per_1k_input),
		availability:
			candidate.is_frozen || candidate.status === "offline"
				? "offline"
				: candidate.status === "active" || candidate.status === "healthy"
					? "active"
					: "idle",
		currentLoad:
			Math.max(0, candidate.active_leases) +
			Math.max(0, Math.round(candidate.context_load)) +
			Math.max(0, Math.round((candidate.cpu_percent ?? 0) / 40)) +
			Math.max(
				0,
				Math.round(
					(candidate.daily_limit_usd && candidate.daily_spend_usd
						? Math.min(4, candidate.daily_spend_usd / candidate.daily_limit_usd)
						: 0) * 2,
				),
			),
		completionHistory: undefined,
	};

	return scoreProposal(agent, proposal).total;
}

async function chooseDispatchAgent(
	queryFn: typeof query,
	context: ProposalDispatchContext,
	roles: string[],
): Promise<AgentDispatchCandidate | null> {
	const candidates = await loadDispatchCandidates(queryFn, roles);
	if (!candidates.length) return null;

	let bestCandidate: AgentDispatchCandidate | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;
	for (const candidate of candidates) {
		const score = scoreDispatchAgent(context, candidate, roles);
		if (score > bestScore) {
			bestScore = score;
			bestCandidate = candidate;
		}
	}

	return bestCandidate;
}

function buildDispatchPlan(
	context: ProposalDispatchContext,
	targetStage: string,
	mode: DispatchMode,
	agent: AgentDispatchCandidate | null,
	reasons: string[],
): DispatchPlan {
	const normalizedTarget = normalizeStage(targetStage);
	const stageRoles = STAGE_DISPATCH_ROLES[normalizeStage(context.status)] ?? {
		prep: ["architect"],
		gate: ["reviewer"],
	};
	const roles = mode === "prep" ? stageRoles.prep : stageRoles.gate;
	const agentCapabilities = new Set(
		(agent?.capabilities ?? []).map((capability) => capability.toLowerCase()),
	);
	const matchedRole =
		roles.find((role) => agentCapabilities.has(role.toLowerCase())) ??
		roles[0] ??
		null;

	return {
		mode,
		phase: normalizedTarget.toLowerCase(),
		stage:
			mode === "gate"
				? `gate:${normalizedTarget}`
				: normalizeStage(context.status),
		agentIdentity: agent?.agent_identity ?? null,
		modelHint: agent?.preferred_model ?? agent?.active_model ?? null,
		timeoutMs: mode === "gate" ? 300_000 : 180_000,
		task:
			mode === "gate"
				? gateTaskForStage(
						context,
						normalizedTarget,
						roles[0] ?? "reviewer",
						reasons,
					)
				: prepTaskForStage(context, normalizedTarget, reasons),
		reasons,
		roles,
		requiredCapabilities: matchedRole ? [matchedRole] : [],
	};
}

export class PipelineCron {
	private readonly queryFn: typeof query;
	private readonly connectListener: () => Promise<ListenerClient>;
	private readonly mcpUrl: string;
	private readonly logger: Logger;
	private readonly defaultWorktree: string;
	private readonly pollIntervalMs: number;
	private readonly batchSize: number;
	private readonly offerReapIntervalMs: number;
	private readonly useOfferDispatch: boolean;
	private readonly setIntervalFn: typeof setInterval;
	private readonly clearIntervalFn: typeof clearInterval;
	private readonly spawnAgentFn?: (
		request: SpawnAgentRequest,
	) => Promise<SpawnAgentResult>;
	private readonly mcpClientFactory: McpClientFactory;

	private listenerClient: ListenerClient | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private offerReapTimer: ReturnType<typeof setInterval> | null = null;
	private offerReapInFlight = false;
	private drainPromise: Promise<void> | null = null;
	private rerunRequested = false;
	private started = false;

	private readonly notificationHandler = (
		message: NotificationMessage,
	): void => {
		if (
			message.channel !== MATURITY_CHANGED_CHANNEL &&
			message.channel !== TRANSITION_QUEUED_CHANNEL &&
			message.channel !== GATE_READY_CHANNEL
		) {
			return;
		}

		this.logger.log(`[PipelineCron] Received NOTIFY on ${message.channel}`);
		void this.scheduleDrain(`notify:${message.channel}`);
	};

	private readonly listenerErrorHandler = (error: Error): void => {
		this.logger.error(`[PipelineCron] Listener error: ${error.message}`);
	};

	constructor(deps: PipelineCronDeps = {}) {
		this.queryFn = deps.queryFn ?? query;
		this.connectListener =
			deps.connectListener ?? (async () => getPool().connect());
		this.mcpUrl = deps.mcpUrl ?? MCP_URL;
		this.logger = deps.logger ?? console;
		this.defaultWorktree = deps.defaultWorktree ?? basename(process.cwd());
		this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
		this.offerReapIntervalMs =
			deps.offerReapIntervalMs ?? DEFAULT_OFFER_REAP_INTERVAL_MS;
		this.useOfferDispatch =
			deps.useOfferDispatch ?? process.env.AGENTHIVE_USE_OFFER_DISPATCH === "1";
		this.setIntervalFn = deps.setIntervalFn ?? setInterval;
		this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
		this.spawnAgentFn = deps.spawnAgentFn;
		this.mcpClientFactory =
			deps.mcpClientFactory ??
			((url) => {
				const client = new Client({ name: "gate-pipeline", version: "1.0.0" });
				const transport = new SSEClientTransport(new URL(url));
				let connected = false;
				return {
					async callTool(args) {
						if (!connected) {
							await client.connect(transport);
							connected = true;
						}
						return client.callTool(args);
					},
					async close() {
						await client.close();
					},
				};
			});
	}

	async run(): Promise<void> {
		if (this.started) {
			return;
		}

		this.started = true;
		await this.startListener();

		this.pollTimer = this.setIntervalFn(() => {
			void this.scheduleDrain("poll");
		}, this.pollIntervalMs);

		this.offerReapTimer = this.setIntervalFn(() => {
			void this.runOfferReaper();
		}, this.offerReapIntervalMs);

		this.logger.log(
			`[PipelineCron] Listening on ${MATURITY_CHANGED_CHANNEL}, ${GATE_READY_CHANNEL}, and ${TRANSITION_QUEUED_CHANNEL}; legacy queue polling every ${this.pollIntervalMs}ms; offer reaper every ${this.offerReapIntervalMs}ms`,
		);

		await this.scheduleDrain("startup");
		void this.runOfferReaper();
	}

	async stop(): Promise<void> {
		this.started = false;

		if (this.pollTimer) {
			this.clearIntervalFn(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.offerReapTimer) {
			this.clearIntervalFn(this.offerReapTimer);
			this.offerReapTimer = null;
		}

		if (this.listenerClient) {
			const listener = this.listenerClient;
			listener.removeListener("notification", this.notificationHandler);
			listener.removeListener("error", this.listenerErrorHandler);

			try {
				await listener.query(`UNLISTEN ${MATURITY_CHANGED_CHANNEL}`);
				await listener.query(`UNLISTEN ${TRANSITION_QUEUED_CHANNEL}`);
				await listener.query(`UNLISTEN ${GATE_READY_CHANNEL}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.warn(
					`[PipelineCron] Failed to unlisten cleanly: ${message}`,
				);
			}

			listener.release?.();
			this.listenerClient = null;
		}

		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		await (this.drainPromise ?? Promise.resolve());
	}

	private async runOfferReaper(): Promise<void> {
		if (this.offerReapInFlight) return;
		this.offerReapInFlight = true;
		try {
			const { rows } = await this.queryFn<{
				reissued_count: number;
				expired_count: number;
			}>("SELECT * FROM roadmap_workforce.fn_reap_expired_offers()");
			const row = rows[0];
			const reissued = Number(row?.reissued_count ?? 0);
			const expired = Number(row?.expired_count ?? 0);
			if (reissued > 0 || expired > 0) {
				this.logger.log(
					`[PipelineCron] offer reaper: ${reissued} reissued, ${expired} expired`,
				);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.warn(`[PipelineCron] offer reaper failed: ${message}`);
		} finally {
			this.offerReapInFlight = false;
		}
	}

	private async startListener(): Promise<void> {
		const listener = await this.connectListener();
		this.listenerClient = listener;
		listener.on("notification", this.notificationHandler);
		listener.on("error", this.listenerErrorHandler);

		await listener.query(`LISTEN ${MATURITY_CHANGED_CHANNEL}`);
		await listener.query(`LISTEN ${TRANSITION_QUEUED_CHANNEL}`);
		await listener.query(`LISTEN ${GATE_READY_CHANNEL}`);
	}

	private async scheduleDrain(reason: string): Promise<void> {
		if (this.drainPromise) {
			this.rerunRequested = true;
			return this.drainPromise;
		}

		this.drainPromise = this.drainLoop(reason).finally(() => {
			this.drainPromise = null;
		});

		return this.drainPromise;
	}

	private async drainLoop(initialReason: string): Promise<void> {
		let reason = initialReason;

		while (true) {
			this.rerunRequested = false;
			await this.drainReadyTransitions(reason);

			if (!this.rerunRequested) {
				return;
			}

			reason = "coalesced";
		}
	}

	private async drainReadyTransitions(reason: string): Promise<void> {
		while (true) {
			const transitions = await this.claimPendingTransitions();
			if (transitions.length === 0) {
				return;
			}

			this.logger.log(
				`[PipelineCron] Claimed ${transitions.length} transition(s) for ${reason}`,
			);

			for (const transition of transitions) {
				await this.processTransition(transition);
			}
		}
	}

	private async claimPendingTransitions(): Promise<TransitionQueueRow[]> {
		const { rows } = await this.queryFn<TransitionQueueRow>(
			`WITH next_transitions AS (
         SELECT tq.id
         FROM roadmap.transition_queue tq
         WHERE tq.status = 'pending'
           AND tq.process_after <= now()
         ORDER BY tq.process_after ASC, tq.id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE roadmap.transition_queue tq
       SET status = 'processing',
           processing_at = now(),
           attempt_count = tq.attempt_count + 1,
           last_error = NULL
       FROM next_transitions nt
       WHERE tq.id = nt.id
       RETURNING tq.id,
                 tq.proposal_id,
                 tq.from_stage,
                 tq.to_stage,
                 tq.triggered_by,
                 tq.attempt_count,
                 tq.max_attempts,
                 tq.metadata`,
			[this.batchSize],
		);

		return rows.map((row) => ({
			...row,
			metadata: normalizeMetadata(row.metadata),
		}));
	}

	/**
	 * Dispatch a transition via MCP cubic tools instead of subprocess.
	 * Uses the same pattern as the orchestrator: create cubic, focus with task.
	 * The agent picks up the work asynchronously through the MCP/Hermes subscription model.
	 */
	private async processTransition(
		transition: TransitionQueueRow,
	): Promise<void> {
		const spawnMetadata = isRecord(transition.metadata?.spawn)
			? transition.metadata.spawn
			: null;
		const proposalId =
			typeof transition.proposal_id === "number"
				? transition.proposal_id
				: Number.isFinite(Number(transition.proposal_id))
					? Number(transition.proposal_id)
					: null;

		const proposalContext =
			proposalId !== null
				? await loadProposalDispatchContext(this.queryFn, proposalId)
				: null;
		const readiness = proposalContext ? assessReadiness(proposalContext) : null;
		const stageRoles = STAGE_DISPATCH_ROLES[
			normalizeStage(transition.from_stage)
		] ?? {
			prep: ["architect"],
			gate: ["reviewer"],
		};
		const dispatchRoles =
			readiness?.mode === "prep" ? stageRoles.prep : stageRoles.gate;
		const selectedAgent =
			proposalContext && dispatchRoles.length > 0
				? await chooseDispatchAgent(
						this.queryFn,
						proposalContext,
						dispatchRoles,
					)
				: null;
		const plan = proposalContext
			? buildDispatchPlan(
					proposalContext,
					transition.to_stage,
					readiness?.mode ?? "gate",
					selectedAgent,
					readiness?.reasons ?? [],
				)
			: null;

		if (this.useOfferDispatch) {
			await this.processTransitionWithOffer(transition, plan, proposalContext);
			return;
		}

		if (this.spawnAgentFn) {
			await this.processTransitionWithSpawnAgent(transition, plan);
			return;
		}

		const client = this.mcpClientFactory(this.mcpUrl);

		try {
			const proposalDisplayId =
				proposalContext?.displayId ?? String(transition.proposal_id);
			const agentName =
				plan?.agentIdentity ??
				readString(transition.metadata, "agent") ??
				(looksLikeWorktreeName(transition.triggered_by)
					? transition.triggered_by
					: null) ??
				plan?.roles[0] ??
				"architect";
			const task =
				plan?.task ??
				readString(spawnMetadata, "task") ??
				readString(transition.metadata, "task") ??
				buildDefaultTask(transition);

			// 1. Create cubic for this proposal
			const cubicResult = await client.callTool({
				name: "cubic_create",
				arguments: {
					name: `gate-${proposalDisplayId}-${transition.to_stage}`,
					agents: Array.from(new Set([agentName, ...(plan?.roles ?? [])])),
					proposals: [proposalDisplayId],
				},
			});
			const cubicData = JSON.parse(mcpResultText(cubicResult) || "{}");

			if (!cubicData.success || !cubicData.cubic?.id) {
				throw new Error(`Failed to create cubic: ${JSON.stringify(cubicData)}`);
			}

			const cubicId = cubicData.cubic.id;

			// 2. Focus cubic with the transition task
			await client.callTool({
				name: "cubic_focus",
				arguments: {
					cubicId,
					agent: agentName,
					task,
					phase: plan?.phase ?? transition.to_stage?.toLowerCase() ?? "build",
				},
			});

			// 3. Keep the row in processing. It is not complete until the proposal
			// state itself changes to the queued target stage.
			await this.markTransitionDispatched(transition.id);
			this.logger.log(
				`[PipelineCron] Dispatched transition ${transition.id} for proposal ${proposalDisplayId} via MCP cubic ${cubicId}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.handleTransitionFailure(transition, message);
		} finally {
			await client.close();
		}
	}

	private async processTransitionWithOffer(
		transition: TransitionQueueRow,
		plan: DispatchPlan | null,
		proposalContext: ProposalDispatchContext | null,
	): Promise<void> {
		const spawnMetadata = isRecord(transition.metadata?.spawn)
			? transition.metadata.spawn
			: null;
		const proposalDisplayId =
			proposalContext?.displayId ?? String(transition.proposal_id);
		const phase = plan?.phase ?? transition.to_stage?.toLowerCase() ?? "build";
		const requiredCapabilities = plan?.requiredCapabilities?.length
			? plan.requiredCapabilities
			: [];
		const role = requiredCapabilities[0] ?? plan?.roles[0] ?? "developer";
		const squadName = `${proposalDisplayId}-${phase}`;
		const task =
			plan?.task ??
			readString(spawnMetadata, "task") ??
			readString(transition.metadata, "task") ??
			buildDefaultTask(transition);
		const worktreeHint =
			plan?.agentIdentity ??
			readString(spawnMetadata, "worktree") ??
			readString(transition.metadata, "worktree") ??
			null;
		const offerMetadata: JsonRecord = {
			task,
			phase,
			stage: `gate:${transition.to_stage}`,
			roles: plan?.roles ?? [role],
			transition_id: transition.id,
			proposal_display_id: proposalDisplayId,
		};
		if (worktreeHint) offerMetadata.worktree_hint = worktreeHint;
		if (plan?.modelHint) offerMetadata.model = plan.modelHint;
		if (plan?.timeoutMs) offerMetadata.timeout_ms = plan.timeoutMs;

		const proposalIdNum =
			typeof transition.proposal_id === "number"
				? transition.proposal_id
				: Number.isFinite(Number(transition.proposal_id))
					? Number(transition.proposal_id)
					: null;
		if (proposalIdNum === null) {
			await this.handleTransitionFailure(
				transition,
				`offer-dispatch: cannot resolve numeric proposal_id from ${String(transition.proposal_id)}`,
			);
			return;
		}

		try {
			const existing = await this.queryFn<{ id: number }>(
				`SELECT id
				   FROM roadmap_workforce.squad_dispatch
				  WHERE proposal_id = $1
				    AND dispatch_role = $2
				    AND (
				      completed_at IS NULL
				      OR dispatch_status IN ('assigned', 'active', 'blocked')
				      OR offer_status IN ('open', 'claimed', 'activated')
				    )
				  ORDER BY assigned_at DESC
				  LIMIT 1`,
				[proposalIdNum, role],
			);
			const existingDispatchId = existing.rows[0]?.id;
			if (existingDispatchId) {
				await this.markTransitionDispatched(transition.id);
				this.logger.log(
					`[PipelineCron] Reused active offer ${existingDispatchId} for ${proposalDisplayId} (${role}/${phase}); transition ${transition.id} marked processing`,
				);
				return;
			}

			const { rows } = await this.queryFn<{ id: number }>(
				`INSERT INTO roadmap_workforce.squad_dispatch
				   (proposal_id, squad_name, dispatch_role, dispatch_status,
				    offer_status, agent_identity, required_capabilities, metadata)
				 VALUES ($1, $2, $3, 'open', 'open', NULL, $4::jsonb, $5::jsonb)
				 RETURNING id`,
				[
					proposalIdNum,
					squadName,
					role,
					requiredCapabilities.length
						? JSON.stringify({ all: requiredCapabilities })
						: "{}",
					JSON.stringify(offerMetadata),
				],
			);
			const dispatchId = rows[0]?.id;
			if (!dispatchId) {
				throw new Error("INSERT returned no dispatch_id");
			}

			await this.queryFn(`SELECT pg_notify('work_offers', $1)`, [
				JSON.stringify({
					event: "emitted",
					dispatch_id: dispatchId,
					proposal_id: proposalIdNum,
					role,
				}),
			]);

			await this.markTransitionDispatched(transition.id);
			this.logger.log(
				`[PipelineCron] Emitted offer ${dispatchId} for ${proposalDisplayId} (${role}/${phase}); transition ${transition.id} marked processing`,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.handleTransitionFailure(
				transition,
				`offer-dispatch failed: ${message}`,
			);
		}
	}

	private async processTransitionWithSpawnAgent(
		transition: TransitionQueueRow,
		plan?: DispatchPlan,
	): Promise<void> {
		if (!this.spawnAgentFn) return;
		const spawnMetadata = isRecord(transition.metadata?.spawn)
			? transition.metadata.spawn
			: null;
		const proposalId =
			readNumber(transition.metadata, "proposalId", "proposal_id") ??
			(typeof transition.proposal_id === "number"
				? transition.proposal_id
				: Number.isFinite(Number(transition.proposal_id))
					? Number(transition.proposal_id)
					: transition.proposal_id);
		const request: SpawnAgentRequest = {
			worktree:
				readString(spawnMetadata, "worktree") ??
				plan?.agentIdentity ??
				readString(transition.metadata, "worktree") ??
				this.defaultWorktree,
			task:
				plan?.task ??
				readString(spawnMetadata, "task") ??
				readString(transition.metadata, "task") ??
				buildDefaultTask(transition),
			proposalId,
			stage: plan?.stage ?? `gate:${transition.to_stage}`,
		};
		const model =
			plan?.modelHint ?? readString(spawnMetadata, "model") ?? undefined;
		if (model) request.model = model;
		const timeoutMs =
			plan?.timeoutMs ??
			readNumber(spawnMetadata, "timeoutMs", "timeout_ms") ??
			undefined;
		if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;

		const result = await this.spawnAgentFn(request);
		if (result.exitCode !== 0) {
			const details = [result.stderr, result.stdout].filter(Boolean).join("\n");
			await this.handleTransitionFailure(
				transition,
				`spawnAgent exited with code ${result.exitCode}${details ? `\n${details}` : ""}`,
			);
			return;
		}
		await this.completeTransitionIfApplied(transition);
	}

	private async markTransitionDispatched(id: TransitionQueueId): Promise<void> {
		await this.queryFn(
			`UPDATE roadmap.transition_queue
       SET status = 'processing',
           processing_at = now(),
           last_error = NULL
       WHERE id = $1`,
			[id],
		);
	}

	private async completeTransitionIfApplied(
		transition: TransitionQueueRow,
	): Promise<void> {
		const result = await this.queryFn(
			`UPDATE roadmap.transition_queue tq
       SET status = 'done',
           completed_at = now(),
           last_error = NULL
       WHERE tq.id = $1
         AND EXISTS (
           SELECT 1
           FROM roadmap_proposal.proposal p
           WHERE p.id = tq.proposal_id
             AND LOWER(p.status) = LOWER(tq.to_stage)
         )`,
			[transition.id],
		);
		if ((result.rowCount ?? 0) === 0) {
			await this.handleTransitionFailure(
				transition,
				`transition target not applied: proposal did not reach ${transition.to_stage}`,
			);
		}
	}

	private async handleTransitionFailure(
		transition: TransitionQueueRow,
		errorMessage: string,
	): Promise<void> {
		const exhausted = transition.attempt_count >= transition.max_attempts;

		if (exhausted) {
			const proposalId =
				typeof transition.proposal_id === "number"
					? transition.proposal_id
					: Number.isFinite(Number(transition.proposal_id))
						? Number(transition.proposal_id)
						: transition.proposal_id;
			await this.queryFn(
				`UPDATE roadmap.transition_queue
         SET status = 'failed',
             completed_at = now(),
             last_error = $2
         WHERE id = $1`,
				[transition.id, errorMessage],
			);
			await this.queryFn(
				`INSERT INTO roadmap.notification_queue
         (proposal_id, severity, channel, title, body, metadata)
       VALUES (
         $1,
         'CRITICAL',
         'ops',
         'Gate transition failed permanently',
         $2,
         jsonb_build_object(
           'transition_queue_id', $3::text,
           'from_stage', $4,
           'to_stage', $5,
           'error', $6
         )
       )`,
				[
					proposalId,
					`Transition ${transition.from_stage} -> ${transition.to_stage} failed permanently: ${errorMessage}`,
					transition.id,
					transition.from_stage,
					transition.to_stage,
					errorMessage,
				],
			);

			this.logger.error(
				`[PipelineCron] Transition ${transition.id} failed permanently: ${errorMessage}`,
			);
			return;
		}

		await this.queryFn(
			`UPDATE roadmap.transition_queue
       SET status = 'pending',
           process_after = now() + ($2 * interval '2 minutes'),
           processing_at = NULL,
           completed_at = NULL,
           last_error = $3
       WHERE id = $1`,
			[transition.id, Math.max(transition.attempt_count, 1), errorMessage],
		);

		this.logger.warn(
			`[PipelineCron] Transition ${transition.id} requeued after failure: ${errorMessage}`,
		);
	}
}
