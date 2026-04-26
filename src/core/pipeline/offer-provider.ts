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
import type { SpawnResult } from "../orchestration/agent-spawner.ts";

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
	/** P466: warm-boot briefing id (passed to child as AGENTHIVE_BRIEFING_ID env). */
	briefingId?: string;
}) => Promise<SpawnResult>;

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
		while (this.activeClaims < this.maxConcurrent) {
			const claim = await this.claimOne();
			if (!claim) break;
			this.activeClaims++;
			// Fire and forget — the promise manages its own lifecycle
			void this.executeOffer(claim).finally(() => {
				this.activeClaims--;
			});
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
		// P466: warm-boot briefing assembled by parent (orchestrator) before
		// posting the offer. The child agent reads this from its env on boot
		// and calls `briefing_load(<id>)` to retrieve mission, success criteria,
		// allowed tools, MCP quirks, and escalation channels. If absent, the
		// child runs in legacy "blind" mode with only the task prompt.
		const briefingId = asString(meta.briefing_id);

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

		// Renew lease while the spawn runs
		const renewTimer = this.setIntervalFn(() => {
			void this.renew(dispatch_id, claim_token);
		}, this.renewIntervalMs);

		let spawnResult: SpawnResult | null = null;
		let spawnError: Error | null = null;

		try {
			spawnResult = await this.spawnFn({
				worktree,
				task,
				proposalId: proposal_id,
				stage,
				model,
				timeoutMs,
				agentLabel: `worker-${dispatch_id} (${dispatch_role})`,
				briefingId,
			});
		} catch (err) {
			spawnError = err instanceof Error ? err : new Error(String(err));
		} finally {
			this.clearIntervalFn(renewTimer);
		}

		const succeeded =
			spawnError === null && (spawnResult?.exitCode === 0 || spawnResult?.exitCode === null);
		const completionStatus = succeeded ? "delivered" : "failed";

		await this.complete(dispatch_id, claim_token, completionStatus);

		// P466: emit a spawn summary on behalf of the child if a briefing was
		// in play. This guarantees the harvester gets at least an outcome row
		// (even when the child crashed before calling spawn_summary_emit
		// itself), so future briefings inherit something. Best-effort —
		// failures here must not break the dispatch path.
		if (briefingId) {
			try {
				const { emitSpawnSummary } = await import(
					"../../infra/agency/spawn-briefing-service.js"
				);
				await emitSpawnSummary({
					briefing_id: briefingId,
					outcome: succeeded ? "success" : "failure",
					summary: spawnError
						? `Agency-side spawn error: ${spawnError.message.slice(0, 500)}`
						: spawnResult?.exitCode === 0
							? `Agency-side spawn returned exit 0 in ${spawnResult.durationMs ?? 0}ms (child should have emitted its own summary; this is the agency fallback).`
							: `Agency-side spawn exit ${spawnResult?.exitCode ?? "n/a"}`,
					new_findings: [],
					updated_quirks: [],
					duration_seconds: Math.round((spawnResult?.durationMs ?? 0) / 1000),
					error_log: spawnError ? { message: spawnError.message } : undefined,
					emitted_by: workerIdentity,
				});
			} catch (err) {
				this.logger.warn(
					`[OfferProvider] dispatch ${dispatch_id} agency-fallback spawn_summary_emit failed (non-fatal): ${(err as Error).message}`,
				);
			}
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

	private async renew(dispatchId: number, claimToken: string): Promise<void> {
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
