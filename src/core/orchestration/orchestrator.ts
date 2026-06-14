import type { PoolClient } from "pg";
import {
	getNextSequence,
	storeMessage,
} from "../../infra/agency/liaison-message-service.ts";
import { createMessageEnvelope } from "../../infra/agency/liaison-message-types.ts";
import { listDispatchableAgencies } from "../../infra/agency/liaison-service.ts";
import { isLegacyPushDispatchEnabled } from "./legacy-push-dispatch-gate.ts";
import { closePool, getPool, query } from "../../infra/postgres/pool.ts";
import { pulseHeartbeat } from "../../infra/pulse/heartbeat.ts";
import { enqueueNotification } from "../notifications/enqueue.ts";
import { postWorkOffer } from "../pipeline/post-work-offer.ts";
import { reapStaleRows } from "../pipeline/reap-stale-rows.ts";
import { getUnlockedGateQueue } from "../proposal/gate-scanner-v2.ts";
import { spawnAgent, spawnWithRetry } from "./agent-spawner.ts";
import { resolveExecutorWorktreeFallback } from "./executor-worktree-fallback.ts";
import { validateChannelRegistry } from "../../infra/messaging/channel-registry.ts";
import {
	bootCancelPokeAttempts,
	runOfferReaper,
	runPokeWatchdogTick,
	runLivenessAlertingTick,
	type PokeWatchdogOptions,
} from "./maintenance.ts";
import { OfferClaimLoop, type ListenerClient } from "./offer-claim-loop.ts";
import { OrchestratorOfferDispatcher } from "./offer-dispatch.ts";
import { resolveQueueContext } from "./queue-context-resolver.ts";
import {
	assessReadiness,
	buildTaskPrompt,
	fetchProposalDetail,
} from "./readiness-resolver.ts";
import { TIER_PREFERENCE, type TaskMetadata } from "../../orchestrator/model_router.ts";
// P903 phase 3+4: legacy dispatch entry points live in legacy-dispatch.ts
// (extracted from scripts/orchestrator.ts during phase 4 to break the cycle
// between the shim and the class). P902-D will progressively pull these
// implementations into class methods.
import {
	dispatchImplicitGate,
	drainEnhancementRevisions,
	drainImplicitGateReady,
	handleGateCompletion,
	handleStateChange,
	reconcileStaleDispatches,
	reconcileStrandedAdvances,
} from "./legacy-dispatch.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import {
	scanAndAlertOfflineAgencies,
	scanAndTransitionSilentAgencies,
} from "./resolvers/agency-resolver.ts";

/**
 * Unified Agent Orchestrator
 *
 * Manages agent pool, resource allocation, and reporting.
 * Uses Postgres as the primary source of truth.
 *
 * P744/P748–P754: scanQueues() is the single unified dispatch loop that
 * collapses the previously-split orchestrator/gate-pipeline architecture
 * into one decision site. PG NOTIFY handlers and the poll fallback both
 * call scanQueues(). (P754 retired the gate-pipeline service.)
 */

// ─── Configuration ────────────────────────────────────────────────────────────

/** Maximum proposals processed per scanQueues() call. */
const SCAN_BATCH_LIMIT = Number(process.env.AGENTHIVE_SCAN_BATCH_LIMIT ?? 20);

/**
 * Hours a proposal must sit mature with no dispatch before stall escalation
 * is triggered.
 */
const STALL_THRESHOLD_HOURS = Number(
	process.env.AGENTHIVE_STALL_THRESHOLD_HOURS ?? 4,
);

/** Maximum stalled proposals to escalate per checkStalls() call. */
const STALL_BATCH_LIMIT = Number(process.env.AGENTHIVE_STALL_BATCH_LIMIT ?? 5);

/**
 * If set, stall escalation Tier 1 spawns an AI liaison agent using this
 * provider (e.g. "anthropic"). If unset, skip to Tier 2 (notification_queue).
 */
const ORCHESTRATOR_LIAISON_PROVIDER =
	process.env.ORCHESTRATOR_LIAISON_PROVIDER ?? null;

const DEFAULT_POKE_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_LIVENESS_ALERT_INTERVAL_MS = Number(
	process.env.AGENTHIVE_LIVENESS_ALERT_INTERVAL_MS ?? 60_000,
);
const DEFAULT_SHUTDOWN_DRAIN_MS = Number(
	process.env.AGENTHIVE_SHUTDOWN_DRAIN_MS ?? 240_000,
);

/** Notify channels the orchestrator listens on for dispatch wake-ups. */
const GATE_READY_CHANNEL = "proposal_gate_ready";
const MATURITY_CHANGED_CHANNEL = "proposal_maturity_changed";
const RUNTIME_FLAG_CHANNEL = "runtime_flag_changed";
const OFFER_COMPLETED_CHANNEL = "offer_completed";

/** Whether the 2-minute state-change poll fallback is enabled (env-driven). */
const ENABLE_POLLING = process.env.AGENTHIVE_ORCHESTRATOR_POLL === "1";

/**
 * Orchestrator agent identity used as the claimer in fn_claim_work_offer.
 * Must exist in roadmap_workforce.agent_registry; ensured at boot.
 */
const ORCHESTRATOR_IDENTITY =
	process.env.AGENTHIVE_ORCHESTRATOR_IDENTITY ??
	"agenthive/agency-orchestrator";

/**
 * Escape hatch: set AGENTHIVE_OFFER_CLAIM_LOOP=0 to disable the
 * orchestrator-side claim loop (e.g. emergency rollback). Default on.
 */
const ENABLE_OFFER_CLAIM_LOOP =
	(process.env.AGENTHIVE_OFFER_CLAIM_LOOP ?? "1") !== "0";

