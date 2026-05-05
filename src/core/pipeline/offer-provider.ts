/**
 * P281 Phase 5 — Offer Provider Service
 *
 * Listens on work_offers NOTIFY channel, claims open offers from squad_dispatch
 * via fn_claim_work_offer, activates them, runs the work via spawnAgent, renews
 * the lease every renewIntervalMs while the spawn is running, and completes the
 * offer (delivered/failed) when the process exits.
 *
 * This is the pull side of the offer/claim/lease model introduced in P281.
 * The orchestrator (pipeline-cron with useOfferDispatch) pushes offers;
 * each instance of this service races to claim one.
 */

import { query } from "../../infra/postgres/pool.ts";
import { spawnAgent } from "../orchestration/agent-spawner.ts";
import type { SpawnHandle, SpawnResult } from "../orchestration/agent-spawner.ts";
import {
	preClaimCapacityCheck,
	pauseClaimForHardLimit,
	recordWindowUsage,
	resumeThrottle,
	SubscriptionThrottleError,
} from "./subscription-capacity.ts";

// ─── Public types (injectable for tests) ──────────────────────────────────────

export type QueryFn = typeof query;
export type Logger = Pick<Console, "log" | "warn" | "error">;

export type SpawnFn = (req: {
	worktree: string;
	task: string;
	proposalId?: number;
	stage: string;
	model?: string;
	timeoutMs?: number;
	agentLabel?: string;
}) => Promise<SpawnHandle>;

export interface ListenerClient {
	query(text: string, params?: unknown[]): Promise<unknown>;
	on(event: "notification", handler: (msg: NotificationMessage) => void): unknown;
	on(event: "error", handler: (err: Error) => void): unknown;
	removeListener(
		event: "notification",
		handler: (msg: NotificationMessage) => void,
	): unknown;
	removeListener(event: "error", handler: (err: Error) => void): unknown;
	release?(): void;
}

export interface NotificationMessage {
	channel: string;
	payload?: string;
}

export interface OfferProviderDeps {
	/** Identity of this agent (must match agent_registry.agent_identity) */
	agentIdentity: string;
	/** Capabilities to advertise when claiming — must satisfy required_capabilities */
	capabilities?: string[];
	/** Lease TTL in seconds sent to fn_claim_work_offer (default 30) */
	leaseTtlSeconds?: number;
	/** How often to renew the lease while a spawn is running, ms (default 10_000) */
	renewIntervalMs?: number;
	/** Fallback poll when LISTEN fires nothing, ms (default 15_000) */
	pollIntervalMs?: number;
	/** Maximum concurrent claims this provider will hold (default 1) */
	maxConcurrent?: number;
	/** P300: Optional project_id to scope claims to a specific project. */
	projectId?: number | null;
	/**
	 * P465: Estimated token cost per claim for subscription window checks.
	 * Used by preClaimCapacityCheck to project whether claiming would breach
	 * the safety margin. Default 0 (no token estimate — capacity check still
	 * runs but only refuses when slots are exhausted).
	 */
	estTokensPerClaim?: number;
	/** P465: Estimated request count per claim (default 1). */
	estRequestsPerClaim?: number;
	queryFn?: QueryFn;
	connectListener?: () => Promise<ListenerClient>;
	spawnFn?: SpawnFn;
	logger?: Logger;
	setIntervalFn?: typeof setInterval;
	clearIntervalFn?: typeof clearInterval;
}

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

type QueryResultLike = { rows: unknown[] };

const WORK_OFFERS_CHANNEL = "work_offers";

// ─── OfferProvider ────────────────────────────────────────────────────────────

export class OfferProvider {
	private readonly agentIdentity: string;
	private readonly capabilitiesJson: string;
	private readonly leaseTtlSeconds: number;
	private readonly renewIntervalMs: number;
	private readonly pollIntervalMs: number;
	private readonly maxConcurrent: number;
	private readonly projectId: number | null | undefined;
	private readonly estTokensPerClaim: number;
	private readonly estRequestsPerClaim: number;
	private readonly queryFn: QueryFn;
	private readonly connectListener: () => Promise<ListenerClient>;
	private readonly spawnFn: SpawnFn;
	private readonly logger: Logger;
	private readonly setIntervalFn: typeof setInterval;
	private readonly clearIntervalFn: typeof clearInterval;

	private listenerClient: ListenerClient | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private activeClaims = 0;

	private readonly notificationHandler = (msg: NotificationMessage): void => {
		if (msg.channel !== WORK_OFFERS_CHANNEL) return;
		void this.tryClaimLoop();
	};

