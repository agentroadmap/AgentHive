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
import { resolvePersonaByRoleName } from "./gate-role-resolver.ts";

const obs = new ObservabilityWriter("agency:offer-dispatch");

const ORCHESTRATOR_HOST = process.env.AGENTHIVE_HOST ?? hostname();
void ORCHESTRATOR_HOST; // reserved for future host-aware agency filtering

/**
 * Maps lowercase role name to the minimum required capabilities for agency selection.
 * Falls back to ["develop"] for any unrecognised role.
 *
 * P1290: Only references capabilities present in live provider_registry data
 * (jobs.develop=9, jobs.review=9, jobs.design=9 as of 2026-05-21).
 * enhance/gate-review/code-review had zero matching agencies and are NOT used.
 * Role-specific behaviour comes from the briefing prompt, not the capability filter.
 *
 * Exported so the capability-coverage health check and preflight (P1289) read
 * from the same source — no private duplicates.
 */
export const ROLE_TO_REQUIRED_CAPABILITIES: Record<string, string[]> = {
	// Developer-class roles
	developer: ["develop"],
	engineer: ["develop"],
	researcher: ["develop"],
	drafter: ["develop"],
	architect: ["develop"],
	enrichment_agent: ["develop"],
	enhancer: ["develop"],
	// Reviewer-class roles (gate/code review reduces to general review for matching)
	"gate-reviewer": ["review"],
	"skeptic-alpha": ["review"],
	"skeptic-beta": ["review"],
	"code-reviewer": ["review"],
	"architecture-reviewer": ["review"],
	skeptic: ["review"],
	// Design-track
	"system-designer": ["design"],
	// Special investigator class — matched as developer
	"orchestrator-liaison-investigator": ["develop"],
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
	}

	async dispatch(claim: ClaimedOffer): Promise<void> {
		const targetAgencyId = await this.pickAgency(claim);
		if (!targetAgencyId) {
			this.logger.warn(
				`[OfferDispatch] no eligible agency for offer ${claim.offerId} (role=${claim.role}); leaving lease to expire so reaper requeues`,
			);
			return;
		}

		const briefingId = await this.assembleBriefing(claim, targetAgencyId);

		const payload: OfferDispatchPayload = {
			offer_id: this.toUuid(claim.offerId),
			role: claim.role,
			required_capabilities: extractCapabilities(claim.metadata),
			route_hint: extractRouteHint(claim.metadata),
		};

		// P1113: pre-resolve persona so the agency doesn't need a DB round-trip
		// per spawn. Errors are swallowed — agency falls back to its own lookup.
		const persona = await resolvePersonaByRoleName(claim.role).catch(() => null);

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
			// P908-D: thread trace_id so offer-dispatch-handler can open the
			// offer_completed lifecycle span correlated to this trace.
			trace_id: extractTraceId(claim.metadata),
			// P1113: forward full task + pre-resolved persona to the agency.
			task: extractTask(claim.metadata),
			...(persona ? { persona } : {}),
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