/** Implicit gate poll interval in ms (set 0 to disable). */
const IMPLICIT_GATE_POLL_INTERVAL_MS = Number(
	process.env.AGENTHIVE_IMPLICIT_GATE_POLL_MS ?? 30_000,
);

/** Enhancer-revise autonomous loop interval (90 s legacy default). */
const ENHANCER_REVISE_INTERVAL_MS = 90_000;

/** P611 stranded-advance reconciler interval (30 s legacy default). */
const RECONCILER_INTERVAL_MS = 30_000;

/** Observability heartbeat interval (60 s legacy default). */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** P765: agency liveness scanner interval (silent → dormant/offline + alert). */
const AGENCY_LIVENESS_SCAN_INTERVAL_MS = Number(
	process.env.AGENTHIVE_AGENCY_LIVENESS_SCAN_MS ?? 60_000,
);

export interface OrchestratorConfig {
	/** Worktree used for liaison agent spawns (Tier 1 stall escalation). */
	defaultWorktree?: string;
	/** Offer reaper interval in ms (default 60 s). */
	offerReapIntervalMs?: number;
	/** Poke watchdog interval in ms (default 60 s). */
	pokeWatchdogIntervalMs?: number;
	/** Minutes of agency silence before a poke is emitted. */
	pokeIdleThresholdMin?: number;
	/** Max pokes emitted per watchdog tick (storm cap). */
	pokeStormCap?: number;
	/** Drain timeout on stop() in ms (default 240 s). */
	shutdownDrainMs?: number;
	/** P765: liveness alerting tick interval in ms (default 60 s). */
	livenessAlertIntervalMs?: number;
}

export class Orchestrator {
	private readonly defaultWorktree: string;
	private offerReapIntervalMs: number;
	private readonly pokeWatchdogIntervalMs: number;
	private readonly livenessAlertIntervalMs: number;
	private pokeOpts: PokeWatchdogOptions;
	private shutdownDrainMs: number;

	// P1144: DB-tunable intervals (defaults match legacy hardcoded values).
	private scanBatchLimit = 20;
	private stallThresholdHours = 4;
	private stallBatchLimit = 5;
	private implicitGatePollMs = 30_000;
	private enhancerReviseMs = 90_000;
	private reconcilerMs = 30_000;
	private staleRowReaperMs = 300_000;
	private stuckWorkerMs = 60_000;
	private heartbeatMs = 60_000;
	private offerClaimEnabled = true;

	private offerReapTimer: ReturnType<typeof setInterval> | null = null;
	private pokeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
	private livenessAlertTimer: ReturnType<typeof setInterval> | null = null;
	private offerReapInFlight = false;

	// P902-A: lifecycle state for start()/stop().
	private started = false;
	private stopping = false;
	private listenClient: PoolClient | null = null;
	private offerClaimLoop: OfferClaimLoop | null = null;
	private readonly pollTimers: Map<string, ReturnType<typeof setInterval>> =
		new Map();
	private readonly inFlight: Set<Promise<unknown>> = new Set();

	constructor(config: OrchestratorConfig = {}) {
		// P1445 AC-3: env-based worktree selection is gated (opt-in). The
		// orchestrator allocates worktrees atomically via the worktree_lease;
		// this default is only a terminal fallback for explicit config.
		this.defaultWorktree =
			config.defaultWorktree ??
			resolveExecutorWorktreeFallback() ??
			"claude-andy";
		this.offerReapIntervalMs = config.offerReapIntervalMs ?? 60_000;
		this.pokeWatchdogIntervalMs =
			config.pokeWatchdogIntervalMs ?? DEFAULT_POKE_WATCHDOG_INTERVAL_MS;
		this.livenessAlertIntervalMs =
			config.livenessAlertIntervalMs ?? DEFAULT_LIVENESS_ALERT_INTERVAL_MS;
		this.pokeOpts = {
			idleThresholdMin: config.pokeIdleThresholdMin ?? 5,
			stormCap: config.pokeStormCap ?? 10,
		};
		this.shutdownDrainMs = config.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
	}

	// ─── Lifecycle (P902-A) ────────────────────────────────────────────────────

	/**
	 * Track an in-flight dispatch promise so {@link stop} can wait for it.
	 * Promise removal is scheduled on settle; callers may await the returned
	 * promise as if `trackInFlight` were transparent.
	 */
	private trackInFlight<T>(p: Promise<T>): Promise<T> {
		this.inFlight.add(p);
		p.finally(() => this.inFlight.delete(p)).catch(() => {
			/* swallow — settled promises are removed regardless */
		});
		return p;
	}

	/** Number of dispatch promises currently tracked. */
	inFlightCount(): number {
		return this.inFlight.size;
	}

	/** Whether {@link start} has been called and {@link stop} has not. */
	isRunning(): boolean {
		return this.started && !this.stopping;
	}