	constructor(deps: OfferProviderDeps) {
		this.agentIdentity = deps.agentIdentity;
		this.capabilitiesJson = JSON.stringify(
			deps.capabilities?.length
				? { all: deps.capabilities }
				: {},
		);
		this.leaseTtlSeconds = deps.leaseTtlSeconds ?? 30;
		this.renewIntervalMs = deps.renewIntervalMs ?? 10_000;
		this.pollIntervalMs = deps.pollIntervalMs ?? 15_000;
		this.maxConcurrent = deps.maxConcurrent ?? 1;
		this.projectId = deps.projectId;
		this.estTokensPerClaim = deps.estTokensPerClaim ?? 0;
		this.estRequestsPerClaim = deps.estRequestsPerClaim ?? 1;
		this.queryFn = deps.queryFn ?? query;
		this.connectListener =
			deps.connectListener ??
			(() => {
				throw new Error("connectListener is required");
			});
		this.spawnFn = deps.spawnFn ?? spawnAgent;
		this.logger = deps.logger ?? console;
		this.setIntervalFn = deps.setIntervalFn ?? setInterval;
		this.clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
	}

	async run(): Promise<void> {
		if (this.started) throw new Error("OfferProvider already running");
		this.started = true;

		// P297: Self-register agency in agent_registry + agent_capability before claiming
		await this.registerAgency();

		const client = await this.connectListener();
		this.listenerClient = client;

		client.on("notification", this.notificationHandler);
		client.on("error", (err) => {
			this.logger.error("[OfferProvider] Listener error:", err);
		});

		await (client.query as (text: string) => Promise<unknown>)(
			`LISTEN ${WORK_OFFERS_CHANNEL}`,
		);
		this.logger.log(
			`[OfferProvider] ${this.agentIdentity} listening on ${WORK_OFFERS_CHANNEL}`,
		);

		// Fallback poll — catches offers emitted before we connected
		this.pollTimer = this.setIntervalFn(() => {
			void this.tryClaimLoop();
		}, this.pollIntervalMs);

		// Immediate attempt on start
		await this.tryClaimLoop();
	}

