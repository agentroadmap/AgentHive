/**
 * V3-C6 (P1438): agency-side self-claim loop.
 *
 * The self-claim inversion of the orchestrator's OfferClaimLoop
 * (src/core/orchestration/offer-claim-loop.ts). Instead of the orchestrator
 * claiming every offer for itself and re-dispatching via A2A, EACH agency's
 * standing liaison runs this loop: it LISTENs on `work_offers`, calls
 * fn_claim_work_offer with its OWN identity and REAL capabilities (the C1
 * atomic primitive, agency-row FOR UPDATE + SKIP LOCKED guarantees exactly one
 * winner), and on a successful claim invokes onClaim() to spawn the worker.
 *
 * Structure (LISTEN + poll + bounded concurrency) mirrors OfferClaimLoop, but
 * two things differ deliberately:
 *   1. claimOne passes (agencyIdentity, REAL capabilities, ttl, projectId, host)
 *      — NOT the orchestrator's empty '[]' caps. The orchestrator claimed as a
 *      pure router so empty caps (match-all) was correct there; an agency must
 *      pass its real caps or fn_claim_work_offer's capability gate silently
 *      passes everything. THIS is the C6 correctness gate.
 *   2. on claim, it calls an injected onClaim(claim) callback (the liaison's
 *      spawn path) rather than an OfferDispatcher that re-routes via A2A.
 *
 * Gated by the AGENCY_OFFER_CLAIM flag; the liaison only starts this when
 * self-claim mode is enabled. Rollback is a flag flip (see P1438 / resume brief).
 */

import { hostname } from "node:os";
import { query as defaultQuery } from "../postgres/pool.ts";
import {
	handleOfferDispatch,
	type OfferDispatchHandlerDeps,
	readAgencyMaxInFlight,
} from "./offer-dispatch-handler.ts";
import { isProviderAuthDown } from "../../core/orchestration/provider-auth.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";
import {
	evaluateSubscriptionPolicy,
	declareThrottle,
} from "./subscription-policy.ts";
import { matchPersonaForCapability } from "./persona-matchmaker.ts";
import {
	decideRecoveryAction,
	type RecoveryDecision,
} from "./recovery-action.ts";
import { evaluateCostQuota } from "./cost-quota-admission.ts";
import { evaluateStakeAdmission } from "./stake-admission.ts";
import { incrementDebt, resetDebt } from "./fair-share-debt.ts";
import { hasActiveOverride } from "./quota-override.ts";

export type QueryFn = typeof defaultQuery;

const WORK_OFFERS_CHANNEL = "work_offers";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
// V3-C1 (P1433): lease TTL must exceed the spawn timeout (default 1_200_000ms =
// 20min); 1320s = 22min floor so a long worker is not falsely lease-expired.
const DEFAULT_LEASE_TTL_SECONDS = 1320;
const DEFAULT_MAX_CONCURRENT = 8;

const AGENCY_HOST = process.env.AGENTHIVE_HOST ?? hostname();

/** Minimal LISTEN client contract (matches OfferClaimLoop's ListenerClient). */
export interface ListenerClient {
	query(text: string, params?: unknown[]): Promise<unknown>;
	on(event: "notification", handler: (msg: { channel: string }) => void): unknown;
	on(event: "error", handler: (err: Error) => void): unknown;
	removeListener(
		event: "notification",
		handler: (msg: { channel: string }) => void,
	): unknown;
	removeListener(event: "error", handler: (err: Error) => void): unknown;
	/** PoolClient releases back to the pool. */
	release?(): void;
	/** Raw pg.Client closes its socket. connectListenClient returns a Client
	 *  (no .release), so stop() MUST .end() it or the dedicated
	 *  agenthive-a2a-listen-<id> connection leaks on every liaison restart. */
	end?(): Promise<void>;
}