	/**
	 * P1144: Load runtime-tunable orchestrator flags from core.runtime_flag.
	 * Env vars are checked first (backward-compat escape hatch); if absent or
	 * invalid, falls back to DB; if DB unavailable, falls back to hardcoded defaults.
	 * All failures are swallowed so a missing DB does not block orchestrator startup.
	 */
	private async loadOrchestratorFlags(): Promise<void> {
		const tryFlag = async <T>(
			envKey: string | null,
			flagKey: any,
			def: T,
			coerce: (s: string) => T,
		): Promise<T> => {
			if (envKey !== null && process.env[envKey] !== undefined) {
				try {
					return coerce(process.env[envKey]!);
				} catch {
					// fall through to DB
				}
			}
			try {
				return await runtimeConfig.get(flagKey);
			} catch {
				return def;
			}
		};

		this.scanBatchLimit = await tryFlag("AGENTHIVE_SCAN_BATCH_LIMIT", FlagKeys.ORCHESTRATOR_SCAN_BATCH_LIMIT, 20, Number);
		this.stallThresholdHours = await tryFlag("AGENTHIVE_STALL_THRESHOLD_HOURS", FlagKeys.ORCHESTRATOR_STALL_THRESHOLD_HOURS, 4, Number);
		this.stallBatchLimit = await tryFlag("AGENTHIVE_STALL_BATCH_LIMIT", FlagKeys.ORCHESTRATOR_STALL_BATCH_LIMIT, 5, Number);
		this.offerReapIntervalMs = await tryFlag("AGENTHIVE_OFFER_REAP_INTERVAL_MS", FlagKeys.ORCHESTRATOR_OFFER_REAP_MS, 60_000, Number);
		const idleMin = await tryFlag("AGENTHIVE_POKE_IDLE_THRESHOLD_MIN", FlagKeys.ORCHESTRATOR_POKE_IDLE_MIN, 5, Number);
		const stormCap = await tryFlag("POKE_STORM_CAP", FlagKeys.ORCHESTRATOR_POKE_STORM_CAP, 10, Number);
		this.pokeOpts = { idleThresholdMin: idleMin, stormCap };
		this.shutdownDrainMs = await tryFlag("AGENTHIVE_ORCHESTRATOR_DRAIN_MS", FlagKeys.ORCHESTRATOR_SHUTDOWN_DRAIN_MS, 240_000, Number);
		this.implicitGatePollMs = await tryFlag("AGENTHIVE_IMPLICIT_GATE_POLL_MS", FlagKeys.ORCHESTRATOR_IMPLICIT_GATE_POLL_MS, 30_000, Number);
		this.enhancerReviseMs = await tryFlag("AGENTHIVE_ENHANCER_REVISE_INTERVAL_MS", FlagKeys.ORCHESTRATOR_ENHANCER_REVISE_MS, 90_000, Number);
		this.reconcilerMs = await tryFlag("AGENTHIVE_RECONCILER_INTERVAL_MS", FlagKeys.ORCHESTRATOR_RECONCILER_MS, 30_000, Number);
		this.staleRowReaperMs = await tryFlag("AGENTHIVE_STALE_ROW_REAPER_INTERVAL_MS", FlagKeys.ORCHESTRATOR_STALE_ROW_REAPER_MS, 300_000, Number);
		this.stuckWorkerMs = await tryFlag("AGENTHIVE_STUCK_WORKER_WATCHDOG_INTERVAL_MS", FlagKeys.ORCHESTRATOR_STUCK_WORKER_MS, 60_000, Number);
		this.heartbeatMs = await tryFlag("AGENTHIVE_HEARTBEAT_INTERVAL_MS", FlagKeys.ORCHESTRATOR_HEARTBEAT_MS, 60_000, Number);
		this.offerClaimEnabled = await tryFlag("AGENTHIVE_OFFER_CLAIM_LOOP", FlagKeys.ORCHESTRATOR_OFFER_CLAIM_ENABLED, true, (s) => s !== "0");
	}

