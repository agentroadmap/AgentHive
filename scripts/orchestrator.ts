/**
 * AgentHive Orchestrator — Event-driven agent dispatcher with dynamic agent deployment.
 *
 * When state machine calls:
 *   - DRAFT → dispatch Architect to enhance
 *   - REVIEW → dispatch Reviewer + Skeptic to evaluate
 *   - DEVELOP → dispatch Developer to implement
 *   - MERGE → dispatch Git Specialist to integrate
 *
 * Research & Architecture agents run on-demand when proposals need them.
 */

import { constants as fsConstants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
	spawnAgent,
	resolveActiveRouteProvider,
} from "../src/core/orchestration/agent-spawner.ts";
import { postWorkOffer } from "../src/core/pipeline/post-work-offer.ts";
import { reapStaleRows } from "../src/core/pipeline/reap-stale-rows.ts";
import { getPool, query } from "../src/infra/postgres/pool.ts";
import { loadStateNames } from "../src/core/workflow/state-names.ts";
import { mcpText } from "./mcp-result.ts";
import { getMcpUrl } from "../src/shared/runtime/endpoints.ts";

const MCP_URL = getMcpUrl();
const AGENTHIVE_HOST = process.env.AGENTHIVE_HOST ?? "default";
const WORKTREE_ROOT =
	process.env.AGENTHIVE_WORKTREE_ROOT ?? "/data/code/worktree";
const DEFAULT_EXECUTOR_WORKTREE =
	process.env.AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE;

// When true, orchestrator posts work offers instead of direct-spawning.
// Registered agency processes (e.g. copilot/agency-gary) claim and execute.
const USE_OFFER_DISPATCH = process.env.AGENTHIVE_USE_OFFER_DISPATCH === "1";

const logger = {
	log: (...args: unknown[]) => console.log("[Orchestrator]", ...args),
	warn: (...args: unknown[]) => console.warn("[Orchestrator]", ...args),
	error: (...args: unknown[]) => console.error("[Orchestrator]", ...args),
};

// P266: graceful-shutdown bookkeeping. New dispatches are refused once
// `stopping` is true; in-flight ones are awaited (bounded) before exit.
let stopping = false;
const inFlight = new Set<Promise<unknown>>();
function trackInFlight<T>(p: Promise<T>): Promise<T> {
	inFlight.add(p);
	p.finally(() => inFlight.delete(p)).catch(() => {});
	return p;
}
const SHUTDOWN_DRAIN_MS = Number(
	process.env.AGENTHIVE_ORCHESTRATOR_DRAIN_MS ?? 240_000,
);

// State → cubic phase mapping
const STATE_TO_PHASE: Record<string, string> = {
	DRAFT: "design",
	TRIAGE: "design",
	REVIEW: "design",
	FIX: "build",
	DEVELOP: "build",
	MERGE: "test",
	COMPLETE: "ship",
	DEPLOYED: "ship",
};

const ENABLE_POLLING = process.env.AGENTHIVE_ORCHESTRATOR_POLL === "1";
const IMPLICIT_GATE_POLL_INTERVAL_MS = Number(
	process.env.AGENTHIVE_IMPLICIT_GATE_POLL_MS ?? 30_000,
);

// ─── Capability-Based Agent Matching ─────────────────────────────────────────

interface RoleSlot {
	role: string;
	requiredCapabilities: string[];
	minProficiency: number;
	prompt: string;
	count: number;
	activity: string; // descriptive label: "researching", "enhancing", "reviewing", etc.
}

const JOB_ROLES: Record<string, RoleSlot[]> = {
	DRAFT: [
		{
			role: "architect",
			requiredCapabilities: ["design", "system-design"],
			minProficiency: 3,
			prompt:
				"You are an Architecture Agent. Enhance this DRAFT proposal with acceptance criteria, design rationale, and implementation plan.",
			count: 1,
			activity: "enhancing",
		},
		{
			role: "researcher",
			requiredCapabilities: ["research"],
			minProficiency: 2,
			prompt:
				"You are a Researcher. Gather context for proposals that need investigation.",
			count: 1,
			activity: "researching",
		},
	],
	TRIAGE: [
		{
			role: "triage-agent",
			requiredCapabilities: ["triage"],
			minProficiency: 2,
			prompt:
				"You are a Triage Agent. Evaluate issues and decide what to work on.",
			count: 1,
			activity: "triaging",
		},
	],
	REVIEW: [
		{
			role: "skeptic",
			requiredCapabilities: ["review", "gating", "skeptic-review"],
			minProficiency: 3,
			prompt:
				"You are a Skeptic Reviewer. Challenge design decisions. Demand evidence. Question assumptions.",
			count: 2,
			activity: "reviewing",
		},
		{
			role: "arch-reviewer",
			requiredCapabilities: ["design", "architecture"],
			minProficiency: 3,
			prompt:
				"You are the Architecture Reviewer. Analyze design completeness, scalability, and integration constraints.",
			count: 1,
			activity: "reviewing architecture",
		},
	],
	FIX: [
		{
			role: "fix-agent",
			requiredCapabilities: ["code"],
			minProficiency: 3,
			prompt: "You are a Fix Agent. Implement code changes to resolve issues.",
			count: 1,
			activity: "fixing",
		},
	],
	DEVELOP: [
		{
			role: "developer",
			requiredCapabilities: ["code"],
			minProficiency: 3,
			prompt:
				"You are a Senior Developer. Implement all acceptance criteria. Write production code and tests.",
			count: 1,
			activity: "implementing",
		},
		{
			role: "skeptic-beta",
			requiredCapabilities: ["review", "code"],
			minProficiency: 2,
			prompt:
				"You are SKEPTIC BETA. Review implementation quality. Check test coverage. Validate error handling.",
			count: 1,
			activity: "reviewing code",
		},
	],
	MERGE: [
		{
			role: "merge-agent",
			requiredCapabilities: ["devops", "terminal"],
			minProficiency: 2,
			prompt:
				"You are a Git Specialist. Integrate branches, resolve conflicts, run tests.",
			count: 1,
			activity: "integrating",
		},
	],
	COMPLETE: [
		{
			role: "documenter",
			requiredCapabilities: ["docs"],
			minProficiency: 2,
			prompt:
				"You are a Documenter. Write documentation for completed proposals.",
			count: 1,
			activity: "documenting",
		},
	],
	DEPLOYED: [
		{
			role: "system-monitor",
			requiredCapabilities: ["ops", "devops"],
			minProficiency: 2,
			prompt:
				"You are the System Monitor. Spot inconsistencies. Make proposals for rectifications.",
			count: 1,
			activity: "monitoring",
		},
	],
};

// Legacy fallback — used when capability matching returns too few agents
const AGENT_DISPATCH: Record<string, string[]> = {
	DRAFT: ["architect", "researcher"],
	TRIAGE: ["triage-agent", "system-monitor"],
	REVIEW: [
		"reviewer",
		"skeptic-alpha",
		"skeptic-beta",
		"architecture-reviewer",
	],
	FIX: ["fix-agent", "developer"],
	DEVELOP: ["developer", "skeptic-beta", "token-tracker"],
	MERGE: ["merge-agent", "git-specialist", "messaging-tester"],
	COMPLETE: ["documenter", "pillar-researcher"],
	DEPLOYED: ["system-monitor", "token-tracker"],
};

