/**
 * P299-C: Orchestrator-side offer dispatch.
 *
 * After `offer-claim-loop.ts` claims an offer with the orchestrator's identity,
 * this module:
 *   1. Picks the target agency (whose liaison will fork the CLI subprocess).
 *   2. Assembles the spawn briefing (P466).
 *   3. Sends an `offer_dispatch` message via the liaison message bus, with
 *      the claim_token + dispatch_id + lease_ttl_seconds in the payload so
 *      the liaison can renew and complete the offer mechanically.
 *
 * Design rule: **the orchestrator is a mechanical process and does not
 * interpret AI-generated content**. After dispatch, the orchestrator is done
 * with this offer. It does NOT subscribe to claim_status uplinks, does NOT
 * process LLM-generated summaries, and does NOT keep an in-memory map of
 * in-flight offers.
 *
 * Lifecycle is driven entirely by mechanical SQL state:
 *   - liaison renews lease   → fn_renew_lease (succeeds while spawn runs)
 *   - liaison completes      → fn_complete_work_offer(claim_token, status)
 *   - liaison crashes        → lease TTL expires; offer reaper requeues
 *                              (existing maintenance.ts loop)
 *
 * The orchestrator's only feedback signal is DB state: agent_runs status,
 * squad_dispatch.offer_status, lease_expires_at.
 */
import { hostname } from "node:os";
import { query } from "../../infra/postgres/pool.ts";
import { resolveAgency } from "./resolvers/agency-resolver.ts";
import { briefingAssemble } from "../../infra/agency/spawn-briefing-service.ts";
import { sendMessage } from "../../infra/agency/liaison-message-service.ts";
import type { OfferDispatchPayload } from "../../infra/agency/liaison-message-types.ts";
import { ObservabilityWriter } from "../observability/observability-writer.ts";
import * as config from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

const obs = new ObservabilityWriter("agency:offer-dispatch");

const ORCHESTRATOR_HOST = process.env.AGENTHIVE_HOST ?? hostname();
void ORCHESTRATOR_HOST; // reserved for future host-aware agency filtering

// P1290 (Option B): Maps lowercase role name to the minimum required capabilities
// for agency selection. References ONLY capabilities currently advertised by >=1
// dispatchable agency in provider_registry.capabilities->'jobs':
//   - develop: 9/19 dispatchable agencies (verified 2026-05-21)
//   - review:  9/19
//   - design:  9/19
// enhance / gate-review / code-review have 0 advertisers and were dropped here;
// enhancer is treated as a developer with a different briefing prompt, and
// gate/code reviewers reduce to general review work for matching purposes.
// Exported so the health check (P1290 AC-5) and preflight (P1289 AC-3) read the
// same source as runtime dispatch.
// Unrecognised roles default to ["develop"] (the broadest seeded capability).
export const ROLE_TO_REQUIRED_CAPABILITIES: Record<string, string[]> = {
	developer: ["develop"],
	engineer: ["develop"],
	researcher: ["develop"],
	drafter: ["develop"],
	architect: ["develop"],
	enhancer: ["develop"],
	"gate-reviewer": ["review"],
	"skeptic-alpha": ["review"],
	"skeptic-beta": ["review"],
	skeptic: ["review"],
	"code-reviewer": ["review"],
	"architecture-reviewer": ["review"],
	enrichment_agent: ["develop"],
	// Live dispatch roles added 2026-05-29 (P1290 AC-6): previously fell through
	// to ["develop"] fallback — now explicitly mapped so coverage check catches
	// agencies going offline.
	"reviewer-d1": ["review"],
	reviewer: ["review"],
	gate_decision_agent: ["review"],
	merge_decision_agent: ["review"],
	integration: ["develop"],
	qa: ["develop"],
};

export interface ClaimedOffer {
	/** Offer identifier (uses dispatch_id stringified — UUID-shaped via padding for the schema). */
	offerId: string;
	dispatchId: number;
	proposalId: number;
	squadName: string;
	role: string;
	claimToken: string;
	claimExpiresAt: string;
	offerVersion: number;
	metadata: Record<string, unknown>;
	leaseTtlSeconds: number;
}