	/**
	 * Start the orchestrator: boot maintenance, register notify handlers, schedule
	 * timers. Idempotent — calling twice is a no-op.
	 *
	 * Behavior parity with the legacy main() in scripts/orchestrator.ts:
	 *   - Boot: reapStaleRows + bootCancelPokeAttempts (via bootMaintenance).
	 *   - LISTEN proposal_gate_ready + proposal_maturity_changed; route through
	 *     onNotification().
	 *   - Schedule maintenance ticks (offer reaper 60s, poke watchdog 60s).
	 *   - Schedule 5 legacy poll timers (2-min state poll if AGENTHIVE_ORCHESTRATOR_POLL=1,
	 *     30s implicit gate poll if AGENTHIVE_IMPLICIT_GATE_POLL_MS>0, 90s enhancer-revise,
	 *     30s P611 reconciler, 60s heartbeat).
	 *
	 * Dispatch bodies live in scripts/orchestrator.ts as exported functions for
	 * now (P903 phase 2); P902-D progressively pulls them into class methods.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.stopping = false;

		// V3-C5 (P1437) AC-3: fail-fast at boot if any pg_notify channel pattern is
		// registered by >1 producer with incompatible payload id-types (the P1408
		// collision class). Pure static assertion — throws only on a code
		// regression, never in steady state. (Codex review P1437 #8683/#8685.)
		validateChannelRegistry();

		await this.loadOrchestratorFlags();
		await this.bootMaintenance();
		this.startMaintenance();

		// P1290 AC-5: Health check that all capabilities in ROLE_TO_REQUIRED_CAPABILITIES
		// have matching dispatchable agencies. Runs in warn-only mode so boot continues
		// even if a capability is missing; operator can then investigate and remediate.
		try {
			const { execSync } = await import("node:child_process");
			execSync("bun run scripts/orchestrator-capability-coverage-check.ts --warn-only", {
				stdio: "inherit",
				cwd: process.cwd(),
			});
		} catch (err) {
			console.warn(
				"[Orchestrator] Capability coverage check failed or not available:",
				err instanceof Error ? err.message : String(err),
			);
		}

		// Connect LISTEN client and register notification handler.
		const pool = getPool();
		this.listenClient = await pool.connect();
		this.listenClient.on(
			"notification",
			(msg: { channel: string; payload?: string }) => {
				if (this.stopping || !msg.payload) return;
				void this.onNotification(msg.channel, msg.payload);
			},
		);
		await this.listenClient.query(`LISTEN ${GATE_READY_CHANNEL}`);
		await this.listenClient.query(`LISTEN ${MATURITY_CHANGED_CHANNEL}`);
		await this.listenClient.query(`LISTEN ${RUNTIME_FLAG_CHANNEL}`);
		await this.listenClient.query(`LISTEN ${OFFER_COMPLETED_CHANNEL}`);
		console.log(
			`[Orchestrator] LISTEN registered: ${GATE_READY_CHANNEL}, ${MATURITY_CHANGED_CHANNEL}, ${RUNTIME_FLAG_CHANNEL}, ${OFFER_COMPLETED_CHANNEL}`,
		);

		// Schedule the five legacy poll timers. Each is parity with the
		// scripts/orchestrator.ts main() interval; toggles preserved.
		if (ENABLE_POLLING) {
			this.pollTimers.set(
				"state-change",
				setInterval(() => this._statePollTick(), 2 * 60 * 1000),
			);
			console.log("[Orchestrator] 2-min state-change polling enabled");
		} else {
			console.log(
				"[Orchestrator] state-change polling disabled (AGENTHIVE_ORCHESTRATOR_POLL!=1)",
			);
		}

		if (this.implicitGatePollMs > 0) {
			// Initial drain at boot (matches legacy line 2604).
			void this.trackInFlight(
				drainImplicitGateReady("startup", 5).catch((err) =>
					console.error("[Orchestrator] startup drain failed:", err),
				),
			);
			this.pollTimers.set(
				"implicit-gate",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						drainImplicitGateReady("implicit-gate-poll", 5).catch((err) =>
							console.error("[Orchestrator] implicit gate poll failed:", err),
						),
					);
				}, this.implicitGatePollMs),
			);
			console.log(
				`[Orchestrator] implicit gate polling every ${this.implicitGatePollMs}ms`,
			);
		}

		this.pollTimers.set(
			"enhancer-revise",
			setInterval(() => {
				void this.trackInFlight(
					this.runEnhancerReviseTick().catch((err) =>
						console.error("[Orchestrator] enhancer-revise failed:", err),
					),
				);
			}, this.enhancerReviseMs),
		);

		this.pollTimers.set(
			"reconciler",
			setInterval(() => {
				if (this.stopping) return;
				void this.trackInFlight(
					reconcileStrandedAdvances(pool).catch((err) =>
						console.error("[Orchestrator] reconciler failed:", err),
					),
				);
			}, this.reconcilerMs),
		);

		this.pollTimers.set(
			"stale-dispatch-reconciler",
			setInterval(() => {
				if (this.stopping) return;
				void this.trackInFlight(
					reconcileStaleDispatches(pool).catch((err) =>
						console.error(
							"[Orchestrator] stale-dispatch reconciler failed:",
							err,
						),
					),
				);
			}, this.reconcilerMs),
		);

		this.pollTimers.set(
			"heartbeat",
			setInterval(() => {
				void pulseHeartbeat("orchestrator", {
					currentTask: this.stopping ? "stopping" : "running",
					metadata: { in_flight: this.inFlight.size },
				}).catch((err) =>
					console.error("[Orchestrator] heartbeat failed:", err),
				);
			}, this.heartbeatMs),
		);

		// P765: agency liveness scanner — transitions silent agencies through
		// dormant/offline states and emits / resolves offline alerts.
		this.pollTimers.set(
			"agency-liveness",
			setInterval(() => {
				if (this.stopping) return;
				void this.trackInFlight(
					scanAndTransitionSilentAgencies()
						.then(() => scanAndAlertOfflineAgencies())
						.catch((err) =>
							console.error("[Orchestrator] agency-liveness scan failed:", err),
						),
				);
			}, AGENCY_LIVENESS_SCAN_INTERVAL_MS),
		);

		// P914 / P904: start the offer-claim loop. The loop LISTENs on
		// `work_offers` (fired by postWorkOffer in legacy-dispatch.ts) +
		// polls every 30s as a safety net. On wake, it calls
		// fn_claim_work_offer with the orchestrator's identity, then hands
		// the claim (with claim_token) to OrchestratorOfferDispatcher which
		// emits a properly-formed offer_dispatch into liaison_message. This
		// is the canonical single push-dispatch path; the broken inline
		// emit-liaison block in legacy-dispatch.ts has been removed.
		if (this.offerClaimEnabled) {
			try {
				await this.startOfferClaimLoop();
			} catch (err) {
				console.error(
					"[Orchestrator] OfferClaimLoop start failed (push dispatch disabled):",
					err instanceof Error ? err.message : err,
				);
			}
		} else {
			console.log(
				"[Orchestrator] OfferClaimLoop disabled (AGENTHIVE_OFFER_CLAIM_LOOP=0)",
			);
		}

		console.log("[Orchestrator] started");
	}

	/**
	 * P914: instantiate and start the OfferClaimLoop + OrchestratorOfferDispatcher.
	 *
	 * Ensures the orchestrator's agent_registry row exists (so fn_claim_work_offer
	 * doesn't reject with FK violation), then wires the claim → dispatch chain.
	 */
	private async startOfferClaimLoop(): Promise<void> {
		// Ensure the orchestrator identity is registered as an agent so
		// fn_claim_work_offer's Gate 1 (agent_registry lookup) passes.
		await query(
			`INSERT INTO roadmap_workforce.agent_registry
			    (agent_identity, agent_type, trust_tier, status)
			 VALUES ($1, 'coordinator', 'authority', 'active')
			 ON CONFLICT (agent_identity) DO UPDATE
			   SET status = 'active'`,
			[ORCHESTRATOR_IDENTITY],
		);

		// Gate 6 (project scope): orchestrator needs a provider_registry row
		// for at least one project. Subscribe to all active projects so the
		// claimer can pick up offers from any project the system serves.
		await query(
			`INSERT INTO roadmap_workforce.provider_registry
			    (agency_id, agency_identity, project_id, squad_name,
			     status, max_in_flight)
			 SELECT ar.id, ar.agent_identity, p.project_id, NULL,
			        'active', 8
			   FROM roadmap_workforce.agent_registry ar
			   CROSS JOIN roadmap.project p
			  WHERE ar.agent_identity = $1
			    AND p.status = 'active'
			    AND p.archived_at IS NULL
			 ON CONFLICT (agency_id, project_id, squad_name) DO UPDATE
			   SET status = 'active'`,
			[ORCHESTRATOR_IDENTITY],
		);

		const dispatcher = new OrchestratorOfferDispatcher({
			orchestratorIdentity: ORCHESTRATOR_IDENTITY,
		});

		const loop = new OfferClaimLoop({
			orchestratorIdentity: ORCHESTRATOR_IDENTITY,
			dispatcher,
			connectListener: async (): Promise<ListenerClient> => {
				const client = await getPool().connect();
				return client as unknown as ListenerClient;
			},
		});

		await loop.start();
		this.offerClaimLoop = loop;
		console.log(
			`[Orchestrator] OfferClaimLoop started as ${ORCHESTRATOR_IDENTITY}`,
		);
	}

