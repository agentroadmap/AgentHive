/**
 * P299-C: Orchestrator-side offer claim loop.
 *
 * Replaces the per-agency `OfferProvider` (P281) by absorbing claim ownership
 * into the central orchestrator. Listens on the `work_offers` Postgres NOTIFY
 * channel + 30s poll fallback. On wake, calls `fn_claim_work_offer` with the
 * orchestrator's identity, then hands the claim to `dispatchOfferToLiaison`.
 *
 * The orchestrator is the **claimer**, not the spawn agency. Capability-based
 * routing happens inside `fn_claim_work_offer`; agency selection (which
 * agency's liaison to dispatch to) happens in `offer-dispatch.ts`.
 *
 * Activated only when `process.env.DISPATCH_MODE === 'liaison_hub'`. Default
 * mode (`offer_provider`) leaves the legacy OfferProvider service in charge.
 */
import { hostname } from "node:os";
import { query as _pgQuery } from "../../infra/postgres/pool.ts";
import type { ClaimedOffer, OfferDispatcher } from "./offer-dispatch.ts";
import { ObservabilityWriter } from "../observability/observability-writer.ts";

const obs = new ObservabilityWriter("agency:offer-claim-loop");

// Allows tests to inject a mock query function without module-level mocking.
type QueryFn = typeof _pgQuery;
let _query: QueryFn = _pgQuery;
export function _setQueryForTest(fn: QueryFn): void { _query = fn; }
function query(...args: Parameters<QueryFn>) { return _query(...args); }

const WORK_OFFERS_CHANNEL = "work_offers";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
// V3-C1 (P1433): lease TTL must exceed the spawn timeout (AGENTHIVE_SPAWN_TIMEOUT_MS,
// default 1_200_000ms = 20min). At the old 60s, a 20-min worker renewing every TTL/3
// was one network/renew hiccup from a false lease_expired reap. 1320s = 22min floor.
const DEFAULT_LEASE_TTL_SECONDS = 1320;
const DEFAULT_MAX_CONCURRENT = 8;

const ORCHESTRATOR_HOST = process.env.AGENTHIVE_HOST ?? hostname();

export interface ListenerClient {
	query(text: string, params?: unknown[]): Promise<unknown>;
	on(event: "notification", handler: (msg: { channel: string }) => void): unknown;
	on(event: "error", handler: (err: Error) => void): unknown;
	removeListener(
		event: "notification",
		handler: (msg: { channel: string }) => void,
	): unknown;
	removeListener(event: "error", handler: (err: Error) => void): unknown;
	release?(): void;
}

export interface OfferClaimLoopOptions {
	orchestratorIdentity: string;
	dispatcher: OfferDispatcher;
	connectListener: () => Promise<ListenerClient>;
	leaseTtlSeconds?: number;
	pollIntervalMs?: number;
	maxConcurrent?: number;
	logger?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Row shape returned by fn_claim_work_offer (5-arg canonical, post-M116/M117).
 */
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

export class OfferClaimLoop {
	private readonly orchestratorIdentity: string;
	private readonly dispatcher: OfferDispatcher;
	private readonly connectListener: () => Promise<ListenerClient>;
	private readonly leaseTtlSeconds: number;
	private readonly pollIntervalMs: number;
	private readonly maxConcurrent: number;
	private readonly logger: Pick<Console, "log" | "warn" | "error">;

	private listenerClient: ListenerClient | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private inFlightClaims = 0;

	private readonly notificationHandler = (msg: { channel: string }): void => {
		if (msg.channel !== WORK_OFFERS_CHANNEL) return;
		void this.tryClaim();
	};

	constructor(opts: OfferClaimLoopOptions) {
		this.orchestratorIdentity = opts.orchestratorIdentity;
		this.dispatcher = opts.dispatcher;
		this.connectListener = opts.connectListener;
		this.leaseTtlSeconds = opts.leaseTtlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
		this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
		this.logger = opts.logger ?? console;
	}

	async start(): Promise<void> {
		if (this.started) throw new Error("OfferClaimLoop already started");
		this.started = true;

		const client = await this.connectListener();
		this.listenerClient = client;
		client.on("notification", this.notificationHandler);
		client.on("error", (err) => {
			this.logger.error("[OfferClaim] listener error:", err);
		});
		await (client.query as (text: string) => Promise<unknown>)(
			`LISTEN ${WORK_OFFERS_CHANNEL}`,
		);
		this.logger.log(
			`[OfferClaim] orchestrator=${this.orchestratorIdentity} listening on ${WORK_OFFERS_CHANNEL}`,
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
			this.listenerClient.release?.();
			this.listenerClient = null;
		}
		this.started = false;
	}

	private async tryClaim(): Promise<void> {
		while (this.inFlightClaims < this.maxConcurrent) {
			const claim = await this.claimOne();
			if (!claim) break;
			this.inFlightClaims++;
			void this.dispatcher
				.dispatch(claim)
				.catch((err) => {
					this.logger.error(
						`[OfferClaim] dispatch failed for offer ${claim.offerId}:`,
						err instanceof Error ? err.message : err,
					);
				})
				.finally(() => {
					this.inFlightClaims--;
				});
		}
	}

	private async claimOne(): Promise<ClaimedOffer | null> {
		try {
			const { rows } = await query<ClaimRow>(
				`SELECT dispatch_id, proposal_id, squad_name, dispatch_role,
				        claim_token, claim_expires_at, offer_version, metadata
				   FROM roadmap_workforce.fn_claim_work_offer($1, '[]'::jsonb, $2, NULL, $3)`,
				[
					this.orchestratorIdentity,
					this.leaseTtlSeconds,
					ORCHESTRATOR_HOST,
				],
			);

			const row = rows[0];
			if (!row) return null;

			const metadata = row.metadata ?? {};
			// P908-D: emit offer_claimed span correlated to the trace started in postWorkOffer.
			const traceId = typeof metadata.trace_id === "string" ? metadata.trace_id : null;
			if (traceId) {
				const span = await obs.startSpan({
					traceId,
					operation: "offer_claimed",
					attributes: { dispatch_id: Number(row.dispatch_id), proposal_id: Number(row.proposal_id), role: row.dispatch_role },
				});
				void obs.closeSpan({ spanId: span.spanId });
			}

			return {
				offerId: String(row.dispatch_id),
				dispatchId: Number(row.dispatch_id),
				proposalId: Number(row.proposal_id),
				squadName: row.squad_name,
				role: row.dispatch_role,
				claimToken: row.claim_token,
				claimExpiresAt: row.claim_expires_at,
				offerVersion: Number(row.offer_version),
				metadata,
				leaseTtlSeconds: this.leaseTtlSeconds,
			};
		} catch (err) {
			this.logger.error(
				"[OfferClaim] fn_claim_work_offer error:",
				err instanceof Error ? err.message : err,
			);
			return null;
		}
	}
}