export interface OfferDispatcher {
	dispatch(claim: ClaimedOffer): Promise<void>;
}

export interface OfferDispatcherOptions {
	orchestratorIdentity: string;
	logger?: Pick<Console, "log" | "warn" | "error">;
	/** Override for test injection. */
	dispatch_resolveAgency?: typeof resolveAgency;
	/** Override for test injection. */
	dispatch_briefingAssemble?: typeof briefingAssemble;
	/** Override for test injection. */
	dispatch_sendMessage?: typeof sendMessage;
	/** Override for test injection — resolves agencyId → agent_identity string. */
	dispatch_queryAgentIdentity?: (agencyId: bigint) => Promise<string | null>;
	/**
	 * P2335 override for test injection — acquires a cubic for the dispatch.
	 * Returns null to indicate "no cubic acquired" (legacy/worktree_hint fallback
	 * path, AC-5/AC-14); throw to exercise the AC-13 failure path.
	 */
	dispatch_acquireCubic?: (
		agentIdentity: string,
		proposalId: number,
		projectId: number,
		phase: string,
	) => Promise<{ cubicId: string; worktreePath: string } | null>;
}

/**
 * Stateless dispatcher. Each `dispatch()` call sends one message and returns.
 * No in-memory tracking — the orchestrator is mechanical.
 */
export class OrchestratorOfferDispatcher implements OfferDispatcher {
	private readonly orchestratorIdentity: string;
	private readonly logger: Pick<Console, "log" | "warn" | "error">;
	private readonly resolveAgencyFn: typeof resolveAgency;
	private readonly briefingAssembleFn: typeof briefingAssemble;
	private readonly sendMessageFn: typeof sendMessage;
	private readonly queryAgentIdentityFn: (agencyId: bigint) => Promise<string | null>;
	private readonly acquireCubicFn: (
		agentIdentity: string,
		proposalId: number,
		projectId: number,
		phase: string,
	) => Promise<{ cubicId: string; worktreePath: string } | null>;

	constructor(opts: OfferDispatcherOptions) {
		this.orchestratorIdentity = opts.orchestratorIdentity;
		this.logger = opts.logger ?? console;
		this.resolveAgencyFn = opts.dispatch_resolveAgency ?? resolveAgency;
		this.briefingAssembleFn =
			opts.dispatch_briefingAssemble ?? briefingAssemble;
		this.sendMessageFn = opts.dispatch_sendMessage ?? sendMessage;
		this.queryAgentIdentityFn =
			opts.dispatch_queryAgentIdentity ??
			(async (agencyId) => {
				const { rows } = await query<{ agent_identity: string }>(
					`SELECT agent_identity FROM roadmap_workforce.agent_registry WHERE id = $1`,
					[agencyId.toString()],
				);
				return rows[0]?.agent_identity ?? null;
			});
		this.acquireCubicFn =
			opts.dispatch_acquireCubic ??
			(async (agentIdentity, proposalId, projectId, phase) => {
				const { rows } = await query<{
					cubic_id: string;
					worktree_path: string;
				}>(
					`SELECT cubic_id, worktree_path
					   FROM roadmap.fn_acquire_cubic($1, $2, $3, NULL, NULL, $4)`,
					[agentIdentity, proposalId, phase, projectId],
				);
				const row = rows[0];
				if (!row?.cubic_id) return null;
				return { cubicId: row.cubic_id, worktreePath: row.worktree_path };
			});
	}