	/**
	 * P908-A: Drain the enhancer-revise queue.
	 *
	 * Wraps `drainEnhancementRevisions` as a class method so tests can stub it
	 * without reaching into legacy-dispatch.ts, and so future evolution can
	 * replace the legacy implementation entirely.
	 */
	async runEnhancerReviseTick(): Promise<void> {
		if (this.stopping) return;
		await drainEnhancementRevisions("enhancer-revise-loop", 4);
	}

	/**
	 * 2-minute state-change poll fallback (enabled by AGENTHIVE_ORCHESTRATOR_POLL=1).
	 *
	 * Mirrors scripts/orchestrator.ts main() polling block: finds workflows that
	 * need an agent, excluding proposals that already have running agent_runs or
	 * alive squad_dispatch. Calls handleStateChange for each.
	 */
	private async _statePollTick(): Promise<void> {
		if (this.stopping) return;
		try {
			const result = await query<{
				id: number;
				proposal_id: number;
				current_stage: string;
			}>(
				`SELECT w.id, w.proposal_id, w.current_stage
				   FROM roadmap.workflows w
				   JOIN roadmap_proposal.v_dispatchable_proposal p ON p.id = w.proposal_id
				  WHERE w.completed_at IS NULL
				    AND p.maturity IN ('new', 'active')
				    AND EXISTS (
				      SELECT 1 FROM roadmap.workflow_transitions wt
				       WHERE wt.template_id = w.template_id
				         AND LOWER(wt.from_stage) = LOWER(w.current_stage)
				    )
				    AND NOT EXISTS (
				      SELECT 1 FROM roadmap_workforce.agent_runs ar
				       WHERE ar.proposal_id = w.proposal_id
				         AND ar.status = 'running'
				    )
				    AND NOT EXISTS (
				      SELECT 1 FROM roadmap_workforce.squad_dispatch sd
				       WHERE sd.proposal_id = w.proposal_id
				         AND sd.dispatch_status IN ('open','assigned','active','blocked')
				    )
				  ORDER BY w.started_at ASC
				  LIMIT 5`,
			);
			for (const wf of result.rows) {
				if (this.stopping) return;
				void this.trackInFlight(
					handleStateChange(String(wf.proposal_id), wf.current_stage),
				);
			}
		} catch (err) {
			console.error("[Orchestrator] state poll failed:", err);
		}
	}

	/**
	 * Stop the orchestrator: flag stopping, clear timers, release LISTEN client,
	 * drain in-flight dispatches up to {@link shutdownDrainMs}.
	 *
	 * Resolves once all in-flight promises settle or the drain timeout elapses.
	 */
	async stop(): Promise<void> {
		if (!this.started || this.stopping) return;
		this.stopping = true;

		this.stopMaintenance();
		for (const [name, timer] of this.pollTimers) {
			clearInterval(timer);
			void name;
		}
		this.pollTimers.clear();

		// P914: stop the offer-claim loop before draining in-flight dispatches
		// so no new claims start during shutdown.
		if (this.offerClaimLoop) {
			try {
				await this.offerClaimLoop.stop();
			} catch (err) {
				console.warn(
					"[Orchestrator] OfferClaimLoop stop failed:",
					err instanceof Error ? err.message : err,
				);
			}
			this.offerClaimLoop = null;
		}

		// Release LISTEN client (release(true) destroys the underlying socket so
		// pool.end() doesn't hang on a long-lived LISTEN connection).
		if (this.listenClient) {
			try {
				this.listenClient.release(true);
			} catch {
				/* best-effort */
			}
			this.listenClient = null;
		}

		// Drain in-flight dispatches with a hard ceiling.
		if (this.inFlight.size > 0) {
			console.log(
				`[Orchestrator] draining ${this.inFlight.size} in-flight dispatch(es) (timeout ${this.shutdownDrainMs}ms)…`,
			);
			const drain = Promise.allSettled(Array.from(this.inFlight));
			const timeout = new Promise<void>((resolve) =>
				setTimeout(resolve, this.shutdownDrainMs).unref(),
			);
			await Promise.race([drain, timeout]);
			if (this.inFlight.size > 0) {
				console.warn(
					`[Orchestrator] drain timeout: ${this.inFlight.size} dispatch(es) still in-flight`,
				);
			}
		}

		this.started = false;
		console.log("[Orchestrator] stopped");
	}