	async stop(): Promise<void> {
		if (this.pollTimer !== null) {
			this.clearIntervalFn(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.listenerClient) {
			this.listenerClient.removeListener("notification", this.notificationHandler);
			this.listenerClient.release?.();
			this.listenerClient = null;
		}
	}

	/**
	 * Wait for all active claims to finish before the pool is closed.
	 * Times out after maxWaitMs to prevent hanging forever.
	 */
	async waitForIdle(maxWaitMs = 60_000): Promise<void> {
		if (this.activeClaims === 0) return;
		const start = Date.now();
		while (this.activeClaims > 0) {
			if (Date.now() - start > maxWaitMs) {
				this.logger.warn(
					`[OfferProvider] waitForIdle timed out after ${maxWaitMs}ms with ${this.activeClaims} claim(s) still active`,
				);
				return;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	// ─── Claim loop ─────────────────────────────────────────────────────────────

	private async tryClaimLoop(): Promise<void> {
		// P465: Clear throttle if the window has expired before trying new claims
		await this.maybeResumeThrottle();

		while (this.activeClaims < this.maxConcurrent) {
			// P465: Subscription capacity pre-check — refuse new claims when any window
			// is within the safety margin. In-flight claims (activeClaims > 0) continue.
			try {
				await preClaimCapacityCheck({
					agencyId: this.agentIdentity,
					activeClaims: this.activeClaims,
					maxConcurrent: this.maxConcurrent,
					estTokens: this.estTokensPerClaim,
					estRequests: this.estRequestsPerClaim,
					queryFn: this.queryFn,
				});
			} catch (err) {
				if (err instanceof SubscriptionThrottleError) {
					this.logger.warn(
						`[OfferProvider] ${this.agentIdentity} throttled (${err.reason}) until ${err.until.toISOString()} — ${this.activeClaims} in-flight claim(s) continue`,
					);
					return; // stop claiming new work; in-flight claims finish normally
				}
				throw err;
			}

			const claim = await this.claimOne();
			if (!claim) break;
			this.activeClaims++;
			// Fire and forget — the promise manages its own lifecycle
			void this.executeOffer(claim).finally(() => {
				this.activeClaims--;
			});
		}
	}

	private async maybeResumeThrottle(): Promise<void> {
		try {
			const cleared = await resumeThrottle(this.agentIdentity, this.queryFn);
			if (cleared) {
				this.logger.log(
					`[OfferProvider] ${this.agentIdentity} throttle cleared — window has reset`,
				);
			}
		} catch {
			// best-effort: don't block claiming if resume check fails
		}
	}

	private async claimOne(): Promise<ClaimRow | null> {
		try {
			const result = (await this.queryFn(
				`SELECT dispatch_id, proposal_id, squad_name, dispatch_role,
				        claim_token, claim_expires_at, offer_version, metadata
				 FROM roadmap_workforce.fn_claim_work_offer($1, $2::jsonb, $3, $4)`,
				[this.agentIdentity, this.capabilitiesJson, this.leaseTtlSeconds, this.projectId ?? null],
			)) as QueryResultLike;

			const row = result.rows[0] as ClaimRow | undefined;
			return row ?? null;
		} catch (err) {
			this.logger.error("[OfferProvider] fn_claim_work_offer error:", err);
			return null;
		}
	}

	// ─── Execute one claimed offer ───────────────────────────────────────────────

	private async executeOffer(claim: ClaimRow): Promise<void> {
		const { dispatch_id, proposal_id, dispatch_role, claim_token } = claim;

		const meta = claim.metadata ?? {};
		const task = asString(meta.task) ?? `Execute work for dispatch ${dispatch_id}`;
		const stage = asString(meta.stage) ?? dispatch_role;
		const model = asString(meta.model) ?? undefined;
		const worktree = asString(meta.worktree_hint) ?? this.defaultWorktree();
		const timeoutMs = asNumber(meta.timeout_ms) ?? 300_000;

		// Generate ephemeral worker identity for this dispatch
		const workerIdentity = `${this.agentIdentity}/worker-${dispatch_id}`;

		this.logger.log(
			`[OfferProvider] Claimed dispatch ${dispatch_id} (${dispatch_role}) for proposal ${proposal_id} — worker: ${workerIdentity}`,
		);

		// Register worker in agent_registry
		await this.registerWorker(workerIdentity);

		// Activate with worker_identity so dispatch record tracks who does the work
		const activated = await this.activate(dispatch_id, claim_token, workerIdentity);
		if (!activated) {
			this.logger.warn(
				`[OfferProvider] dispatch ${dispatch_id} activation rejected — likely reaped`,
			);
			return;
		}

		let handle: SpawnHandle | null = null;
		let spawnResult: SpawnResult | null = null;
		let spawnError: Error | null = null;

		try {
			handle = await this.spawnFn({
				worktree,
				task,
				proposalId: proposal_id,
				stage,
				model,
				timeoutMs,
				agentLabel: `worker-${dispatch_id} (${dispatch_role})`,
			});
		} catch (err) {
			spawnError = err instanceof Error ? err : new Error(String(err));
		}

		if (handle) {
			// Renew lease while spawn runs; kill the process if renewal is rejected (lease reaped)
			const renewTimer = this.setIntervalFn(() => {
				void this.renew(dispatch_id, claim_token, () => handle!.kill());
			}, this.renewIntervalMs);
			try {
				spawnResult = await handle.result;
			} catch (err) {
				spawnError = err instanceof Error ? err : new Error(String(err));
			} finally {
				this.clearIntervalFn(renewTimer);
			}
		}

		// P465: If provider returned a hard rate-limit (429 or exit 429), pause the
		// dispatch and let the orchestrator decide to wait, reassign, or escalate.
		// This is distinct from a soft throttle (which blocks NEW claims only).
		const isHardProviderLimit = this.isProviderHardLimit(spawnError, spawnResult);
		if (isHardProviderLimit) {
			const resumeEligibleAt = new Date(Date.now() + 3_600_000); // 1h default — orchestrator may override
			await pauseClaimForHardLimit(dispatch_id, resumeEligibleAt, this.queryFn);
			this.logger.warn(
				`[OfferProvider] dispatch ${dispatch_id} paused — provider hard limit hit; resume eligible at ${resumeEligibleAt.toISOString()}`,
			);
			// Record estimated tokens as proxy (actual usage not available from SpawnResult)
			if (this.estTokensPerClaim > 0) {
				await recordWindowUsage(
					this.agentIdentity,
					this.estTokensPerClaim,
					this.estRequestsPerClaim,
					this.queryFn,
				).catch(() => {/* best-effort */});
			}
			return;
		}

		const succeeded =
			spawnError === null && (spawnResult?.exitCode === 0 || spawnResult?.exitCode === null);
		const completionStatus = succeeded ? "delivered" : "failed";

		await this.complete(dispatch_id, claim_token, completionStatus);

		// P465: Update local meter with estimated token usage after claim completes
		if (this.estTokensPerClaim > 0) {
			await recordWindowUsage(
				this.agentIdentity,
				this.estTokensPerClaim,
				this.estRequestsPerClaim,
				this.queryFn,
			).catch(() => {/* best-effort */});
		}

		if (spawnError) {
			this.logger.error(
				`[OfferProvider] dispatch ${dispatch_id} spawn threw:`,
				spawnError,
			);
		} else {
			this.logger.log(
				`[OfferProvider] dispatch ${dispatch_id} → ${completionStatus} (exit ${spawnResult?.exitCode ?? "n/a"}, ${spawnResult?.durationMs ?? 0}ms)`,
			);
		}
	}

	// ─── P465: hard limit detection ─────────────────────────────────────────────

	private isProviderHardLimit(err: Error | null, result: SpawnResult | null): boolean {
		if (err) {
			const msg = err.message.toLowerCase();
			return msg.includes("429") || msg.includes("rate limit") || msg.includes("quota exceeded");
		}
		// Exit code 429 is a convention we use when a CLI wrapper detects a hard 429
		if (result?.exitCode === 429) return true;
		return false;
	}

	// ─── SQL helpers ─────────────────────────────────────────────────────────────

	private async activate(dispatchId: number, claimToken: string, workerIdentity?: string): Promise<boolean> {
		try {
			const result = (await this.queryFn(
				`SELECT roadmap_workforce.fn_activate_work_offer($1, $2, $3::uuid, $4) AS ok`,
				[dispatchId, this.agentIdentity, claimToken, workerIdentity ?? null],
			)) as QueryResultLike;
			const row = result.rows[0] as { ok: boolean } | undefined;
			return row?.ok === true;
		} catch (err) {
			this.logger.error(`[OfferProvider] activate ${dispatchId} error:`, err);
			return false;
		}
	}

	// P297: Register this agency in agent_registry + agent_capability
	// Capabilities are read from agent_capability table (DB), not from env/config.
	// If no capabilities exist yet, register with empty set (can claim offers with no capability requirement).
	private async registerAgency(): Promise<void> {
		try {
			// Upsert agency in agent_registry (no skills — capabilities live in agent_capability)
			await this.queryFn(
				`INSERT INTO roadmap_workforce.agent_registry
				 (agent_identity, agent_type, status)
				 VALUES ($1, 'agency', 'active')
				 ON CONFLICT (agent_identity) DO UPDATE SET
				   status = 'active',
				   updated_at = now()`,
				[this.agentIdentity],
			);

			// Read existing capabilities from DB (pre-configured by operator or MCP)
			const capsResult = await this.queryFn(
				`SELECT ac.capability
				 FROM roadmap_workforce.agent_capability ac
				 JOIN roadmap_workforce.agent_registry ar ON ar.id = ac.agent_id
				 WHERE ar.agent_identity = $1`,
				[this.agentIdentity],
			);
			const caps: string[] = capsResult.rows.map((r: any) => r.capability);

			this.logger.log(
				`[OfferProvider] Agency registered: ${this.agentIdentity} (caps: ${caps.join(", ") || "none — configure via agent_capability table"})`,
			);
		} catch (err) {
			this.logger.error(`[OfferProvider] registerAgency ${this.agentIdentity} error:`, err);
		}
	}

	private defaultWorktree(): string {
		const envWorktree = process.env.AGENTHIVE_WORKTREE?.trim();
		if (envWorktree) return envWorktree;
		if (!this.agentIdentity.includes("/")) return this.agentIdentity;
		return this.agentIdentity.split("/").filter(Boolean).at(-1) ?? this.agentIdentity;
	}

	private async registerWorker(workerIdentity: string): Promise<void> {
		try {
			await this.queryFn(
				`SELECT roadmap_workforce.fn_register_worker($1, $2, $3, $4, $5)`,
				[
					workerIdentity,
					this.agentIdentity,
					'workforce',
					this.capabilitiesJson,
					null, // preferred_model — inherited from agency
				],
			);
		} catch (err) {
			this.logger.error(`[OfferProvider] registerWorker ${workerIdentity} error:`, err);
		}
	}

	private async renew(
		dispatchId: number,
		claimToken: string,
		onLeaseRejected?: () => void,
	): Promise<void> {
		try {
			const result = (await this.queryFn(
				`SELECT roadmap_workforce.fn_renew_lease($1, $2, $3::uuid, $4) AS ok`,
				[dispatchId, this.agentIdentity, claimToken, this.leaseTtlSeconds],
			)) as QueryResultLike;
			const row = result.rows[0] as { ok: boolean } | undefined;
			if (!row?.ok) {
				this.logger.warn(
					`[OfferProvider] lease renewal rejected for dispatch ${dispatchId} — token mismatch (reaped?)`,
				);
				onLeaseRejected?.();
			}
		} catch (err) {
			this.logger.error(`[OfferProvider] renew ${dispatchId} error:`, err);
		}
	}

	private async complete(
		dispatchId: number,
		claimToken: string,
		status: "delivered" | "failed",
	): Promise<void> {
		try {
			await this.queryFn(
				`SELECT roadmap_workforce.fn_complete_work_offer($1, $2, $3::uuid, $4)`,
				[dispatchId, this.agentIdentity, claimToken, status],
			);
		} catch (err) {
			this.logger.error(`[OfferProvider] complete ${dispatchId} error:`, err);
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function asString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}
