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
import { spawnAgent, detectProvider } from "../src/core/orchestration/agent-spawner.ts";
import { reapStaleRows } from "../src/core/pipeline/reap-stale-rows.ts";
import { getPool, query } from "../src/infra/postgres/pool.ts";
import { mcpText } from "./mcp-result.ts";

const MCP_URL = "http://127.0.0.1:6421/sse";
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

// Agent dispatch map: state → agents to call
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
		[provider, errorType === "rate_limit" ? "rate_limited" : "credit_exhausted", errorMsg.slice(0, 500)],
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

	// Filter out worktrees whose provider is forbidden by host policy
	const filtered: ExecutorCandidate[] = [];
	for (const candidate of deduped.values()) {
		try {
			const provider = await detectProvider(candidate.worktree);
			// Look up route_provider (what fn_check_spawn_policy validates)
			const { rows: routeRows } = await query<{ route_provider: string }>(
				`SELECT mr.route_provider
           FROM roadmap.model_routes mr
           WHERE mr.agent_provider = $1 AND mr.is_enabled = true
           ORDER BY mr.priority ASC LIMIT 1`,
				[provider],
			);
			const routeProvider = routeRows[0]?.route_provider ?? provider;
			const { rows } = await query<{ allowed: boolean }>(
				`SELECT roadmap.fn_check_spawn_policy($1, $2) AS allowed`,
				[AGENTHIVE_HOST, routeProvider],
			);
			if (rows[0]?.allowed) {
				filtered.push(candidate);
			} else {
				logger.log(
					`Skipping executor ${candidate.worktree} — provider "${routeProvider}" forbidden by host policy (${AGENTHIVE_HOST})`,
				);
			}
		} catch (err) {
			logger.warn(
				`Skipping executor ${candidate.worktree} — provider detection failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	const ranked = filtered.sort(
		(a, b) => b.score - a.score || a.worktree.localeCompare(b.worktree),
	);
	const selected = ranked[0];
	if (!selected) {
		throw new Error(
			`No usable executor worktree found under ${WORKTREE_ROOT}. Create one such as codex-one/codex-two with a readable .env.agent and write access for ${process.env.USER ?? "the orchestrator user"}.`,
		);
	}
	logger.log(
		`Selected executor ${selected.worktree} (${selected.source}, score=${selected.score})`,
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
): Promise<string | null> {
	const client = new Client({ name: "orchestrator", version: "1.0.0" });
	const transport = new SSEClientTransport(new URL(MCP_URL));

	try {
		await client.connect(transport);

		// Single MCP call replaces: cubic_list → cubic_recycle → cubic_focus
		const acquired = await client.callTool({
			name: "cubic_acquire",
			arguments: {
				agent_identity: agent,
				proposal_id: Number(proposalId),
				phase,
			},
		});
		const data = safeParseMcpResponse(mcpText(acquired));

		if (!data?.success || !data?.cubic_id) {
			logger.warn(`cubic_acquire failed for ${agent} on P${proposalId}: ${mcpText(acquired)?.substring(0, 120)}`);
			return null;
		}

		const cubicId = data.cubic_id as string;
		const verb = data.was_created ? "📦 New" : data.was_recycled ? "♻️ Recycled" : "🔄 Reused";
		logger.log(
			`${verb} cubic ${cubicId.substring(0, 8)} for ${agent} → P${proposalId} (${phase})`,
		);

		// Spawn the agent process
		const taskPrompt = `${AGENT_PROMPTS[agent] || ""}\n\nProposal P${proposalId}: ${task}\n\nUse the MCP tools to do your work. Connect to http://127.0.0.1:6421/sse for proposal management.`;
		const worktree = await selectExecutorWorktree(null);
		const result = await spawnAgent({
			worktree,
			task: taskPrompt,
			proposalId: Number(proposalId),
			stage: phase,
			timeoutMs: 600_000,
		});

		if (result.exitCode === 0) {
			logger.log(
				`✅ ${agent} completed (run=${result.agentRunId}) for P${proposalId}`,
			);
			// Record provider success — clears any cooldown
			try {
				const provider = await detectProvider(worktree);
				await recordProviderSuccess(provider);
			} catch {}
		} else {
			logger.warn(
				`⚠️ ${agent} exited ${result.exitCode} (run=${result.agentRunId}) for P${proposalId}`,
			);
			// Dynamic control: classify error, set cooldown
			const fullError = [result.stderr, result.stdout].filter(Boolean).join("\n");
			const classified = classifyProviderError(fullError);
			if (classified) {
				try {
					const provider = await detectProvider(worktree);
					await setProviderCooldown(provider, classified.type, fullError);
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
	const agents = AGENT_DISPATCH[normalizedState];

	if (!agents || agents.length === 0) {
		logger.log(`No agents for state: ${newState}`);
		return;
	}

	const phase = STATE_TO_PHASE[normalizedState] || "design";

	logger.log(`📢 P${proposalId} → ${newState} (${phase})`);
	logger.log(`   Squad: ${agents.join(", ")}`);

	// Release any locked cubics for this proposal from previous phases
	await releaseStaleCubics(proposalId);

	// Dynamic control: check if provider is in cooldown before dispatching
	try {
		const worktree = await selectExecutorWorktree(null);
		const provider = await detectProvider(worktree);
		if (await isProviderInCooldown(provider)) {
			logger.log(
				`⏸ Skipping P${proposalId} (${newState}): provider ${provider} is in cooldown`,
			);
			return;
		}
	} catch {
		// Provider resolution failed — let dispatch handle it
	}

	// Dispatch all agents for this state (parallel, tolerate individual failures)
	const results = await Promise.allSettled(
		agents.map((agent) =>
			dispatchAgent(agent, proposalId, `Handle ${newState}`, phase),
		),
	);
	const dispatched = results.filter(
		(r) => r.status === "fulfilled" && r.value,
	).length;
	logger.log(`   ${dispatched}/${agents.length} dispatched`);
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

function buildImplicitGateTask(
	proposal: GateReadyProposal,
	gate: GateDefinition,
): string {
	return [
		`Process implicit maturity gate ${gate.gate} for ${proposal.display_id}.`,
		"",
		`Proposal: ${proposal.display_id}`,
		`Title: ${proposal.title}`,
		`Current state: ${proposal.status}`,
		`Current maturity: ${proposal.maturity}`,
		`Successful transition: ${proposal.status} -> ${gate.toStage}`,
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
            AND sd.dispatch_role = 'gate-reviewer'
            AND sd.dispatch_status = 'active'
          ORDER BY sd.assigned_at DESC
          LIMIT 1
       ) dispatch ON true
      WHERE p.maturity = 'mature'
        AND LOWER(p.status) IN ('draft', 'review', 'develop', 'merge')
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
	const [proposal] = await claimImplicitGateReady(proposalId, 1);
	if (!proposal) {
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
		const provider = await detectProvider(worktree);
		if (await isProviderInCooldown(provider)) {
			logger.log(
				`⏸ Skipping ${proposal.display_id}: provider ${provider} is in cooldown`,
			);
			return;
		}
	} catch {
		// Provider resolution failed — let spawn handle the error
	}

	await ensureAgentIdentity("orchestrator", "State Machine Orchestrator");
	await ensureAgentIdentity(worktree, "Gate Executor");

	const { rows: dispatchRows } = await query<{ id: number }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
       (proposal_id, agent_identity, squad_name, dispatch_role, dispatch_status,
        assigned_by, metadata)
     VALUES ($1, $2, $3, 'gate-reviewer', 'active', 'orchestrator',
       jsonb_build_object(
         'source', 'implicit_maturity_gating',
         'reason', $4::text,
         'gate', $5::text,
         'from_stage', $6::text,
         'to_stage', $7::text
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
		],
	);
	const dispatchId = dispatchRows[0]?.id;
	logger.log(
		`Implicit gate dispatch ${dispatchId} -> ${worktree} for ${proposal.display_id} (${proposal.status} -> ${gate.toStage}, ${gate.gate})`,
	);

	let result: Awaited<ReturnType<typeof spawnAgent>>;
	try {
		result = await spawnAgent({
			worktree,
			task: buildImplicitGateTask(proposal, gate),
			proposalId: proposal.id,
			stage: gate.toStage,
			timeoutMs: 600_000,
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
		await releaseDispatchLease(dispatchId, `gate spawn failed: ${errMsg.slice(0, 500)}`);
		logger.warn(`Implicit gate dispatch ${dispatchId} blocked (spawn threw): ${errMsg}`);
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
			const provider = await detectProvider(worktree);
			await setProviderCooldown(provider, classified.type, fullError);
		} catch {
			// Provider detection failed — skip cooldown
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
         'to_stage', $6::text
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
		stage: transition.to_stage,
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
