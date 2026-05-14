import { getPool, query } from "../../infra/postgres/pool.ts";
import { reapStaleRows } from "../pipeline/reap-stale-rows.ts";
import { enqueueNotification } from "../notifications/enqueue.ts";
import { getUnlockedGateQueue } from "../proposal/gate-scanner-v2.ts";
import { postWorkOffer } from "../pipeline/post-work-offer.ts";
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

/**
 * Unified Agent Orchestrator
 *
 * Manages agent pool, resource allocation, and reporting.
 * Uses Postgres as the primary source of truth.
 *
 * P744/P748–P754: scanQueues() is the single unified dispatch loop that
 * replaces the split between scripts/orchestrator.ts and PipelineCron.
 * PG NOTIFY handlers and the poll fallback both call scanQueues().
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
}

export class Orchestrator {
	private readonly defaultWorktree: string;
	private readonly offerReapIntervalMs: number;
	private readonly pokeWatchdogIntervalMs: number;
	private readonly pokeOpts: PokeWatchdogOptions;

	private offerReapTimer: ReturnType<typeof setInterval> | null = null;
	private pokeWatchdogTimer: ReturnType<typeof setInterval> | null = null;
	private offerReapInFlight = false;

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

				const task = buildTaskPrompt(detail, mode, reasons);

				await postWorkOffer({
					proposalId: detail.id,
					squadName: `P${detail.id}-${detail.status}`,
					role: mode,
					task,
					stage: detail.status,
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
				await postWorkOffer({
					proposalId: stall.id,
					squadName: `P${stall.id}-stall-liaison`,
					role: "orchestrator-liaison-investigator",
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
					stage: stall.status,
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