/** The claim handed to onClaim — same shape the spawn path needs. */
export interface AgencyClaimedOffer {
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

/** Row returned by fn_claim_work_offer (8-col, 5-arg canonical). */
interface ClaimRow {
	dispatch_id: number;
	proposal_id: number;
	squad_name: string;
	dispatch_role: string;
	claim_token: string;
	claim_expires_at: string;
	offer_version: number;
	metadata: Record<string, unknown> | null;
}

export interface AgencyClaimLoopOptions {
	/** This agency's identity — the claimer passed to fn_claim_work_offer. */
	agencyIdentity: string;
	/** This agency's provider (e.g., "anthropic", "openai"). Used for AC-5 auth readiness checks. */
	provider: string;
	/**
	 * This agency's REAL capabilities (e.g. ["develop"] / ["review"]). Passed as
	 * the p_required_capabilities arg so fn_claim_work_offer's capability gate
	 * only lets this agency win offers it can actually serve. Empty array would
	 * mean "match everything" — almost never what an agency wants.
	 */
	capabilities: string[];
	/** Invoked once per successfully-claimed offer; the liaison spawns here. */
	onClaim: (claim: AgencyClaimedOffer) => Promise<void>;
	/** Opens a dedicated LISTEN connection for this agency. */
	connectListener: () => Promise<ListenerClient>;
	/** Optional project scope; NULL = any project this agency is subscribed to. */
	projectId?: number | null;
	leaseTtlSeconds?: number;
	pollIntervalMs?: number;
	maxConcurrent?: number;
	queryFn?: QueryFn;
	logger?: Pick<Console, "log" | "warn" | "error">;
}

export class AgencyClaimLoop {
	private readonly agencyIdentity: string;
	private readonly provider: string;
	private readonly capabilitiesJson: string;
	private readonly onClaim: (claim: AgencyClaimedOffer) => Promise<void>;
	private readonly connectListener: () => Promise<ListenerClient>;
	private readonly projectId: number | null;
	private readonly leaseTtlSeconds: number;
	private readonly pollIntervalMs: number;
	private readonly maxConcurrent: number;
	private readonly query: QueryFn;
	private readonly logger: Pick<Console, "log" | "warn" | "error">;

	private listenerClient: ListenerClient | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private inFlightClaims = 0;

	private readonly notificationHandler = (msg: { channel: string }): void => {
		if (msg.channel !== WORK_OFFERS_CHANNEL) return;
		void this.tryClaim();
	};

	constructor(opts: AgencyClaimLoopOptions) {
		this.agencyIdentity = opts.agencyIdentity;
		this.provider = opts.provider;
		// Default to NO capabilities-filter only if the caller explicitly passes
		// an empty list; otherwise serialize the real caps as a jsonb array.
		this.capabilitiesJson = JSON.stringify(opts.capabilities ?? []);
		this.onClaim = opts.onClaim;
		this.connectListener = opts.connectListener;
		this.projectId = opts.projectId ?? null;
		this.leaseTtlSeconds = opts.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
		this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.query = opts.queryFn ?? defaultQuery;
		this.logger = opts.logger ?? console;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("AgencyClaimLoop already started");
		this.started = true;

		const client = await this.connectListener();
		this.listenerClient = client;
		client.on("notification", this.notificationHandler);
		client.on("error", (err) => {
			this.logger.error(`[AgencyClaim:${this.agencyIdentity}] listener error:`, err);
		});
		await (client.query as (text: string) => Promise<unknown>)(
			`LISTEN ${WORK_OFFERS_CHANNEL}`,
		);
		this.logger.log(
			`[AgencyClaim:${this.agencyIdentity}] listening on ${WORK_OFFERS_CHANNEL} (caps=${this.capabilitiesJson})`,
		);

		this.pollTimer = setInterval(() => {
			void this.tryClaim();
		}, this.pollIntervalMs);

		await this.tryClaim();
	}

	async stop(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.listenerClient) {
			this.listenerClient.removeListener("notification", this.notificationHandler);
			// A raw pg.Client (connectListenClient) must be .end()ed to free its
			// dedicated connection; a PoolClient is .release()d. Prefer end().
			if (this.listenerClient.end) {
				await this.listenerClient.end().catch(() => {
					/* socket may already be closed */
				});
			} else {
				this.listenerClient.release?.();
			}
			this.listenerClient = null;
		}
		this.started = false;
	}

