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

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
	resolveActiveRouteProvider,
	terminateLiveChildren,
	liveChildCount,
} from "../src/core/orchestration/agent-spawner.ts";
import { postWorkOffer } from "../src/core/pipeline/post-work-offer.ts";
import { reapStaleRows } from "../src/core/pipeline/reap-stale-rows.ts";
import { briefingAssemble } from "../src/infra/agency/spawn-briefing-service.ts";
import { getPool, query } from "../src/infra/postgres/pool.ts";
import { loadStateNames } from "../src/core/workflow/state-names.ts";
import { mcpText } from "./mcp-result.ts";
import { getMcpUrl } from "../src/shared/runtime/endpoints.ts";
import { listDispatchableAgencies } from "../src/infra/agency/liaison-service.ts";
import { storeMessage, getNextSequence } from "../src/infra/agency/liaison-message-service.ts";
import { createMessageEnvelope } from "../src/infra/agency/liaison-message-types.ts";
import { resolveGateRole } from "../src/core/orchestration/gate-role-resolver.ts";
import {
	bootCancelPokeAttempts,
	runOfferReaper,
	runPokeWatchdogTick,
} from "../src/core/orchestration/maintenance.ts";
import { pulseHeartbeat } from "../src/infra/pulse/heartbeat.ts";
import {
	getRolesForQueue,
	shadowCheck,
	type RoleProfile,
} from "../src/core/orchestration/role-resolver.ts";

const MCP_URL = getMcpUrl();
const AGENTHIVE_HOST = process.env.AGENTHIVE_HOST ?? "default";
const WORKTREE_ROOT =
	process.env.AGENTHIVE_WORKTREE_ROOT ?? "/data/code/worktree";