	/**
	 * Route a Postgres notification to the appropriate dispatch path.
	 *
	 * Mirrors scripts/orchestrator.ts main() notification handler at line 2491:
	 *   - proposal_gate_ready  → dispatchImplicitGate(proposal_id)
	 *   - proposal_maturity_changed → resolve workflow, then handleStateChange
	 *
	 * Both wrapped in trackInFlight so {@link stop} can drain them.
	 */
	async onNotification(channel: string, payload?: string): Promise<void> {
		if (this.stopping || !payload) return;

		if (channel === RUNTIME_FLAG_CHANNEL) {
			try {
				await this.loadOrchestratorFlags();
				console.log("[Orchestrator] runtime flags reloaded via pg_notify");
			} catch (err) {
				console.error("[Orchestrator] flag reload failed:", err);
			}
			return;
		}

		if (
			channel !== GATE_READY_CHANNEL &&
			channel !== MATURITY_CHANGED_CHANNEL &&
			channel !== OFFER_COMPLETED_CHANNEL
		) {
			return;
		}
		try {
			const data = JSON.parse(payload) as {
				proposal_id?: number | string;
				id?: number | string;
				dispatch_id?: number | string;
			};

			if (channel === GATE_READY_CHANNEL) {
				const pid = Number(data.proposal_id ?? data.id);
				if (Number.isFinite(pid)) {
					await this.trackInFlight(
						dispatchImplicitGate(pid, "notify:proposal_gate_ready"),
					);
				}
				return;
			}

			if (channel === OFFER_COMPLETED_CHANNEL) {
				const dispatchId = Number(data.dispatch_id);
				if (Number.isFinite(dispatchId)) {
					await this.trackInFlight(
						handleGateCompletion(dispatchId),
					);
				}
				return;
			}

			// proposal_maturity_changed: resolve current workflow stage.
			const proposalId = data.proposal_id ?? data.id;
			if (!proposalId) return;
			const result = await query<{
				id: number;
				proposal_id: number;
				current_stage: string;
			}>(
				"SELECT id, proposal_id, current_stage FROM roadmap.workflows WHERE proposal_id = $1 ORDER BY started_at DESC LIMIT 1",
				[proposalId],
			);
			if (result.rows.length > 0) {
				const wf = result.rows[0];
				await this.trackInFlight(
					handleStateChange(String(wf.proposal_id), wf.current_stage),
				);
			}
		} catch (err) {
			console.error("[Orchestrator] notification handler failed:", err);
		}
	}

	/**
	 * Best-effort pool teardown for the shim's signal-handler path. Idempotent.
	 * Hard-exits at +5s if pool.end() hangs (mirrors legacy entry point).
	 */
	async closePoolWithFallback(hardExitMs = 5_000): Promise<void> {
		const fallback = setTimeout(() => {
			console.warn(
				"[Orchestrator] pool.end() did not return; forcing process exit",
			);
			process.exit(0);
		}, hardExitMs);
		fallback.unref();
		try {
			await closePool();
		} finally {
			clearTimeout(fallback);
		}
	}

	// ─── Maintenance cycle ─────────────────────────────────────────────────────

	/**
	 * Run boot-time maintenance: cancel orphaned poke attempts and reap stale
	 * DB rows left by a prior abrupt stop. Call once before startMaintenance().
	 */
	async bootMaintenance(): Promise<void> {
		await bootCancelPokeAttempts(query, console, "Orchestrator");
		await reapStaleRows(
			getPool(),
			{ log: (m) => console.log(m), warn: (m) => console.warn(m) },
			"Orchestrator.Reaper",
		);
	}

	/**
	 * Start periodic maintenance timers: offer reaper + poke watchdog + liveness alerting.
	 * Idempotent — calling twice is a no-op.
	 */
	startMaintenance(): void {
		if (this.offerReapTimer) return;

		this.offerReapTimer = setInterval(() => {
			if (this.offerReapInFlight) return;
			this.offerReapInFlight = true;
			void runOfferReaper(query, console, "Orchestrator").finally(() => {
				this.offerReapInFlight = false;
			});
		}, this.offerReapIntervalMs);

		this.pokeWatchdogTimer = setInterval(() => {
			void runPokeWatchdogTick(this.pokeOpts, query, console, "Orchestrator");
		}, this.pokeWatchdogIntervalMs);

		// P765: liveness alerting — transitions silent agencies and emits Discord alerts.
		this.livenessAlertTimer = setInterval(() => {
			if (this.stopping) return;
			void runLivenessAlertingTick(console, "Orchestrator");
		}, this.livenessAlertIntervalMs);

		console.log(
			`[Orchestrator] Maintenance started — offer reaper every ${this.offerReapIntervalMs}ms, poke watchdog every ${this.pokeWatchdogIntervalMs}ms, liveness alerting every ${this.livenessAlertIntervalMs}ms`,
		);
	}

	/** Stop periodic maintenance timers. */
	stopMaintenance(): void {
		if (this.offerReapTimer) {
			clearInterval(this.offerReapTimer);
			this.offerReapTimer = null;
		}
		if (this.pokeWatchdogTimer) {
			clearInterval(this.pokeWatchdogTimer);
			this.pokeWatchdogTimer = null;
		}
		if (this.livenessAlertTimer) {
			clearInterval(this.livenessAlertTimer);
			this.livenessAlertTimer = null;
		}
	}

	// ─── Unified dispatch loop ─────────────────────────────────────────────────