	async dispatch(claim: ClaimedOffer): Promise<void> {
		// P1386 AC-5 Layer 1: skip spawn entirely when a role's early-exit predicate matches.
		// Predicate is evaluated mechanically via SQL function and writes a
		// synthetic agent_runs row + completes the offer with status='success'.
		// Failure of the precondition query falls through to normal dispatch.
		if (await this.tryRoleEarlyExit(claim)) {
			return;
		}

		const targetAgencyId = await this.pickAgency(claim);
		if (!targetAgencyId) {
			const requiredCaps = ROLE_TO_REQUIRED_CAPABILITIES[claim.role.toLowerCase()] ?? ["develop"];
			this.logger.warn(
				`[OfferDispatch] no eligible agency for offer ${claim.offerId} (role=${claim.role}, requiredCaps=${JSON.stringify(requiredCaps)}); marking offer failed with metadata`,
			);
			// P1289: record failure immediately so the dispatch-loop circuit breaker
			// (post-work-offer.ts) can observe it without waiting for lease expiry.
			await query(
				`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, 'failed')`,
				[claim.dispatchId, this.orchestratorIdentity, claim.claimToken],
			);
			await query(
				`UPDATE roadmap_workforce.squad_dispatch
				    SET failure_class = 'no_eligible_agency',
				        failure_is_transient = true,
				        metadata = metadata || jsonb_build_object(
				                     'failure_reason', 'no_eligible_agency',
				                     'required_capabilities', $2::jsonb,
				                     'failed_at', to_jsonb(now())
				                   )
				  WHERE id = $1`,
				[claim.dispatchId, JSON.stringify(requiredCaps)],
			);

			// P1291: increment failure counter and potentially activate pause.
			// Compute backoff only if threshold is reached.
			try {
				const threshold = (await config.getOptional(FlagKeys.PAUSE_FAILURE_THRESHOLD)) ?? 2;
				const baseBackoffMs = (await config.getOptional(FlagKeys.PAUSE_BASE_BACKOFF_MS)) ?? 1800000;
				const multiplier = (await config.getOptional(FlagKeys.PAUSE_BACKOFF_MULTIPLIER)) ?? 2;
				const maxBackoffMs = (await config.getOptional(FlagKeys.PAUSE_MAX_BACKOFF_MS)) ?? 86400000;

				await this.upsertPauseRow(
					claim.proposalId,
					claim.role,
					threshold,
					baseBackoffMs,
					multiplier,
					maxBackoffMs,
					claim.dispatchId,
				);
			} catch (err) {
				// Best-effort — pause update failures don't block dispatch completion.
				this.logger.error(
					`[OfferDispatch] error upserting pause row for proposal=${claim.proposalId} role=${claim.role}:`,
					err instanceof Error ? err.message : err,
				);
			}

			return;
		}

		// P2335: acquire a project-scoped cubic (worktree workspace) for the
		// target agency BEFORE dispatch. The cubic_id + cubic_worktree_path are
		// injected into the payload so the liaison provisions/uses the correct
		// isolated worktree. The lock is released mechanically on completion by
		// fn_complete_work_offer (migration 266).
		//
		// AC-13: if acquisition fails, do NOT dispatch — complete the offer as
		// 'failed' so the dispatch-loop circuit breaker observes it immediately
		// rather than spawning into an unallocated/colliding worktree.
		let cubic: { cubicId: string; worktreePath: string } | null;
		try {
			cubic = await this.acquireCubic(claim, targetAgencyId);
		} catch (err) {
			this.logger.error(
				`[OfferDispatch] P2335 cubic acquisition failed for offer=${claim.offerId} agency=${targetAgencyId}; completing offer as failed:`,
				err instanceof Error ? err.message : err,
			);
			await query(
				`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, 'failed')`,
				[claim.dispatchId, this.orchestratorIdentity, claim.claimToken],
			).catch((e) =>
				this.logger.error(
					`[OfferDispatch] P2335 fn_complete_work_offer failed after cubic-acquire failure:`,
					e instanceof Error ? e.message : e,
				),
			);
			await query(
				`UPDATE roadmap_workforce.squad_dispatch
				    SET failure_class = 'cubic_acquire_failed',
				        failure_is_transient = true,
				        metadata = metadata || jsonb_build_object(
				                     'failure_reason', 'cubic_acquire_failed',
				                     'failed_at', to_jsonb(now())
				                   )
				  WHERE id = $1`,
				[claim.dispatchId],
			).catch(() => {});
			return;
		}

		const briefingId = await this.assembleBriefing(claim, targetAgencyId);

		const payload: OfferDispatchPayload = {
			offer_id: this.toUuid(claim.offerId),
			role: claim.role,
			required_capabilities: extractCapabilities(claim.metadata),
			route_hint: extractRouteHint(claim.metadata),
		};

		// Augment with mechanical fields the liaison needs to renew + complete
		// the offer directly. The Zod schema strips unknown fields by default;
		// the liaison reads these from the raw message.
		const augmented: Record<string, unknown> = {
			...payload,
			briefing_id: briefingId,
			claim_token: claim.claimToken,
			dispatch_id: claim.dispatchId,
			proposal_id: claim.proposalId,
			squad_name: claim.squadName,
			lease_ttl_seconds: claim.leaseTtlSeconds,
			// P914: propagate worktree_hint from the offer's metadata
			// (postWorkOffer stores selectedWorktree there). Without this
			// the handler falls back to "main" which is not a real worktree
			// dir and node spawn raises ENOENT before the CLI runs.
			worktree_hint: extractWorktreeHint(claim.metadata),
			// P2335: cubic lease — handler prefers cubic_worktree_path over
			// worktree_hint (AC-9) and provisions the worktree if missing.
			cubic_id: cubic?.cubicId,
			cubic_worktree_path: cubic?.worktreePath,
			// P908-D: thread trace_id so offer-dispatch-handler can open the
			// offer_completed lifecycle span correlated to this trace.
			trace_id: extractTraceId(claim.metadata),
			// P1113: forward full task string so agency handler can use it directly
			// (instead of falling back to generic "Execute offer" text).
			task: extractTask(claim.metadata),
		};

		await this.sendMessageFn({
			agency_id: targetAgencyId,
			direction: "orchestrator->liaison",
			kind: "offer_dispatch",
			payload: augmented,
		});

		// P908-D: offer_activated span marks the moment the dispatch message was sent.
		const traceId = extractTraceId(claim.metadata);
		if (traceId) {
			const span = await obs.startSpan({
				traceId,
				operation: "offer_activated",
				attributes: { dispatch_id: claim.dispatchId, proposal_id: claim.proposalId, agency_id: targetAgencyId },
			});
			void obs.closeSpan({ spanId: span.spanId });
		}

		this.logger.log(
			`[OfferDispatch] offer=${claim.offerId} dispatched to agency=${targetAgencyId} (role=${claim.role}, briefing=${briefingId})`,
		);
	}