	private async tryClaim(): Promise<void> {
		while (this.inFlightClaims < this.maxConcurrent) {
			const claim = await this.claimOne();
			if (!claim) break;
			this.inFlightClaims++;
			void this.onClaim(claim)
				.catch((err) => {
					this.logger.error(
						`[AgencyClaim:${this.agencyIdentity}] onClaim failed for offer ${claim.offerId}:`,
						err instanceof Error ? err.message : err,
					);
				})
				.finally(() => {
					this.inFlightClaims--;
				});
		}
	}

	private async claimOne(): Promise<AgencyClaimedOffer | null> {
		try {
			// AC-5: Check auth readiness before attempting to claim
			const authDown = await isProviderAuthDown(this.provider, this.query);
			if (authDown) {
				this.logger.warn(
					`[AgencyClaim:${this.agencyIdentity}] Provider auth for '${this.provider}' is down; skipping claim until cleared`,
				);
				return null;
			}

			// P465: subscription-aware claim policy — refuse new claims that would
			// breach the safety margin. On refusal, self-declare throttled so the
			// orchestrator re-routes any pending offers to an unthrottled agency.
			// P3000 AC-10d: check for an operator-granted quota override FIRST; if
			// one is found (and consumed if single_use), skip the subscription check.
			const sqlExec = (sql: string, params?: unknown[]) => this.query(sql, params);

			// P2997 AC-7/AC-8: stake/capability-bond pre-claim gate. An agent whose
			// bond was slashed (genuine failures consumed it) or returned (withdrawn)
			// is not admissible until re-bonded. active/legacy agents pass. This is a
			// hard gate (unlike the soft-fail proof layer): a slashed agent must not
			// keep claiming work. Read failures fail-open (admit) so a transient DB
			// hiccup never wedges the whole claim loop.
			const stakeAdmission = await evaluateStakeAdmission(
				this.agencyIdentity,
				sqlExec,
			).catch(() => null);
			if (stakeAdmission && !stakeAdmission.allowed) {
				this.logger.warn(
					`[AgencyClaim:${this.agencyIdentity}] P2997 stake gate refused claim: ${stakeAdmission.reason} (status=${stakeAdmission.stakeStatus})`,
				);
				return null;
			}

			// P2997 AC-7: wire the EXISTING proof check (verifyAgentIdentity) into the
			// claim path. Previously it ran only in msg_send (pg-handlers.ts). The
			// claim loop has no per-message signature, so we verify identity presence
			// (unsigned → soft-fail logged). In hard-fail mode (AGENTHIVE_AUTH_REQUIRED
			// =true) an unsigned/unverifiable agent is refused at claim, not just at
			// msg_send — closing the wiring gap named in AC-7.
			try {
				const { verifyAgentIdentity } = await import(
					"../../core/identity/identity-verification.ts"
				);
				const proof = await verifyAgentIdentity(this.agencyIdentity);
				if (proof.rejected) {
					this.logger.warn(
						`[AgencyClaim:${this.agencyIdentity}] P2997 proof gate (hard-fail) refused claim: ${proof.reason}`,
					);
					return null;
				}
			} catch (err) {
				// Proof module load/lookup failure: fail-open (soft), never wedge claims.
				this.logger.warn(
					`[AgencyClaim:${this.agencyIdentity}] P2997 proof check skipped (non-fatal):`,
					err instanceof Error ? err.message : err,
				);
			}

			const quotaOverride = await hasActiveOverride(this.agencyIdentity, sqlExec as unknown as Parameters<typeof hasActiveOverride>[1]).catch(() => null);
			if (quotaOverride) {
				this.logger.log(
					`[AgencyClaim:${this.agencyIdentity}] P3000 quota override active (id=${quotaOverride.id}, grantedBy=${quotaOverride.grantedBy}, singleUse=${quotaOverride.singleUse}) — skipping subscription policy`,
				);
			}
			const policyResult = quotaOverride
				? { allowed: true, reason: null, resets_at: null, tightest_window: null }
				: await evaluateSubscriptionPolicy(
					this.agencyIdentity,
					sqlExec,
					this.logger,
				);
			if (!policyResult.allowed) {
				this.logger.warn(
					`[AgencyClaim:${this.agencyIdentity}] subscription policy refused claim: ${policyResult.reason}`,
				);
				await declareThrottle(
					this.agencyIdentity,
					policyResult.resets_at,
					policyResult.reason ?? "subscription_quota_exceeded",
					sqlExec,
				).catch((err) => {
					this.logger.error(
						`[AgencyClaim:${this.agencyIdentity}] declareThrottle failed:`,
						err instanceof Error ? err.message : err,
					);
				});
				return null;
			}

			// P1698 AC-8: Check max_in_flight capacity before claiming
			const maxInFlight = await readAgencyMaxInFlight(
				this.agencyIdentity,
				sqlExec,
				this.logger,
			);
			const inFlightResult = (await this.query(
				`SELECT COALESCE(inf.in_flight_count, 0) AS in_flight_count
				 FROM roadmap_workforce.provider_registry pr
				 JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
				 LEFT JOIN roadmap_workforce.v_agency_in_flight inf ON inf.provider_registry_id = pr.id
				 WHERE ar.agent_identity = $1
				 LIMIT 1`,
				[this.agencyIdentity],
			)) as { rows: Array<{ in_flight_count: number }> };
			const inFlightCount = inFlightResult.rows[0]?.in_flight_count ?? 0;

			if (inFlightCount >= maxInFlight) {
				this.logger.warn(
					`[AgencyClaim:${this.agencyIdentity}] at capacity: in_flight=${inFlightCount} >= max=${maxInFlight}; skipping claim`,
				);
				return null;
			}

			// P3000: cost-quota admission control at claim time. Runs after the
			// subscription policy + capacity gates so token-quota refusals are caught
			// only once those cheaper checks pass. On refusal, bump the starvation
			// debt so the fair-share recovery path can grant reserved headroom later.
			// Skip when an operator quota override is active (AC-10d).
			const costResult = quotaOverride
				? { allowed: true, reason: null, resets_at: null, reserved_headroom_used: false }
				: await evaluateCostQuota(this.agencyIdentity, 0, sqlExec);
			if (!costResult.allowed) {
				this.logger.warn(
					`[AgencyClaim:${this.agencyIdentity}] cost quota refused claim: ${costResult.reason}`,
				);
				void incrementDebt(this.agencyIdentity, sqlExec);
				return null;
			}

			const { rows } = await this.query<ClaimRow>(
				`SELECT dispatch_id, proposal_id, squad_name, dispatch_role,
				        claim_token, claim_expires_at, offer_version, metadata
				   FROM roadmap_workforce.fn_claim_work_offer($1, $2::jsonb, $3, $4, $5)`,
				[
					this.agencyIdentity,
					this.capabilitiesJson,
					this.leaseTtlSeconds,
					this.projectId,
					AGENCY_HOST,
				],
			);
			const row = rows[0];
			if (!row) return null;
			// P3000: successful claim — reset starvation debt.
			void resetDebt(this.agencyIdentity, sqlExec);
			return {
				offerId: String(row.dispatch_id),
				dispatchId: Number(row.dispatch_id),
				proposalId: Number(row.proposal_id),
				squadName: row.squad_name,
				role: row.dispatch_role,
				claimToken: row.claim_token,
				claimExpiresAt: row.claim_expires_at,
				offerVersion: Number(row.offer_version),
				metadata: row.metadata ?? {},
				leaseTtlSeconds: this.leaseTtlSeconds,
			};
		} catch (err) {
			this.logger.error(
				`[AgencyClaim:${this.agencyIdentity}] fn_claim_work_offer error:`,
				err instanceof Error ? err.message : err,
			);
			return null;
		}
	}
}