	/**
	 * P751: Unified scan loop — the single entry point for all proposal dispatch.
	 *
	 * Called by:
	 *   - PG NOTIFY handler for `proposal_maturity_changed` / `proposal_gate_ready`
	 *   - 2-minute poll fallback when AGENTHIVE_ORCHESTRATOR_POLL=1
	 *
	 * Flow per candidate:
	 *   1. resolveQueueContext()  — enrich with workflowTemplateId + roleProfiles
	 *   2. fetchProposalDetail()  — full RFC fields for readiness check
	 *   3. assessReadiness()      — determines mode: gate | prep | skip
	 *   4. postWorkOffer()        — any registered agency claims and executes
	 *
	 * Returns the number of proposals that were dispatched (mode ≠ skip).
	 */
	async scanQueues(): Promise<number> {
		const candidates = await getUnlockedGateQueue(this.scanBatchLimit);
		if (candidates.length === 0) return 0;

		let dispatched = 0;

		for (const candidate of candidates) {
			try {
				const ctx = await resolveQueueContext(candidate);
				const detail = await fetchProposalDetail(candidate.id);

				if (!detail) {
					console.warn(
						`[Orchestrator] scanQueues: proposal ${candidate.id} not found in detail query, skipping`,
					);
					continue;
				}

				const { mode, reasons } = assessReadiness(detail);

				if (mode === "skip") {
					continue;
				}

				const primaryProfile = ctx.roleProfiles[0] ?? null;
				// AC-11 (P1113): pass primary profile so buildTaskPrompt can prepend
				// role-specific task_prompt when available.
				const task = buildTaskPrompt(detail, mode, reasons, primaryProfile);

				// P226: derive tier preference from proposal type + mode so the route
				// resolver can prefer cheaper routes for routine work and frontier routes
				// for gate/architecture reviews, without a hardcoded role-name check.
				const taskType: string =
					mode === "gate" ? "gate_review"
					: detail.type === "architecture" ? "architecture_review"
					: "code_gen";
				const difficultyRow = TIER_PREFERENCE[taskType];
				const difficulty: TaskMetadata["difficulty"] =
					detail.maturity === "mature" ? "hard"
					: detail.maturity === "active" ? "medium"
					: "easy";
				const preferredTierRow = difficultyRow?.[difficulty];
				const requiredTier = preferredTierRow ?? null;

				// P1359 D3 wire-up: spawnWithRetry writes per-(provider, model)
				// cooldown to model_routes.cooldown_until on quota-class outcomes
				// and re-resolves to the next-priority same-provider route via the
				// existing cooldownFilterSql layer-6 filter. Replaces bare spawnAgent
				// so cooldown writes exercise on every live dispatch.
				await spawnWithRetry({
					worktree: this.defaultWorktree,
					task,
					proposalId: detail.id,
					squadName: `scan-P${detail.id}-${mode}`,
					role,
					task,
					stage: detail.status,
					agentLabel: `${detail.displayId} (${mode})`,
					activity: mode === "gate" ? "reviewing" : "preparing",
					projectId: ctx.projectId ?? undefined,
					// Pass the DB-backed profile id when present so P771 role-policy
					// filters (allowed_route_providers, forbidden_route_providers)
					// reach resolveModelRoute. Builtin-fallback rows have id=null
					// and route resolution falls through to host/project policy.
					roleProfileId: primaryProfile?.id ?? null,
					// P226: tier preference derived from task difficulty/type
					requiredTier,
					phase: mode,
					worktreeHint: this.defaultWorktree,
					requiredCapabilities:
						(primaryProfile?.requiredCapabilities ?? []).length > 0
							? (primaryProfile?.requiredCapabilities ?? [])
							: [role],
				});
				console.log(
					`[Orchestrator] scanQueues: posted offer ${dispatchId} for ${detail.displayId} (${mode})`,
				);

				dispatched++;
			} catch (err) {
				console.error(
					`[Orchestrator] scanQueues: dispatch failed for proposal ${candidate.id}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		return dispatched;
	}

	// ─── Stall detection ───────────────────────────────────────────────────────

	/**
	 * P751: Stall detector — finds mature proposals with no recent dispatch and
	 * escalates via two-tier strategy.
	 *
	 * Tier 1 (optional): Spawn an AI liaison agent if ORCHESTRATOR_LIAISON_PROVIDER
	 *   is set. The liaison has MCP access to investigate blockers and unblock the
	 *   proposal without human involvement.
	 *
	 * Tier 2 (always): Emit `stall_detected` to notification_queue. The
	 *   notification router resolves transport from the `notification_route` table
	 *   (Discord, Slack, email, etc.) — no hardcode here.
	 *
	 * @param thresholdHours  Hours stalled before escalation (default from env)
	 */
	async checkStalls(thresholdHours?: number): Promise<void> {
		const hours = thresholdHours ?? this.stallThresholdHours;
		const { rows } = await query<{
			id: number;
			display_id: string;
			title: string;
			status: string;
			stall_hours: number;
		}>(
			`SELECT
			    p.id,
			    p.display_id,
			    p.title,
			    p.status,
			    ROUND(EXTRACT(EPOCH FROM (NOW() - p.updated_at)) / 3600.0, 1)::float AS stall_hours
			 FROM roadmap_proposal.v_dispatchable_proposal p
			 WHERE p.maturity = 'mature'
			   AND p.updated_at < NOW() - ($1 * INTERVAL '1 hour')
			   AND NOT EXISTS (
			       SELECT 1 FROM roadmap.route_decision_log rdl
			       WHERE rdl.proposal_id = p.id
			         AND rdl.created_at > NOW() - ($1 * INTERVAL '1 hour')
			   )
			 ORDER BY p.updated_at ASC
			 LIMIT $2`,
			[hours, this.stallBatchLimit],
		);

		if (rows.length === 0) return;

		for (const row of rows) {
			console.warn(
				`[Orchestrator] stall detected: ${row.display_id} (${row.status}) stalled ${row.stall_hours}h`,
			);

			await this._escalateStall({
				id: row.id,
				displayId: row.display_id,
				title: row.title,
				status: row.status,
				stallHours: row.stall_hours,
			});
		}
	}

	private async _escalateStall(stall: {
		id: number;
		displayId: string;
		title: string;
		status: string;
		stallHours: number;
	}): Promise<void> {
		// Tier 1: liaison-first offer dispatch (P904-A3: replaced spawnAgent with postWorkOffer)
		if (ORCHESTRATOR_LIAISON_PROVIDER) {
			try {
				const stallTask = [
					`You are an AI liaison investigating a stalled proposal.`,
					``,
					`Proposal: ${stall.displayId} — ${stall.title}`,
					`Current stage: ${stall.status}`,
					`Stalled for: ${stall.stallHours}h`,
					``,
					`Use your MCP tools to:`,
					`1. Diagnose why this proposal hasn't advanced`,
					`2. Contact relevant agents or escalate blockers`,
					`3. Record your findings and any actions taken`,
					``,
					`If you cannot resolve the block, use mcp_ops escalation_add with severity CRITICAL.`,
				].join("\n");
				const { dispatchId } = await postWorkOffer({
					proposalId: stall.id,
					squadName: `P${stall.id}-stall-liaison`,
					role: "orchestrator-liaison-investigator",
					task: stallTask,
					stage: stall.status,
					phase: "investigate",
					timeoutMs: 600_000,
					worktreeHint: this.defaultWorktree ?? undefined,
					requiredCapabilities: ["orchestrator-liaison-investigator"],
				});
				console.log(
					`[Orchestrator] stall liaison offer ${dispatchId} posted for ${stall.displayId}`,
				);

				// P1438 C6 AC-14: the open-pool offer above is the dispatch. The
				// legacy heartbeat-derived offer_dispatch downlink push (target =
				// listDispatchableAgencies()[0], chosen by v_agency_status.dispatchable
				// = last_heartbeat_at) is a mechanical presence floor and is gated OFF
				// by default — emergent-presence claim decides who picks this up.
				if (await isLegacyPushDispatchEnabled()) {
					try {
						const agencies = await listDispatchableAgencies();
						if (agencies.length > 0) {
							const targetAgency = agencies[0];
							const envelope = createMessageEnvelope({
								agencyId: targetAgency.agency_id,
								direction: "orchestrator->liaison",
								kind: "offer_dispatch",
								payload: {
									offer_id: String(dispatchId),
									dispatch_id: dispatchId,
									proposal_id: stall.id,
									squad_name: `P${stall.id}-stall-liaison`,
									role: "orchestrator-liaison-investigator",
									required_capabilities: ["orchestrator-liaison-investigator"],
									route_hint: ORCHESTRATOR_LIAISON_PROVIDER,
								},
							});
							const sequence = await getNextSequence(targetAgency.agency_id);
							await storeMessage({
								...(envelope as any),
								sequence,
								signature: "stub-orchestrator",
							});
							console.log(
								`[Orchestrator] stall liaison offer_dispatch sent to ${targetAgency.agency_id} for dispatch ${dispatchId}`,
							);
						} else {
							console.warn(
								`[Orchestrator] stall liaison dispatch ${dispatchId}: no dispatchable agencies`,
								{ reason: "no_dispatchable_agency" },
							);
						}
					} catch (err) {
						console.warn(
							`[Orchestrator] failed to emit liaison message for stall dispatch ${dispatchId}:`,
							err instanceof Error ? err.message : err,
						);
					}
				}
				return;
			} catch (err) {
				console.warn(
					`[Orchestrator] liaison offer failed for ${stall.displayId}, falling through to Tier 2:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		// Tier 2: notification_queue (transport-agnostic, always available)
		try {
			await enqueueNotification({
				severity: "CRITICAL",
				kind: "stall_detected",
				title: `Stall: ${stall.displayId} — ${stall.title}`,
				body: `Proposal ${stall.displayId} has been mature in ${stall.status} for ${stall.stallHours}h with no dispatch.`,
				proposalId: stall.id,
				payload: {
					proposalId: stall.id,
					displayId: stall.displayId,
					title: stall.title,
					stage: stall.status,
					stallDurationHours: stall.stallHours,
				},
			});
		} catch (err) {
			console.error(
				`[Orchestrator] notification_queue write failed for stall ${stall.displayId}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}

	// ─── Legacy report methods (kept for compatibility) ────────────────────────

	async getProposalCount(): Promise<number> {
		const { rows } = await query<{ count: number }>(
			"SELECT COUNT(*)::int AS count FROM roadmap_proposal.proposal",
		);
		return rows[0]?.count ?? 0;
	}

	async getProposalsByStatus(status: string): Promise<string[]> {
		const { rows } = await query<{ display_id: string | null; id: number }>(
			"SELECT id, display_id FROM roadmap_proposal.proposal WHERE status = $1 ORDER BY id",
			[status],
		);
		return rows.map((row) => row.display_id ?? String(row.id));
	}

	async generateReport(): Promise<string> {
		const total = await this.getProposalCount();
		const active = await this.getProposalsByStatus("Active");
		const complete = await this.getProposalsByStatus("Complete");

		return (
			`📊 **ORCHESTRATION REPORT** - ${new Date().toLocaleTimeString()}\n` +
			`📝 Total proposals: ${total}\n` +
			`🚀 Active: ${active.length}\n` +
			`✅ Complete: ${complete.length}\n` +
			`🤖 System status: Operational`
		);
	}

	async assignTask(proposalId: string, agentId: string): Promise<boolean> {
		console.log(`[Orchestrator] Assigning ${proposalId} to ${agentId}`);
		return true;
	}
}