// Agent prompts
const AGENT_PROMPTS: Record<string, string> = {
	architect:
		"You are an Architecture Agent. Enhance this DRAFT proposal with acceptance criteria, design rationale, and implementation plan.",
	reviewer:
		"You are an RFC Reviewer. Evaluate this proposal for coherence, economic optimization, and structural soundness.",
	"skeptic-alpha":
		"You are SKEPTIC ALPHA. Challenge this proposal's design decisions. Demand evidence. Question assumptions.",
	"skeptic-beta":
		"You are SKEPTIC BETA. Review implementation quality. Check test coverage. Validate error handling.",
	"architecture-reviewer":
		"You are the Architecture Reviewer. Analyze design completeness, scalability, and integration constraints.",
	developer:
		"You are a Senior Developer. Implement all acceptance criteria. Write production code and tests.",
	"git-specialist":
		"You are a Git Specialist. Integrate branches, resolve conflicts, run tests.",
	"token-tracker":
		"You are the Token Efficiency Agent. Track usage, calculate costs, suggest optimizations.",
	"messaging-tester":
		"You are the Messaging Tester. Test A2A communication. Verify channel subscriptions.",
	"system-monitor":
		"You are the System Monitor. Spot inconsistencies. Make proposals for rectifications.",
	"pillar-researcher":
		"You are the Pillar Researcher. Research complementary components. Propose refinements.",
	documenter:
		"You are a Documenter. Write documentation for completed proposals.",
	researcher:
		"You are a Researcher. Gather context for proposals that need investigation.",
	"triage-agent":
		"You are a Triage Agent. Evaluate issues and decide what to work on.",
	"fix-agent": "You are a Fix Agent. Implement code changes to resolve issues.",
};

// ─── Capability-Based Agent Matching ─────────────────────────────────────────

interface AgentCandidate {
	agentIdentity: string;
	agentRole: string | null;
	skills: string[] | null;
	trustTier: string;
	capabilities: Array<{ cap: string; prof: number }>;
	activeLeases: number;
}

/**
 * Score an agent against a role slot.
 * Higher score = better fit.
 */
function scoreAgentForRole(agent: AgentCandidate, slot: RoleSlot): number {
	let score = 0;

	// Capability match from agent_capability table
	for (const ac of agent.capabilities) {
		if (
			slot.requiredCapabilities.includes(ac.cap) &&
			ac.prof >= slot.minProficiency
		) {
			score += Math.min(ac.prof, 5) * 2;
		}
	}

	// Capability match from skills jsonb (fallback signal)
	if (Array.isArray(agent.skills)) {
		for (const skill of agent.skills) {
			if (slot.requiredCapabilities.includes(skill)) {
				score += 5;
			}
		}
	}

	// Role alignment bonus — agent's declared role matches the slot
	if (agent.agentRole) {
		const roleLower = agent.agentRole.toLowerCase();
		const slotLower = slot.role.toLowerCase();
		if (roleLower.includes(slotLower) || slotLower.includes(roleLower)) {
			score += 10;
		}
	}

	// Workload penalty — prefer less loaded agents
	score -= agent.activeLeases * 5;

	// Trust bonus
	switch (agent.trustTier) {
		case "authority":
			score += 15;
			break;
		case "trusted":
			score += 10;
			break;
		case "known":
			score += 5;
			break;
	}

	return score;
}

interface MatchedAgent {
	agentIdentity: string;
	role: string;
	requiredCapabilities: string[];
	prompt: string;
	score: number;
	activity: string;
}

/**
 * Query the DB for active agents and score them against the role slots
 * required for a given proposal state. Returns the best-fit agents,
 * one per role slot (up to the slot's count).
 */
async function matchAgentsForState(state: string): Promise<MatchedAgent[]> {
	const slots = JOB_ROLES[state];
	if (!slots || slots.length === 0) return [];

	// Single query: fetch all active agents with capabilities, skills, workload
	const { rows } = await query<{
		agent_identity: string;
		role: string | null;
		skills: string[] | null;
		trust_tier: string;
		capabilities: Array<{ cap: string; prof: number }>;
		active_leases: number;
	}>(
		`SELECT
			ar.agent_identity,
			ar.role,
			ar.skills,
			ar.trust_tier,
			COALESCE(
				(SELECT jsonb_agg(jsonb_build_object('cap', ac.capability, 'prof', ac.proficiency))
				 FROM roadmap_workforce.agent_capability ac WHERE ac.agent_id = ar.id),
				'[]'::jsonb
			) AS capabilities,
			COALESCE(aw.active_lease_count, 0) AS active_leases
		FROM roadmap_workforce.agent_registry ar
		LEFT JOIN roadmap_workforce.agent_workload aw ON aw.agent_id = ar.id
		WHERE ar.status = 'active'
		  AND ar.agent_type IN ('llm', 'tool', 'hybrid')`,
	);

	const agents: AgentCandidate[] = rows.map((r) => ({
		agentIdentity: r.agent_identity,
		agentRole: r.role,
		skills: r.skills,
		trustTier: r.trust_tier,
		capabilities: r.capabilities ?? [],
		activeLeases: r.active_leases,
	}));

	const matched: MatchedAgent[] = [];
	const used = new Set<string>(); // no double-booking within one dispatch

	for (const slot of slots) {
		// Score all agents against this slot, exclude already-used agents
		const scored = agents
			.filter((a) => !used.has(a.agentIdentity))
			.map((a) => ({
				agentIdentity: a.agentIdentity,
				role: slot.role,
				requiredCapabilities: slot.requiredCapabilities,
				prompt: slot.prompt,
				score: scoreAgentForRole(a, slot),
				activity: slot.activity,
			}))
			.filter((s) => s.score > 0) // must have at least some capability match
			.sort((a, b) => b.score - a.score);

		// Pick top N agents for this slot
		const picks = scored.slice(0, slot.count);
		for (const pick of picks) {
			matched.push(pick);
			used.add(pick.agentIdentity);
		}

		if (picks.length < slot.count) {
			logger.warn(
				`Only ${picks.length}/${slot.count} agents matched for role "${slot.role}" in ${state} (needed capabilities: ${slot.requiredCapabilities.join(", ")})`,
			);
		}
	}

	return matched;
}

// ─── Provider Health & Dynamic Control ─────────────────────────────────────

const RATE_LIMIT_PATTERNS = [
	/rate.?limit/i,
	/429/,
	/too many requests/i,
	/throttle/i,
	/retry.?after/i,
	/rpm.?exceeded/i,
	/tpm.?exceeded/i,
];

const CREDIT_PATTERNS = [
	/credit/i,
	/insufficient.?funds/i,
	/billing/i,
	/quota.?exceeded/i,
	/usage.?limit/i,
	/budget.?exceeded/i,
];

/**
 * Classify an error string into rate_limit, credit_exhausted, or unknown.
 */
function classifyProviderError(stderr: string): {
	type: "rate_limit" | "credit_exhausted" | "unknown";
	matched: string;
} | null {
	for (const pat of RATE_LIMIT_PATTERNS) {
		const m = stderr.match(pat);
		if (m) return { type: "rate_limit", matched: m[0] };
	}
	for (const pat of CREDIT_PATTERNS) {
		const m = stderr.match(pat);
		if (m) return { type: "credit_exhausted", matched: m[0] };
	}
	return null;
}

/**
 * Check if a provider is in cooldown. Returns true if provider should NOT be used.
 */
async function isProviderInCooldown(provider: string): Promise<boolean> {
	const { rows } = await query<{ in_cooldown: boolean }>(
		`SELECT (cooldown_until IS NOT NULL AND cooldown_until > now()) AS in_cooldown
       FROM roadmap.provider_health
       WHERE provider_name = $1`,
		[provider],
	);
	return rows[0]?.in_cooldown ?? false;
}

/**
 * Set cooldown on a provider. rate_limit: 2min backoff, credit_exhausted: 30min.
 */
async function setProviderCooldown(
	provider: string,
	errorType: "rate_limit" | "credit_exhausted",
	errorMsg: string,
): Promise<void> {
	const cooldownMinutes = errorType === "rate_limit" ? 2 : 30;
	await query(
		`INSERT INTO roadmap.provider_health
       (provider_name, status, last_error_at, last_error_msg, error_count, cooldown_until, updated_at)
     VALUES ($1, $2, now(), $3, 1, now() + interval '${cooldownMinutes} minutes', now())
     ON CONFLICT (provider_name) DO UPDATE SET
       status = EXCLUDED.status,
       last_error_at = now(),
       last_error_msg = EXCLUDED.last_error_msg,
       error_count = roadmap.provider_health.error_count + 1,
       cooldown_until = now() + interval '${cooldownMinutes} minutes',
       updated_at = now()`,
		[
			provider,
			errorType === "rate_limit" ? "rate_limited" : "credit_exhausted",
			errorMsg.slice(0, 500),
		],
	);
	logger.warn(
		`⏱ Provider ${provider} → ${errorType}, cooldown ${cooldownMinutes}min: ${errorMsg.slice(0, 100)}`,
	);
}

