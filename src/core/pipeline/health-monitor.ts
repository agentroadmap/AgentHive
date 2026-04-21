/**
 * P190: Pipeline Health Monitor — Anomaly Detection & Alerting
 *
 * Periodically queries transition_queue and agent_runs to detect:
 *   1. Repeated failure: same transition_id fails N times (default 3)
 *   2. System-wide stall: ALL transitions fail for M minutes (default 10)
 *   3. Queue depth growth without corresponding COMPLETE/DEPLOYED growth
 *   4. Agent spawn failure rate > 50% over 15 minutes
 *
 * Alerts go to Discord via discordSend() and notification_queue.
 * Zero LLM cost — pure SQL queries + threshold checks.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";
import { discordSend, type DiscordLevel } from "../../infra/discord/notify.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HealthMonitorDeps {
	queryFn?: typeof defaultQuery;
	logger?: Pick<Console, "log" | "warn" | "error">;
	checkIntervalMs?: number;
	repeatedFailureThreshold?: number;
	stallWindowMinutes?: number;
	spawnFailureWindowMinutes?: number;
	spawnFailureRateThreshold?: number;
	senderIdentity?: string;
}

interface TransitionFailureRecord {
	transition_id: number | string;
	proposal_id: number | string;
	from_stage: string;
	to_stage: string;
	attempt_count: number;
	max_attempts: number;
	last_error: string | null;
	last_failure_at: string;
}

interface QueueDepthSnapshot {
	pending: number;
	processing: number;
	failed: number;
	done: number;
	timestamp: string;
}

interface SpawnStats {
	total: number;
	failed: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_REPEATED_FAILURE_THRESHOLD = 3;
const DEFAULT_STALL_WINDOW_MINUTES = 10;
const DEFAULT_SPAWN_FAILURE_WINDOW_MINUTES = 15;
const DEFAULT_SPAWN_FAILURE_RATE_THRESHOLD = 0.5;
const DEFAULT_SENDER = "health-monitor";

// Cooldown: don't re-alert for the same transition within 10 minutes
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

// ─── HealthMonitor ───────────────────────────────────────────────────────────

export class HealthMonitor {
	private readonly queryFn: typeof defaultQuery;
	private readonly logger: Pick<Console, "log" | "warn" | "error">;
	private readonly checkIntervalMs: number;
	private readonly repeatedFailureThreshold: number;
	private readonly stallWindowMinutes: number;
	private readonly spawnFailureWindowMinutes: number;
	private readonly spawnFailureRateThreshold: number;
	private readonly sender: string;

	private timer: ReturnType<typeof setInterval> | null = null;
	private started = false;

	// Cooldown tracking — prevent alert storms
	private lastRepeatedFailureAlert = new Map<string, number>(); // transition_id -> timestamp
	private lastStallAlert = 0;
	private lastSpawnFailureAlert = 0;
	private lastQueueDepthAlert = 0;

	// Queue depth history for trend detection
	private queueHistory: QueueDepthSnapshot[] = [];
	private readonly maxHistoryLength = 30; // 30 snapshots at 1-min intervals = 30 min

	constructor(deps: HealthMonitorDeps = {}) {
		this.queryFn = deps.queryFn ?? defaultQuery;
		this.logger = deps.logger ?? console;
		this.checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
		this.repeatedFailureThreshold =
			deps.repeatedFailureThreshold ?? DEFAULT_REPEATED_FAILURE_THRESHOLD;
		this.stallWindowMinutes =
			deps.stallWindowMinutes ?? DEFAULT_STALL_WINDOW_MINUTES;
		this.spawnFailureWindowMinutes =
			deps.spawnFailureWindowMinutes ?? DEFAULT_SPAWN_FAILURE_WINDOW_MINUTES;
		this.spawnFailureRateThreshold =
			deps.spawnFailureRateThreshold ?? DEFAULT_SPAWN_FAILURE_RATE_THRESHOLD;
		this.sender = deps.senderIdentity ?? DEFAULT_SENDER;
	}

	/** Start periodic health checks. */
	start(): void {
		if (this.started) return;
		this.started = true;

		this.timer = setInterval(() => {
			void this.runChecks();
		}, this.checkIntervalMs);

		this.logger.log(
			`[HealthMonitor] Started — checking every ${this.checkIntervalMs}ms`,
		);

		// Run immediately on start
		void this.runChecks();
	}

	/** Stop the health monitor. */
	stop(): void {
		this.started = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.logger.log("[HealthMonitor] Stopped");
	}

	/** Run all health checks. */
	async runChecks(): Promise<void> {
		try {
			await Promise.all([
				this.checkRepeatedFailures(),
				this.checkSystemStall(),
				this.checkQueueDepth(),
				this.checkSpawnFailureRate(),
			]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logger.error(`[HealthMonitor] Check cycle failed: ${msg}`);
		}
	}

	// ─── Check 1: Repeated Failures ──────────────────────────────────────────

	private async checkRepeatedFailures(): Promise<void> {
		// Find transitions that have failed repeatedly but aren't exhausted yet.
		// These are the ones that get requeued silently — the exact problem from P190.
		const { rows } = await this.queryFn<TransitionFailureRecord>(`
			SELECT
				tq.id AS transition_id,
				tq.proposal_id,
				tq.from_stage,
				tq.to_stage,
				tq.attempt_count,
				tq.max_attempts,
				tq.last_error,
				tq.processing_at AS last_failure_at
			FROM roadmap.transition_queue tq
			WHERE tq.status = 'pending'
			  AND tq.attempt_count >= $1
			  AND tq.attempt_count < tq.max_attempts
			  AND tq.last_error IS NOT NULL
			  AND tq.last_error != ''
			ORDER BY tq.attempt_count DESC
		`, [this.repeatedFailureThreshold]);

		for (const row of rows) {
			const key = String(row.transition_id);
			const now = Date.now();
			const lastAlert = this.lastRepeatedFailureAlert.get(key) ?? 0;

			if (now - lastAlert < ALERT_COOLDOWN_MS) continue;

			const errorMsg = (row.last_error ?? "unknown").slice(0, 200);
			const message =
				`⚠️ **Repeated failure detected** — Transition ${row.transition_id} ` +
				`(${row.from_stage} → ${row.to_stage}) for proposal ${row.proposal_id}: ` +
				`failed ${row.attempt_count}/${row.max_attempts} times. ` +
				`Last error: ${errorMsg}`;

			await this.sendAlert(message, "warning");

			// Also insert into notification_queue for persistent tracking
			await this.queueNotification(
				row.proposal_id,
				"ALERT",
				`Transition ${row.transition_id} failing repeatedly`,
				message,
			);

			this.lastRepeatedFailureAlert.set(key, now);
			this.logger.warn(
				`[HealthMonitor] Repeated failure: transition ${key} failed ${row.attempt_count}x`,
			);
		}

		// Clean up old cooldown entries
		for (const [key, ts] of this.lastRepeatedFailureAlert) {
			if (now() - ts > ALERT_COOLDOWN_MS * 2) {
				this.lastRepeatedFailureAlert.delete(key);
			}
		}
	}

	// ─── Check 2: System-Wide Stall ──────────────────────────────────────────

	private async checkSystemStall(): Promise<void> {
		// A stall = all recent transitions are failing, none succeeding.
		// Check if in the last N minutes, there are pending transitions
		// and ALL completed/failed transitions in that window failed.
		const { rows } = await this.queryFn<{
			total_recent: number;
			failed_recent: number;
			pending_stuck: number;
		}>(`
			SELECT
				COUNT(*) FILTER (
					WHERE tq.completed_at > now() - ($1 || ' minutes')::interval
				) AS total_recent,
				COUNT(*) FILTER (
					WHERE tq.status = 'failed'
					  AND tq.completed_at > now() - ($1 || ' minutes')::interval
				) AS failed_recent,
				COUNT(*) FILTER (
					WHERE tq.status = 'pending'
				) AS pending_stuck
			FROM roadmap.transition_queue tq
		`, [String(this.stallWindowMinutes)]);

		const row = rows[0];
		if (!row) return;

		const totalRecent = Number(row.total_recent);
		const failedRecent = Number(row.failed_recent);
		const pendingStuck = Number(row.pending_stuck);

		// Stall condition: there are pending transitions stuck AND
		// all recent completions in the window are failures (or no completions at all)
		const isStalled =
			pendingStuck > 0 &&
			totalRecent > 0 &&
			failedRecent === totalRecent;

		if (!isStalled) return;

		const now = Date.now();
		if (now - this.lastStallAlert < ALERT_COOLDOWN_MS) return;

		const message =
			`🚨 **CRITICAL: Gate pipeline is STUCK** — ${pendingStuck} transitions ` +
			`pending, ${failedRecent}/${totalRecent} failed in the last ` +
			`${this.stallWindowMinutes} minutes. No transitions are progressing. ` +
			`Investigate immediately.`;

		await this.sendAlert(message, "error");

		await this.queueNotification(
			null,
			"CRITICAL",
			"Gate pipeline stalled",
			message,
		);

		this.lastStallAlert = now;
		this.logger.error(
			`[HealthMonitor] STALL detected: ${pendingStuck} pending, ${failedRecent}/${totalRecent} failed`,
		);
	}

	// ─── Check 3: Queue Depth Growth ─────────────────────────────────────────

	private async checkQueueDepth(): Promise<void> {
		const { rows } = await this.queryFn<{
			pending: number;
			processing: number;
			failed: number;
			done: number;
		}>(`
			SELECT
				COUNT(*) FILTER (WHERE status = 'pending') AS pending,
				COUNT(*) FILTER (WHERE status = 'processing') AS processing,
				COUNT(*) FILTER (WHERE status = 'failed') AS failed,
				COUNT(*) FILTER (WHERE status = 'done') AS done
			FROM roadmap.transition_queue
		`);

		const row = rows[0];
		if (!row) return;

		const snapshot: QueueDepthSnapshot = {
			pending: Number(row.pending),
			processing: Number(row.processing),
			failed: Number(row.failed),
			done: Number(row.done),
			timestamp: new Date().toISOString(),
		};

		this.queueHistory.push(snapshot);

		// Keep history bounded
		if (this.queueHistory.length > this.maxHistoryLength) {
			this.queueHistory = this.queueHistory.slice(-this.maxHistoryLength);
		}

		// Need at least 5 snapshots to detect a trend (5 minutes)
		if (this.queueHistory.length < 5) return;

		// Detect: queue growing without done/failed growth
		const oldest = this.queueHistory[0];
		const newest = this.queueHistory[this.queueHistory.length - 1];

		const pendingGrowth = newest.pending - oldest.pending;
		const completionGrowth = (newest.done + newest.failed) - (oldest.done + oldest.failed);

		// Anomaly: pending grew by 5+ but completions barely moved
		if (pendingGrowth >= 5 && completionGrowth < 2) {
			const now = Date.now();
			if (now - this.lastQueueDepthAlert < ALERT_COOLDOWN_MS) return;

			const message =
				`📊 **Queue depth growing** — Pending transitions increased by ` +
				`${pendingGrowth} over ${this.queueHistory.length} minutes ` +
				`(now ${newest.pending}), but only ${completionGrowth} completed/failed. ` +
				`Pipeline may be falling behind.`;

			await this.sendAlert(message, "warning");

			this.lastQueueDepthAlert = now;
			this.logger.warn(
				`[HealthMonitor] Queue depth anomaly: +${pendingGrowth} pending, +${completionGrowth} done`,
			);
		}
	}

	// ─── Check 4: Agent Spawn Failure Rate ───────────────────────────────────

	private async checkSpawnFailureRate(): Promise<void> {
		// Check squad_dispatch for recent failures vs total
		const { rows } = await this.queryFn<SpawnStats>(`
			SELECT
				COUNT(*) AS total,
				COUNT(*) FILTER (WHERE dispatch_status = 'failed') AS failed
			FROM roadmap_workforce.squad_dispatch
			WHERE created_at > now() - ($1 || ' minutes')::interval
		`, [String(this.spawnFailureWindowMinutes)]);

		const row = rows[0];
		if (!row) return;

		const total = Number(row.total);
		const failed = Number(row.failed);

		if (total < 3) return; // Not enough data

		const failureRate = failed / total;

		if (failureRate >= this.spawnFailureRateThreshold) {
			const now = Date.now();
			if (now - this.lastSpawnFailureAlert < ALERT_COOLDOWN_MS) return;

			const pct = Math.round(failureRate * 100);
			const message =
				`🔴 **Agent spawn failure rate critical** — ${failed}/${total} ` +
				`dispatches failed in the last ${this.spawnFailureWindowMinutes} minutes ` +
				`(${pct}% failure rate, threshold: ${Math.round(this.spawnFailureRateThreshold * 100)}%). ` +
				`Check agent availability and model connectivity.`;

			await this.sendAlert(message, "error");

			await this.queueNotification(
				null,
				"CRITICAL",
				"Agent spawn failure rate critical",
				message,
			);

			this.lastSpawnFailureAlert = now;
			this.logger.error(
				`[HealthMonitor] Spawn failure rate: ${failed}/${total} (${pct}%)`,
			);
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private async sendAlert(
		message: string,
		level: DiscordLevel,
	): Promise<void> {
		try {
			await discordSend(this.sender, message, level);
		} catch (err) {
			// Don't let Discord failures crash the health monitor
			this.logger.warn(
				`[HealthMonitor] Discord send failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async queueNotification(
		proposalId: number | string | null,
		severity: "INFO" | "ALERT" | "URGENT" | "CRITICAL",
		title: string,
		body: string,
	): Promise<void> {
		try {
			await this.queryFn(
				`INSERT INTO roadmap.notification_queue
					(proposal_id, severity, channel, title, body, metadata)
				VALUES ($1, $2, 'discord', $3, $4, jsonb_build_object('source', 'health-monitor'))`,
				[proposalId, severity, title, body],
			);
		} catch (err) {
			// Don't let DB failures crash the health monitor
			this.logger.warn(
				`[HealthMonitor] notification_queue insert failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// Helper to get current timestamp
function now(): number {
	return Date.now();
}