	/**
	 * P1386 AC-2 & AC-5 (Layer 1): pre-spawn early-exit when a role's precondition is met.
	 *
	 * Looks up role in roadmap_proposal.role_early_exit_predicate; if found, evaluates
	 * the predicate function. If true, writes a synthetic agent_runs completion row
	 * and completes the offer with status='success' — no agency dispatch, no
	 * 5-min idle spawn, no SIGTERM, no pause-counter increment.
	 *
	 * Returns true when the dispatcher should NOT continue to pickAgency.
	 *
	 * Failure modes (all fail-open to normal dispatch):
	 *   - role not in predicate table → false (no early-exit for this role)
	 *   - predicate query errors (e.g. function not yet migrated) → false
	 *   - agent_runs telemetry write errors → logged, offer still completed
	 *
	 * Telemetry: each early-exit writes one agent_runs row with
	 * status='completed', activity='early-exit', output_summary='early-exit: <reason>',
	 * duration_ms=0. Operators can count savings via
	 *   SELECT count(*) FROM agent_runs WHERE output_summary LIKE 'early-exit:%'.
	 *
	 * AC-5 (generalization): This method is role-agnostic and reads the predicate
	 * name from the mapping table, allowing other roles (e.g., skeptic-beta) to
	 * define their own early-exit predicates without code changes here.
	 */
	private async tryRoleEarlyExit(claim: ClaimedOffer): Promise<boolean> {
		let predicateName: string | null = null;
		try {
			const { rows } = await query<{ predicate_name: string | null }>(
				`SELECT predicate_name FROM roadmap_proposal.role_early_exit_predicate
				 WHERE role = $1`,
				[claim.role.toLowerCase()],
			);
			predicateName = rows[0]?.predicate_name ?? null;
		} catch (err) {
			this.logger.warn(
				`[OfferDispatch] P1386 AC-5 predicate lookup failed for role=${claim.role}, falling through to normal dispatch:`,
				err instanceof Error ? err.message : err,
			);
			return false;
		}

		if (!predicateName) {
			return false;
		}

		let earlyExitEligible = false;
		let exitReason = "unknown";
		try {
			// Dynamically invoke the predicate function (e.g., roadmap_proposal.v_architect_early_exit)
			const { rows } = await query<{ ok: boolean }>(
				`SELECT ${predicateName}($1) AS ok`,
				[claim.proposalId],
			);
			earlyExitEligible = rows[0]?.ok === true;
			if (earlyExitEligible) {
				exitReason = `${claim.role} precondition met`;
			}
		} catch (err) {
			this.logger.warn(
				`[OfferDispatch] P1386 AC-5 predicate evaluation failed for role=${claim.role}, proposal=${claim.proposalId}, falling through to normal dispatch:`,
				err instanceof Error ? err.message : err,
			);
			return false;
		}

		if (!earlyExitEligible) {
			return false;
		}

		let agentRunId: string | null = null;
		try {
			const { rows } = await query<{ id: number }>(
				`INSERT INTO agent_runs
				   (proposal_id, display_id, agent_identity, stage, model_used,
				    status, activity, started_at)
				 VALUES ($1, 'early-exit', $2, $3, NULL,
				    'running', 'early-exit', now())
				 RETURNING id`,
				[claim.proposalId, this.orchestratorIdentity, claim.role],
			);
			agentRunId = String(rows[0].id);
			await query(
				`UPDATE agent_runs
				    SET status         = 'completed',
				        duration_ms    = 0,
				        output_summary = $1,
				        completed_at   = now()
				  WHERE id = $2`,
				[`early-exit: ${exitReason}`, agentRunId],
			);
		} catch (err) {
			this.logger.error(
				`[OfferDispatch] P1386 AC-5 telemetry write failed for proposal=${claim.proposalId} (continuing with offer completion):`,
				err instanceof Error ? err.message : err,
			);
		}

		await query(
			`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, 'success')`,
			[claim.dispatchId, this.orchestratorIdentity, claim.claimToken],
		);

		this.logger.log(
			`[OfferDispatch] P1386 AC-5 early-exit: ${claim.role} on proposal=${claim.proposalId} (${exitReason}); offer=${claim.offerId} completed as no-op (agent_run=${agentRunId ?? "skipped"})`,
		);

		return true;
	}

