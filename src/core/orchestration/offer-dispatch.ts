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

const ORCHESTRATOR_HOST = process.env.AGENTHIVE_HOST ?? hostname();
void ORCHESTRATOR_HOST; // reserved for future host-aware agency filtering

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

	constructor(opts: OfferDispatcherOptions) {
		this.orchestratorIdentity = opts.orchestratorIdentity;
		this.logger = opts.logger ?? console;
		this.resolveAgencyFn = opts.dispatch_resolveAgency ?? resolveAgency;
		this.briefingAssembleFn =
			opts.dispatch_briefingAssemble ?? briefingAssemble;
		this.sendMessageFn = opts.dispatch_sendMessage ?? sendMessage;
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
		};

		await this.sendMessageFn({
			agency_id: targetAgencyId,
			direction: "orchestrator->liaison",
			kind: "offer_dispatch",
			payload: augmented,
		});

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
		const candidate = await this.resolveAgencyFn(
			projectId ?? "",
			claim.role,
		);
		if (!candidate) return null;

		// agency-resolver returns the provider_registry row's agency_id (numeric);
		// the liaison message bus keys on the agent_registry.agent_identity TEXT.
		const { rows } = await query<{ agent_identity: string }>(
			`SELECT agent_identity FROM roadmap_workforce.agent_registry WHERE id = $1`,
			[candidate.agencyId.toString()],
		);
		return rows[0]?.agent_identity ?? null;
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