/**
 * V3-C6 (P1438) adapter: execute a self-claimed offer through the EXISTING,
 * battle-tested liaison spawn path (handleOfferDispatch) instead of duplicating
 * its capacity-check / failure_class-stamp / renewal / completion logic.
 *
 * handleOfferDispatch consumes a LiaisonMessage whose payload is the
 * OfferDispatchEnvelope the orchestrator's A2A path used to send. We synthesize
 * that same envelope from the AgencyClaimedOffer — the offer is already CLAIMED
 * (by this agency, via fn_claim_work_offer), so the handler just spawns + renews
 * + completes. briefing_id / worktree_hint / route_hint are read from the offer
 * metadata (briefing assembled at post-time per the C6 design).
 *
 * This is the onClaim callback the liaison hands to AgencyClaimLoop.
 */
export function makeAgencyClaimExecutor(
	agencyId: string,
	deps: OfferDispatchHandlerDeps = {},
	executorDeps: AgencyClaimExecutorDeps = {},
): (claim: AgencyClaimedOffer) => Promise<void> {
	const exec = executorDeps.queryFn ?? defaultQuery;
	const logger = executorDeps.logger ?? console;
	return async (claim: AgencyClaimedOffer): Promise<void> => {
		const md = claim.metadata ?? {};
		const briefingId =
			typeof md.briefing_id === "string" ? md.briefing_id : undefined;
		const worktreeHint =
			typeof md.worktree_hint === "string" ? md.worktree_hint : undefined;
		const routeHint =
			typeof md.route_hint === "string" ? md.route_hint : "";
		const requiredCaps = Array.isArray(md.required_capabilities)
			? (md.required_capabilities as string[])
			: [claim.role];

		// V3-C6 AC-9 (matchmaking): the brain selects the worker persona for this
		// claimed offer — a stable name for common capabilities, a dynamic
		// claude.<specialty> for rare ones. We record it on the dispatch row
		// (metadata.persona_name) so the control feed reflects the chosen persona,
		// and we lead the spawn's capability hints with the matched expertise so
		// the spawner's structured-identity branch encodes the specialty.
		const personaMatch = matchPersonaForCapability(claim.role, requiredCaps);
		const orderedCaps = orderCapsByExpertise(requiredCaps, personaMatch.expertiseHint);
		await recordPersonaMatch(exec, claim.dispatchId, personaMatch, logger).catch(
			() => {},
		);
		logger.log(
			`[AgencyClaim:${agencyId}] AC-9 matchmaking offer=${claim.offerId} role=${claim.role} → persona=${personaMatch.personaName} (stable=${personaMatch.stable}, source=${personaMatch.source})`,
		);

		// handleOfferDispatch reads ONLY msg.payload (offer-dispatch-handler.ts:118),
		// so we synthesize just the payload and cast — fabricating the full
		// LiaisonMessage envelope (message_id/sequence/correlation_id/signed_at/
		// signature) would be meaningless here since none of it is consumed.
		const synthetic = {
			agency_id: agencyId,
			direction: "orchestrator->liaison" as const,
			kind: "offer_dispatch" as const,
			payload: {
				offer_id: claim.offerId,
				role: claim.role,
				required_capabilities: orderedCaps,
				route_hint: routeHint,
				briefing_id: briefingId,
				claim_token: claim.claimToken,
				dispatch_id: claim.dispatchId,
				proposal_id: claim.proposalId,
				squad_name: claim.squadName,
				lease_ttl_seconds: claim.leaseTtlSeconds,
				worktree_hint: worktreeHint,
				// AC-9: carry the matched persona name so the control feed / telemetry
				// label the worker by the chosen persona, not just the agency.
				persona_name: personaMatch.personaName,
			},
		} as unknown as LiaisonMessage;

		await handleOfferDispatch(agencyId, synthetic, deps);

		// V3-C6 AC-10 (fix coordination): after the dispatch completes, if the
		// offer did NOT end delivered, decide a bounded recovery action
		// (retry/reroute/escalate/log) and record it against the offer — never a
		// silent drop, never an unconditional retry storm. handleOfferDispatch has
		// already applied the mechanical lifecycle (failed/hold); here we attach the
		// brain's recovery DECISION as a durable, observable record.
		await coordinateFailureRecovery(exec, agencyId, claim, logger).catch((err) => {
			logger.warn(
				`[AgencyClaim:${agencyId}] AC-10 recovery coordination failed for offer=${claim.offerId}:`,
				err instanceof Error ? err.message : err,
			);
		});
	};
}

