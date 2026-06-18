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
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
	spawnAgent,
	spawnWithRetry,
	resolveActiveRouteProvider,
	terminateLiveChildren,
	liveChildCount,
} from "./agent-spawner.ts";
import { ObservabilityWriter } from "../observability/observability-writer.ts";
import {
	isTerminalProposalStatus,
	postWorkOffer,
} from "../pipeline/post-work-offer.ts";
import { ROLE_TO_REQUIRED_CAPABILITIES } from "./offer-dispatch.ts";
import { reapStaleRows } from "../pipeline/reap-stale-rows.ts";
import { enqueueNotification } from "../notifications/enqueue.ts";
import { briefingAssemble } from "../../infra/agency/spawn-briefing-service.ts";
import { getPool, query } from "../../infra/postgres/pool.ts";
import { loadStateNames } from "../workflow/state-names.ts";
import { mcpText } from "../../../scripts/mcp-result.ts";
import { getMcpUrl } from "../../shared/runtime/endpoints.ts";
import { listDispatchableAgencies } from "../../infra/agency/liaison-service.ts";
import { isLegacyPushDispatchEnabled } from "./legacy-push-dispatch-gate.ts";
import {
	storeMessage,
	getNextSequence,
} from "../../infra/agency/liaison-message-service.ts";
import { createMessageEnvelope } from "../../infra/agency/liaison-message-types.ts";
import { resolveGateRole, getGateRoleRegistry } from "./gate-role-resolver.ts";
import { resolveExecutorWorktreeFallback } from "./executor-worktree-fallback.ts";
import {
	bootCancelPokeAttempts,
	runOfferReaper,
	runPokeWatchdogTick,
} from "./maintenance.ts";
import { pulseHeartbeat } from "../../infra/pulse/heartbeat.ts";
import {
	getRolesForQueue,
	shadowCheck,
	type RoleProfile,
} from "./role-resolver.ts";
import {
	classifyProviderSignal,
	isProviderInCooldown,
	setProviderCooldown,
	recordProviderSuccess,
} from "./provider-cooldown.ts";

const MCP_URL = getMcpUrl();
const AGENTHIVE_HOST = process.env.AGENTHIVE_HOST ?? "default";
const WORKTREE_ROOT =
	process.env.AGENTHIVE_WORKTREE_ROOT ?? "/data/code/worktree";