	/**
	 * P2335: acquire a project-scoped cubic for the resolved target agency.
	 *
	 * - `targetAgencyId` is the agent_registry.agent_identity TEXT (what
	 *   pickAgency returns), which is exactly the cubic's owning identity.
	 * - project_id is resolved from the offer metadata, falling back to the
	 *   proposal row, defaulting to 1 (control-plane / single-tenant).
	 * - phase is mapped from the offer role (review/gate roles → 'review',
	 *   everything else → 'build') to match the cubic phase taxonomy.
	 *
	 * Returns null when no cubic_id comes back (handler then falls back to the
	 * legacy worktree_hint — AC-14). Throws on DB error so dispatch() can take
	 * the AC-13 "complete as failed" path.
	 */
	private async acquireCubic(
		claim: ClaimedOffer,
		targetAgencyId: string,
	): Promise<{ cubicId: string; worktreePath: string } | null> {
		let projectId = Number(extractProjectId(claim.metadata) ?? "");
		if (!Number.isFinite(projectId) || projectId <= 0) {
			projectId = 1;
			if (claim.proposalId) {
				try {
					const { rows } = await query<{ project_id: number | null }>(
						`SELECT project_id FROM roadmap_proposal.proposal WHERE id = $1`,
						[claim.proposalId],
					);
					const pid = rows[0]?.project_id;
					if (pid !== undefined && pid !== null) projectId = Number(pid);
				} catch {
					/* best-effort — default to project 1 */
				}
			}
		}

		const role = claim.role.toLowerCase();
		const phase =
			ROLE_TO_REQUIRED_CAPABILITIES[role]?.[0] === "review" ? "review" : "build";

		return this.acquireCubicFn(
			targetAgencyId,
			claim.proposalId,
			projectId,
			phase,
		);
	}