const DEFAULT_EXECUTOR_WORKTREE =
	process.env.AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE;


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
const ENHANCEMENT_HOLD_WINDOW_HOURS = Number(
	process.env.AGENTHIVE_ENHANCEMENT_HOLD_WINDOW_HOURS ?? 24,
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

// ─── Role Profile Resolution (Phase 2A) ──────────────────────────────────────

const _roleProfileCache = new Map<
	string,
	{ profiles: RoleProfile[]; expiresAt: number }
>();

async function resolveRoleProfile(
	stage: string,
	maturity: string,
	workflowTemplateId = 14,
	projectId: number | null = null,
): Promise<RoleProfile[]> {
	const key = `${workflowTemplateId}:${stage}:${maturity}:${projectId ?? ""}`;
	const cached = _roleProfileCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.profiles;
	const profiles = await getRolesForQueue({
		workflowTemplateId,
		stage,
		maturity,
		projectId,
	});
	_roleProfileCache.set(key, { profiles, expiresAt: Date.now() + 5 * 60 * 1000 });
	return profiles;
}

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

	// Phase 2B: shadow-mode divergence check
	const legacyRoles = (slots ?? []).map((s) => s.role);
	shadowCheck(
		{ workflowTemplateId: 14, stage: state, maturity: "new", projectId: null },
		legacyRoles,
	).catch(() => {});

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

type GateDefinition = {
	gate: "D1" | "D2" | "D3" | "D4";
	toStage: "Review" | "Develop" | "Merge" | "Complete";
};

type GateReadyProposal = {
	id: number;
	project_id: number | null;
	display_id: string;
	status: string;
	maturity: string;
	title: string;
	summary: string | null;
	type: string | null;
	leased_by: string | null;
	active_dispatch_id: number | null;
};

// P437: deterministic idempotency key for squad_dispatch INSERTs. Mirrors the
// computeIdempotencyKey helper in src/core/pipeline/post-work-offer.ts so
// orchestrator-side gate dispatches and pipeline work-offer dispatches share
// the same hash domain. Both paths feed the partial UNIQUE INDEX
// uniq_squad_dispatch_idempotency_alive on roadmap_workforce.squad_dispatch.
function computeDispatchIdempotencyKey(parts: {
	projectId: number | null;
	proposalId: number;
	status: string;
	maturity: string;
	role: string;
	version?: number;
}): string {
	const raw = [
		parts.projectId ?? 0,
		parts.proposalId,
		parts.status,
		parts.maturity,
		parts.role,
		parts.version ?? 1,
	].join(":");
	return createHash("sha256").update(raw).digest("hex");
}

type ExecutorCandidate = {
	worktree: string;
	source: string;
	score: number;
};

function normalizeState(state: string): string {
	return state.trim().toUpperCase();
}

function inferGateForState(
	state: string,
	type?: string | null,
): GateDefinition | null {
	const s = normalizeState(state);
	const t = (type ?? "").toLowerCase();

	// Hotfix is a 3-stage workflow: TRIAGE → FIX → DEPLOYED.
	// REVIEW and MERGE are skipped — the design is "fix it fast, prove it works."
	// D1 reviews the mature TRIAGE (defect reproduced, fix scope agreed).
	// D3 reviews the mature FIX (patch lands, regression test passes).
	if (t === "hotfix") {
		switch (s) {
			case "TRIAGE":
				return { gate: "D1", toStage: "FIX" as any };
			case "FIX":
				return { gate: "D3", toStage: "DEPLOYED" as any };
			default:
				return null;
		}
	}

	// Standard RFC workflow: DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE.
	switch (s) {
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

// ─── Briefing helpers (P466) ─────────────────────────────────────────────────

interface ProposalBriefingContext {
	id: number;
	displayId: string;
	title: string;
	type: string | null;
	status: string;
	maturity: string;
	summary: string | null;
	motivation: string | null;
	design: string | null;
	pendingAcs: string[];
	totalAcs: number;
}

async function fetchProposalBriefingContext(
	proposalId: number,
): Promise<ProposalBriefingContext> {
	const { rows } = await query<{
		id: number;
		display_id: string;
		title: string;
		type: string | null;
		status: string;
		maturity: string;
		summary: string | null;
		motivation: string | null;
		design: string | null;
	}>(
		`SELECT id, display_id, title, type, status, maturity, summary, motivation, design
       FROM roadmap_proposal.proposal
      WHERE id = $1`,
		[proposalId],
	);
	const p = rows[0];
	if (!p) throw new Error(`proposal ${proposalId} not found`);

	const { rows: acRows } = await query<{ item_number: number; criterion_text: string; status: string }>(
		`SELECT item_number, criterion_text, status
       FROM roadmap_proposal.proposal_acceptance_criteria
      WHERE proposal_id = $1
      ORDER BY item_number`,
		[proposalId],
	);
	const pendingAcs = acRows
		.filter((r) => r.status !== "pass" && r.status !== "waived")
		.map((r) => `[AC#${r.item_number}] ${r.criterion_text}`);

	return {
		id: p.id,
		displayId: p.display_id,
		title: p.title,
		type: p.type,
		status: p.status,
		maturity: p.maturity,
		summary: p.summary,
		motivation: p.motivation,
		design: p.design,
		pendingAcs,
		totalAcs: acRows.length,
	};
}

function composeBriefingMission(
	ctx: ProposalBriefingContext,
	role: string,
	rolePrompt: string,
): string {
	const acsHeader =
		ctx.pendingAcs.length > 0
			? `\n\nPending ACs (${ctx.pendingAcs.length}/${ctx.totalAcs} not yet pass):\n${ctx.pendingAcs.map((s) => `  - ${s}`).join("\n")}`
			: ctx.totalAcs === 0
				? "\n\nNo ACs defined yet — your job (if architect/researcher) is to author measurable ACs and INSERT them via add_criteria."
				: "\n\nAll ACs already pass; verify and advance.";

	const designStatus = ctx.design
		? `Design column populated (${ctx.design.length} chars).`
		: "Design column is EMPTY. If you are an architect/researcher, write substantive design content via prop_update.";

	return [
		`Role: ${role}`,
		``,
		`Proposal: ${ctx.displayId} — ${ctx.title}`,
		`Type: ${ctx.type ?? "(unknown)"} · Status: ${ctx.status}/${ctx.maturity}`,
		``,
		`Summary: ${ctx.summary ?? "(none)"}`,
		`Motivation: ${ctx.motivation ?? "(none)"}`,
		``,
		designStatus,
		acsHeader,
		``,
		`Role-specific framing:`,
		rolePrompt,
	].join("\n");
}

function roleTimeoutMs(role: string | undefined | null): number {
	// Wall-clock budget per role. The historical 600s default is fine for gate
	// adjudication (read + write decision) but kills developers mid-flight —
	// P463 and P472 were both `Killed after timeout` at exactly 600s on
	// 2026-04-26 because real implementation work needs 30-60 min.
	const r = (role ?? "").toLowerCase();
	if (r.includes("developer")) return 3_600_000;            // 60 min
	if (r.includes("e2e")) return 1_800_000;                  // 30 min
	if (
		r.includes("architect") ||
		r.includes("researcher") ||
		r.includes("enhancer")
	)
		return 1_500_000;                                     // 25 min
	return 600_000;                                           // 10 min — gates, reviews, default
}

function deriveAllowedTools(
	role: string,
	toolAllowList: string[] | null = null,
): string[] | undefined {
	// P609 Phase 1: when gate_role.tool_allow_list is set, return it as advisory
	// context. No MCP-level enforcement until P593 ships (AC-27).
	if (toolAllowList !== null) {
		logger.warn(
			"tool_allow_list set but P593 not live — enforcement is advisory only",
		);
		return toolAllowList;
	}
	// Conservative default: every dispatched role can read proposal data,
	// add discussion/criteria/dependencies, submit reviews, and emit spawn
	// summaries. Skeptic/gate roles also need transition + set_maturity.
	const base = [
		"prop_get",
		"prop_list",
		"mcp_get_proposal_projection",
		"prop_get_detail",
		"list_ac",
		"list_reviews",
		"add_discussion",
		"submit_review",
		"add_criteria",
		"verify_criteria",
		"add_dependency",
		"get_dependencies",
		"briefing_load",
		"child_boot_check",
		"spawn_summary_emit",
	];
	const enhancer = [...base, "prop_update"];
	const gate = [
		...base,
		"prop_transition",
		"prop_set_maturity",
	];
	if (role.startsWith("skeptic") || role.includes("gate") || role.includes("review")) {
		return gate;
	}
	if (role === "architect" || role === "researcher" || role === "developer") {
		return enhancer;
	}
	return undefined; // no restriction
}

async function firstDispatchableAgency(): Promise<string | null> {
	try {
		const agencies = await listDispatchableAgencies();
		return agencies[0]?.agency_id ?? null;
	} catch {
		return null;
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

		await client.connect(transport);

		// Single MCP call replaces: cubic_list → cubic_recycle → cubic_focus
		// Pass the worktree *basename* — the MCP-side safeWorktreePath() normalizes
		// it as an agent-id and joins with WORKTREE_ROOT itself. Passing a full
		// absolute path triggers normalizeAgentId rejection ("path traversal").
		const acquired = await client.callTool({
			name: "cubic_acquire",
			arguments: {
				agent_identity: agent,
				proposal_id: Number(proposalId),
				phase,
				worktree_path: selectedWorktree,
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

		// P466 — assemble a warm-boot briefing BEFORE posting the offer. Without
		// this, the spawned child receives only the generic role prompt and runs
		// blind (P597–P608 evidence: 12 dispatches exited 0 in ~55s and wrote
		// nothing to the proposal table). With briefing wired, the child calls
		// `briefing_load(<id>)` on boot and gets mission, success_criteria
		// (the proposal's pending ACs), allowed_tools, MCP quirks catalog, and
		// fallback playbook entries.
		let briefingId: string | undefined;
		try {
			const proposalContext = await fetchProposalBriefingContext(
				Number(proposalId),
			);
			const briefing = await briefingAssemble(
				{
					task_id: `P${proposalId}-${phase}-${agentLabel ?? agent}`,
					mission: composeBriefingMission(
						proposalContext,
						agentLabel ?? agent,
						task,
					),
					success_criteria: proposalContext.pendingAcs,
					done_signal:
						(agentLabel ?? agent).startsWith("skeptic") ||
						stage.startsWith("gate")
							? "verdict"
							: "ac-pass",
					allowed_tools: deriveAllowedTools(agentLabel ?? agent),
					parent_agent: "orchestrator",
					liaison_agent:
						(await firstDispatchableAgency()) ?? undefined,
					request_assistance_threshold: 3,
					topic_keywords: [
						`P${proposalId}`,
						proposalContext.type ?? "feature",
						agentLabel ?? agent,
					],
				},
				"orchestrator",
			);
			briefingId = briefing.briefing_id;
		} catch (err) {
			// Non-fatal: briefing service may not be ready (e.g. during a partial
			// migration). Fall back to the legacy generic prompt so the dispatch
			// path still functions, but the child runs blind.
			logger.warn(
				`briefing_assemble failed for P${proposalId} (${agent}); falling back to generic prompt: ${(err as Error).message}`,
			);
		}

		const taskPrompt = briefingId
			? `${task}\n\n` +
			  `## Boot protocol — DO THIS FIRST\n` +
			  `Your warm-boot briefing is at briefing_id=${briefingId}.\n` +
			  `Call this MCP action BEFORE any other work:\n` +
			  `  mcp_agent  action="briefing_load"  briefing_id="${briefingId}"\n` +
			  `(Note the tool is **mcp_agent**, not mcp_proposal. Briefings live in the agent domain.)\n` +
			  `It returns mission, success_criteria (the proposal's pending AC list), allowed_tools, MCP quirks catalog, and escalation channels. If the call fails with 'Unknown action', try mcp_proposal as fallback — the same actions are aliased there.\n\n` +
			  `## Working context\n` +
			  `Proposal: P${proposalId}\n` +
			  `Read the full projection with:\n` +
			  `  mcp_proposal  action="detail"  id="P${proposalId}"\n` +
			  `MCP endpoint: ${getMcpUrl()}\n\n` +
			  `## Output contract — REQUIRED\n` +
			  `For enhancement work (architect/researcher/developer):\n` +
			  `  - persist substantive design content into proposal.design via:\n` +
			  `      mcp_proposal  action="update"  id="P${proposalId}"  design="..."  motivation="..."  drawbacks="..."\n` +
			  `  - add measurable ACs via:\n` +
			  `      mcp_proposal  action="add_criteria"  proposal_id="P${proposalId}"  criteria=["...","..."]\n` +
			  `  - record cross-proposal links via add_dependency.\n` +
			  `  Do NOT just emit a prose summary — the DB is the source of truth. A run that writes nothing is a failed run.\n\n` +
			  `For gate work (skeptic/reviewer): emit\n` +
			  `  ## Verdict\n  hold|advance|reject\n  ## Failures\n  - (severity) [code] summary — evidence: file:line\n  ## Remediation\n  - action — fixes: codes\n  ## Next step\n  ...\n` +
			  `to stdout. Orchestrator parses stdout into gate_decision_log.\n\n` +
			  `When you finish, emit a spawn summary:\n` +
			  `  mcp_agent  action="spawn_summary_emit"  briefing_id="${briefingId}"  outcome=<success|partial|failure|timeout|escalated>  emitted_by="${agent}"  summary="..."`
			: `${task}\n\nUse the MCP tools to do your work. Connect to ${getMcpUrl()} for proposal management.`;

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
			timeoutMs: roleTimeoutMs(agentLabel ?? agent),
			// IMPORTANT: pass the *selected worktree directory name* — not the
			// agent identity. The agency's offer-provider uses worktree_hint as
			// the cwd basename under WORKTREE_ROOT (`/data/code/worktree/`). If
			// we pass the agent identity (e.g. "researcher" or "sre@agenthive"),
			// `spawn()` fails with ENOENT because no such worktree directory
			// exists. selectedWorktree was already validated by scoreUsableWorktree.
			worktreeHint: selectedWorktree,
			briefingId,
			requiredCapabilities:
				requiredCapabilities.length > 0
					? requiredCapabilities
					: [agentLabel ?? agent],
		});
		logger.log(
			`📬 Posted offer ${dispatchId} for ${agent} on P${proposalId} (${stage})`,
		);

		// Emit liaison offer_dispatch message to first dispatchable agency
		try {
			const agencies = await listDispatchableAgencies();
			if (agencies.length > 0) {
				const targetAgency = agencies[0];
				const envelope = createMessageEnvelope({
					agencyId: targetAgency.agency_id,
					direction: "orchestrator->liaison",
					kind: "offer_dispatch",
					payload: {
						offer_id: String(dispatchId),
						dispatch_id: dispatchId,
						proposal_id: proposalId,
						squad_name: squadName,
						stage,
						phase,
						role: agentLabel ?? agent,
						required_capabilities:
							requiredCapabilities.length > 0
								? requiredCapabilities
								: [agentLabel ?? agent],
						route_hint: "anthropic",
					},
				});
				const sequence = await getNextSequence(targetAgency.agency_id);
				await storeMessage({
					...(envelope as any),
					sequence,
					signature: "stub-orchestrator",
				});
				logger.log(
					`📮 Emitted liaison message to ${targetAgency.agency_id} for dispatch ${dispatchId}`,
				);
			}
		} catch (err) {
			logger.warn(
				`Failed to emit liaison message for dispatch ${dispatchId}:`,
				err,
			);
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

	// Skip if the proposal is already 'mature' — that means an investigator/
	// developer has finished work and the implicit-gate scanner owns the
	// next move (advance / hold / reject). Without this guard, the NOTIFY
	// path keeps firing investigator agents (triage-agent, architect, etc.)
	// at a mature proposal, claiming a lease that flips maturity to 'active'
	// and starves the gate scanner — producing the dispatch loop seen on
	// P689/P704 (8h of triage-agent runs with no advancement).
	const { rows: maturityRows } = await query<{ maturity: string | null; status: string | null }>(
		`SELECT maturity, status FROM roadmap_proposal.proposal WHERE id = $1`,
		[proposalId],
	);
	if (maturityRows[0]?.maturity === "mature") {
		logger.log(
			`⏭ P${proposalId} → ${newState}: maturity=mature — leaving for implicit-gate scanner`,
		);
		return;
	}

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
		    AND dispatch_status NOT IN ('cancelled', 'failed', 'completed')
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

/**
 * Persist a non-advance gate decision into `gate_decision_log` so the next
 * enhancing agent can read structured findings, not just liaison messages.
 *
 * MCP discussions/messages are best-effort — they may not reach the next
 * cubic. `gate_decision_log` IS the canonical channel: every non-transition
 * gate decision MUST land here with enough rationale that a fresh agent
 * (with no prior conversation context) can plan its next revision.
 *
 * `agentStdout` is the gate agent's raw output; we excerpt the tail (where
 * conclusions usually live) into the rationale so the row is actionable
 * even if the agent didn't emit a structured `details` payload.
 */
async function recordGateDecisionFromOrchestrator(input: {
	proposalId: number;
	fromState: string;
	toState: string;
	gate: string;
	decision: "hold" | "reject" | "escalate";
	authorityAgent: string;
	agentRunId: number | string | null;
	agentStdout: string | null;
	maturity: string;
}): Promise<void> {
	const stdout = (input.agentStdout ?? "").trim();
	const tail = stdout.length > 3500 ? stdout.slice(-3500) : stdout;
	const rationale =
		tail.length > 0
			? `Gate ${input.gate} decision: ${input.decision}. ` +
			  `${input.authorityAgent} did not advance ${input.proposalId}. ` +
			  `Excerpted gate-agent output (tail) follows; for full context see ` +
			  `agent_runs.id=${input.agentRunId ?? "?"}.\n\n` +
			  tail
			: `Gate ${input.gate} decision: ${input.decision}. ` +
			  `${input.authorityAgent} did not advance ${input.proposalId} and ` +
			  `produced no structured rationale. agent_runs.id=${input.agentRunId ?? "?"}.`;

	try {
		await query(
			`INSERT INTO roadmap_proposal.gate_decision_log
         (proposal_id, from_state, to_state, maturity, gate, decided_by,
          authority_agent, decision, rationale, ac_verification)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
			[
				input.proposalId,
				input.fromState,
				input.toState,
				input.maturity,
				input.gate,
				input.authorityAgent,
				"gate-evaluator",
				input.decision,
				rationale,
				JSON.stringify({
					source: "orchestrator_implicit_gating",
					agent_run_id: input.agentRunId,
					captured_from_stdout: stdout.length > 0,
					details: null,
				}),
			],
		);
	} catch (err) {
		// Don't let a logging failure break the dispatch path; log and move on.
		console.error(
			`[orchestrator] failed to record gate_decision_log row for proposal=${input.proposalId} gate=${input.gate}:`,
			err,
		);
	}
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
			"You are SKEPTIC ALPHA gating DRAFT → REVIEW. Your job is to validate the SPEC, not the IMPLEMENTATION. " +
			"At this gate the design + AC list are authoritative; the migration files, TS modules, and tests are NOT YET expected to exist on disk. " +
			"DEVELOP commits them later (D3 is where missing/uncommitted artifacts become a hold).\n\n" +
			"What you check at D1 — every item below is a real P592–P607 failure mode you must call out by name when found:\n" +
			"  1. AC ACCRETION: list_criteria + read the design body. If the body says \"AC-N supersedes AC-M\" or \"Addendum X declares Y VOID\" while AC-M is still a live row in proposal_acceptance_criteria, that's a hard hold — DEVELOP cannot follow two contradictory ACs. Cite both item_numbers and require delete_criteria.\n" +
			"  2. PHANTOM COLUMNS in EXISTING tables: any column the design names on a table that already exists must appear in information_schema.columns. (Columns the design proposes to add via its own migration are fine — those don't exist yet by definition.)\n" +
			"  3. INTERNAL CONTRADICTION: scan the design for sync-vs-async, two hash formulas, two table-name lists, conflicting type signatures. Pick-one-and-delete-the-other is the only valid resolution; annotation prose (\"VOID\", \"superseded\") with both versions still present = hold.\n" +
			"  4. DEAD VOCABULARY: a CHECK constraint that hardcodes a literal list while a sibling table claims to be the canonical vocabulary = hold (the table enforces nothing).\n" +
			"  5. MISSING GRANTS in the proposed migration: if an AC requires UPDATE on a column, the migration's GRANT block must include UPDATE. Read the migration that the proposal SHIPS, not what's already in the repo.\n" +
			"  6. INVALID FK TARGETS: when the design declares `REFERENCES schema.table(col)` against a table that already exists, verify (col) is the PK or a UNIQUE column; if it doesn't exist or isn't unique, hold.\n\n" +
			"What you DO NOT check at D1 (these are D3 concerns — explicitly out of scope here):\n" +
			"  - Whether the migration / DDL / TS / test files have been committed to a branch (git ls-files / git log --all). They don't have to exist yet at DRAFT.\n" +
			"  - Whether the implementation runs, the tests pass, or the spending log shows actual cost.\n" +
			"  - Whether unrelated proposals' artifacts are floating in the worktree (worktree hygiene is an ops concern, not a spec concern).\n" +
			"If you find a coherent, source-verified spec with measurable ACs, ADVANCE — even if not a single line of code has been written.\n\n" +
			"OUTPUT CONTRACT: emit a clear final-line decision and structured findings to STDOUT — the orchestrator parses your stdout and persists it into gate_decision_log. " +
			"For HOLD/REJECT, output a `## Failures` section (one bullet per blocker, severity tag, file:line evidence where possible) AND populate `ac_verification.details` JSONB array (each entry: {item_number, status, evidence}). " +
			"Also call `mcp_proposal action=add_discussion context_prefix=gate-decision:` with the same body. The enhancing agent reads stdout AND the discussion thread.",
	},
	D2: {
		role: "architecture-reviewer",
		framing:
			"You are the Architecture Reviewer gating REVIEW → DEVELOP. Validate the design is buildable: dependencies satisfied, integration constraints respected, scalability and rollback paths sound. " +
			"At this gate you assume the spec is internally coherent (D1 already enforced that). You're checking whether a developer agent can pick this up and implement without surprises.\n\n" +
			"What you check at D2:\n" +
			"  - Dependency graph: every blocking proposal in proposal_dependencies is resolved or scheduled.\n" +
			"  - Cross-proposal coherence: FK targets, shared schemas, role names, env vars match what sibling proposals expect.\n" +
			"  - Rollback / migration safety: destructive operations are reversible or explicitly accepted.\n" +
			"  - Cost / capacity envelope: any new index, table, or function is sized for current traffic.\n\n" +
			"What you DO NOT check at D2 (deferred to D3):\n" +
			"  - Whether the migration file has been committed yet. The DEVELOP phase that follows D2 is where commits land.\n" +
			"  - Whether the tests pass or coverage is sufficient.\n\n" +
			"OUTPUT CONTRACT: same as D1 — for non-advance verdicts, emit `## Failures` + `## Remediation` to stdout so the next enhancing agent can act.",
	},
	D3: {
		role: "skeptic-beta",
		framing:
			"You are SKEPTIC BETA gating DEVELOP → MERGE. The spec was already validated upstream; you validate the IMPLEMENTATION. " +
			"Files must exist on disk and be tracked by git. Tests must pass. ACs must be met against running code, not against prose.\n\n" +
			"What you check at D3 (this is the right gate for these — they are NOT D1 concerns):\n" +
			"  - ARTIFACT EXISTENCE: every file the design promised must be tracked. Verify with `git log --all -- <path>` returning ≥1 SHA. Untracked files = hold.\n" +
			"  - MIGRATION SLOT COLLISIONS: the migration file's slot number must not be taken by another committed migration. Verify against the migrations directory.\n" +
			"  - WORKTREE HYGIENE: only this proposal's deliverables should be uncommitted in this branch — sibling-proposal artifacts must be moved before merge.\n" +
			"  - TEST COVERAGE: every AC has at least one passing test that exercises its assertion. Run `npm test` (or the relevant suite) and inspect output.\n" +
			"  - RUNTIME CORRECTNESS: apply the migration to a scratch DB, exercise the SECURITY DEFINER functions, confirm no permission-denied errors and no broken FK chains.\n" +
			"  - AC VERIFICATION: each AC must be verified against the live system, not just against its own text. Populate ac_verification.details with item_number, status, and concrete evidence (test name, query result, file:line).\n\n" +
			"OUTPUT CONTRACT: same as D1 — emit `## Failures` + `## Remediation` to stdout for non-advance verdicts. ac_verification.details is mandatory at D3.",
	},
	D4: {
		role: "gate-reviewer",
		framing:
			"You are the Integration Reviewer. Validate that the merge is clean, tests pass, and the feature is deployable. " +
			"Only advance if the integration is stable.\n\n" +
			"OUTPUT CONTRACT: same as D1 — emit `## Failures` + `## Remediation` to stdout for non-advance verdicts.",
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
		"The proposal maturity is the implicit queue signal, and your gate lease must be released after the decision.",
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
            p.project_id,
            p.display_id,
            p.status,
            p.maturity,
            p.title,
            p.summary,
            p.type,
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
            AND sd.dispatch_status IN ('active', 'open', 'assigned')
            AND sd.completed_at IS NULL
          ORDER BY sd.assigned_at DESC
          LIMIT 1
       ) dispatch ON true
      WHERE p.maturity = 'mature'
        AND LOWER(p.status) IN ('draft', 'review', 'develop', 'merge', 'triage', 'fix')
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

	const gate = inferGateForState(proposal.status, proposal.type);
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
		// Provider resolution failed — proceed with offer dispatch
	}

	await ensureAgentIdentity("orchestrator", "State Machine Orchestrator");

	const role = gateRole(gate);

	// P609 Phase 1 — shadow-mode: resolve DB profile alongside GATE_ROLES.
	// GATE_ROLES is still authoritative; divergences are logged for ≥24h validation
	// (AC-17). After zero-divergence window, GATE_ROLES lookup will be removed.
	const pool = getPool();
	const resolvedProfile = await resolveGateRole(
		proposal.type ?? "feature",
		gate.gate as "D1" | "D2" | "D3" | "D4",
		pool,
	).catch((err) => {
		logger.warn(`gate_role resolver error for ${proposal.display_id}/${gate.gate}:`, err);
		return null;
	});
	if (resolvedProfile && resolvedProfile.role !== role) {
		logger.warn(
			{
				resolvedRole: resolvedProfile.role,
				legacyRole: role,
				proposalType: proposal.type,
				gate: gate.gate,
				gateRoleSource: resolvedProfile.source,
			},
			"gate_role divergence in shadow mode",
		);
	}
	// Advisory tool_allow_list from resolver (AC-27 Phase 1).
	if (resolvedProfile?.toolAllowList != null) {
		deriveAllowedTools(role, resolvedProfile.toolAllowList);
	}
	const gateRoleSource = resolvedProfile?.source ?? "builtin-fallback";

	// P437: deterministic idempotency key over the gate-dispatch tuple. Two
	// concurrent claimImplicitGateReady poll cycles racing on the same
	// proposal hit the partial UNIQUE INDEX and DO UPDATE the existing row
	// instead of double-spawning the gate agent.
	const gateIdempotencyKey = computeDispatchIdempotencyKey({
		projectId: proposal.project_id ?? null,
		proposalId: proposal.id,
		status: proposal.status,
		maturity: proposal.maturity ?? "mature",
		role,
	});

	const { rows: dispatchRows } = await query<{
		id: number;
		attempt_count: number;
		was_replay: boolean;
	}>(
		`INSERT INTO roadmap_workforce.squad_dispatch
       (proposal_id, squad_name, dispatch_role, dispatch_status, offer_status,
        assigned_by, metadata, idempotency_key, attempt_count)
     VALUES ($1, $2, $7, 'open', 'open', 'orchestrator',
       jsonb_build_object(
         'source', 'implicit_maturity_gating',
         'reason', $3::text,
         'gate', $4::text,
         'from_stage', $5::text,
         'to_stage', $6::text,
         'stage', 'gate:' || $6::text,
         'gateRoleSource', $8::text
       ), $9, 1)
     ON CONFLICT (idempotency_key)
       WHERE dispatch_status IN ('open', 'assigned', 'active')
     DO UPDATE SET
       attempt_count = squad_dispatch.attempt_count + 1,
       metadata = squad_dispatch.metadata
                || jsonb_build_object(
                     'last_replay_at', to_jsonb(now()),
                     'replay_reason', 'idempotency_collision'
                   )
     RETURNING id, attempt_count, (xmax::text::int <> 0) AS was_replay`,
		[
			proposal.id,
			`gate-${proposal.display_id}-${gate.gate}`,
			reason,
			gate.gate,
			proposal.status,
			gate.toStage,
			role,
			gateRoleSource,
			gateIdempotencyKey,
		],
	);
	const dispatchId = dispatchRows[0]?.id;
	if (dispatchRows[0]?.was_replay) {
		logger.log(
			`Implicit gate dispatch idempotency replay for ${proposal.display_id} (dispatch ${dispatchId}, attempt ${dispatchRows[0].attempt_count}) — skipping offer`,
		);
		return;
	}
	logger.log(
		`Implicit gate dispatch ${dispatchId} offer posted for ${proposal.display_id} (${proposal.status} -> ${gate.toStage}, ${gate.gate})`,
	);

	// Notify work_offers channel; agencies listening will claim and spawn.
	await query(`SELECT pg_notify($1, $2)`, [
		"work_offers",
		JSON.stringify({
			event: "emitted",
			dispatch_id: dispatchId,
			proposal_id: proposal.id,
			role,
		}),
	]);

	// Send offer_dispatch downlink to first dispatchable agency.
	try {
		const agencies = await listDispatchableAgencies();
		if (agencies.length > 0) {
			const targetAgency = agencies[0];
			const envelope = createMessageEnvelope({
				agencyId: targetAgency.agency_id,
				direction: "orchestrator->liaison",
				kind: "offer_dispatch",
				payload: {
					offer_id: String(dispatchId),
					dispatch_id: dispatchId,
					proposal_id: proposal.id,
					squad_name: `gate-${proposal.display_id}-${gate.gate}`,
					role,
					required_capabilities: [role],
					route_hint: "anthropic",
				},
			});
			const sequence = await getNextSequence(targetAgency.agency_id);
			await storeMessage({
				...(envelope as any),
				sequence,
				signature: "stub-orchestrator",
			});
			logger.log(
				`📮 Implicit gate offer_dispatch sent to ${targetAgency.agency_id} for dispatch ${dispatchId}`,
			);
		} else {
			logger.warn(
				`Implicit gate dispatch ${dispatchId}: no dispatchable agencies, offer posted to queue only`,
			);
		}
	} catch (err) {
		logger.warn(
			`Failed to emit liaison message for implicit gate dispatch ${dispatchId}:`,
			err,
		);
	}
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

// ─── Autonomous enhancer-revise loop (closes the gate-loop on holds) ──────────
//
// When a gate writes decision='hold' the proposal drops to maturity='new'.
// Without this loop, that proposal sits at DRAFT/new forever — no autonomous
// agent reads the rationale, applies fixes, and re-matures. The persisted
// enhancer role profile (`roadmap.agent_role_profile.role_label='enhancer'`)
// describes the contract; this is the dispatcher that fires it.

type EnhancementRevisionTarget = {
	id: number;
	display_id: string;
	status: string;
	maturity: string;
	title: string;
	summary: string | null;
	hold_decision_id: number;
	hold_rationale: string | null;
	hold_ac_verification: unknown;
	hold_created_at: string;
	gate_level: string | null;
};

async function claimEnhancementRevisionReady(
	limit = 4,
): Promise<EnhancementRevisionTarget[]> {
	const { rows } = await query<EnhancementRevisionTarget>(
		`SELECT p.id,
            p.display_id,
            p.status,
            p.maturity,
            p.title,
            p.summary,
            gdl.id              AS hold_decision_id,
            gdl.rationale       AS hold_rationale,
            gdl.ac_verification AS hold_ac_verification,
            gdl.created_at      AS hold_created_at,
            gdl.gate_level
       FROM roadmap_proposal.proposal p
       JOIN LATERAL (
         SELECT id, rationale, ac_verification, created_at, gate_level, decision
           FROM roadmap_proposal.gate_decision_log
          WHERE proposal_id = p.id
          ORDER BY created_at DESC
          LIMIT 1
       ) gdl ON true
       LEFT JOIN LATERAL (
         SELECT 1
           FROM roadmap_workforce.squad_dispatch sd
          WHERE sd.proposal_id = p.id
            AND sd.dispatch_role = 'enhancer'
            AND sd.dispatch_status IN ('open', 'active')
          LIMIT 1
       ) active_enhancer ON true
      WHERE p.maturity = 'new'
        AND LOWER(p.status) IN ('draft', 'review', 'develop')
        AND gdl.decision = 'hold'
        AND gdl.created_at > now() - ($2 * interval '1 hour')
        AND active_enhancer IS NULL
      ORDER BY gdl.created_at ASC
      LIMIT $1`,
		[limit, ENHANCEMENT_HOLD_WINDOW_HOURS],
	);
	return rows;
}

async function dispatchEnhancementRevision(
	target: EnhancementRevisionTarget,
	reason: string,
): Promise<void> {
	// Pull the persisted enhancer role profile so the prompt reflects the
	// canonical contract (must_call_complete=set_maturity('mature'), allowlist,
	// author_identity convention).
	// Phase 3A: fallback prompt for when agent_role_profile is empty or missing
	const ENHANCER_FALLBACK_PROMPT = `You are the Enhancement Agent. Your task is to address gate-identified gaps.

{display_id} ({proposal_id}): {title}
Current status: {status}/{maturity}

Your contract:
1. Read EVERY rationale in the sections below — latest and prior holds.
2. Update the proposal design via mcp_proposal.update to address gaps.
3. Update acceptance criteria via add_criteria/verify_criteria/delete_criteria.
4. Write a feedback: discussion explaining what changed and why.
5. Call mcp_proposal action=set_maturity maturity=mature to signal completion.

Without set_maturity=mature, the gate will not re-run and your work remains invisible.`;

	const { rows: profileRows } = await query<{
		task_prompt: string | null;
		required_capabilities: string[];
	}>(
		`SELECT prompt_template->>'task_prompt' AS task_prompt,
                required_capabilities
           FROM roadmap.agent_role_profile
          WHERE role = 'enhancer'
          ORDER BY CASE WHEN UPPER(stage) = UPPER($1) THEN 0 ELSE 1 END, priority ASC
          LIMIT 1`,
		[target.status],
	);
	const profile = profileRows[0];
	if (!profile) {
		logger.warn(
			JSON.stringify({
				proposal_id: target.id,
				display_id: target.display_id,
				status: target.status,
				maturity: target.maturity,
				reason: "enhancer_profile_missing",
			}),
		);
		return;
	}

	const acVerification = target.hold_ac_verification
		? JSON.stringify(target.hold_ac_verification, null, 2)
		: "(empty)";
	const rationale = target.hold_rationale ?? "(empty)";

	// Pull every unresolved hold since the proposal entered its current state.
	// The enhancer was looping because it only saw the *latest* rationale —
	// fixing the freshest blocker while reverting the previous one and
	// triggering the next gate hold. Inlining the full chain breaks that loop.
	const { rows: priorHolds } = await query<{
		id: number;
		gate_level: string | null;
		created_at: string;
		rationale: string | null;
	}>(
		`SELECT gdl.id, gdl.gate_level, gdl.created_at, gdl.rationale
		   FROM roadmap_proposal.gate_decision_log gdl
		  WHERE gdl.proposal_id = $1
		    AND gdl.decision = 'hold'
		    AND gdl.id < $2
		    AND gdl.created_at >= COALESCE(
		      (
		        SELECT MAX(prev.created_at)
		          FROM roadmap_proposal.gate_decision_log prev
		         WHERE prev.proposal_id = $1
		           AND prev.decision = 'advance'
		      ),
		      gdl.created_at - interval '7 days'
		    )
		  ORDER BY gdl.created_at DESC
		  LIMIT 4`,
		[target.id, target.hold_decision_id],
	);

	// Phase 3A: substitute placeholders using profile prompt or fallback
	const taskBody = (profile.task_prompt ?? ENHANCER_FALLBACK_PROMPT)
		.replace(/\{display_id\}/g, target.display_id)
		.replace(/\{title\}/g, target.title)
		.replace(/\{status\}/g, target.status)
		.replace(/\{maturity\}/g, target.maturity)
		.replace(/\{proposal_id\}/g, String(target.id))
		.replace(/\{provider\}/g, "claude");

	const priorHoldsBlock =
		priorHolds.length === 0
			? "(no prior unresolved holds in this state)"
			: priorHolds
					.map(
						(h, i) =>
							`### Prior hold #${i + 1} — gate_decision_log.id=${h.id} ` +
							`gate=${h.gate_level ?? "(unknown)"} held_at=${h.created_at}\n${h.rationale ?? "(empty)"}`,
					)
					.join("\n\n");

	const taskPrompt = [
		taskBody,
		"",
		"## Cited gaps to close — LATEST gate hold",
		`Gate decision id: ${target.hold_decision_id}`,
		`Gate level: ${target.gate_level ?? "(unknown)"}`,
		`Held at: ${target.hold_created_at}`,
		"",
		"### Rationale (verbatim from gate cubic)",
		rationale,
		"",
		"### AC verification details (verbatim JSONB)",
		acVerification,
		"",
		"## Cited gaps to close — PRIOR unresolved holds in this state",
		"Each one of these was held by a previous gate run and must still be closed.",
		"Failing to address them means the next gate will hold again on the same blockers.",
		"",
		priorHoldsBlock,
		"",
		"## Reminder of the contract",
		"- Read EVERY rationale above (latest + prior). Each cited blocker must be closed.",
		"- Update design via `mcp_proposal action=update`. Update ACs via `mcp_proposal action=add_criteria` / `verify_criteria` / **`delete_criteria`**.",
		"- **If a new AC supersedes an old one, DELETE the old one with `delete_criteria item_number=N`. Never leave both live.**",
		"- Write a `feedback:` discussion explaining what changed and why.",
		"- Final mandatory call: `mcp_proposal action=set_maturity maturity=mature`.",
		"- Without `set_maturity=mature`, the gate never re-runs and your work is invisible.",
	].join("\n");

	const requiredCapabilities = profile.required_capabilities ?? [];
	const selectedWorktree = await selectExecutorWorktree(undefined);
	// No briefingId — the enhancer's task prompt already carries the full hold
	// rationale + ac_verification.details inline. briefing_load is unnecessary
	// here; the contract is self-contained.

	try {
		const { dispatchId } = await postWorkOffer({
			proposalId: target.id,
			squadName: `P${target.id}-enhance`,
			role: "enhancer",
			task: taskPrompt,
			stage: target.status,
			phase: "enhance",
			timeoutMs: roleTimeoutMs("enhancer"),
			worktreeHint: selectedWorktree,
			requiredCapabilities:
				requiredCapabilities.length > 0 ? requiredCapabilities : ["enhancer"],
		});
		logger.log(
			`📬 Enhancer offer ${dispatchId} posted for ${target.display_id} (revising hold #${target.hold_decision_id}; reason=${reason})`,
		);
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.warn(
			`[Enhancer] postWorkOffer failed for ${target.display_id}: ${errMsg}`,
		);
	}
}

async function drainEnhancementRevisions(
	reason: string,
	limit = 4,
): Promise<void> {
	if (stopping) return;
	const targets = await claimEnhancementRevisionReady(limit);
	for (const target of targets) {
		if (stopping) return;
		await trackInFlight(dispatchEnhancementRevision(target, reason));
	}
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
let enhancerReviseTimer: NodeJS.Timeout | null = null;
let reconcilerTimer: NodeJS.Timeout | null = null;
let offerReapTimer: NodeJS.Timeout | null = null;
let pokeWatchdogTimer: NodeJS.Timeout | null = null;
let offerReapInFlight = false;

// P611: backstop reconciler — catches any gate advances that the AFTER INSERT trigger
// missed (e.g., trigger disabled, cross-transaction race, or manual GDL INSERT).
async function reconcileStrandedAdvances(
	pool: ReturnType<typeof getPool>,
): Promise<void> {
	const stranded = await pool.query(`
		SELECT gdl.id, gdl.proposal_id, gdl.from_state, gdl.to_state, gdl.decided_by
		  FROM roadmap_proposal.gate_decision_log gdl
		  JOIN roadmap_proposal.proposal p ON p.id = gdl.proposal_id
		 WHERE gdl.decision = 'advance'
		   AND gdl.created_at > now() - INTERVAL '24 hours'
		   AND p.status = LOWER(gdl.from_state)
		 ORDER BY gdl.created_at ASC
	`);
	let recovered = 0;
	for (const row of stranded.rows) {
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL lock_timeout = '5s'");
			await client.query("SET LOCAL app.gate_bypass = 'true'");
			await client.query(
				"SELECT id FROM roadmap_proposal.proposal WHERE id = $1 FOR UPDATE",
				[row.proposal_id],
			);
			const upd = await client.query(
				`UPDATE roadmap_proposal.proposal
				    SET status = $1, maturity = 'new'
				  WHERE id = $2
				    AND status = LOWER($3)`,
				[row.to_state, row.proposal_id, row.from_state],
			);
			if (upd.rowCount && upd.rowCount > 0) {
				await client.query(
					`INSERT INTO roadmap_proposal.proposal_discussions
					     (proposal_id, author_identity, context_prefix, body)
					 VALUES ($1, 'system/reconciler', 'gate-decision:', $2)`,
					[
						row.proposal_id,
						`Auto-advanced ${row.from_state}->${row.to_state} via gate_decision_log id=${row.id} (decided_by: ${row.decided_by}). Reconciler backstop.`,
					],
				);
				recovered++;
			}
			await client.query("COMMIT");
		} catch (e) {
			await client.query("ROLLBACK").catch(() => {});
			logger.error(
				`Reconciler: Failed to apply advance for proposal_id=${row.proposal_id}, gdl_id=${row.id}: ${e instanceof Error ? e.message : e}`,
			);
		} finally {
			client.release();
		}
	}
	if (recovered > 0) logger.log(`Reconciler: Recovered ${recovered} stranded advances`);
}

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

	// Cancel orphaned poke attempts from any prior process epoch.
	await bootCancelPokeAttempts(query, logger, "Orchestrator");

	const pgClient = await pool.connect();

	// Listen for state changes
	await pgClient.query("LISTEN proposal_gate_ready");
	await pgClient.query("LISTEN proposal_maturity_changed");
	await pgClient.query("LISTEN orchestrator_wake");

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

				if (msg.channel === "orchestrator_wake") {
					await trackInFlight(drainImplicitGateReady("notify:orchestrator_wake"));
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
					// Find workflows that need an agent. Two exclusions matter — without
					// both, the LIMIT budget gets eaten by proposals that the
					// downstream handleStateChange will just no-op:
					//   1. proposal already has running agent_runs
					//   2. proposal already has alive squad_dispatch (open/assigned/active)
					// (P753: the transition_queue exclusion was removed when the table was
					// retired; agent_runs + squad_dispatch are the canonical in-flight set.)
					// Order by oldest-first (ASC) so backlog drains; otherwise newer
					// proposals can monopolize every cycle and starve idle ones for days
					// (observed: P455 stuck DEVELOP+new for 3 days behind 10+ newer rows).
					const result = await query(
						`SELECT w.id, w.proposal_id, w.current_stage
           FROM roadmap.workflows w
           JOIN roadmap_proposal.proposal p ON p.id = w.proposal_id
           WHERE w.completed_at IS NULL
             AND p.maturity IN ('new', 'active')
             AND p.gate_scanner_paused = false
             AND NOT EXISTS (
               SELECT 1 FROM roadmap_workforce.agent_runs ar
               WHERE ar.proposal_id = w.proposal_id
                 AND ar.status = 'running'
             )
             AND NOT EXISTS (
               SELECT 1 FROM roadmap_workforce.squad_dispatch sd
               WHERE sd.proposal_id = w.proposal_id
                 AND sd.dispatch_status IN ('open','assigned','active','blocked')
             )
           ORDER BY w.started_at ASC
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

	// Autonomous enhancer-revise loop: every 90s, find proposals that were held
	// in the last 24h and have no in-flight enhancer dispatch — fire one. Closes
	// the gate-loop on holds without operator intervention. Profile lives in
	// roadmap.agent_role_profile (role_label='enhancer').
	enhancerReviseTimer = setInterval(async () => {
		if (stopping) return;
		try {
			await drainEnhancementRevisions("enhancer-revise-poll", 4);
		} catch (e) {
			logger.error("Enhancer-revise poll error:", e);
		}
	}, 90_000);
	logger.log("Enhancer-revise loop polling every 90s.");

	// P611: backstop reconciler runs every 30s to catch stranded gate advances.
	reconcilerTimer = setInterval(() => {
		if (stopping) return;
		reconcileStrandedAdvances(pool).catch((e) =>
			logger.error("Reconciler error:", e),
		);
	}, 30_000);
	logger.log("P611 reconciler polling every 30s for stranded gate advances.");

	// Phase 3 / maintenance.ts: offer reaper (every 60s) + poke watchdog (every 60s).
	offerReapTimer = setInterval(() => {
		if (stopping || offerReapInFlight) return;
		offerReapInFlight = true;
		void runOfferReaper(query, logger, "Orchestrator").finally(() => {
			offerReapInFlight = false;
		});
	}, 60_000);
	pokeWatchdogTimer = setInterval(() => {
		if (stopping) return;
		void runPokeWatchdogTick(
			{
				idleThresholdMin: Number(process.env.AGENTHIVE_POKE_IDLE_THRESHOLD_MIN ?? 5),
				stormCap: Number(process.env.POKE_STORM_CAP ?? 10),
			},
			query,
			logger,
			"Orchestrator",
		);
	}, 60_000);
	logger.log("[Orchestrator] Maintenance started — offer reaper + poke watchdog every 60s");

	// P299-C: orchestrator-side offer claim + dispatch (gated).
	// Default mode (DISPATCH_MODE unset or 'offer_provider') leaves the
	// per-agency OfferProvider service in charge of claiming offers — back-
	// compat. When DISPATCH_MODE=liaison_hub, the central orchestrator
	// claims and dispatches via offer_dispatch messages to each agency
	// liaison; per-agency OfferProvider services are not started.
	if (process.env.DISPATCH_MODE === "liaison_hub") {
		const { OfferClaimLoop } = await import(
			"../src/core/orchestration/offer-claim-loop.ts"
		);
		const { OrchestratorOfferDispatcher } = await import(
			"../src/core/orchestration/offer-dispatch.ts"
		);
		const orchestratorIdentity =
			process.env.AGENTHIVE_AGENT_IDENTITY ?? "orchestrator-agent";
		const dispatcher = new OrchestratorOfferDispatcher({
			orchestratorIdentity,
			logger,
		});
		const claimLoop = new OfferClaimLoop({
			orchestratorIdentity,
			dispatcher,
			connectListener: async () => {
				const c = await pool.connect();
				return c as never;
			},
			logger,
		});
		await claimLoop.start();
		logger.log(
			"[Orchestrator] DISPATCH_MODE=liaison_hub — orchestrator owns offer claim + dispatch (P299-C)",
		);
		logger.warn(
			"[Orchestrator] TODO P299-C2: claim_status uplink subscription not yet wired; orchestrator can claim+dispatch but liaison completion reports won't be processed until follow-up wiring lands",
		);
	}

	const orchStartMs = Date.now();
	const heartbeatTimer = setInterval(() => {
		pulseHeartbeat("orchestrator-agent", {
			currentTask: "dispatching",
			uptimeSeconds: Math.floor((Date.now() - orchStartMs) / 1000),
		}).catch((e) => logger.warn("Heartbeat failed:", e));
	}, 60_000);
	// Write first heartbeat immediately so the process is visible without waiting 60s
	pulseHeartbeat("orchestrator-agent", { currentTask: "starting" }).catch(
		(e) => logger.warn("Initial heartbeat failed:", e),
	);
	// Ensure timer is cleared on shutdown (timer var captured via closure below)
	void heartbeatTimer;

	logger.log("Orchestrator running with dynamic agent deployment...");

	// P266 + hotfix: graceful shutdown — drain in-flight dispatches before
	// exit. Previously the drain awaited promises that only resolve when
	// spawned `claude --print` children exit, but those children were never
	// signalled, so the drain always lost to its timer and systemd had to
	// SIGKILL the unit at TimeoutStopSec. Now we propagate SIGTERM to live
	// children up-front so the in-flight promises resolve quickly, and
	// SIGKILL stragglers before pool.end().
	const shutdown = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		logger.log(
			`Received ${signal}, draining ${inFlight.size} in-flight dispatch(es), ${liveChildCount()} live child(ren) (timeout ${SHUTDOWN_DRAIN_MS}ms)...`,
		);

		if (pollTimer) clearInterval(pollTimer);
		if (implicitGateTimer) clearInterval(implicitGateTimer);
		if (enhancerReviseTimer) clearInterval(enhancerReviseTimer);
		if (reconcilerTimer) clearInterval(reconcilerTimer);
		if (offerReapTimer) clearInterval(offerReapTimer);
		if (pokeWatchdogTimer) clearInterval(pokeWatchdogTimer);
		clearInterval(heartbeatTimer);

		// Propagate the signal to spawned children; their stdout/close events
		// then let the in-flight dispatch promises settle naturally. Use a
		// shorter grace than the overall drain budget so the SIGKILL fallback
		// still happens inside SHUTDOWN_DRAIN_MS.
		const childGraceMs = Math.min(
			SHUTDOWN_DRAIN_MS,
			Math.max(2000, Math.min(60_000, Math.floor(SHUTDOWN_DRAIN_MS / 4))),
		);
		void terminateLiveChildren({
			graceMs: childGraceMs,
			log: (m) => logger.log(m),
		}).catch((e) => {
			logger.warn(`terminateLiveChildren: ${e instanceof Error ? e.message : e}`);
		});

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
			`Drain ${winner} after ${Date.now() - drainStart}ms; ${inFlight.size} still in-flight, ${liveChildCount()} live child(ren) remaining`,
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

		// Hard-exit guard: if pool.end() hangs (LISTEN socket not cleanly closed),
		// the process would otherwise sit until systemd SIGKILLs it. unref() so
		// the timer doesn't prevent an earlier clean exit.
		const hardExit = setTimeout(() => {
			logger.warn("pool.end hung, forcing process.exit(0)");
			process.exit(0);
		}, 5_000);
		hardExit.unref();

		try {
			// Destroy (not recycle) the LISTEN client so pool.end() doesn't wait
			// for a LISTEN socket that has no clean teardown path.
			pgClient.release(true);
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