// P1445 AC-3: env-based executor worktree selection is gated (opt-in via
// AGENTHIVE_ALLOW_ENV_WORKTREE_FALLBACK=1). In the default multi-agent config
// this is undefined, so selectExecutorWorktree relies on the requested
// (orchestrator-assigned) worktree instead of self-selecting from the env.
const DEFAULT_EXECUTOR_WORKTREE = resolveExecutorWorktreeFallback();

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
// (P903 phase 4 will move this into Orchestrator.stopping; until then the
// legacy dispatch helpers below own their own copy.)
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
// P706: Unified state vocabulary — TRIAGE/FIX/DEPLOYED consolidated to DRAFT/DEVELOP/COMPLETE
const STATE_TO_PHASE: Record<string, string> = {
	DRAFT: "design",
	REVIEW: "design",
	DEVELOP: "build",
	MERGE: "test",
	COMPLETE: "ship",
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

// ─── Builtin Fallback for Role Resolution ───────────────────────────────────
// P748: AC-4 — BUILTIN_FALLBACK local constants (AC-4 mandates this be local to
// the function that uses it, not exported). These are used only when DB lookup fails.
// The actual job role mapping is now driven by roadmap.agent_role_profile (see
// getRolesForQueue in role-resolver.ts).

function builtinFallbackForState(state: string): RoleProfile[] {
	// Map legacy JOB_ROLES to RoleProfile objects for backward compat
	// This fallback is only used if getRolesForQueue() fails or returns empty
	const JOB_ROLES_FALLBACK: Record<string, RoleProfile[]> = {
		DRAFT: [
			{
				id: null,
				role: "architect",
				requiredCapabilities: ["design", "system-design"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 10,
				source: "builtin-fallback" as const,
			},
			{
				id: null,
				role: "researcher",
				requiredCapabilities: ["research"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 20,
				source: "builtin-fallback" as const,
			},
		],
		// P706: TRIAGE consolidated to DRAFT
		DRAFT: [
			{
				id: null,
				role: "architect",
				requiredCapabilities: ["design"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 10,
				source: "builtin-fallback" as const,
			},
		],
		REVIEW: [
			{
				id: null,
				role: "skeptic",
				requiredCapabilities: ["review", "gating", "skeptic-review"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 10,
				source: "builtin-fallback" as const,
			},
			{
				id: null,
				role: "arch-reviewer",
				requiredCapabilities: ["design", "architecture"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 20,
				source: "builtin-fallback" as const,
			},
		],
		// P706: FIX consolidated to DEVELOP
		DEVELOP: [
			{
				id: null,
				role: "developer",
				requiredCapabilities: ["code"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 10,
				source: "builtin-fallback" as const,
			},
			{
				id: null,
				role: "skeptic-beta",
				requiredCapabilities: ["review", "code"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 20,
				source: "builtin-fallback" as const,
			},
		],
		MERGE: [
			{
				id: null,
				role: "merge-agent",
				requiredCapabilities: ["devops", "terminal"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 10,
				source: "builtin-fallback" as const,
			},
		],
		COMPLETE: [
			{
				id: null,
				role: "documenter",
				requiredCapabilities: ["docs"],
				allowedRouteProviders: null,
				forbiddenRouteProviders: null,
				promptTemplate: null,
				priority: 10,
				source: "builtin-fallback" as const,
			},
		],
		// P706: DEPLOYED consolidated to COMPLETE
				priority: 10,
				source: "builtin-fallback" as const,
			},
		],
	};

	return JOB_ROLES_FALLBACK[state] ?? [];
}

// Legacy fallback — used when capability matching returns too few agents
// P706: Consolidated TRIAGE→DRAFT, FIX→DEVELOP, DEPLOYED→COMPLETE
const AGENT_DISPATCH: Record<string, string[]> = {
	DRAFT: ["architect", "researcher"],
	REVIEW: [
		"reviewer",
		"skeptic-alpha",
		"skeptic-beta",
		"architecture-reviewer",
	],
	DEVELOP: ["developer", "skeptic-beta", "token-tracker"],
	MERGE: ["merge-agent", "git-specialist", "messaging-tester"],
	COMPLETE: ["documenter", "pillar-researcher"],
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
		"You are a Documenter. For each completed proposal: (1) query the DB via the MCP mcp_proposal action='get' to retrieve full proposal context including acceptance criteria, discussions, and design; (2) synthesize a structured documentation entry covering motivation, design decisions, and outcome; (3) post the result as a proposal discussion entry using mcp_proposal action='add_discussion' with context_prefix='feedback:' so the record is queryable for architecture reconstruction. Use /api/arch-docs for capability tree, dependency DAG, and gap analysis — do NOT read filesystem proposal files.",
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
	// AC-4: Resolve roles from DB via getRolesForQueue (P748 phase 1)
	// Fall back to JOB_ROLES_FALLBACK if no profiles found
	const profiles = await getRolesForQueue({
		workflowTemplateId: 14,
		stage: state,
		maturity: "new",
		projectId: null,
	}).catch(() => builtinFallbackForState(state));

	// Convert RoleProfile[] to RoleSlot[] for compatibility with scoring logic
	const slots = profiles.map(
		(profile): RoleSlot => ({
			role: profile.role,
			requiredCapabilities: profile.requiredCapabilities,
			minProficiency: 2, // default for DB-resolved roles
			prompt: `Dispatch to role "${profile.role}" (priority ${profile.priority})`,
			count: 1, // each profile is treated as one dispatch
			activity: profile.role.replace(/-/g, " "),
		}),
	);
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
			.filter((s) => s.score > 0 || slot.requiredCapabilities.length === 0) // empty requirements = any agent eligible
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
// isProviderInCooldown / setProviderCooldown / recordProviderSuccess /
// classifyProviderSignal are now imported from ./provider-cooldown.ts

type GateDefinition = {
	gate: "D1" | "D2" | "D3" | "D4" | "D5";
	toStage: "DELIBERATION" | "Review" | "Develop" | "Merge" | "Complete";
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

	// Governance-amendment: 6-stage workflow with DELIBERATION between DRAFT and REVIEW.
	// D1: DRAFT→DELIBERATION, D2: DELIBERATION→REVIEW (48h gate), D3: REVIEW→DEVELOP,
	// D4: DEVELOP→MERGE, D5: MERGE→COMPLETE (human-only gate).
	if (t === "governance-amendment") {
		switch (s) {
			case "DRAFT":
				return { gate: "D1", toStage: "DELIBERATION" };
			case "DELIBERATION":
				return { gate: "D2", toStage: "Review" };
			case "REVIEW":
				return { gate: "D3", toStage: "Develop" };
			case "DEVELOP":
				return { gate: "D4", toStage: "Merge" };
			case "MERGE":
				return { gate: "D5", toStage: "Complete" };
			default:
				return null;
		}
	}

	// P706: Hotfix now uses unified vocabulary: DRAFT → DEVELOP → COMPLETE.
	// REVIEW and MERGE are skipped — the design is "fix it fast, prove it works."
	// D1 reviews the mature DRAFT (defect reproduced, fix scope agreed).
	// D3 reviews the mature DEVELOP (patch lands, regression test passes).
	if (t === "hotfix") {
		switch (s) {
			case "DRAFT":
				return { gate: "D1", toStage: "DEVELOP" };
			case "DEVELOP":
				return { gate: "D3", toStage: "COMPLETE" };
			default:
				return null;
		}
	}

	// Governance Amendment: 6-stage workflow with mandatory DELIBERATION stage.
	// Gate-to-stage mapping follows stage_order (D1–D5). D2 enforces 48h timing
	// and blocking-concern checks via the DB trigger (fn_guard_gate_advance).
	if (t === "governance-amendment") {
		switch (s) {
			case "DRAFT":
				return { gate: "D1", toStage: "DELIBERATION" as any };
			case "DELIBERATION":
				return { gate: "D2", toStage: "Review" };
			case "REVIEW":
				return { gate: "D3", toStage: "Develop" };
			case "DEVELOP":
				return { gate: "D4", toStage: "Merge" };
			case "MERGE":
				return { gate: "D5", toStage: "Complete" };
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

/**
 * P1360 Change 3: Check if the worktree's provider auth is accessible.
 * Maps worktree prefix (e.g., 'codex-*') to provider and checks for auth files/env vars.
 * Returns true if auth is accessible, false if not.
 */
async function checkProviderAuthAccessible(worktree: string): Promise<boolean> {
	const prefix = worktree.split("-")[0]; // e.g., 'codex-one' → 'codex'
	const homeDir = process.env.HOME ?? "/root";

	const authChecks: Record<string, string[]> = {
		codex: [
			`${homeDir}/.codex/auth.json`,
			`${homeDir}/.openai/settings.json`,
		],
		gemini: [`${homeDir}/.gemini/settings.json`],
		claude: [`${homeDir}/.claude/settings.json`],
		copilot: [`${homeDir}/.config/github-copilot/auth.json`],
	};

	// If no known prefix mapping, assume auth exists (fail-open)
	if (!(prefix in authChecks)) return true;

	const authPaths = authChecks[prefix];
	for (const authPath of authPaths) {
		try {
			await access(authPath, fsConstants.R_OK);
			return true; // Found at least one usable auth file
		} catch {
			// This path is not accessible; try next
		}
	}

	// If no auth file found, also check env vars as override
	const envVarMap: Record<string, string[]> = {
		codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
		gemini: ["GEMINI_API_KEY"],
		claude: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
		copilot: ["GH_COPILOT_TOKEN"],
	};

	if (prefix in envVarMap) {
		const envVars = envVarMap[prefix];
		for (const envVar of envVars) {
			if (process.env[envVar]) return true;
		}
	}

	return false; // No auth accessible for this provider/worktree
}

// Log provider auth unavailability once per worktree per restart
const loggedAuthUnavailable = new Set<string>();
function logProviderAuthUnavailable(worktree: string): void {
	if (!loggedAuthUnavailable.has(worktree)) {
		const prefix = worktree.split("-")[0];
		const currentUser = process.env.USER ?? "unknown";
		logger.warn(
			`[selectExecutorWorktree] ${prefix} worktrees not usable by ${currentUser} — auth not accessible (no ${prefix}-auth file or env var set). Worktree: ${worktree}`,
		);
		loggedAuthUnavailable.add(worktree);
	}
}

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

		// P1360 Change 3: Check provider-auth accessibility before returning a usable candidate
		const providerAuthOk = await checkProviderAuthAccessible(normalized);
		if (!providerAuthOk) {
			logProviderAuthUnavailable(normalized);
			return null; // This worktree is not usable due to auth inaccessibility
		}

		const currentUid =
			typeof process.getuid === "function" ? process.getuid() : null;
		const ownedByCurrentUser =
			currentUid !== null && dirStat.uid === currentUid;
		const currentWorktree = normalized === basename(process.cwd());

		let baseScore =
			(ownedByCurrentUser ? 100 : 0) +
			(currentWorktree ? 20 : 0) +
			(source === "metadata" ? 15 : 0) +
			(source === "env" ? 10 : 0);

		// P1360 Change 2: Query recent failures for this worktree and apply penalty
		try {
			const { rows: failureRows } = await query<{ failure_count: number }>(
				`SELECT COUNT(*)::int AS failure_count
				 FROM roadmap_workforce.squad_dispatch
				 WHERE (metadata->>'worktree_hint')::text = $1
				   AND dispatch_status = 'failed'
				   AND completed_at >= now() - interval '10 minutes'`,
				[normalized],
			);
			const failureCount = failureRows[0]?.failure_count ?? 0;
			baseScore -= failureCount * 10; // Each failure = -10 points
		} catch (queryErr) {
			logger.warn(
				`scoreUsableWorktree(${normalized}): failed to query recent failures: ${queryErr instanceof Error ? queryErr.message : queryErr}`,
			);
			// Failure to query doesn't block — use base score
		}

		return {
			worktree: normalized,
			source,
			score: baseScore,
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

// P904-A1: cubic_acquire removed — dispatch via offer (postWorkOffer + OfferClaimLoop).
async function dispatchAgent(
	agent: string,
	proposalId: string,
	task: string,
	phase: string,
	stage: string,
	agentLabel?: string,
	activity?: string,
	requiredCapabilities: string[] = [],
): Promise<boolean> {
	try {
		const selectedWorktree = await selectExecutorWorktree(agent);

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
					// P230: inject proposal-scoped context package into briefing
					proposal_id: Number(proposalId),
					context_package_type:
						(agentLabel ?? agent).startsWith("skeptic") ||
						stage.startsWith("gate")
							? "gate_review"
							: "code_gen",
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

		if (USE_OFFER_DISPATCH) {
			// Post a work offer — any registered agency (e.g. copilot/agency-gary)
			// will race to claim it and spawn the appropriate CLI. The orchestrator
			// does not need to know the binary path or credentials.
			const squadName = `P${proposalId}-${phase}`;
			// P1290 Option B: do NOT pass fine-grained legacy capabilities
			// (text_generation, code_generation, web_search, etc.) — they were
			// JOB_ROLES_FALLBACK leftovers that don't exist in the seeded
			// provider_registry.capabilities->'jobs' vocab and made the P1289
			// preflight throw CapabilityMismatchError for every dispatchAgent call.
			// Let postWorkOffer's AC-1 fallback derive the cap from the centralized
			// ROLE_TO_REQUIRED_CAPABILITIES map keyed by role.
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
				// requiredCapabilities deliberately omitted — postWorkOffer derives
				// from ROLE_TO_REQUIRED_CAPABILITIES[role] when not supplied.
			});
			logger.log(
				`📬 Posted offer ${dispatchId} for ${agent} on P${proposalId} (${stage})`,
			);

			// P914/P904: OfferClaimLoop LISTENs on `work_offers` and emits the
			// offer_dispatch liaison_message with claim_token once the offer is
			// claimed. No inline emit needed here.
			return true;
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
			return false;
		}
		// P405: resolve provider from model_routes, not worktree metadata
		const activeProvider = await resolveActiveRouteProvider();

		// P604: parent dispatch span
		const traceId = randomUUID();
		const orchWriter = new ObservabilityWriter("operator:orchestrator");
		const { spanId: orchSpanId } = await orchWriter.startSpan({
			traceId,
			operation: "orch.dispatch",
			attributes: {
				proposal_id: Number(proposalId),
				agent,
				stage,
				phase,
			},
		});

		// P1359 D3 wire-up: spawnWithRetry on the legacy direct-spawn path so
		// model cooldown writes + same-provider retries exercise on every live
		// dispatch, not just the test harness.
		const result = await spawnWithRetry({
			worktree,
			task: taskPrompt,
			proposalId: Number(proposalId),
			stage,
			timeoutMs: roleTimeoutMs(agentLabel ?? agent),
			provider: activeProvider ?? undefined,
			agentLabel: agentLabel ?? agent,
			activity,
			traceId,
			parentSpanId: orchSpanId,
		});

		await orchWriter.closeSpan({
			spanId: orchSpanId,
			status: result.exitCode === 0 ? "ok" : "error",
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
			const signal = classifyProviderSignal(fullError);
			if (signal && activeProvider) {
				try {
					await setProviderCooldown(activeProvider, signal, fullError);
				} catch {}
			}
		}

		return true;
	} catch (err) {
		logger.error(`Dispatch failed for ${agent} on P${proposalId}:`, err);
		return false;
	}
}

// Handle state change and dispatch agents
export async function handleStateChange(proposalId: string, newState: string) {
	const normalizedState = normalizeState(newState);

	const phase = STATE_TO_PHASE[normalizedState] || "design";

	// Skip if the proposal is already 'mature' — that means an investigator/
	// developer has finished work and the implicit-gate scanner owns the
	// next move (advance / hold / reject). Without this guard, the NOTIFY
	// path keeps firing investigator agents (triage-agent, architect, etc.)
	// at a mature proposal, claiming a lease that flips maturity to 'active'
	// and starves the gate scanner — producing the dispatch loop seen on
	// P689/P704 (8h of triage-agent runs with no advancement).
	//
	// P3535 AC-11 (reviewed, retained as defense-in-depth): with sticky-mature
	// in place, the underlying flap this guarded against can no longer occur —
	// roadmap_proposal.fn_lease_set_maturity_active only does new→active
	// (mig 288), so a NOTIFY-path claim can no longer flip mature→active. This
	// early-return is now redundant but kept as a cheap, harmless guard that
	// also short-circuits the dispatch bookkeeping for mature proposals and
	// keeps gate ownership unambiguous (the implicit-gate scanner dispatches a
	// gate exactly once via dispatchImplicitGate's active_dispatch_id check).
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

	// P2496 AC-5: COMPLETE (and any terminal status) is the end of the line —
	// post zero offers. Without this guard the NOTIFY path keeps queuing dev/gate
	// offers for completed proposals, which then sit open and starve genuine work
	// (dispatch churn, 2026-06-09). postWorkOffer also refuses (AC-1), but
	// short-circuiting here avoids the downstream backpressure/dispatch bookkeeping
	// and the noisy TerminalProposalError throw on every poll cycle.
	if (isTerminalProposalStatus(maturityRows[0]?.status)) {
		logger.log(
			`⏭ P${proposalId} → ${newState}: status=${maturityRows[0]?.status} is terminal — no offers for completed proposals`,
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

	// Backpressure guard: stop queuing new offers when the global open-offer
	// count exceeds total agency capacity. Prevents the queue from growing
	// unboundedly while agents are backed up, and ensures urgent proposals
	// that arrive later don't wait behind a wall of stale unclaimed work.
	// Threshold = 36 (9 named agencies × max_in_flight=4); env override supported.
	const MAX_OPEN_OFFERS =
		Number(process.env.AGENTHIVE_MAX_OPEN_OFFERS ?? "36");
	const { rows: openOfferRows } = await query<{ cnt: number }>(
		`SELECT count(*)::int AS cnt
		   FROM roadmap_workforce.squad_dispatch
		  WHERE offer_status = 'open'
		    AND dispatch_status NOT IN ('cancelled', 'failed', 'completed')`,
	);
	const openOfferCount = openOfferRows[0]?.cnt ?? 0;
	if (openOfferCount >= MAX_OPEN_OFFERS) {
		logger.log(
			`⏸ P${proposalId} → ${newState}: global open-offer queue at ${openOfferCount}/${MAX_OPEN_OFFERS} — backpressure hold`,
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
		// P908-C shadow-mode: if the gate agent already wrote a canonical decision
		// row via mcp_proposal action=gate_decision (identified by agent_run_id in
		// ac_verification), skip the stdout-tail fallback to avoid a duplicate row.
		if (input.agentRunId !== null && input.agentRunId !== undefined) {
			const { rows: existing } = await query(
				`SELECT id FROM roadmap_proposal.gate_decision_log
				  WHERE proposal_id = $1
				    AND ac_verification->>'agent_run_id' = $2
				  LIMIT 1`,
				[input.proposalId, String(input.agentRunId)],
			);
			if (existing.length) {
				console.log(
					`[orchestrator] gate_decision_log row already written by agent (agent_run_id=${input.agentRunId}) for proposal=${input.proposalId} — skipping stdout-tail fallback`,
				);
				return;
			}
		}

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

export async function setProposalMaturity(
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

export async function releaseDispatchLease(
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

/**
 * AC-4: Resolve the primary gate reviewer role using DB lookup.
 *
 * For a given gate, returns the first (highest-priority) role that should
 * review it from the agent_role_profile table. Falls back to GATE_ROLES_FALLBACK
 * if DB lookup fails or returns empty results.
 *
 * Gates are implicit maturity reviews at the boundary of a stage transition.
 * We look up profiles for the FROM stage at mature maturity, and return the
 * first (lowest priority number) role as the gate reviewer.
 */
async function gateRoleFromDb(gate: GateDefinition): Promise<string> {
	try {
		// Infer the current stage from the gate definition
		// D1 → DRAFT, D2 → REVIEW, D3 → DEVELOP, D4 → MERGE
		const stageMap: Record<"D1" | "D2" | "D3" | "D4", string> = {
			D1: "DRAFT",
			D2: "REVIEW",
			D3: "DEVELOP",
			D4: "MERGE",
		};
		const stage = stageMap[gate.gate];

		const profiles = await getRolesForQueue({
			workflowTemplateId: 14, // Standard RFC
			stage,
			maturity: "mature",
			projectId: null,
		});

		if (profiles.length > 0) {
			return profiles[0].role; // highest priority (lowest number)
		}
	} catch (err) {
		logger.warn(
			`[gateRole] DB lookup failed for gate ${gate.gate}, using BUILTIN_FALLBACK:`,
			err instanceof Error ? err.message : err,
		);
	}

	// Fall back to hardcoded GATE_ROLES_FALLBACK
	const GATE_ROLES_FALLBACK: Record<
		string,
		{ role: string; framing: string }
	> = {
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

	return GATE_ROLES_FALLBACK[gate.gate]?.role ?? "gate-reviewer";
}

async function gateRole(gate: GateDefinition): Promise<string> {
	return gateRoleFromDb(gate);
}

function buildImplicitGateTask(
	proposal: GateReadyProposal,
	gate: GateDefinition,
): string {
	// AC-4: Use local fallback; gating framing text is deterministic and doesn't
	// need DB lookup. (DB profiles are role names only; framing text lives here.)
	const GATE_FRAMING_FALLBACK: Record<
		string,
		{ role: string; framing: string }
	> = {
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

	const roleConfig = GATE_FRAMING_FALLBACK[gate.gate];
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
       FROM roadmap_proposal.v_dispatchable_proposal p
       LEFT JOIN LATERAL (
         SELECT pl.agent_identity
           FROM roadmap_proposal.proposal_lease pl
          WHERE pl.proposal_id = p.id
            AND pl.released_at IS NULL
            AND (pl.expires_at IS NULL OR pl.expires_at > now())
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
        -- P2496 AC-6: never select terminal proposals for an implicit gate. The
        -- positive allowlist below already excludes COMPLETE, but this explicit
        -- guard keeps the invariant true even if the allowlist is later widened.
        AND UPPER(p.status) <> 'COMPLETE'
        AND (LOWER(p.status) IN ('draft', 'review', 'develop', 'merge', 'triage', 'fix')
             OR (LOWER(p.status) = 'deliberation' AND p.type = 'governance-amendment'))
        AND dispatch.id IS NULL
        AND ($1::bigint IS NULL OR p.id = $1)
      ORDER BY p.modified_at ASC, p.id ASC
      LIMIT $2`,
		[proposalId ?? null, limit],
	);
	return rows;
}

/**
 * P1292 AC-8: Gate completion listener.
 *
 * Routes gate offer_completed notifications to maturity advance or hold.
 * Triggered by orchestrator.ts:onNotification when offer_completed is fired.
 *
 * Logic:
 * 1. Look up the dispatch row by id and extract metadata
 * 2. If metadata.gate_role is not set, skip (not a gate dispatch)
 * 3. Look up proposal state and compare against metadata.gate_to_stage
 * 4. If states match (normalized): set maturity='new', release lease with 'gate_review_complete'
 * 5. If states diverge: release lease with 'gate_hold' (proposal already diverged during execution)
 */
export async function handleGateCompletion(dispatchId: number): Promise<void> {
	try {
		// Look up the dispatch row + its metadata
		const { rows: dispatchRows } = await query<{
			proposal_id: number;
			lease_id: number | null;
			metadata: Record<string, unknown>;
		}>(
			`SELECT proposal_id, lease_id, metadata
			   FROM roadmap_workforce.squad_dispatch
			  WHERE id = $1`,
			[dispatchId],
		);

		if (dispatchRows.length === 0) {
			logger.warn(
				`handleGateCompletion: dispatch ${dispatchId} not found`,
			);
			return;
		}

		const dispatch = dispatchRows[0];
		const { proposal_id: proposalId, lease_id: leaseId, metadata } = dispatch;

		// Check if this is a gate dispatch (AC-8 step 2)
		const gateRole = metadata?.gate_role as string | undefined;
		if (!gateRole) {
			// Not a gate dispatch — skip
			return;
		}

		const gateToStage = metadata?.gate_to_stage as string | undefined;
		if (!gateToStage) {
			logger.warn(
				`handleGateCompletion: dispatch ${dispatchId} has gate_role but missing gate_to_stage`,
			);
			// Fallback: release lease without advancing maturity
			if (leaseId) {
				await releaseDispatchLease(dispatchId, "gate_incomplete");
			}
			return;
		}

		// Look up current proposal state
		const { rows: propRows } = await query<{
			status: string | null;
			maturity: string | null;
		}>(
			`SELECT status, maturity
			   FROM roadmap_proposal.proposal
			  WHERE id = $1`,
			[proposalId],
		);

		if (propRows.length === 0) {
			logger.warn(
				`handleGateCompletion: proposal ${proposalId} not found`,
			);
			// Proposal disappeared — release lease
			if (leaseId) {
				await releaseDispatchLease(dispatchId, "proposal_missing");
			}
			return;
		}

		const proposal = propRows[0];
		const currentStatus = proposal.status?.trim().toUpperCase() ?? "";
		const normalizedGateToStage = gateToStage.trim().toUpperCase();

		// AC-8 step 4: Compare current state against gate_to_stage
		if (currentStatus === normalizedGateToStage) {
			// State matches — gate completed successfully.
			// P3535 AC-6: release FIRST so the trigger fires while maturity=mature
			// (gate_review_complete is not in the send-back bucket → trigger preserves
			// mature). Then set maturity='new' explicitly with no active lease so
			// no trigger fights the explicit call. Swapped from prior order which
			// allowed the trigger to overwrite the explicit 'new' back to 'mature'.
			const orchestratorId = "agenthive/orchestrator";
			if (leaseId) {
				await releaseDispatchLease(dispatchId, "gate_review_complete");
			}
			await setProposalMaturity(
				proposalId,
				"new",
				orchestratorId,
				"gate_review_complete",
			);
			logger.log(
				`Gate completion for P${proposalId}: state matches ${normalizedGateToStage}, maturity set to 'new'`,
			);
		} else {
			// State diverged — proposal changed during gate execution
			// AC-8 step 5: release lease with 'gate_hold' but don't advance maturity
			if (leaseId) {
				await releaseDispatchLease(dispatchId, "gate_hold");
			}
			logger.log(
				`Gate completion for P${proposalId}: state diverged (was ${currentStatus}, expected ${normalizedGateToStage}), holding`,
			);
		}
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.error(
			`handleGateCompletion(${dispatchId}) failed: ${errMsg}`,
		);
		// Best effort — don't crash the orchestrator on gate completion errors
	}
}

export async function dispatchImplicitGate(
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

	const role = await gateRole(gate);

	// P609 Phase 1 — shadow-mode: resolve DB profile alongside GATE_ROLES.
	// GATE_ROLES is still authoritative; divergences are logged for ≥24h validation
	// (AC-17). After zero-divergence window, GATE_ROLES lookup will be removed.
	const pool = getPool();
	const resolvedProfile = await resolveGateRole(
		proposal.type ?? "feature",
		gate.gate as "D1" | "D2" | "D3" | "D4" | "D5",
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

	// P1292: Post implicit-gate work offer through offer lifecycle instead of direct spawn.
	// The offer includes gate metadata (gate_role, gate_from_stage, gate_to_stage, gate_role_source)
	// which the liaison picks up and forwards to the spawned agent. Gate completion is now
	// handled by a listener on offer_completed (orchestrator.ts), not by this function.
	try {
		await postWorkOffer({
			proposalId: proposal.id,
			squadName: `gate-${proposal.display_id}-${gate.gate}`,
			role,
			task: buildImplicitGateTask(proposal, gate),
			stage: `gate:${gate.toStage}`,
			worktreeHint: null,
			requiredCapabilities: ROLE_TO_REQUIRED_CAPABILITIES[role.toLowerCase()] ?? ["develop"],
			gateRole: role,
			gateFromStage: proposal.status,
			gateToStage: gate.toStage,
			gateRoleSource: gateRoleSource,
		});
		logger.log(
			`Implicit gate work offer posted for ${proposal.display_id} (${proposal.status} -> ${gate.toStage}, ${gate.gate})`,
		);
		return;
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.warn(
			`Implicit gate work offer failed for ${proposal.display_id}: ${errMsg}`,
		);
		// CapabilityMismatchError, BackpressureError, PausedRoleError are expected;
		// proposal remains mature and scannable next cycle.
		throw err;
	}
}

export async function drainImplicitGateReady(
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

export type EnhancementRevisionTarget = {
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

export async function claimEnhancementRevisionReady(
	limit = 4,
	proposalId?: number,
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
       FROM roadmap_proposal.v_dispatchable_proposal p
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
      WHERE p.maturity IN ('new', 'active')
        AND LOWER(p.status) IN ('draft', 'review', 'develop')
        AND gdl.decision = 'hold'
        AND gdl.created_at > now() - ($2 * interval '1 hour')
        AND active_enhancer IS NULL
        AND ($3::int IS NULL OR p.id = $3::int)
      ORDER BY gdl.created_at ASC
      LIMIT $1`,
		[limit, ENHANCEMENT_HOLD_WINDOW_HOURS, proposalId ?? null],
	);
	return rows;
}

export async function dispatchEnhancementRevision(
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
			worktreeHint: null,
			requiredCapabilities:
				requiredCapabilities.length > 0 ? requiredCapabilities : ["enhancer"],
		});
		logger.log(
			`📬 Enhancer offer ${dispatchId} posted for ${target.display_id} (revising hold #${target.hold_decision_id}; reason=${reason})`,
		);

		// P904-A2: send offer_dispatch downlink so agencies receive push notification.
		// P1438 C6 AC-14: gated OFF by default — selecting the target from
		// listDispatchableAgencies() (v_agency_status.dispatchable = last_heartbeat_at)
		// is a heartbeat-derived dispatchability path. The open-pool offer above is the
		// dispatch; emergent-presence claim picks it up.
		if (await isLegacyPushDispatchEnabled()) {
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
							proposal_id: target.id,
							squad_name: `P${target.id}-enhance`,
							role: "enhancer",
							required_capabilities:
								requiredCapabilities.length > 0 ? requiredCapabilities : ["enhancer"],
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
						`📮 Enhancer offer_dispatch sent to ${targetAgency.agency_id} for dispatch ${dispatchId}`,
					);
				} else {
					logger.warn(
						`Enhancer dispatch ${dispatchId}: no dispatchable agencies, offer queued only`,
						{ reason: "no_dispatchable_agency" },
					);
				}
			} catch (err) {
				logger.warn(
					`Failed to emit liaison message for enhancer dispatch ${dispatchId}:`,
					err,
				);
			}
		}
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		logger.warn(
			`[Enhancer] postWorkOffer failed for ${target.display_id}: ${errMsg}`,
		);
	}
}

export async function drainEnhancementRevisions(
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

// P196: Audit context for cubic/lease/worker cleanup paths.
// Carried through every cleanup action so proposal_event + message_ledger rows
// capture the full dispatch/worker/liaison/route/host snapshot.
interface CubicCleanupContext {
	dispatchId?: number | string;
	workerIdentity?: string;
	liaisonIdentity?: string;
	routeId?: number | string;
	host?: string;
	trigger?: string; // 'state_change' | 'lease_expiry' | 'orphan_sweep'
}

// Release cubics that are still locked for a proposal that moved on.
// P196: writes proposal_event (cubic_released) + message_ledger feed on each
// successful release. Does NOT mutate proposal maturity or state.
async function releaseStaleCubics(
	proposalId: string,
	ctx: CubicCleanupContext = {},
) {
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
				// P196: audit the release — no maturity/state mutation.
				const payload = JSON.stringify({
					proposal_id: proposalId,
					cubic_id: cubic.id,
					cubic_name: cubic.name,
					dispatch_id: ctx.dispatchId ?? null,
					worker_identity: ctx.workerIdentity ?? null,
					liaison_identity: ctx.liaisonIdentity ?? null,
					route_id: ctx.routeId ?? null,
					host: ctx.host ?? AGENTHIVE_HOST,
					trigger: ctx.trigger ?? "state_change",
					source: "releaseStaleCubics",
				});
				try {
					await query(
						`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
                         VALUES ($1, 'cubic_released', $2::jsonb)`,
						[proposalId, payload],
					);
					await query(
						`INSERT INTO roadmap.message_ledger
                         (from_agent, to_agent, channel, message_type, message_content, proposal_id)
                         VALUES ($1, $2, $3, 'event', $4, $5)`,
						[
							"orchestrator",
							ctx.liaisonIdentity ?? "operator",
							"lifecycle",
							`Cubic released: P${proposalId} cubic=${cubic.id} (${cubic.name?.substring(0, 30)}) trigger=${ctx.trigger ?? "state_change"}`,
							proposalId,
						],
					);
				} catch (auditErr) {
					logger.warn("Cubic release audit write failed:", auditErr);
				}
			}
		}
	} catch (err) {
		logger.warn("Cleanup error:", err);
	} finally {
		await client.close();
	}
}

// P196: Lease-expiry-driven cubic cleanup.
// Queries expired leases, writes lease_expired audit + feed events, releases
// any locked cubics, and marks workspaces for inspection via the feed.
// Does NOT mutate proposal maturity or state directly.
export async function cleanupExpiredLeaseCubics(
	pool: ReturnType<typeof getPool>,
): Promise<void> {
	const { rows } = await pool.query<{
		lease_id: number;
		proposal_id: string;
		dispatch_id: number | null;
		agent_identity: string | null;
		route_id: number | null;
	}>(`
		SELECT pl.id        AS lease_id,
		       pl.proposal_id::text,
		       sd.id        AS dispatch_id,
		       sd.agent_identity,
		       sd.route_id
		  FROM roadmap_proposal.proposal_lease pl
		  LEFT JOIN roadmap_workforce.squad_dispatch sd
		         ON sd.lease_id = pl.id
		 WHERE pl.released_at IS NULL
		   AND pl.expires_at < now()
		 ORDER BY pl.expires_at ASC
	`);

	if (rows.length === 0) return;
	logger.log(`P196 lease-expiry sweep: ${rows.length} expired lease(s)`);

	for (const row of rows) {
		try {
			await pool.query(
				`UPDATE roadmap_proposal.proposal_lease
                    SET released_at   = now(),
                        release_reason = 'lease_expired'
                  WHERE id = $1
                    AND released_at IS NULL`,
				[row.lease_id],
			);
			const payload = JSON.stringify({
				lease_id: row.lease_id,
				proposal_id: row.proposal_id,
				dispatch_id: row.dispatch_id ?? null,
				agent_identity: row.agent_identity ?? null,
				route_id: row.route_id ?? null,
				host: AGENTHIVE_HOST,
				trigger: "lease_expiry",
				source: "cleanupExpiredLeaseCubics",
			});
			await pool.query(
				`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
                 VALUES ($1, 'lease_expired', $2::jsonb)`,
				[row.proposal_id, payload],
			);
			// Feed event marks the workspace for inspection by the liaison/operator.
			await pool.query(
				`INSERT INTO roadmap.message_ledger
                 (from_agent, to_agent, channel, message_type, message_content, proposal_id)
                 VALUES ($1, $2, $3, 'event', $4, $5)`,
				[
					"orchestrator",
					row.agent_identity ?? "operator",
					"lifecycle",
					`Lease expired: P${row.proposal_id} lease=${row.lease_id} dispatch=${row.dispatch_id ?? "none"} — workspace marked for inspection`,
					row.proposal_id,
				],
			);
			await releaseStaleCubics(row.proposal_id, {
				dispatchId: row.dispatch_id ?? undefined,
				workerIdentity: row.agent_identity ?? undefined,
				routeId: row.route_id ?? undefined,
				host: AGENTHIVE_HOST,
				trigger: "lease_expiry",
			});
		} catch (err) {
			logger.warn(
				`P196 lease-expiry cleanup failed for proposal=${row.proposal_id} lease=${row.lease_id}:`,
				err,
			);
		}
	}
}

// P196: Orphaned worker detection and retirement.
// Finds agent_runs still 'running' for >10 minutes with no active dispatch,
// cancels them, and writes worker_retired audit/feed events.
export async function retireOrphanedWorkers(
	pool: ReturnType<typeof getPool>,
): Promise<void> {
	const { rows } = await pool.query<{
		run_id: number;
		proposal_id: string | null;
		agent_identity: string;
		started_at: string;
	}>(`
		SELECT ar.id           AS run_id,
		       ar.proposal_id::text,
		       ar.agent_identity,
		       ar.started_at::text
		  FROM roadmap_workforce.agent_runs ar
		 WHERE ar.status = 'running'
		   AND ar.started_at < now() - interval '10 minutes'
		   AND NOT EXISTS (
		     SELECT 1
		       FROM roadmap_workforce.squad_dispatch sd
		      WHERE sd.proposal_id    = ar.proposal_id
		        AND sd.agent_identity = ar.agent_identity
		        AND sd.dispatch_status IN ('assigned', 'active')
		   )
		 ORDER BY ar.started_at ASC
	`);

	if (rows.length === 0) return;
	logger.log(`P196 orphaned-worker sweep: ${rows.length} orphan(s)`);

	for (const row of rows) {
		try {
			await pool.query(
				`UPDATE roadmap_workforce.agent_runs
                    SET status       = 'cancelled',
                        completed_at = now(),
                        metadata     = COALESCE(metadata, '{}'::jsonb)
                                       || jsonb_build_object(
                                            'retired_by', 'orphan-worker-sweep',
                                            'retired_at', now()::text,
                                            'reason',     'no active dispatch after 10 minutes'
                                          )
                  WHERE id     = $1
                    AND status = 'running'`,
				[row.run_id],
			);
			const payload = JSON.stringify({
				run_id: row.run_id,
				proposal_id: row.proposal_id,
				agent_identity: row.agent_identity,
				started_at: row.started_at,
				host: AGENTHIVE_HOST,
				trigger: "orphan_sweep",
				source: "retireOrphanedWorkers",
			});
			if (row.proposal_id) {
				await pool.query(
					`INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
                     VALUES ($1, 'worker_retired', $2::jsonb)`,
					[row.proposal_id, payload],
				);
			}
			await pool.query(
				`INSERT INTO roadmap.message_ledger
                 (from_agent, to_agent, channel, message_type, message_content, proposal_id)
                 VALUES ($1, $2, $3, 'event', $4, $5)`,
				[
					"orchestrator",
					row.agent_identity,
					"lifecycle",
					`Orphaned worker retired: agent=${row.agent_identity} run=${row.run_id} proposal=${row.proposal_id ?? "none"} — no active dispatch after 10min`,
					row.proposal_id ?? null,
				],
			);
			logger.log(
				`🧹 Retired orphaned worker: agent=${row.agent_identity} run=${row.run_id} proposal=${row.proposal_id ?? "none"}`,
			);
		} catch (err) {
			logger.warn(
				`P196 orphan-worker retirement failed for run=${row.run_id} agent=${row.agent_identity}:`,
				err,
			);
		}
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
export async function reconcileStrandedAdvances(
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
	let detected = 0;
	for (const row of stranded.rows) {
		try {
			// P902-A8.2: Emit notification for each stranded item instead of updating
			// status/maturity. The notification triggers the normal dispatch path which
			// applies the state machine transition. This ensures there is exactly one
			// proposal stage mutation path.
			await enqueueNotification({
				severity: "ALERT",
				kind: "stranded-gate-advance",
				title: `Stranded gate advance for ${row.proposal_id}`,
				body: `Detected un-applied advance ${row.from_state}->${row.to_state} (gate_decision_log id=${row.id}, decided_by=${row.decided_by}). Queuing for state machine application.`,
				payload: {
					gate_decision_log_id: row.id,
					proposal_id: row.proposal_id,
					from_state: row.from_state,
					to_state: row.to_state,
					decided_by: row.decided_by,
				},
				proposalId: row.proposal_id,
			});
			detected++;
		} catch (e) {
			logger.error(
				`Reconciler: Failed to enqueue notification for proposal_id=${row.proposal_id}, gdl_id=${row.id}: ${e instanceof Error ? e.message : e}`,
			);
		}
	}
	if (detected > 0)
		logger.log(
			`Reconciler: Detected ${detected} stranded advance(s) — emitted notification(s) for state machine application`,
		);
}

// P661: reconcile squad_dispatch rows whose agent_run reached a terminal state
// but the dispatch was never closed (crash, orphan-cleanup, manual cancel).
// Runs every 30s as a complement to reapStaleRows (which uses wall-clock age
// alone). The 5-minute safety window on ar.completed_at prevents racing against
// a slow but successful happy-path closer.
export async function reconcileStaleDispatches(
	pool: ReturnType<typeof getPool>,
): Promise<void> {
	const result = await pool.query(`
		UPDATE roadmap_workforce.squad_dispatch sd
		SET dispatch_status = 'cancelled',
		    completed_at    = now(),
		    metadata = COALESCE(sd.metadata, '{}'::jsonb)
		               || jsonb_build_object(
		                    'reconciled_by',  'stale-dispatch-reconciler',
		                    'reconciled_at',  now()::text,
		                    'reason',         'agent_run terminal but dispatch left active',
		                    'terminal_ar_id', ar.id::text,
		                    'terminal_status', ar.status
		                  )
		FROM roadmap_workforce.agent_runs ar
		WHERE sd.proposal_id      = ar.proposal_id
		  AND sd.agent_identity   = ar.agent_identity
		  AND sd.dispatch_status IN ('assigned', 'active')
		  AND ar.status          IN ('failed', 'cancelled')
		  AND ar.completed_at     < now() - interval '5 minutes'
		  AND NOT EXISTS (
		    SELECT 1 FROM roadmap_workforce.agent_runs ar2
		    WHERE ar2.proposal_id    = sd.proposal_id
		      AND ar2.agent_identity = sd.agent_identity
		      AND ar2.status         = 'running'
		      AND ar2.started_at    >= sd.assigned_at
		  )
		RETURNING sd.id, sd.proposal_id
	`);
	if (result.rowCount && result.rowCount > 0) {
		logger.log(
			`P661 stale-dispatch reconciler: cancelled ${result.rowCount} stale dispatch(es) — proposal_ids: ${result.rows.map((r) => r.proposal_id).join(", ")}`,
		);
	}
}

