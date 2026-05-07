import type { PoolClient } from "pg";
import { closePool, getPool, query } from "../../infra/postgres/pool.ts";
import { pulseHeartbeat } from "../../infra/pulse/heartbeat.ts";
import { reapStaleRows } from "../pipeline/reap-stale-rows.ts";
import { enqueueNotification } from "../notifications/enqueue.ts";
import { getUnlockedGateQueue } from "../proposal/gate-scanner-v2.ts";
import { spawnAgent } from "./agent-spawner.ts";
import {
	bootCancelPokeAttempts,
	runOfferReaper,
	runPokeWatchdogTick,
	type PokeWatchdogOptions,
} from "./maintenance.ts";
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
	dispatchImplicitGate,
	drainEnhancementRevisions,
	drainImplicitGateReady,
	handleStateChange,
	reconcileStrandedAdvances,
} from "./legacy-dispatch.ts";

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

/** Drain timeout on stop() — how long to wait for in-flight dispatches before forcing exit. */
const DEFAULT_SHUTDOWN_DRAIN_MS = Number(
	process.env.AGENTHIVE_ORCHESTRATOR_DRAIN_MS ?? 240_000,
);

/** Notify channels the orchestrator listens on for dispatch wake-ups. */
const GATE_READY_CHANNEL = "proposal_gate_ready";
const MATURITY_CHANGED_CHANNEL = "proposal_maturity_changed";

/** Whether the 2-minute state-change poll fallback is enabled (env-driven). */
const ENABLE_POLLING = process.env.AGENTHIVE_ORCHESTRATOR_POLL === "1";

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
}

export class Orchestrator {
	private readonly defaultWorktree: string;
	private readonly offerReapIntervalMs: number;
	private readonly pokeWatchdogIntervalMs: number;
	private readonly pokeOpts: PokeWatchdogOptions;
	private readonly shutdownDrainMs: number;

	private offerReapTimer: ReturnType<typeof setInterval> | null = null;
	private pokeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
	private offerReapInFlight = false;

	// P902-A: lifecycle state for start()/stop().
	private started = false;
	private stopping = false;
	private listenClient: PoolClient | null = null;
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
		console.log(
			`[Orchestrator] LISTEN registered: ${GATE_READY_CHANNEL}, ${MATURITY_CHANGED_CHANNEL}`,
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

		if (IMPLICIT_GATE_POLL_INTERVAL_MS > 0) {
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
				}, IMPLICIT_GATE_POLL_INTERVAL_MS),
			);
			console.log(
				`[Orchestrator] implicit gate polling every ${IMPLICIT_GATE_POLL_INTERVAL_MS}ms`,
			);
		}

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

		console.log("[Orchestrator] started");
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
				   JOIN roadmap_proposal.proposal p ON p.id = w.proposal_id
				  WHERE w.completed_at IS NULL
				    AND p.maturity IN ('new', 'active')
				    AND p.gate_scanner_paused = false
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
			channel !== MATURITY_CHANGED_CHANNEL
		) {
			return;
		}
		try {
			const data = JSON.parse(payload) as {
				proposal_id?: number | string;
				id?: number | string;
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
	 * Start periodic maintenance timers: offer reaper + poke watchdog.
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

		console.log(
			`[Orchestrator] Maintenance started — offer reaper every ${this.offerReapIntervalMs}ms, poke watchdog every ${this.pokeWatchdogIntervalMs}ms`,
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
	 *   4. spawnAgent()           — routes through 6-layer policy filter
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

				if (mode === "skip") {
					continue;
				}

				const primaryProfile = ctx.roleProfiles[0] ?? null;
				const task = buildTaskPrompt(detail, mode, reasons);

				await spawnAgent({
					worktree: this.defaultWorktree,
					task,
					proposalId: detail.id,
					stage: detail.status,
					agentLabel: `${detail.displayId} (${mode})`,
					activity: mode === "gate" ? "reviewing" : "preparing",
					projectId: ctx.projectId ?? undefined,
					// Pass the DB-backed profile id when present so P771 role-policy
					// filters (allowed_route_providers, forbidden_route_providers)
					// reach resolveModelRoute. Builtin-fallback rows have id=null
					// and route resolution falls through to host/project policy.
					roleProfileId: primaryProfile?.id ?? null,
				});

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
		// Tier 1: AI liaison (conditional on env var)
		if (ORCHESTRATOR_LIAISON_PROVIDER) {
			try {
				await spawnAgent({
					worktree: this.defaultWorktree,
					proposalId: stall.id,
					stage: stall.status,
					provider: ORCHESTRATOR_LIAISON_PROVIDER,
					agentLabel: `${stall.displayId} (liaison)`,
					activity: "investigating stall",
					task: [
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
					].join("\n"),
				});
				return;
			} catch (err) {
				console.warn(
					`[Orchestrator] liaison spawn failed for ${stall.displayId}, falling through to Tier 2:`,
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
