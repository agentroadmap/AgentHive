/**
 * P299-C: Orchestrator-side offer dispatch.
 *
 * Once `offer-claim-loop.ts` claims an offer with the orchestrator's identity,
 * this module:
 *   1. Picks the target agency (whose liaison will fork the CLI subprocess).
 *   2. Assembles the spawn briefing (P466).
 *   3. Sends an `offer_dispatch` message via the liaison message bus.
 *   4. Starts a per-offer lease-renewal timer (orchestrator-side, so a liaison
 *      crash does not orphan the lease — the orchestrator keeps renewing until
 *      a `claim_status` uplink lands or the TTL expires).
 *
 * The corresponding `claim_status` uplink (sent by the agency liaison when its
 * subprocess exits) is consumed by `handleClaimStatusUplink()` below, which
 * cancels the renewal timer and calls `fn_complete_work_offer`.
 *
 * No subprocess is forked here — that happens inside the agency liaison
 * (`src/infra/agency/offer-dispatch-handler.ts`).
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { query } from "../../infra/postgres/pool.ts";
import { resolveAgency } from "./resolvers/agency-resolver.ts";
import { briefingAssemble } from "../../infra/agency/spawn-briefing-service.ts";
import { sendMessage } from "../../infra/agency/liaison-message-service.ts";
import type { OfferDispatchPayload } from "../../infra/agency/liaison-message-types.ts";

const ORCHESTRATOR_HOST = process.env.AGENTHIVE_HOST ?? hostname();

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
	handleClaimStatusUplink(payload: ClaimStatusUplink): Promise<void>;
	stop(): void;
}

export interface ClaimStatusUplink {
	offerId: string;
	status: "delivered" | "failed" | "in_progress";
	exitCode?: number | null;
	summary?: string | null;
}

interface InFlightOffer {
	claim: ClaimedOffer;
	targetAgencyId: string;
	briefingId: string;
	renewalTimer: ReturnType<typeof setInterval>;
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
 * Stateful dispatcher: holds in-memory state for renewal timers + agency
 * routing. One instance per orchestrator process. Crash-safe: if the
 * orchestrator dies, all in-flight leases time out at `claim_expires_at`
 * and the offer reaper requeues them.
 */
export class OrchestratorOfferDispatcher implements OfferDispatcher {
	private readonly orchestratorIdentity: string;
	private readonly logger: Pick<Console, "log" | "warn" | "error">;
	private readonly inFlight = new Map<string, InFlightOffer>();
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

		// Augment payload with briefing_id as an extra field. The Zod schema
		// uses .strip() by default, so unknown fields are tolerated by the
		// liaison side; receiver reads briefing_id from the raw message.
		const augmented: Record<string, unknown> = {
			...payload,
			briefing_id: briefingId,
			claim_token: claim.claimToken,
			dispatch_id: claim.dispatchId,
			proposal_id: claim.proposalId,
			squad_name: claim.squadName,
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

		const renewalIntervalMs = Math.max(
			5_000,
			Math.floor((claim.leaseTtlSeconds * 1_000) / 3),
		);
		const renewalTimer = setInterval(() => {
			void this.renewLease(claim);
		}, renewalIntervalMs);

		this.inFlight.set(claim.offerId, {
			claim,
			targetAgencyId,
			briefingId,
			renewalTimer,
		});
	}

	async handleClaimStatusUplink(uplink: ClaimStatusUplink): Promise<void> {
		const inflight = this.inFlight.get(uplink.offerId);
		if (!inflight) {
			this.logger.warn(
				`[OfferDispatch] claim_status for unknown offer ${uplink.offerId} (status=${uplink.status}); orchestrator may have restarted`,
			);
			return;
		}

		clearInterval(inflight.renewalTimer);
		this.inFlight.delete(uplink.offerId);

		if (uplink.status === "in_progress") {
			// Liaison reports liveness without exiting — keep tracking but don't
			// complete the offer. Re-arm the renewal timer.
			const renewalIntervalMs = Math.max(
				5_000,
				Math.floor((inflight.claim.leaseTtlSeconds * 1_000) / 3),
			);
			inflight.renewalTimer = setInterval(() => {
				void this.renewLease(inflight.claim);
			}, renewalIntervalMs);
			this.inFlight.set(uplink.offerId, inflight);
			return;
		}

		const completionStatus =
			uplink.status === "delivered" ? "delivered" : "failed";

		try {
			await query(
				`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3, $4)`,
				[
					inflight.claim.dispatchId,
					this.orchestratorIdentity,
					inflight.claim.claimToken,
					completionStatus,
				],
			);
			this.logger.log(
				`[OfferDispatch] offer=${uplink.offerId} completed status=${completionStatus} (agency=${inflight.targetAgencyId})`,
			);
		} catch (err) {
			this.logger.error(
				`[OfferDispatch] fn_complete_work_offer failed for offer ${uplink.offerId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	stop(): void {
		for (const [, inflight] of this.inFlight) {
			clearInterval(inflight.renewalTimer);
		}
		this.inFlight.clear();
	}

	private async pickAgency(claim: ClaimedOffer): Promise<string | null> {
		const projectId = extractProjectId(claim.metadata);
		const candidate = await this.resolveAgencyFn(
			projectId ?? "",
			claim.role,
		);
		if (!candidate) return null;

		// agency-resolver returns the provider_registry row's agency_id (numeric);
		// the liaison message bus keys on the agent_registry.agent_identity TEXT.
		// Resolve via a single lookup.
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

	private async renewLease(claim: ClaimedOffer): Promise<void> {
		try {
			await query(
				`SELECT roadmap_workforce.fn_renew_lease($1, $2, $3, $4)`,
				[
					claim.dispatchId,
					this.orchestratorIdentity,
					claim.claimToken,
					claim.leaseTtlSeconds,
				],
			);
		} catch (err) {
			this.logger.warn(
				`[OfferDispatch] fn_renew_lease failed for offer ${claim.offerId} (will retry next tick):`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	/**
	 * The Zod schema for OfferDispatchPayload requires offer_id to be a UUID.
	 * Live `dispatch_id` is a BIGINT. Pad-and-format into a stable UUID-shaped
	 * string so the schema validates without changing the payload spec.
	 * Format: 00000000-0000-0000-0000-<12-hex-chars-of-dispatch_id>
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
	return "claude-code";
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

function extractStage(metadata: Record<string, unknown>): string | null {
	if (typeof metadata.stage === "string") return metadata.stage;
	return null;
}

function extractSuccessCriteria(metadata: Record<string, unknown>): string[] {
	const v = metadata.success_criteria ?? metadata.acceptance_criteria;
	if (Array.isArray(v)) {
		return v.filter((x): x is string => typeof x === "string");
	}
	return [];
}