/**
 * Record a successful run for a provider (resets error_count, clears cooldown).
 */
async function recordProviderSuccess(provider: string): Promise<void> {
	await query(
		`UPDATE roadmap.provider_health
        SET status = 'healthy', error_count = 0, cooldown_until = NULL,
            last_success_at = now(), updated_at = now()
      WHERE provider_name = $1`,
		[provider],
	);
}

type TransitionQueueRow = {
	id: number;
	proposal_id: number;
	display_id: string | null;
	from_stage: string;
	to_stage: string;
	gate: string | null;
	status: string;
	attempt_count: number;
	max_attempts: number;
	metadata: Record<string, unknown> | null;
};

type GateDefinition = {
	gate: "D1" | "D2" | "D3" | "D4";
	toStage: "Review" | "Develop" | "Merge" | "Complete";
};

type GateReadyProposal = {
	id: number;
	display_id: string;
	status: string;
	maturity: string;
	title: string;
	summary: string | null;
	leased_by: string | null;
	active_dispatch_id: number | null;
};

type ExecutorCandidate = {
	worktree: string;
	source: string;
	score: number;
};

function normalizeState(state: string): string {
	return state.trim().toUpperCase();
}

function inferGateForState(state: string): GateDefinition | null {
	switch (normalizeState(state)) {
		case "DRAFT":
			return { gate: "D1", toStage: "Review" };
		case "REVIEW":
			return { gate: "D2", toStage: "Develop" };
		case "DEVELOP":
			return { gate: "D3", toStage: "Merge" };
		case "MERGE":
			return { gate: "D4", toStage: "Complete" };
		default:
			return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
	record: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(
	record: Record<string, unknown> | null | undefined,
	key: string,
): number | null {
	const value = record?.[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (
		typeof value === "string" &&
		value.trim() &&
		Number.isFinite(Number(value))
	) {
		return Number(value);
	}
	return null;
}

function normalizeWorktreeIdentity(value: string): string {
	return basename(value.trim().replaceAll("/", "-"));
}

/**
 * P405: Resolve the active route provider from model_routes.
 * Worktrees are filesystem contexts, not provider constraints.
 */

async function scoreUsableWorktree(
	worktree: string,
	source: string,
): Promise<ExecutorCandidate | null> {
	const normalized = normalizeWorktreeIdentity(worktree);
	if (!normalized || normalized === "." || normalized === "..") return null;
	const dir = join(WORKTREE_ROOT, normalized);
	try {
		const dirStat = await stat(dir);
		if (!dirStat.isDirectory()) return null;
		await access(join(dir, ".env.agent"), fsConstants.R_OK);
		await access(dir, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);

		const currentUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		const ownedByCurrentUser =
			currentUid !== null && dirStat.uid === currentUid;
		const currentWorktree = normalized === basename(process.cwd());
		return {
			worktree: normalized,
			source,
			score:
				(ownedByCurrentUser ? 100 : 0) +
				(currentWorktree ? 20 : 0) +
				(source === "metadata" ? 15 : 0) +
				(source === "env" ? 10 : 0),
		};
	} catch {
		return null;
	}
}

async function listEnvAgentWorktrees(): Promise<string[]> {
	try {
		const entries = await readdir(WORKTREE_ROOT, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function selectExecutorWorktree(
	requested?: string | null,
): Promise<string> {
	const candidates: ExecutorCandidate[] = [];

	for (const [worktree, source] of [
		[requested, "metadata"],
		[DEFAULT_EXECUTOR_WORKTREE, "env"],
	] as Array<[string | null | undefined, string]>) {
		if (!worktree) continue;
		const candidate = await scoreUsableWorktree(worktree, source);
		if (candidate) candidates.push(candidate);
		else
			logger.warn(
				`Executor worktree "${worktree}" from ${source} is not usable by ${process.env.USER ?? "current user"}`,
			);
	}

	const { rows } = await query<{ agent_identity: string; role: string | null }>(
		`SELECT agent_identity, role
       FROM roadmap_workforce.agent_registry
      WHERE status = 'active'
        AND agent_type IN ('llm', 'tool')
      ORDER BY
        CASE WHEN role ILIKE '%gate%' THEN 0 ELSE 1 END,
        updated_at DESC NULLS LAST,
        agent_identity`,
	);
	for (const row of rows) {
		const candidate = await scoreUsableWorktree(row.agent_identity, "registry");
		if (candidate) candidates.push(candidate);
	}

	for (const worktree of await listEnvAgentWorktrees()) {
		const candidate = await scoreUsableWorktree(worktree, "filesystem");
		if (candidate) candidates.push(candidate);
	}

	const deduped = new Map<string, ExecutorCandidate>();
	for (const candidate of candidates) {
		const current = deduped.get(candidate.worktree);
		if (!current || candidate.score > current.score) {
			deduped.set(candidate.worktree, candidate);
		}
	}

	// P405: worktree is a filesystem context, not a provider constraint.
	// Provider/model are resolved from model_routes at spawn time.
	const ranked = Array.from(deduped.values()).sort(
		(a, b) => b.score - a.score || a.worktree.localeCompare(b.worktree),
	);
	if (!ranked.length) {
		throw new Error(
			`No usable executor worktree found under ${WORKTREE_ROOT}. Create one such as codex-one/codex-two with a readable .env.agent and write access for ${process.env.USER ?? "the orchestrator user"}.`,
		);
	}
	// Pick randomly from top scorers (within 10 points of best) for load distribution
	const bestScore = ranked[0].score;
	const topTier = ranked.filter((c) => c.score >= bestScore - 10);
	const selected = topTier[Math.floor(Math.random() * topTier.length)];
	logger.log(
		`Selected executor ${selected.worktree} (${selected.source}, score=${selected.score}) [${topTier.length} candidates]`,
	);
	return selected.worktree;
}

// Parse MCP tool response safely — returns null if response is error text
// biome-ignore lint/suspicious/noExplicitAny: MCP tool payloads are dynamic JSON.
function safeParseMcpResponse(text: string | undefined): any {
	if (!text) return null;
	// "No cubics found." is a valid empty result, not an error
	if (text.startsWith("No ") && text.endsWith("found.")) return { cubics: [] };
	if (
		text.startsWith("⚠️") ||
		text.startsWith("Error") ||
		text.startsWith("Failed")
	) {
		logger.warn(`MCP tool returned error: ${text.substring(0, 120)}`);
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		logger.warn(`MCP tool returned non-JSON: ${text.substring(0, 120)}`);
		return null;
	}
}

// Dispatch agent to cubic — uses cubic_acquire for atomic find-or-create + focus
async function dispatchAgent(
	agent: string,
	proposalId: string,
	task: string,
	phase: string,
	stage: string,
	agentLabel?: string,
	activity?: string,
	requiredCapabilities: string[] = [],
): Promise<string | null> {
	const client = new Client({ name: "orchestrator", version: "1.0.0" });
	const transport = new SSEClientTransport(new URL(MCP_URL));

	try {
		const selectedWorktree = await selectExecutorWorktree(agent);
		const selectedWorktreePath = join(WORKTREE_ROOT, selectedWorktree);

		await client.connect(transport);

		// Single MCP call replaces: cubic_list → cubic_recycle → cubic_focus
		const acquired = await client.callTool({
			name: "cubic_acquire",
			arguments: {
				agent_identity: agent,
				proposal_id: Number(proposalId),
				phase,
				worktree_path: selectedWorktreePath,
			},
		});
		const data = safeParseMcpResponse(mcpText(acquired));

		if (!data?.success || !data?.cubic_id) {
			logger.warn(
				`cubic_acquire failed for ${agent} on P${proposalId}: ${mcpText(acquired)?.substring(0, 120)}`,
			);
			return null;
		}

		const cubicId = data.cubic_id as string;
		const verb = data.was_created
			? "📦 New"
			: data.was_recycled
				? "♻️ Recycled"
				: "🔄 Reused";
		logger.log(
			`${verb} cubic ${cubicId.substring(0, 8)} for ${agent} → P${proposalId} (${phase})`,
		);

		const taskPrompt = `${task}\n\nUse the MCP tools to do your work. Connect to ${getMcpUrl()} for proposal management.`;

		if (USE_OFFER_DISPATCH) {
			// Post a work offer — any registered agency (e.g. copilot/agency-gary)
			// will race to claim it and spawn the appropriate CLI. The orchestrator
			// does not need to know the binary path or credentials.
			const squadName = `P${proposalId}-${phase}`;
			const { dispatchId } = await postWorkOffer({
				proposalId: Number(proposalId),
				squadName,
				role: agentLabel ?? agent,
				task: taskPrompt,
				stage,
				phase,
				timeoutMs: 600_000,
				worktreeHint: agent,
				requiredCapabilities:
					requiredCapabilities.length > 0
						? requiredCapabilities
						: [agentLabel ?? agent],
			});
			logger.log(
				`📬 Posted offer ${dispatchId} for ${agent} on P${proposalId} (${stage})`,
			);
			return cubicId;
		}

		// Direct spawn path (used when AGENTHIVE_USE_OFFER_DISPATCH is not set)
		let worktree: string | null = selectedWorktree;
		const tried = new Set<string>();
		const { rows: selectedRuns } = await query<{ cnt: number }>(
			`SELECT count(*)::int AS cnt FROM agent_runs
		      WHERE display_id LIKE '%' || $1 || '%'
		        AND status = 'running'`,
			[selectedWorktree],
		);
		if (selectedRuns[0]?.cnt) {
			logger.log(
				`⏭ ${selectedWorktree} busy (${selectedRuns[0].cnt} running) — trying another`,
			);
			worktree = null;
		}
		for (let attempt = 0; attempt < 5; attempt++) {
			if (worktree) break;
			const candidate = await selectExecutorWorktree(null);
			if (!candidate) break;
			if (tried.has(candidate)) break;
			tried.add(candidate);
			const { rows } = await query<{ cnt: number }>(
				`SELECT count(*)::int AS cnt FROM agent_runs
			      WHERE display_id LIKE '%' || $1 || '%'
			        AND status = 'running'`,
				[candidate],
			);
			if (rows[0]?.cnt) {
				logger.log(
					`⏭ ${candidate} busy (${rows[0].cnt} running) — trying another`,
				);
				continue;
			}
			worktree = candidate;
			break;
		}
		if (!worktree) {
			logger.warn(
				`No free worktree for ${agent} on P${proposalId} — skipping dispatch`,
			);
			return null;
		}
		// P405: resolve provider from model_routes, not worktree metadata
		const activeProvider = await resolveActiveRouteProvider();
		const result = await spawnAgent({
			worktree,
			task: taskPrompt,
			proposalId: Number(proposalId),
			stage,
			timeoutMs: 600_000,
			provider: activeProvider ?? undefined,
			agentLabel: agentLabel ?? agent,
			activity,
		});

		if (result.exitCode === 0) {
			logger.log(
				`✅ ${agent} completed (run=${result.agentRunId}) for P${proposalId}`,
			);
			// Record provider success — clears any cooldown
			if (activeProvider) {
				try {
					await recordProviderSuccess(activeProvider);
				} catch {}
			}
		} else {
			logger.warn(
				`⚠️ ${agent} exited ${result.exitCode} (run=${result.agentRunId}) for P${proposalId}`,
			);
			// Dynamic control: classify error, set cooldown
			const fullError = [result.stderr, result.stdout]
				.filter(Boolean)
				.join("\n");
			const classified = classifyProviderError(fullError);
			if (classified && activeProvider) {
				try {
					await setProviderCooldown(activeProvider, classified.type, fullError);
				} catch {}
			}
		}

		return cubicId;
	} catch (err) {
		logger.error(`Dispatch failed for ${agent} on P${proposalId}:`, err);
		return null;
	} finally {
		await client.close();
	}
}

// Handle state change and dispatch agents
async function handleStateChange(proposalId: string, newState: string) {
	const normalizedState = normalizeState(newState);

	const phase = STATE_TO_PHASE[normalizedState] || "design";

	// Skip if this proposal already has a running agent (prevents re-dispatch every poll cycle)
	const { rows: runningRows } = await query<{ cnt: number }>(
		`SELECT count(*)::int AS cnt FROM agent_runs
	      WHERE proposal_id = $1 AND status = 'running'`,
		[proposalId],
	);
	if (runningRows[0]?.cnt) {
		logger.log(
			`⏭ P${proposalId} → ${newState}: already has ${runningRows[0].cnt} running agent(s) — skipping`,
		);
		return;
	}

	const { rows: activeDispatchRows } = await query<{ cnt: number }>(
		`SELECT count(*)::int AS cnt
		   FROM roadmap_workforce.squad_dispatch
		  WHERE proposal_id = $1
		    AND (
		      completed_at IS NULL
		      OR dispatch_status IN ('assigned', 'active', 'blocked')
		      OR offer_status IN ('open', 'claimed', 'activated')
		    )`,
		[proposalId],
	);
	if (activeDispatchRows[0]?.cnt) {
		logger.log(
			`⏭ P${proposalId} → ${newState}: already has ${activeDispatchRows[0].cnt} active dispatch(es) — skipping`,
		);
		return;
	}

	// Release any locked cubics for this proposal from previous phases
	await releaseStaleCubics(proposalId);

	// Dynamic control: check if provider is in cooldown before dispatching
	try {
		const activeProvider = await resolveActiveRouteProvider();
		if (activeProvider && (await isProviderInCooldown(activeProvider))) {
			logger.log(
				`⏸ Skipping P${proposalId} (${newState}): provider ${activeProvider} is in cooldown`,
			);
			return;
		}
	} catch {
		// Provider resolution failed — let dispatch handle it
	}

	// Capability-based agent matching
	let matchedAgents = await matchAgentsForState(normalizedState);

	// Fallback to hardcoded dispatch if capability matching returns too few
	const fallbackAgents = AGENT_DISPATCH[normalizedState];
	if (
		matchedAgents.length === 0 &&
		fallbackAgents &&
		fallbackAgents.length > 0
	) {
		logger.warn(
			`⚠ No capability-matched agents for ${normalizedState} — falling back to hardcoded dispatch`,
		);
		matchedAgents = fallbackAgents.map((agent) => ({
			agentIdentity: agent,
			role: agent,
			requiredCapabilities: [agent],
			prompt: AGENT_PROMPTS[agent] || `Handle ${newState}`,
			score: 0,
			activity: "working",
		}));
	}

	if (matchedAgents.length === 0) {
		logger.log(`No agents for state: ${newState}`);
		return;
	}

	logger.log(`📢 P${proposalId} → ${newState} (${phase})`);
	for (const m of matchedAgents) {
		logger.log(`   → ${m.agentIdentity} as ${m.role} (score=${m.score})`);
	}

	// Dispatch all matched agents (parallel, tolerate individual failures)
	const results = await Promise.allSettled(
		matchedAgents.map((m) =>
			dispatchAgent(
				m.agentIdentity,
				proposalId,
				m.prompt,
				phase,
				normalizedState,
				m.role,
				m.activity,
				m.requiredCapabilities,
			),
		),
	);
	const dispatched = results.filter(
		(r) => r.status === "fulfilled" && r.value,
	).length;
	logger.log(`   ${dispatched}/${matchedAgents.length} dispatched`);
}

async function ensureAgentIdentity(
	agentIdentity: string,
	role: string,
): Promise<void> {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, status)
     VALUES ($1, 'tool', $2, 'active')
     ON CONFLICT (agent_identity) DO UPDATE
       SET role = COALESCE(roadmap_workforce.agent_registry.role, EXCLUDED.role),
           status = 'active'`,
		[agentIdentity, role],
	);
}

async function recordGateCommunication(input: {
	proposalId: number;
	author: string;
	toAgent: string;
	channel: string;
	contextPrefix: string;
	body: string;
	metadata: Record<string, unknown>;
}): Promise<void> {
	await query(
		`INSERT INTO roadmap_proposal.proposal_discussions
       (proposal_id, author_identity, context_prefix, body, body_markdown)
     VALUES ($1, $2, $3, $4, $4)`,
		[input.proposalId, input.author, input.contextPrefix, input.body],
	);
	await query(
		`INSERT INTO roadmap.message_ledger
       (from_agent, to_agent, channel, message_type, message_content, proposal_id)
     VALUES ($1, $2, $3, 'event', $4, $5)`,
		[input.author, input.toAgent, input.channel, input.body, input.proposalId],
	);
	await query(
		`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
     VALUES ($1, 'decision_made', $2::jsonb)`,
		[input.proposalId, JSON.stringify(input.metadata)],
	);
}

async function setProposalMaturity(
	proposalId: number,
	maturity: "new" | "active" | "mature" | "obsolete",
	agentIdentity: string,
	reason: string,
): Promise<void> {
	await query(
		`WITH _actor AS (
       SELECT set_config('app.agent_identity', $1, true) AS agent_identity
     )
     UPDATE roadmap_proposal.proposal
        SET maturity = $2,
            modified_at = now()
       FROM _actor
      WHERE id = $3
        AND maturity IS DISTINCT FROM $2`,
		[agentIdentity, maturity, proposalId],
	);
	await query(
		`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
     VALUES ($1, 'maturity_changed', $2::jsonb)`,
		[
			proposalId,
			JSON.stringify({
				maturity,
				agent: agentIdentity,
				reason,
				source: "implicit_maturity_gating",
			}),
		],
	);
}

async function releaseDispatchLease(
	dispatchId: number | undefined,
	reason: string,
): Promise<void> {
	if (!dispatchId) return;
	await query(
		`UPDATE roadmap_proposal.proposal_lease pl
        SET released_at = now(),
            release_reason = $2
       FROM roadmap_workforce.squad_dispatch sd
      WHERE sd.id = $1
        AND pl.id = sd.lease_id
        AND pl.released_at IS NULL`,
		[dispatchId, reason],
	);
}

// Maps each gate to the dispatch role that should review it and a framing line
// for the task. D1 uses a skeptic to challenge Draft RFCs; D2 uses an architect
// to validate design; D3 uses a skeptic to review implementation; D4 validates
// integration and deployment readiness.
const GATE_ROLES: Record<string, { role: string; framing: string }> = {
	D1: {
		role: "skeptic-alpha",
		framing:
			"You are SKEPTIC ALPHA. Challenge this Draft RFC hard. Demand evidence. Question every assumption. " +
			"Verify ACs are measurable and complete. Only advance if the RFC is coherent, economically sound, and structurally ready for Review.",
	},
	D2: {
		role: "architecture-reviewer",
		framing:
			"You are the Architecture Reviewer. Validate design completeness, scalability, integration constraints, and dependency health. " +
			"Only advance if the proposal is ready to be built.",
	},
	D3: {
		role: "skeptic-beta",
		framing:
			"You are SKEPTIC BETA. Review implementation quality: test coverage, error handling, edge cases, and AC verification. " +
			"Only advance if all ACs are met and the implementation is production-ready.",
	},
	D4: {
		role: "gate-reviewer",
		framing:
			"You are the Integration Reviewer. Validate that the merge is clean, tests pass, and the feature is deployable. " +
			"Only advance if the integration is stable.",
	},
};

function gateRole(gate: GateDefinition): string {
	return GATE_ROLES[gate.gate]?.role ?? "gate-reviewer";
}

function buildImplicitGateTask(
	proposal: GateReadyProposal,
	gate: GateDefinition,
): string {
	const roleConfig = GATE_ROLES[gate.gate];
	return [
		roleConfig
			? roleConfig.framing
			: `Process implicit maturity gate ${gate.gate} for ${proposal.display_id}.`,
		"",
		`Proposal: ${proposal.display_id}`,
		`Title: ${proposal.title}`,
		`Current state: ${proposal.status}`,
		`Current maturity: ${proposal.maturity}`,
		`Target transition: ${proposal.status} -> ${gate.toStage}`,
		"",
		proposal.summary ? `Summary: ${proposal.summary}` : null,
		"",
		"Use MCP proposal tools to read the full YAML+Markdown projection, discussions, acceptance criteria, and advisory context.",
		"",
		"Decision rules:",
		`- advance: call prop_transition to ${gate.toStage} with reason=decision and concrete decision notes, then set maturity to new.`,
		"- send_back/hold/reject: keep the workflow state, record concrete feedback through MCP discussion/message/event paths, and set maturity to new.",
		"- obsolete: set maturity to obsolete and record the reason.",
		"",
		"Dependency rule:",
		"- Do not reject or hold this gate solely because dependencies are unresolved.",
		"- Dependencies carry forward after an advance and may block later work or later advancement when the next state needs them resolved.",
		"",
		"This is not a transition_queue job. The proposal maturity is the implicit queue signal, and your gate lease must be released after the decision.",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

async function claimImplicitGateReady(
	proposalId?: number,
	limit = 5,
): Promise<GateReadyProposal[]> {
	const { rows } = await query<GateReadyProposal>(
		`SELECT p.id,
            p.display_id,
            p.status,
            p.maturity,
            p.title,
            p.summary,
            lease.agent_identity AS leased_by,
            dispatch.id AS active_dispatch_id
       FROM roadmap_proposal.proposal p
       LEFT JOIN LATERAL (
         SELECT pl.agent_identity
           FROM roadmap_proposal.proposal_lease pl
          WHERE pl.proposal_id = p.id
            AND pl.released_at IS NULL
          ORDER BY pl.claimed_at DESC
          LIMIT 1
       ) lease ON true
       LEFT JOIN LATERAL (
         SELECT sd.id
           FROM roadmap_workforce.squad_dispatch sd
          WHERE sd.proposal_id = p.id
            AND sd.dispatch_role LIKE 'skeptic%'
            AND sd.dispatch_status IN ('active', 'open')
            AND sd.metadata->>'source' = 'implicit_maturity_gating'
          ORDER BY sd.assigned_at DESC
          LIMIT 1
       ) dispatch ON true
      WHERE p.maturity = 'mature'
        AND LOWER(p.status) IN ('draft', 'review', 'develop', 'merge')
        AND dispatch.id IS NULL
        AND ($1::bigint IS NULL OR p.id = $1)
      ORDER BY p.modified_at ASC, p.id ASC
      LIMIT $2`,
		[proposalId ?? null, limit],
	);
	return rows;
}

async function dispatchImplicitGate(
	proposalId: number,
	reason: string,
): Promise<void> {
	// Gate dispatch ONLY for maturity='mature'. new/active = enhancement queue, not gating.
	const [proposal] = await claimImplicitGateReady(proposalId, 1);
	if (!proposal) {
		return;
	}

	// Defense in depth: re-check maturity at dispatch time
	if (proposal.maturity !== "mature") {
		logger.log(
			`Skipping gate for ${proposal.display_id}: maturity=${proposal.maturity}, not mature`,
		);
		return;
	}

	const gate = inferGateForState(proposal.status);
	if (!gate) {
		return;
	}

	if (proposal.active_dispatch_id) {
		logger.log(
			`Implicit gate ${gate.gate} for ${proposal.display_id} already has active dispatch ${proposal.active_dispatch_id}`,
		);
		return;
	}

	if (proposal.leased_by) {
		logger.log(
			`Implicit gate ${gate.gate} for ${proposal.display_id} waits for active lease held by ${proposal.leased_by}`,
		);
		return;
	}

	const worktree = await selectExecutorWorktree(null);

	// Dynamic control: check if provider is in cooldown before dispatching
	try {
		const activeProvider = await resolveActiveRouteProvider();
		if (activeProvider && (await isProviderInCooldown(activeProvider))) {
			logger.log(
				`⏸ Skipping ${proposal.display_id}: provider ${activeProvider} is in cooldown`,
			);
			return;
		}
	} catch {
		// Provider resolution failed — let spawn handle the error
	}

	await ensureAgentIdentity("orchestrator", "State Machine Orchestrator");
	await ensureAgentIdentity(worktree, "Gate Executor");

	const role = gateRole(gate);
	const { rows: dispatchRows } = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
       (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
        assigned_by, metadata)
     VALUES ($1, $2, $3, $8, 'active', 'orchestrator',
       jsonb_build_object(
         'source', 'implicit_maturity_gating',
         'reason', $4::text,
         'gate', $5::text,
         'from_stage', $6::text,
         'to_stage', $7::text,
         'stage', 'gate:' || $7::text
       ))
     RETURNING id`,
		[
			proposal.id,
			worktree,
			`gate-${proposal.display_id}-${gate.gate}`,
			reason,
			gate.gate,
			proposal.status,
			gate.toStage,
			role,
		],
	);
	const dispatchId = dispatchRows[0]?.id;
	logger.log(
		`Implicit gate dispatch ${dispatchId} -> ${worktree} for ${proposal.display_id} (${proposal.status} -> ${gate.toStage}, ${gate.gate})`,
	);

	let result: Awaited<ReturnType<typeof spawnAgent>>;
	// P405: resolve provider from model_routes, not worktree metadata
	const activeProvider = await resolveActiveRouteProvider();
	try {
		result = await spawnAgent({
			worktree,
			task: buildImplicitGateTask(proposal, gate),
			proposalId: proposal.id,
			stage: `gate:${gate.toStage.toUpperCase()}`,
			timeoutMs: 600_000,
			provider: activeProvider ?? undefined,
		});
	} catch (spawnErr) {
		const errMsg =
			spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
		await query(
			`UPDATE roadmap_workforce.squad_dispatch
	        SET dispatch_status = 'blocked',
	            completed_at = now(),
	            metadata = COALESCE(metadata, '{}'::jsonb) ||
	              jsonb_build_object('error', $2::text)
	      WHERE id = $1`,
			[dispatchId, errMsg],
		);
		await releaseDispatchLease(
			dispatchId,
			`gate spawn failed: ${errMsg.slice(0, 500)}`,
		);
		logger.warn(
			`Implicit gate dispatch ${dispatchId} blocked (spawn threw): ${errMsg}`,
		);
		return;
	}

	const proposalState = await query<{ status: string; maturity: string }>(
		`SELECT status, maturity
       FROM roadmap_proposal.proposal
      WHERE id = $1`,
		[proposal.id],
	);
	const current = proposalState.rows[0];
	const reachedTarget =
		current && normalizeState(current.status) === normalizeState(gate.toStage);

	if (result.exitCode === 0 && reachedTarget) {
		await setProposalMaturity(
			proposal.id,
			"new",
			worktree,
			`gate ${gate.gate} advanced to ${gate.toStage}`,
		);
		await query(
			`UPDATE roadmap_workforce.squad_dispatch
          SET dispatch_status = 'completed',
              completed_at = now(),
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object('agent_run_id', $2::text, 'gate_decision', 'advance', 'proposal_status', $3::text, 'proposal_maturity', 'new')
        WHERE id = $1`,
			[dispatchId, result.agentRunId, gate.toStage],
		);
		await releaseDispatchLease(
			dispatchId,
			`gate ${gate.gate} advanced to ${gate.toStage}`,
		);
		logger.log(
			`Implicit gate dispatch ${dispatchId} advanced ${proposal.display_id} to ${gate.toStage}/new`,
		);
		return;
	}

	if (result.exitCode === 0 && current) {
		const finalMaturity =
			normalizeState(current.maturity) === "OBSOLETE" ? "obsolete" : "new";
		if (finalMaturity === "new") {
			await setProposalMaturity(
				proposal.id,
				"new",
				worktree,
				`gate ${gate.gate} sent back or held`,
			);
		}
		const decisionMessage = `gate decision completed without state transition: proposal is ${current.status}/${finalMaturity}`;
		await recordGateCommunication({
			proposalId: proposal.id,
			author: worktree,
			toAgent: "orchestrator",
			channel: "direct",
			contextPrefix: "feedback:",
			body: [
				`Gate ${gate.gate} held ${proposal.display_id}.`,
				`Target transition: ${proposal.status} -> ${gate.toStage}`,
				`Current proposal state: ${current.status}/${finalMaturity}`,
				"",
				"The gate agent made a non-transition decision. Continue the conversation through MCP discussions/messages, revise the proposal, then set maturity back to mature when it is ready for another gate attempt.",
			].join("\n"),
			metadata: {
				gate: gate.gate,
				gate_decision: finalMaturity === "obsolete" ? "obsolete" : "hold",
				proposal_status: current.status,
				proposal_maturity: finalMaturity,
				agent_run_id: result.agentRunId,
				source: "implicit_maturity_gating",
			},
		});
		await query(
			`UPDATE roadmap_workforce.squad_dispatch
          SET dispatch_status = 'completed',
              completed_at = now(),
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object('agent_run_id', $2::text, 'gate_decision', $3::text, 'proposal_status', $4::text, 'proposal_maturity', $5::text)
        WHERE id = $1`,
			[
				dispatchId,
				result.agentRunId,
				finalMaturity === "obsolete" ? "obsolete" : "hold",
				current.status,
				finalMaturity,
			],
		);
		await releaseDispatchLease(dispatchId, decisionMessage);
		logger.log(
			`Implicit gate dispatch ${dispatchId} held ${proposal.display_id}: ${decisionMessage}`,
		);
		return;
	}

	const errorMessage =
		result.exitCode === 0
			? `gate agent completed but proposal state could not be read`
			: `gate agent exited ${result.exitCode}: ${[result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 2000)}`;

	// Dynamic control: classify error and set provider cooldown if needed
	const fullError = [result.stderr, result.stdout].filter(Boolean).join("\n");
	const classified = classifyProviderError(fullError);
	if (classified && result.exitCode !== 0) {
		try {
			const provider = activeProvider ?? (await resolveActiveRouteProvider());
			if (provider) {
				await setProviderCooldown(provider, classified.type, fullError);
			}
		} catch {
			// Provider resolution failed — skip cooldown
		}
	}

	await query(
		`UPDATE roadmap_workforce.squad_dispatch
        SET dispatch_status = 'blocked',
            completed_at = now(),
            metadata = COALESCE(metadata, '{}'::jsonb) ||
              jsonb_build_object('agent_run_id', $2::text, 'error', $3::text)
      WHERE id = $1`,
		[dispatchId, result.agentRunId, errorMessage],
	);
	await releaseDispatchLease(
		dispatchId,
		`gate dispatch blocked: ${errorMessage.slice(0, 500)}`,
	);
	logger.warn(
		`Implicit gate dispatch ${dispatchId} blocked ${proposal.display_id}: ${errorMessage}`,
	);
}

async function drainImplicitGateReady(
	reason: string,
	limit = 5,
): Promise<void> {
	if (stopping) return;
	const proposals = await claimImplicitGateReady(undefined, limit);
	for (const proposal of proposals) {
		if (stopping) return;
		await trackInFlight(dispatchImplicitGate(proposal.id, reason));
	}
}

async function _dispatchTransitionQueue(queueId: number): Promise<void> {
	const { rows } = await query<TransitionQueueRow>(
		`SELECT tq.id, tq.proposal_id, p.display_id, tq.from_stage, tq.to_stage, tq.gate,
            tq.status, tq.attempt_count, tq.max_attempts, tq.metadata
       FROM roadmap.transition_queue tq
       JOIN roadmap_proposal.proposal p ON p.id = tq.proposal_id
      WHERE tq.id = $1`,
		[queueId],
	);
	const transition = rows[0];
	if (!transition) {
		logger.warn(`transition_queue ${queueId} not found`);
		return;
	}
	if (!["pending", "processing"].includes(transition.status)) {
		logger.log(
			`transition_queue ${queueId} is ${transition.status}; no dispatch needed`,
		);
		return;
	}

	const metadata = transition.metadata ?? {};
	const spawnMetadata = isRecord(metadata.spawn) ? metadata.spawn : null;
	const requestedWorktree =
		readString(spawnMetadata, "worktree") ?? readString(metadata, "worktree");
	const worktree = await selectExecutorWorktree(requestedWorktree);
	const task =
		readString(spawnMetadata, "task") ??
		readString(metadata, "task") ??
		[
			`Process transition_queue ${transition.id}.`,
			`Proposal: ${transition.display_id ?? transition.proposal_id}`,
			`Transition: ${transition.from_stage} -> ${transition.to_stage}`,
			"Use MCP proposal tools to make the gate decision.",
		].join("\n");
	const timeoutMs =
		readNumber(spawnMetadata, "timeoutMs") ??
		readNumber(spawnMetadata, "timeout_ms") ??
		600_000;

	await ensureAgentIdentity("orchestrator", "State Machine Orchestrator");
	await ensureAgentIdentity(worktree, "Gate Executor");
	const { rows: dispatchRows } = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
       (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
        assigned_by, metadata)
     VALUES ($1, $2, $3, 'gate-reviewer', 'active', 'orchestrator',
       jsonb_build_object(
         'transition_queue_id', $4::text,
         'from_stage', $5::text,
         'to_stage', $6::text,
         'stage', 'gate:' || $6::text
       ))
     RETURNING id`,
		[
			transition.proposal_id,
			worktree,
			`gate-${transition.display_id ?? transition.proposal_id}-${transition.to_stage}`,
			transition.id,
			transition.from_stage,
			transition.to_stage,
		],
	);
	const dispatchId = dispatchRows[0]?.id;

	logger.log(
		`Gate dispatch ${dispatchId} -> ${worktree} for ${transition.display_id ?? transition.proposal_id} (${transition.from_stage} -> ${transition.to_stage})`,
	);

	const result = await spawnAgent({
		worktree,
		task,
		proposalId: transition.proposal_id,
		stage: `gate:${transition.to_stage}`,
		timeoutMs,
	});

	const proposalState = await query<{ status: string; maturity: string }>(
		`SELECT status, maturity
       FROM roadmap_proposal.proposal
      WHERE id = $1`,
		[transition.proposal_id],
	);
	const current = proposalState.rows[0];
	const reachedTarget =
		current &&
		normalizeState(current.status) === normalizeState(transition.to_stage);

	if (result.exitCode === 0 && reachedTarget) {
		await query(
			`UPDATE roadmap.transition_queue
          SET status = 'done',
              completed_at = now(),
              last_error = NULL
        WHERE id = $1`,
			[transition.id],
		);
		await query(
			`UPDATE roadmap_workforce.squad_dispatch
          SET dispatch_status = 'completed',
              completed_at = now(),
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object('agent_run_id', $2::text, 'proposal_status', $3)
        WHERE id = $1`,
			[dispatchId, result.agentRunId, current.status],
		);
		logger.log(
			`Gate dispatch ${dispatchId} completed transition_queue ${transition.id}`,
		);
		return;
	}

	if (
		result.exitCode === 0 &&
		current &&
		normalizeState(current.maturity) !== "MATURE"
	) {
		const decisionMessage = `gate decision completed without state transition: proposal is ${current.status}/${current.maturity}`;
		await recordGateCommunication({
			proposalId: transition.proposal_id,
			author: worktree,
			toAgent: "orchestrator",
			channel: "direct",
			contextPrefix: "feedback:",
			body: [
				`Gate ${transition.gate ?? ""} held ${transition.display_id ?? transition.proposal_id}.`,
				`Queue: ${transition.id}`,
				`Target transition: ${transition.from_stage} -> ${transition.to_stage}`,
				`Current proposal state: ${current.status}/${current.maturity}`,
				"",
				"The gate agent made a non-transition decision. Continue the conversation through MCP discussions/messages, revise the proposal, then set maturity back to mature when it is ready for another gate attempt.",
			].join("\n"),
			metadata: {
				transition_queue_id: transition.id,
				gate: transition.gate,
				gate_decision: "hold",
				proposal_status: current.status,
				proposal_maturity: current.maturity,
				agent_run_id: result.agentRunId,
			},
		});
		await query(
			`UPDATE roadmap.transition_queue
          SET status = 'held',
              completed_at = now(),
              last_error = $2,
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object('gate_decision', 'hold', 'proposal_status', $3::text, 'proposal_maturity', $4::text)
        WHERE id = $1`,
			[transition.id, decisionMessage, current.status, current.maturity],
		);
		await query(
			`UPDATE roadmap_workforce.squad_dispatch
          SET dispatch_status = 'completed',
              completed_at = now(),
              metadata = COALESCE(metadata, '{}'::jsonb) ||
                jsonb_build_object('agent_run_id', $2::text, 'gate_decision', 'hold', 'proposal_status', $3::text, 'proposal_maturity', $4::text)
        WHERE id = $1`,
			[dispatchId, result.agentRunId, current.status, current.maturity],
		);
		await query(
			`UPDATE roadmap_proposal.proposal_lease pl
          SET released_at = now(),
              release_reason = $2
         FROM roadmap_workforce.squad_dispatch sd
        WHERE sd.id = $1
          AND pl.id = sd.lease_id
          AND pl.released_at IS NULL`,
			[dispatchId, decisionMessage],
		);
		logger.log(
			`Gate dispatch ${dispatchId} held transition_queue ${transition.id}: ${decisionMessage}`,
		);
		return;
	}

	const errorMessage =
		result.exitCode === 0
			? `gate agent completed but proposal remained ${current?.status ?? "unknown"}/${current?.maturity ?? "unknown"}`
			: `gate agent exited ${result.exitCode}: ${[result.stderr, result.stdout].filter(Boolean).join("\n").slice(0, 2000)}`;
	const finalAttempt = transition.attempt_count >= transition.max_attempts;
	await query(
		`UPDATE roadmap.transition_queue
        SET status = $2,
            process_after = CASE WHEN $2 = 'pending' THEN now() + interval '5 minutes' ELSE process_after END,
            completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE completed_at END,
            last_error = $3
      WHERE id = $1`,
		[transition.id, finalAttempt ? "failed" : "pending", errorMessage],
	);
	await query(
		`UPDATE roadmap_workforce.squad_dispatch
        SET dispatch_status = $2,
            completed_at = now(),
            metadata = COALESCE(metadata, '{}'::jsonb) ||
              jsonb_build_object('agent_run_id', $3::text, 'error', $4::text)
      WHERE id = $1`,
		[
			dispatchId,
			finalAttempt ? "cancelled" : "blocked",
			result.agentRunId,
			errorMessage,
		],
	);
	await query(
		`UPDATE roadmap_proposal.proposal_lease pl
        SET released_at = now(),
            release_reason = $2
       FROM roadmap_workforce.squad_dispatch sd
      WHERE sd.id = $1
        AND pl.id = sd.lease_id
        AND pl.released_at IS NULL`,
		[
			dispatchId,
			`dispatch ${finalAttempt ? "cancelled" : "blocked"}: ${errorMessage.slice(0, 500)}`,
		],
	);
	logger.warn(
		`Gate dispatch ${dispatchId} did not advance transition_queue ${transition.id}: ${errorMessage}`,
	);
}

// Release cubics that are still locked for a proposal that moved on
async function releaseStaleCubics(proposalId: string) {
	const client = new Client({ name: "orchestrator-cleanup", version: "1.0.0" });
	const transport = new SSEClientTransport(new URL(MCP_URL));
	try {
		await client.connect(transport);
		const existing = await client.callTool({
			name: "cubic_list",
			arguments: {},
		});
		const data = safeParseMcpResponse(mcpText(existing));
		if (!data?.cubics) return;

		for (const cubic of data.cubics) {
			const proposals = cubic.proposals || [];
			if (proposals.includes(Number(proposalId)) && cubic.lock) {
				await client.callTool({
					name: "cubic_transition",
					arguments: { cubicId: cubic.id, toPhase: "complete" },
				});
				logger.log(
					`🔓 Released ${cubic.name?.substring(0, 30)} (was locked for P${proposalId})`,
				);
			}
		}
	} catch (err) {
		logger.warn("Cleanup error:", err);
	} finally {
		await client.close();
	}
}

// P266: poller handles owned by main() so shutdown() can clear them.
let pollTimer: NodeJS.Timeout | null = null;
let implicitGateTimer: NodeJS.Timeout | null = null;

// Main orchestrator
async function main() {
	logger.log("Starting Orchestrator with dynamic agent deployment...");

	const pool = getPool();

	// Load state-names registry from DB (includes NOTIFY listener for live reloads)
	try {
		await loadStateNames(pool);
		logger.log("State-names registry loaded from database");
	} catch (error) {
		logger.error("Failed to load state-names registry:", error);
		// Non-fatal; continue without the registry
	}

	// P269: reap stale rows left by any prior abrupt stop, BEFORE LISTEN.
	await reapStaleRows(
		pool,
		{
			log: (m) => logger.log(m),
			warn: (m) => logger.warn(m),
		},
		"Orchestrator.Reaper",
	);

	const pgClient = await pool.connect();

	// Listen for state changes
	await pgClient.query("LISTEN proposal_gate_ready");
	await pgClient.query("LISTEN proposal_maturity_changed");

	logger.log("Listening for state changes to dispatch agents...");

	// Handle notifications
	pgClient.on(
		"notification",
		async (msg: { channel: string; payload?: string }) => {
			if (!msg.payload) return;

			if (stopping) return;
			try {
				const data = JSON.parse(msg.payload);
				if (msg.channel === "proposal_gate_ready") {
					const proposalId = Number(data.proposal_id || data.id);
					if (Number.isFinite(proposalId)) {
						await trackInFlight(
							dispatchImplicitGate(proposalId, "notify:proposal_gate_ready"),
						);
					}
					return;
				}
				const proposalId = data.proposal_id || data.id;

				if (!proposalId) return;

				// Get current state from workflows table
				const result = await query(
					"SELECT id, proposal_id, current_stage FROM roadmap.workflows WHERE proposal_id = $1 ORDER BY started_at DESC LIMIT 1",
					[proposalId],
				);

				if (result.rows.length > 0) {
					const wf = result.rows[0];
					await trackInFlight(
						handleStateChange(String(wf.proposal_id), wf.current_stage),
					);
				}
			} catch (e) {
				logger.error("Error handling notification:", e);
			}
		},
	);

	if (ENABLE_POLLING) {
		// Poll for proposals needing agents (every 2 minutes)
		pollTimer = setInterval(
			async () => {
				if (stopping) return;
				try {
					// Find workflows in NEW states that haven't had agents dispatched yet
					// (workflows with no recent agent activity, ordered by recency)
					const result = await query(
						`SELECT w.id, w.proposal_id, w.current_stage
           FROM roadmap.workflows w
           WHERE w.completed_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM roadmap.transition_queue tq
               WHERE tq.proposal_id = w.proposal_id
                 AND tq.status IN ('pending', 'processing')
             )
           ORDER BY w.started_at DESC
           LIMIT 5`,
					);

					for (const wf of result.rows) {
						if (stopping) return;
						await trackInFlight(
							handleStateChange(String(wf.proposal_id), wf.current_stage),
						);
					}
				} catch (e) {
					logger.error("Polling error:", e);
				}
			},
			2 * 60 * 1000,
		); // Every 2 minutes
		logger.log("Polling enabled.");
	} else {
		logger.log(
			"Polling disabled; orchestrator will react to notifications only.",
		);
	}

	if (IMPLICIT_GATE_POLL_INTERVAL_MS > 0) {
		await drainImplicitGateReady("startup", 5);
		implicitGateTimer = setInterval(async () => {
			if (stopping) return;
			try {
				await drainImplicitGateReady("implicit-gate-poll", 5);
			} catch (e) {
				logger.error("Implicit gate poll error:", e);
			}
		}, IMPLICIT_GATE_POLL_INTERVAL_MS);
		logger.log(
			`Implicit maturity gate polling every ${IMPLICIT_GATE_POLL_INTERVAL_MS}ms.`,
		);
	}

	logger.log("Orchestrator running with dynamic agent deployment...");

	// P266: graceful shutdown — drain in-flight dispatches before exit.
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		logger.log(
			`Received ${signal}, draining ${inFlight.size} in-flight dispatch(es) (timeout ${SHUTDOWN_DRAIN_MS}ms)...`,
		);

		if (pollTimer) clearInterval(pollTimer);
		if (implicitGateTimer) clearInterval(implicitGateTimer);

		const drainStart = Date.now();
		const drainPromise = Promise.allSettled(Array.from(inFlight));
		const timeoutPromise = new Promise<"timeout">((resolve) =>
			setTimeout(() => resolve("timeout"), SHUTDOWN_DRAIN_MS),
		);
		const winner = await Promise.race([
			drainPromise.then(() => "drained" as const),
			timeoutPromise,
		]);
		logger.log(
			`Drain ${winner} after ${Date.now() - drainStart}ms; ${inFlight.size} still in-flight`,
		);

		// If anything is still hanging, mark the corresponding squad_dispatch
		// rows as cancelled so the next boot's reaper has nothing left to do.
		if (inFlight.size > 0) {
			try {
				const r = await pool.query(
					`UPDATE roadmap_workforce.squad_dispatch
					 SET dispatch_status='cancelled',
					     completed_at=now(),
					     metadata = COALESCE(metadata,'{}'::jsonb)
					                || jsonb_build_object('shutdown_cancelled_at', to_jsonb(now()),
					                                       'shutdown_signal', $1::text)
					 WHERE dispatch_status IN ('assigned','active')
					   AND completed_at IS NULL
					   AND assigned_at > now() - interval '1 hour'
					 RETURNING id`,
					[signal],
				);
				logger.warn(
					`Cancelled ${r.rowCount ?? 0} dispatch row(s) on forced shutdown`,
				);
			} catch (e) {
				logger.error("Failed to cancel hanging dispatches:", e);
			}
		}

		try {
			pgClient.release();
		} catch (e) {
			logger.warn(`pgClient release: ${e instanceof Error ? e.message : e}`);
		}
		try {
			await pool.end();
		} catch (e) {
			logger.warn(`pool.end: ${e instanceof Error ? e.message : e}`);
		}
		process.exit(0);
	};

	process.on("SIGTERM", () => {
		shutdown("SIGTERM").catch((e) => {
			logger.error("Shutdown failed:", e);
			process.exit(1);
		});
	});
	process.on("SIGINT", () => {
		shutdown("SIGINT").catch((e) => {
			logger.error("Shutdown failed:", e);
			process.exit(1);
		});
	});
}

main().catch((err) => {
	console.error("[Orchestrator] Fatal error:", err);
	process.exit(1);
});