	private async pickAgency(claim: ClaimedOffer): Promise<string | null> {
		// Prefer project_id from the metadata; fall back to looking it up on
		// the proposal so resolveAgency gets a real bigint, not "" (which
		// breaks the project_id = $1 filter with an invalid-bigint error).
		let projectId = extractProjectId(claim.metadata);
		if (!projectId && claim.proposalId) {
			try {
				const { rows } = await query<{ project_id: number | null }>(
					`SELECT project_id FROM roadmap_proposal.proposal WHERE id = $1`,
					[claim.proposalId],
				);
				const pid = rows[0]?.project_id;
				if (pid !== undefined && pid !== null) projectId = String(pid);
			} catch {
				/* best-effort — fall through to "" and let resolver handle */
			}
		}

		// Require job capabilities matching the offer role so agencies without
		// capabilities (auto-named ghost agents) are excluded. All named agencies
		// have the full job list; unregistered or ghost agencies don't.
		const requiredCaps = ROLE_TO_REQUIRED_CAPABILITIES[claim.role.toLowerCase()] ?? ["develop"];

		const candidate = await this.resolveAgencyFn(
			projectId ?? "",
			claim.role,
			undefined,
			requiredCaps,
		);
		if (!candidate) return null;

		// agency-resolver returns the provider_registry row's agency_id (numeric);
		// the liaison message bus keys on the agent_registry.agent_identity TEXT.
		return this.queryAgentIdentityFn(candidate.agencyId);
	}

	private async assembleBriefing(
		claim: ClaimedOffer,
		targetAgencyId: string,
	): Promise<string> {
		const briefing = await this.briefingAssembleFn(
			{
				task_id: `offer-${claim.dispatchId}`,
				mission: extractTask(claim.metadata),
				success_criteria: extractSuccessCriteria(claim.metadata),
				parent_agent: this.orchestratorIdentity,
				liaison_agent: targetAgencyId,
				topic_keywords: extractCapabilities(claim.metadata),
			},
			this.orchestratorIdentity,
		);
		return briefing.briefing_id;
	}

	/**
	 * The Zod schema for OfferDispatchPayload requires offer_id to be a UUID.
	 * Live `dispatch_id` is a BIGINT. Pad-and-format into a stable UUID-shaped
	 * string so the schema validates without changing the payload spec.
	 */
	private toUuid(dispatchId: string): string {
		const hex = BigInt(dispatchId).toString(16).padStart(12, "0").slice(-12);
		return `00000000-0000-0000-0000-${hex}`;
	}

