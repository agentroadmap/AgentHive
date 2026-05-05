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

import { postWorkOffer } from "../src/core/pipeline/post-work-offer.ts";
import { reapStaleRows } from "../src/core/pipeline/reap-stale-rows.ts";
import { getPool, query } from "../src/infra/postgres/pool.ts";
import { loadStateNames } from "../src/core/workflow/state-names.ts";
// P223: Canonical orchestrator — single source of truth for work selection / allocation.
import { CanonicalOrchestrator } from "../src/core/orchestrator/canonical-orchestrator.ts";

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
	if (agent.skills) {
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

	// Post work offers for all matched agents (parallel, tolerate individual failures)
	const results = await Promise.allSettled(
		matchedAgents.map((m) =>
			postWorkOffer({
				proposalId: Number(proposalId),
				squadName: `P${proposalId}-${phase}`,
				role: m.role,
				task: m.prompt,
				stage: normalizedState,
				phase,
				timeoutMs: 600_000,
				worktreeHint: m.agentIdentity,
				requiredCapabilities:
					m.requiredCapabilities.length > 0 ? m.requiredCapabilities : [m.role],
			}),
		),
	);
	const dispatched = results.filter((r) => r.status === "fulfilled").length;
	logger.log(`   ${dispatched}/${matchedAgents.length} offers posted`);
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

async function postGateOffer(
	proposal: GateReadyProposal,
	gate: GateDefinition,
): Promise<void> {
	if (proposal.maturity !== "mature") return;
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
	const role = gateRole(gate);
	const { dispatchId } = await postWorkOffer({
		proposalId: proposal.id,
		squadName: `gate-${proposal.display_id}-${gate.gate}`,
		role,
		task: buildImplicitGateTask(proposal, gate),
		stage: `gate:${gate.toStage.toUpperCase()}`,
		phase: "review",
		timeoutMs: 600_000,
		worktreeHint: role,
		requiredCapabilities: [role],
	});
	logger.log(
		`📬 Gate offer ${dispatchId} posted for ${proposal.display_id} (${proposal.status} → ${gate.toStage}, role=${role})`,
	);
}

async function drainGateQueue(reason: string, limit = 5): Promise<void> {
	if (stopping) return;
	const proposals = await claimImplicitGateReady(undefined, limit);
	for (const proposal of proposals) {
		if (stopping) return;
		const gate = inferGateForState(proposal.status);
		if (!gate) continue;
		void trackInFlight(postGateOffer(proposal, gate));
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
						const [p] = await claimImplicitGateReady(proposalId, 1);
						if (p) {
							const g = inferGateForState(p.status);
							if (g) void trackInFlight(postGateOffer(p, g));
						}
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

	// P223: CanonicalOrchestrator drives the work-selection / allocation cycle.
	const canonicalOrchestrator = new CanonicalOrchestrator({
		batch_size: Number(process.env.AGENTHIVE_BATCH_SIZE ?? 5),
		unlimited_workers: process.env.AGENTHIVE_UNLIMITED_WORKERS === "1",
		cubic_budget_usd: Number(process.env.AGENTHIVE_CUBIC_BUDGET_USD ?? 100),
		cubic_timeout_minutes: Number(
			process.env.AGENTHIVE_CUBIC_TIMEOUT_MINUTES ?? 60,
		),
		max_concurrent_per_agent: 3,
	});

	if (IMPLICIT_GATE_POLL_INTERVAL_MS > 0) {
		await drainGateQueue("startup", 5);
		implicitGateTimer = setInterval(async () => {
			if (stopping) return;
			try {
				await drainGateQueue("implicit-gate-poll", 5);
				// P223: run the canonical work-selection loop on each poll cycle.
				const result = await canonicalOrchestrator.orchestrateWork();
				if (result.proposals_picked > 0) {
					logger.log(
						`[P223] orchestrateWork: picked=${result.proposals_picked} allocated=${result.agents_allocated} ok=${result.successful} fail=${result.failed} (${result.duration_ms}ms)`,
					);
				}
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