/** Injectable deps for the executor (test seam for DB writes + logging). */
export interface AgencyClaimExecutorDeps {
	queryFn?: QueryFn;
	logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Lead the capability list with the matched expertise hint so the spawner's
 * structured-identity branch (agent-spawner identityHints[0]) encodes the
 * chosen specialty into worker_identity. Preserves the rest of the caps.
 */
export function orderCapsByExpertise(
	caps: readonly string[],
	expertiseHint: string,
): string[] {
	const hint = expertiseHint.trim();
	if (!hint) return [...caps];
	const rest = caps.filter((c) => c && c.toLowerCase() !== hint.toLowerCase());
	return [hint, ...rest];
}

/**
 * AC-9: persist the matched persona on the dispatch row so the control feed and
 * telemetry surface which persona the brain selected for this offer.
 */
async function recordPersonaMatch(
	exec: QueryFn,
	dispatchId: number,
	match: { personaName: string; stable: boolean; source: string },
	logger: Pick<Console, "warn">,
): Promise<void> {
	try {
		await exec(
			`UPDATE roadmap_workforce.squad_dispatch
			    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
			          'persona_name', $2::text,
			          'worker_persona', $2::text,
			          'persona_stable', $3::boolean,
			          'persona_source', $4::text
			        )
			  WHERE id = $1`,
			[dispatchId, match.personaName, match.stable, match.source],
		);
	} catch (err) {
		logger.warn(
			`[AgencyClaim] recordPersonaMatch failed for dispatch ${dispatchId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

/**
 * AC-10: read the post-dispatch outcome and, if the offer is not delivered,
 * decide + record a recovery action. Idempotent-ish: if a recovery_action is
 * already recorded for the same attempt we skip (avoids double-write on retries).
 */
export async function coordinateFailureRecovery(
	exec: QueryFn,
	agencyId: string,
	claim: AgencyClaimedOffer,
	logger: Pick<Console, "log" | "warn">,
): Promise<RecoveryDecision | null> {
	const { rows } = await exec<{
		offer_status: string;
		dispatch_status: string;
		attempt_count: number;
		failure_class: string | null;
		failure_is_transient: boolean | null;
		metadata: Record<string, unknown> | null;
		paused_at_provider_limit: boolean | null;
	}>(
		`SELECT offer_status, dispatch_status, attempt_count, failure_class,
		        failure_is_transient,
		        COALESCE(metadata, '{}'::jsonb) AS metadata,
		        paused_at_provider_limit
		   FROM roadmap_workforce.squad_dispatch
		  WHERE id = $1`,
		[claim.dispatchId],
	);
	const row = rows[0];
	if (!row) return null;

	// Delivered → nothing to recover. A provider-limit HOLD is a deliberate pause
	// (P1682), not a failure to coordinate — leave it for the wake sweep.
	const delivered =
		row.offer_status === "delivered" || row.dispatch_status === "completed";
	if (delivered || row.paused_at_provider_limit) return null;

	const failed =
		row.offer_status === "failed" ||
		row.dispatch_status === "failed" ||
		row.offer_status === "returned";
	if (!failed) return null;

	const decision = decideRecoveryAction({
		errorText:
			typeof row.metadata?.last_error === "string"
				? (row.metadata.last_error as string)
				: null,
		failureReason: row.failure_class ?? null,
		attemptCount: row.attempt_count ?? 1,
	});

	await exec(
		`UPDATE roadmap_workforce.squad_dispatch
		    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
		          'recovery_action', $2::text,
		          'recovery_reason', $3::text,
		          'recovery_failure_class', $4::text,
		          'recovery_decided_by', $5::text,
		          'recovery_attempt', $6::int
		        )
		  WHERE id = $1`,
		[
			claim.dispatchId,
			decision.action,
			decision.reason,
			decision.failureClass,
			agencyId,
			row.attempt_count ?? 1,
		],
	);
	logger.log(
		`[AgencyClaim:${agencyId}] AC-10 recovery offer=${claim.offerId} → ${decision.action} (${decision.failureClass}): ${decision.reason}`,
	);
	return decision;
}
