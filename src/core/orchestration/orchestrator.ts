import type { PoolClient } from "pg";
import { closePool, getPool, query } from "../../infra/postgres/pool.ts";
import { pulseHeartbeat } from "../../infra/pulse/heartbeat.ts";
import { reapStaleRows } from "../pipeline/reap-stale-rows.ts";
import {
	BackpressureError,
	DispatchLoopError,
	postWorkOffer,
} from "../pipeline/post-work-offer.ts";
import { enqueueNotification } from "../notifications/enqueue.ts";
import { getUnlockedGateQueue } from "../proposal/gate-scanner-v2.ts";
import { loadStateNames } from "../workflow/state-names.ts";
import { spawnAgent } from "./agent-spawner.ts";
import { listDispatchableAgencies } from "../../infra/agency/liaison-service.ts";
import {
	storeMessage,
	getNextSequence,
} from "../../infra/agency/liaison-message-service.ts";
import { createMessageEnvelope } from "../../infra/agency/liaison-message-types.ts";
import {
	bootCancelPokeAttempts,
	runOfferReaper,
	runPokeWatchdogTick,
	runLivenessAlertingTick,
	type PokeWatchdogOptions,
} from "./maintenance.ts";
import { OfferClaimLoop, type ListenerClient } from "./offer-claim-loop.ts";
import { OrchestratorOfferDispatcher } from "./offer-dispatch.ts";
import {
	checkCapabilityCoverage,
	hasGaps,
} from "./capability-coverage.ts";
import { resolveQueueContext } from "./queue-context-resolver.ts";
import {
	assessReadiness,
	buildTaskPrompt,
	fetchProposalDetail,
} from "./readiness-resolver.ts";
// P903 phase 3+4: legacy dispatch entry points live in legacy-dispatch.ts
// (extracted from scripts/orchestrator.ts during phase 4 to break the cycle
// between the shim and the class). P902-D will progressively pull these
// implementations into class methods.
import {
	cleanupExpiredLeaseCubics,
	dispatchImplicitGate,
	drainEnhancementRevisions,
	drainImplicitGateReady,
	handleStateChange,
	reconcileStaleDispatches,
	reconcileStrandedAdvances,
	retireOrphanedWorkers,
} from "./legacy-dispatch.ts";
import { detectStuckWorkers } from "../../infra/agency/task-dispatcher.ts";
import { listDispatchableAgencies } from "../../infra/agency/liaison-service.ts";
import {
	emitOfflineAlerts,
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
const STALL_BATCH_LIMIT = Number(
	process.env.AGENTHIVE_STALL_BATCH_LIMIT ?? 5,
);

/**
 * If set, stall escalation Tier 1 spawns an AI liaison agent using this
 * provider (e.g. "anthropic"). If unset, skip to Tier 2 (notification_queue).
 */
const ORCHESTRATOR_LIAISON_PROVIDER =
	process.env.ORCHESTRATOR_LIAISON_PROVIDER ?? null;

const DEFAULT_OFFER_REAP_INTERVAL_MS = Number(
	process.env.AGENTHIVE_OFFER_REAP_INTERVAL_MS ?? 60_000,
);
const DEFAULT_POKE_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_POKE_IDLE_THRESHOLD_MIN = Number(
	process.env.AGENTHIVE_POKE_IDLE_THRESHOLD_MIN ?? 5,
);
const DEFAULT_POKE_STORM_CAP = Number(process.env.POKE_STORM_CAP ?? 10);
const DEFAULT_LIVENESS_ALERT_INTERVAL_MS = Number(
	process.env.AGENTHIVE_LIVENESS_ALERT_INTERVAL_MS ?? 60_000,
);

/** Drain timeout on stop() — how long to wait for in-flight dispatches before forcing exit. */
const DEFAULT_SHUTDOWN_DRAIN_MS = Number(
	process.env.AGENTHIVE_ORCHESTRATOR_DRAIN_MS ?? 240_000,
);

/** Notify channels the orchestrator listens on for dispatch wake-ups. */
const GATE_READY_CHANNEL = "proposal_gate_ready";
const MATURITY_CHANGED_CHANNEL = "proposal_maturity_changed";
/** P765 AC-1: agency recovery wake — fired by recordCheckIn when an agency transitions to active. */
const AGENCY_RECOVERY_CHANNEL = "orchestrator_wake";

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

/**
 * Workflow-drain polls — fallbacks to PG NOTIFY. Each one scans a table for
 * proposals in a particular state and processes them. The NOTIFY-driven fast
 * path is the primary trigger; the poll is the safety net for missed NOTIFYs
 * (PgBouncer transaction-pool reconnects, listener restarts, race conditions
 * around state transitions).
 *
 * Setting interval = 0 disables the poll (NOTIFY remains; relies on its
 * coverage being complete). The full migration of these to core.runtime_flag
 * is tracked as a separate follow-on under P1133 universal-config commitment.
 *
 *   implicit-gate poll  → NOTIFY channel: proposal_gate_ready
 *   enhancer-revise     → NOTIFY channel: proposal_maturity_changed (mature)
 *   reconciler          → no NOTIFY (cleanup of stranded advances; periodic only)
 *   stale-dispatch      → no NOTIFY (cleanup of stale dispatches; periodic only)
 *   stale-row reaper    → no NOTIFY (zombie agent_runs/leases; periodic only)
 *   heartbeat           → not a workflow poll; observability self-pulse
 */

/** Implicit gate poll interval in ms (set 0 to disable; NOTIFY-fallback). */
const IMPLICIT_GATE_POLL_INTERVAL_MS = Number(
	process.env.AGENTHIVE_IMPLICIT_GATE_POLL_MS ?? 30_000,
);

/** Enhancer-revise autonomous loop interval in ms (set 0 to disable; NOTIFY-fallback). */
const ENHANCER_REVISE_INTERVAL_MS = Number(
	process.env.AGENTHIVE_ENHANCER_REVISE_INTERVAL_MS ?? 90_000,
);

/** P611 stranded-advance reconciler interval in ms (set 0 to disable; periodic-only, no NOTIFY). */
const RECONCILER_INTERVAL_MS = Number(
	process.env.AGENTHIVE_RECONCILER_INTERVAL_MS ?? 30_000,
);

/** Stale-row reaper interval in ms (set 0 to disable; zombie cleanup, no NOTIFY). */
const STALE_ROW_REAPER_INTERVAL_MS = Number(
	process.env.AGENTHIVE_STALE_ROW_REAPER_INTERVAL_MS ?? 5 * 60 * 1000,
);

/** Stuck-worker watchdog interval in ms (set 0 to disable; no NOTIFY). */
const STUCK_WORKER_WATCHDOG_INTERVAL_MS = Number(
	process.env.AGENTHIVE_STUCK_WORKER_WATCHDOG_INTERVAL_MS ?? 60_000,
);

/** P196: expired-lease cubic cleanup interval (set 0 to disable). Default 5 min. */
const LEASE_CUBIC_CLEANUP_INTERVAL_MS = Number(
	process.env.AGENTHIVE_LEASE_CUBIC_CLEANUP_INTERVAL_MS ?? 5 * 60 * 1000,
);

/** P196: orphaned-worker retirement sweep interval (set 0 to disable). Default 5 min. */
const ORPHAN_WORKER_SWEEP_INTERVAL_MS = Number(
	process.env.AGENTHIVE_ORPHAN_WORKER_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000,
);

/** Observability heartbeat interval (60 s legacy default; observability, set 0 to disable). */
const HEARTBEAT_INTERVAL_MS = Number(
	process.env.AGENTHIVE_HEARTBEAT_INTERVAL_MS ?? 60_000,
);

/** P765: offline alert sweep — transitions silent agencies and fires Discord alerts. Default 2 min. */
const OFFLINE_ALERT_INTERVAL_MS = Number(
	process.env.AGENTHIVE_OFFLINE_ALERT_INTERVAL_MS ?? 2 * 60 * 1000,
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
	private readonly offerReapIntervalMs: number;
	private readonly pokeWatchdogIntervalMs: number;
	private readonly livenessAlertIntervalMs: number;
	private readonly pokeOpts: PokeWatchdogOptions;
	private readonly shutdownDrainMs: number;

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
		this.defaultWorktree =
			config.defaultWorktree ??
			process.env.AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE ??
			"claude-andy";
		this.offerReapIntervalMs =
			config.offerReapIntervalMs ?? DEFAULT_OFFER_REAP_INTERVAL_MS;
		this.pokeWatchdogIntervalMs =
			config.pokeWatchdogIntervalMs ?? DEFAULT_POKE_WATCHDOG_INTERVAL_MS;
		this.livenessAlertIntervalMs =
			config.livenessAlertIntervalMs ?? DEFAULT_LIVENESS_ALERT_INTERVAL_MS;
		this.pokeOpts = {
			idleThresholdMin:
				config.pokeIdleThresholdMin ?? DEFAULT_POKE_IDLE_THRESHOLD_MIN,
			stormCap: config.pokeStormCap ?? DEFAULT_POKE_STORM_CAP,
		};
		this.shutdownDrainMs =
			config.shutdownDrainMs ?? DEFAULT_SHUTDOWN_DRAIN_MS;
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

		await this.bootMaintenance();
		this.startMaintenance();

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
		await this.listenClient.query(`LISTEN ${AGENCY_RECOVERY_CHANNEL}`);
		console.log(
			`[Orchestrator] LISTEN registered: ${GATE_READY_CHANNEL}, ${MATURITY_CHANGED_CHANNEL}, ${AGENCY_RECOVERY_CHANNEL}`,
		);

		// Schedule the maintenance and scan timers.
		if (ENABLE_POLLING) {
			this.pollTimers.set(
				"unified-scan",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(this.scanQueues());
				}, 60_000), // 1-minute unified scan
			);

			this.pollTimers.set(
				"state-poll",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(this._runLegacyStatePoll());
				}, 2 * 60 * 1000), // 2-minute legacy state poll
			);

			console.log(
				"[Orchestrator] Polling enabled: unified-scan (1-min), state-poll (2-min)",
			);
		}

		if (IMPLICIT_GATE_POLL_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"implicit-gate",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						drainImplicitGateReady("implicit-gate-poll", 5).catch((err) =>
							console.error("[Orchestrator] implicit gate poll failed:", err),
						),
					);
				}, IMPLICIT_GATE_POLL_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] implicit gate polling every ${IMPLICIT_GATE_POLL_INTERVAL_MS}ms`,
			);
		}

		if (ENHANCER_REVISE_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"enhancer-revise",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						drainEnhancementRevisions("enhancer-revise-loop", 4).catch((err) =>
							console.error("[Orchestrator] enhancer-revise failed:", err),
						),
					);
				}, ENHANCER_REVISE_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] enhancer-revise poll every ${ENHANCER_REVISE_INTERVAL_MS}ms (NOTIFY-fallback)`,
			);
		} else {
			console.log("[Orchestrator] enhancer-revise poll disabled (AGENTHIVE_ENHANCER_REVISE_INTERVAL_MS=0)");
		}

		if (RECONCILER_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"reconciler",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						reconcileStrandedAdvances(pool).catch((err) =>
							console.error("[Orchestrator] reconciler failed:", err),
						),
					);
				}, RECONCILER_INTERVAL_MS),
			);
			this.pollTimers.set(
				"stale-dispatch-reconciler",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						reconcileStaleDispatches(pool).catch((err) =>
							console.error("[Orchestrator] stale-dispatch reconciler failed:", err),
						),
					);
				}, RECONCILER_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] reconciler + stale-dispatch every ${RECONCILER_INTERVAL_MS}ms (periodic-only)`,
			);
		} else {
			console.log("[Orchestrator] reconciler + stale-dispatch disabled (AGENTHIVE_RECONCILER_INTERVAL_MS=0)");
		}

		// P196: lease-expiry cubic cleanup
		if (LEASE_CUBIC_CLEANUP_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"lease-cubic-cleanup",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						cleanupExpiredLeaseCubics(pool).catch((err) =>
							console.error("[Orchestrator] lease-cubic cleanup failed:", err),
						),
					);
				}, LEASE_CUBIC_CLEANUP_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] P196 lease-cubic cleanup every ${LEASE_CUBIC_CLEANUP_INTERVAL_MS}ms`,
			);
		} else {
			console.log("[Orchestrator] P196 lease-cubic cleanup disabled (AGENTHIVE_LEASE_CUBIC_CLEANUP_INTERVAL_MS=0)");
		}

		// P196: orphaned-worker retirement sweep
		if (ORPHAN_WORKER_SWEEP_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"orphan-worker-sweep",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						retireOrphanedWorkers(pool).catch((err) =>
							console.error("[Orchestrator] orphan-worker sweep failed:", err),
						),
					);
				}, ORPHAN_WORKER_SWEEP_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] P196 orphan-worker sweep every ${ORPHAN_WORKER_SWEEP_INTERVAL_MS}ms`,
			);
		} else {
			console.log("[Orchestrator] P196 orphan-worker sweep disabled (AGENTHIVE_ORPHAN_WORKER_SWEEP_INTERVAL_MS=0)");
		}

		if (STUCK_WORKER_WATCHDOG_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"stuck-worker-watchdog",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						detectStuckWorkers().catch((err) =>
							console.error("[Orchestrator] stuck-worker watchdog failed:", err),
						),
					);
				}, STUCK_WORKER_WATCHDOG_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] detectStuckWorkers watchdog every ${STUCK_WORKER_WATCHDOG_INTERVAL_MS}ms`,
			);
		} else {
			console.log("[Orchestrator] stuck-worker watchdog disabled (AGENTHIVE_STUCK_WORKER_WATCHDOG_INTERVAL_MS=0)");
		}

		// Periodic stale-row inspection: zombie agent_runs, expired leases, stale
		// dispatches. No NOTIFY fast-path — zombies live in cracks between
		// expected transitions. Default cadence well below 60-min zombie threshold.
		if (STALE_ROW_REAPER_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"stale-row-reaper",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						reapStaleRows(
							getPool(),
							{ log: (m) => console.log(m), warn: (m) => console.warn(m) },
							"Orchestrator.Reaper",
						).catch((err) =>
							console.error("[Orchestrator] periodic reaper failed:", err),
						),
					);
				}, STALE_ROW_REAPER_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] periodic stale-row reaper every ${STALE_ROW_REAPER_INTERVAL_MS}ms`,
			);
		} else {
			console.log("[Orchestrator] stale-row reaper disabled (AGENTHIVE_STALE_ROW_REAPER_INTERVAL_MS=0)");
		}

		if (HEARTBEAT_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"heartbeat",
				setInterval(() => {
					void pulseHeartbeat("orchestrator", {
						currentTask: this.stopping ? "stopping" : "running",
						metadata: { in_flight: this.inFlight.size },
					}).catch((err) =>
						console.error("[Orchestrator] heartbeat failed:", err),
					);
				}, HEARTBEAT_INTERVAL_MS),
			);
		} else {
			console.log("[Orchestrator] observability heartbeat disabled (AGENTHIVE_HEARTBEAT_INTERVAL_MS=0)");
		}

		// P914 / P904: start the offer-claim loop. The loop LISTENs on
		// `work_offers` (fired by postWorkOffer in legacy-dispatch.ts) +
		// polls every 30s as a safety net. On wake, it calls
		// fn_claim_work_offer with the orchestrator's identity, then hands
		// the claim (with claim_token) to OrchestratorOfferDispatcher which
		// emits a properly-formed offer_dispatch into liaison_message. This
		// is the canonical single push-dispatch path; the broken inline
		// emit-liaison block in legacy-dispatch.ts has been removed.
		if (ENABLE_OFFER_CLAIM_LOOP) {
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

		// P765 AC-3/AC-4: offline alert sweep — scan provider_registry for silent
		// agencies and fire single-shot Discord alerts (>10 min offline, deduped via
		// alert_sent_at). Same timer handles active→dormant (5 min) and dormant→offline
		// (30 min) transitions in provider_registry.
		if (OFFLINE_ALERT_INTERVAL_MS > 0) {
			this.pollTimers.set(
				"offline-alert-sweep",
				setInterval(() => {
					if (this.stopping) return;
					void this.trackInFlight(
						(async () => {
							await scanAndTransitionSilentAgencies();
							await emitOfflineAlerts();
						})().catch((err) =>
							console.error("[Orchestrator] offline-alert sweep failed:", err),
						),
					);
				}, OFFLINE_ALERT_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] offline-alert sweep every ${OFFLINE_ALERT_INTERVAL_MS}ms`,
			);
		} else {
			console.log("[Orchestrator] offline-alert sweep disabled (AGENTHIVE_OFFLINE_ALERT_INTERVAL_MS=0)");
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
	 * Maintenance loop: checks for proposals that are ready to advance but have no
	 * alive squad_dispatch. Calls handleStateChange for each.
	 */
	private async _runLegacyStatePoll(): Promise<void> {
		if (this.stopping) return;
		try {
			const result = await query<{
				id: number;
				proposal_id: number;
				current_stage: string;
			}>(
				`SELECT w.id, w.proposal_id, w.current_stage
				   FROM roadmap.workflows w
				   JOIN roadmap_proposal.proposal p ON p.id = w.proposal_id
				  WHERE w.completed_at IS NULL
				    AND p.maturity IN ('new', 'active')
				    AND p.status NOT IN ('COMPLETE')
				    AND p.gate_scanner_paused = false
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
			console.error("[Orchestrator] legacy state poll failed:", err);
		}
	}

	/**
	 * Stop the orchestrator: flag stopping, clear timers, release LISTEN client,
	 * drain in-flight dispatches.
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
		if (
			channel !== GATE_READY_CHANNEL &&
			channel !== MATURITY_CHANGED_CHANNEL &&
			channel !== AGENCY_RECOVERY_CHANNEL
		) {
			return;
		}

		try {
			if (channel === GATE_READY_CHANNEL) {
				// Mature proposals ready for gating or preparation.
				void this.trackInFlight(this.scanQueues());
				return;
			}

			// proposal_maturity_changed: handle non-mature work dispatches.
			const data = JSON.parse(payload) as {
				proposal_id?: number | string;
				id?: number | string;
			};

			// P765 AC-1: agency recovered — trigger an immediate scan so queued
			// offers get dispatched without waiting for the next poll cycle.
			if (channel === AGENCY_RECOVERY_CHANNEL) {
				void this.trackInFlight(
					drainImplicitGateReady("agency-recovery-wake", 5).catch((err) =>
						console.error("[Orchestrator] agency-recovery scan failed:", err),
					),
				);
				return;
			}


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
				void this.trackInFlight(
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
	 * Run boot-time maintenance: load state-names registry, cancel orphaned poke
	 * attempts, and reap stale DB rows left by a prior abrupt stop. Call once
	 * before startMaintenance().
	 */
	async bootMaintenance(): Promise<void> {
		const pool = getPool();

		// Load state-names registry from DB (includes NOTIFY listener for live reloads).
		try {
			await loadStateNames(pool);
			console.log("[Orchestrator] State-names registry loaded from database");
		} catch (error) {
			console.error("[Orchestrator] Failed to load state-names registry:", error);
			// Non-fatal; continue without the registry
		}

		await bootCancelPokeAttempts(query, console, "Orchestrator");
		await reapStaleRows(
			pool,
			{ log: (m) => console.log(m), warn: (m) => console.warn(m) },
			"Orchestrator.Reaper",
		);

		// Boot-time offer reaper: reapStaleRows above only catches dispatches
		// whose dispatch_status='assigned'/'active' have aged past 20m. It
		// leaves offer_status='claimed' rows alone — those are handled by
		// fn_reap_expired_offers, which the periodic timer runs every 60s but
		// only AFTER startMaintenance(). Without a boot pass, the first
		// scanQueues tick sees the in-flight cap already poisoned by orphaned
		// claims from the prior session (observed 2026-05-14: 25 stale rows
		// from 5h earlier blocked the cap at boot).
		await runOfferReaper(query, console, "Orchestrator.BootReaper");

		// P1290: Warn-only capability coverage check. Never throws — boot continues
		// so the operator can diagnose and fix provider_registry seeding.
		try {
			const coverage = await checkCapabilityCoverage(console);
			if (hasGaps(coverage)) {
				console.warn(
					"[Orchestrator] Boot warning: some capabilities have no dispatchable agencies (see above). " +
					"Run `npm run check:capability-coverage` or see CONVENTIONS.md §capability-coverage-runbook.",
				);
			}
		} catch (err) {
			console.warn("[Orchestrator] capability coverage check failed (non-fatal):", err);
		}
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
	 *   4. postWorkOffer()        — enqueues offer; OfferClaimLoop → OrchestratorOfferDispatcher
	 *                               → liaison_message offer_dispatch (AC-2)
	 *
	 * Returns the number of proposals that were dispatched (mode ≠ skip).
	 */
	async scanQueues(): Promise<number> {
		const candidates = await getUnlockedGateQueue(SCAN_BATCH_LIMIT);
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

				const isHighRisk =
					detail.priority === "high" ||
					detail.priority === "critical" ||
					detail.unresolvedDependencies > 2 ||
					detail.totalAcceptanceCriteria > 5;

				if (mode === "skip") {
					// P226: 10% sampling for completed work
					if (detail.status.toUpperCase() === "COMPLETE" && Math.random() < 0.1) {
						await postWorkOffer({
							proposalId: detail.id,
							squadName: `P${detail.id}-audit`,
							role: `frontier-review`,
							task: `Frontier audit sample for completed proposal ${detail.displayId}. Review decisions and final state.`,
							stage: detail.status,
							worktreeHint: this.defaultWorktree,
							roleProfileId: null,
						});
						dispatched++;
					}
					continue;
				}

				const primaryProfile = ctx.roleProfiles[0] ?? null;
				const task = buildTaskPrompt(detail, mode, reasons);

				// AC-2: route all proposal-level dispatches through the offer
				// dispatch pipeline (postWorkOffer → OfferClaimLoop →
				// OrchestratorOfferDispatcher → liaison_message offer_dispatch).
				// The liaison's OfferDispatchHandler calls spawnAgent; the
				// orchestrator itself no longer forks CLI subprocesses for
				// proposal execution.
				await postWorkOffer({
					proposalId: detail.id,
					squadName: `P${detail.id}-${mode}`,
					role: `${detail.displayId} (${mode})`,
					task,
					stage: detail.status,
					worktreeHint: this.defaultWorktree,
					// P771: forward role_profile_id so the liaison applies the
					// same route-policy filters that a direct spawnAgent call
					// would have applied (allowed_route_providers, etc.).
					roleProfileId: primaryProfile?.id ?? null,
				});

				dispatched++;

				if (isHighRisk && mode === "gate") {
					await postWorkOffer({
						proposalId: detail.id,
						squadName: `P${detail.id}-audit`,
						role: `frontier-review`,
						task: `Frontier oversight for high-risk gate transition on ${detail.displayId}. Review primary decision.`,
						stage: detail.status,
						worktreeHint: this.defaultWorktree,
						roleProfileId: null,
					});
					dispatched++;
				}
			} catch (err) {
				// Backpressure isn't a failure — it's the cap doing its job.
				// Stop scanning this tick: if the queue is full, no point
				// trying more candidates. They'll be picked up next tick.
				if (err instanceof BackpressureError) {
					console.log(
						`[Orchestrator] scanQueues: ${err.message} stopping at proposal ${candidate.id}, dispatched=${dispatched}`,
					);
					break;
				}
				// Circuit breaker is also expected behavior — log at warn, not error.
				if (err instanceof DispatchLoopError) {
					console.warn(
						`[Orchestrator] scanQueues: ${err.message}`,
					);
					continue;
				}
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
	async checkStalls(
		thresholdHours: number = STALL_THRESHOLD_HOURS,
	): Promise<void> {
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
			 FROM roadmap_proposal.proposal p
			 WHERE p.maturity = 'mature'
			   AND p.updated_at < NOW() - ($1 * INTERVAL '1 hour')
			   AND NOT EXISTS (
			       SELECT 1 FROM roadmap.route_decision_log rdl
			       WHERE rdl.proposal_id = p.id
			         AND rdl.created_at > NOW() - ($1 * INTERVAL '1 hour')
			   )
			 ORDER BY p.updated_at ASC
			 LIMIT $2`,
			[thresholdHours, STALL_BATCH_LIMIT],
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

				// Push notification to first dispatchable agency
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