	/**
	 * P1291: UPSERT proposal_role_pause row for no-eligible-agency failure.
	 *
	 * Increments failure_count. If failure_count >= threshold, sets expires_at
	 * using exponential backoff formula: BASE * 2^(pause_cycle - 1), capped at MAX.
	 * Then resets failure_count to 0 and increments pause_cycle.
	 *
	 * Emits NOTIFY proposal_role_paused on insertion/activation.
	 */
	private async upsertPauseRow(
		proposalId: number,
		role: string,
		threshold: number,
		baseBackoffMs: number,
		multiplier: number,
		maxBackoffMs: number,
		dispatchId: number,
	): Promise<void> {
		// First attempt: INSERT or increment failure_count if already exists.
		const { rows } = await query<{
			new_failure_count: number;
			pause_cycle: number;
			paused: boolean;
		}>(
			`INSERT INTO roadmap_workforce.proposal_role_pause
			   (proposal_id, role, pause_reason, expires_at, failure_count, pause_cycle, last_failure_dispatch_id)
			 VALUES ($1, $2, 'no_eligible_agency', now() + interval '1 second', 1, 1, $3)
			 ON CONFLICT (proposal_id, role)
			 DO UPDATE SET
			   failure_count = proposal_role_pause.failure_count + 1,
			   paused_at = now(),
			   last_failure_dispatch_id = $3
			 RETURNING
			   failure_count AS new_failure_count,
			   pause_cycle,
			   (xmax::text::int <> 0) AS was_update`,
			[proposalId, role, dispatchId],
		);

		const row = rows[0];
		if (!row) return;

		const newFailureCount = row.new_failure_count;
		const pauseCycle = row.pause_cycle;
		const wasUpdate = row.paused; // true if ON CONFLICT branch executed

		// If we hit the threshold, update expires_at to activate the pause.
		if (newFailureCount >= threshold) {
			// Compute expiry: BASE * 2^(cycle - 1), capped at MAX.
			const expiryMs = Math.min(
				baseBackoffMs * Math.pow(multiplier, pauseCycle - 1),
				maxBackoffMs,
			);
			const expiryInterval = `${expiryMs} milliseconds`;

			await query(
				`UPDATE roadmap_workforce.proposal_role_pause
				   SET expires_at = now() + $1::interval,
				       failure_count = 0,
				       pause_cycle = pause_cycle + 1
				 WHERE proposal_id = $2 AND role = $3`,
				[expiryInterval, proposalId, role],
			);

			// Emit NOTIFY for dashboard/operator visibility.
			await query(`SELECT pg_notify('proposal_role_paused', $1)`, [
				JSON.stringify({
					proposal_id: proposalId,
					role,
					pause_reason: "no_eligible_agency",
					pause_cycle: pauseCycle,
					expires_in_ms: expiryMs,
				}),
			]);

			this.logger.log(
				`[OfferDispatch] P${proposalId} role=${role} paused after ${newFailureCount} failures (cycle=${pauseCycle}, duration=${expiryMs}ms)`,
			);
		}
	}
}

function extractCapabilities(metadata: Record<string, unknown>): string[] {
	const v = metadata.required_capabilities ?? metadata.capabilities;
	if (Array.isArray(v)) {
		return v.filter((x): x is string => typeof x === "string");
	}
	return [];
}

function extractRouteHint(metadata: Record<string, unknown>): string {
	if (typeof metadata.route_hint === "string") return metadata.route_hint;
	if (typeof metadata.provider === "string") return metadata.provider;
	// Default must match a roadmap.model_routes.agent_provider value
	// ('claude', 'codex', 'copilot', 'gemini'). 'claude-code' is the
	// CLI name, not the provider name — using it raises P235 in
	// agent-spawner ("No enabled route found in DB").
	return "claude";
}

function extractProjectId(metadata: Record<string, unknown>): string | null {
	const v = metadata.project_id;
	if (typeof v === "string") return v;
	if (typeof v === "number") return String(v);
	return null;
}

function extractTask(metadata: Record<string, unknown>): string {
	if (typeof metadata.task === "string") return metadata.task;
	return "Execute the dispatched work for this offer.";
}

function extractSuccessCriteria(metadata: Record<string, unknown>): string[] {
	const v = metadata.success_criteria ?? metadata.acceptance_criteria;
	if (Array.isArray(v)) {
		return v.filter((x): x is string => typeof x === "string");
	}
	return [];
}

function extractWorktreeHint(metadata: Record<string, unknown>): string | null {
	const v = metadata.worktree_hint ?? metadata.worktree;
	return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function extractTraceId(metadata: Record<string, unknown>): string | null {
	const v = metadata.trace_id;
	return typeof v === "string" && v.length > 0 ? v : null;
}
