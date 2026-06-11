/**
 * State Monitor — zero-cost AC pass rate evaluator with gate-hold grace period.
 *
 * AC-1: Evaluates whether all acceptance criteria have passed using the CORRECT table
 * (roadmap_proposal.proposal_acceptance_criteria).
 *
 * AC-2: Before writing maturity=mature, reads latest gate_decision_log row for proposal_id.
 * If decision IN (hold, reject) AND created_at > (now() - GRACE_PERIOD), skips the write
 * and logs "[SKIP] recent gate hold N seconds ago".
 *
 * AC-3: Atomic CAS guard on UPDATE using WHERE clause with subquery checking max gate hold
 * against GRACE_PERIOD. Prevents race between state-monitor read and gate-agent hold write.
 *
 * AC-4: GRACE_PERIOD read from core.runtime_flag PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC
 * (default 300 seconds, 5 min). Hot-reloadable via the core.runtime_flag TTL cache.
 *
 * AC-5: Logs all maturity decisions with clear reason strings for operator audit trail.
 */

import { query } from "../../infra/postgres/pool.ts";
import { Maturity } from "../workflow/state-names.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

interface StateMonitorConfig {
	acPassThreshold?: number;
	autoAdvance?: boolean;
}

interface AcRow {
	item_number: number;
	status: string;
}

interface GateDecisionRow {
	id: number;
	decision: string;
	created_at: Date;
}

export class StateMonitor implements ToolAgent {
	identity = "tool/state-monitor";
	capabilities = ["state-transition", "ac-evaluation", "auto-advance"];

	private readonly acPassThreshold: number;
	private readonly autoAdvance: boolean;

	constructor(config: Record<string, unknown>) {
		const cfg = config as StateMonitorConfig;
		this.acPassThreshold = cfg.acPassThreshold ?? 1.0;
		this.autoAdvance = cfg.autoAdvance ?? true;
	}

	async invoke(task: ToolTask): Promise<ToolResult> {
		const proposalId = task.proposalId;
		if (!proposalId) {
			return {
				success: false,
				output: "No proposal_id provided",
				tokensUsed: 0,
			};
		}

		// AC-1: Query the CORRECT table (roadmap_proposal.proposal_acceptance_criteria)
		const { rows: acRows } = await query<AcRow>(
			`SELECT item_number, status
			   FROM roadmap_proposal.proposal_acceptance_criteria
			  WHERE proposal_id = $1
			  ORDER BY item_number ASC`,
			[proposalId],
		);

		if (acRows.length === 0) {
			const reason = "[SKIP] query returned 0 ACs";
			console.log(`[StateMonitor] Proposal ${proposalId}: ${reason}`);
			return {
				success: true,
				output: `Proposal ${proposalId}: no ACs defined, skipping`,
				tokensUsed: 0,
			};
		}

		const passed = acRows.filter((r) => r.status === "pass").length;
		const total = acRows.length;
		const rate = passed / total;

		if (rate < this.acPassThreshold) {
			const reason = `[SKIP] AC pass rate ${(rate * 100).toFixed(0)}% below threshold ${(this.acPassThreshold * 100).toFixed(0)}%`;
			console.log(`[StateMonitor] Proposal ${proposalId}: ${reason}`);
			return {
				success: true,
				output: `Proposal ${proposalId}: ${passed}/${total} ACs pass (${(rate * 100).toFixed(0)}%) — below threshold ${(this.acPassThreshold * 100).toFixed(0)}%`,
				tokensUsed: 0,
			};
		}

		// All ACs pass — check gate-hold grace period before writing (AC-2, AC-3)
		if (this.autoAdvance) {
			// AC-4: Read GRACE_PERIOD from hot-reloadable runtime flag
			const gracePeriodSec = await this.getGracePeriodSeconds();

			// AC-2: Check for recent gate hold/reject decisions
			const gateHoldResult = await this.checkRecentGateHold(proposalId, gracePeriodSec);
			if (gateHoldResult.isHeld) {
				const reason = `[SKIP] gate ${gateHoldResult.decision} detected ${gateHoldResult.secondsAgo} seconds ago (grace period ${gracePeriodSec} seconds)`;
				console.log(`[StateMonitor] Proposal ${proposalId}: ${reason}`);
				return {
					success: true,
					output: `Proposal ${proposalId}: ${reason}`,
					tokensUsed: 0,
				};
			}

			// AC-3: Atomic CAS guard UPDATE with subquery checking max gate hold against GRACE_PERIOD
			const casResult = await query<{ count: number }>(
				`UPDATE roadmap_proposal.proposal
				    SET maturity = $2,
				        modified_at = now()
				  WHERE id = $1
				    AND maturity != $2
				    -- AC-3: Atomic guard — only update if no recent gate hold
				    AND NOT EXISTS (
				      SELECT 1 FROM roadmap.gate_decision_log
				       WHERE proposal_id = $1
				         AND decision IN ('hold', 'reject')
				         AND created_at > now() - ($3::int || ' seconds')::interval
				    )
				  RETURNING id`,
				[proposalId, Maturity.MATURE, gracePeriodSec],
			);

			if (casResult.rows.length > 0) {
				// AC-5: Log the decision with clear reason
				const reason = "[WRITE] no gate hold, all ACs pass";
				console.log(`[StateMonitor] Proposal ${proposalId}: ${reason}`);

				// Log to proposal_discussions for operator audit trail
				await query(
					`INSERT INTO roadmap_proposal.proposal_discussions
					   (proposal_id, author_identity, context_prefix, body)
					 VALUES ($1, $2, $3, $4)`,
					[
						proposalId,
						"tool/state-monitor",
						"decision:",
						`${reason} (${passed}/${total} ACs pass, grace period: ${gracePeriodSec}s)`,
					],
				);

				return {
					success: true,
					output: `Proposal ${proposalId}: ${passed}/${total} ACs pass — maturity set to '${Maturity.MATURE}' (${reason})`,
					tokensUsed: 0,
				};
			} else {
				// Either maturity already MATURE or gate hold guard blocked the update
				const reason = "[SKIP] maturity already mature OR gate hold guard blocked update (CAS failed)";
				console.log(`[StateMonitor] Proposal ${proposalId}: ${reason}`);
				return {
					success: true,
					output: `Proposal ${proposalId}: ${reason}`,
					tokensUsed: 0,
				};
			}
		}

		return {
			success: true,
			output: `Proposal ${proposalId}: ${passed}/${total} ACs pass (${(rate * 100).toFixed(0)}%) — autoAdvance disabled`,
			tokensUsed: 0,
		};
	}

	/**
	 * AC-4: Retrieve grace period from hot-reloadable runtime flag.
	 * Default: 300 seconds (5 minutes).
	 * Uses FeatureFlagService with 5-second TTL cache.
	 */
	private async getGracePeriodSeconds(): Promise<number> {
		// AC-4: core.runtime_flag PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC,
		// read through the runtime-config TTL cache so operators can tune it
		// live (UPDATE core.runtime_flag SET value_jsonb='600' ...).
		try {
			return await runtimeConfig.get(
				FlagKeys.PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC,
			);
		} catch {
			return 300; // fail-safe default (5 min)
		}
	}

	/**
	 * AC-2: Check for recent gate hold/reject decisions within grace period.
	 * Returns { isHeld: boolean, decision?: string, secondsAgo?: number }.
	 */
	private async checkRecentGateHold(
		proposalId: number,
		gracePeriodSec: number,
	): Promise<{
		isHeld: boolean;
		decision?: string;
		secondsAgo?: number;
	}> {
		try {
			const { rows } = await query<GateDecisionRow>(
				`SELECT id, decision, created_at
				   FROM roadmap.gate_decision_log
				  WHERE proposal_id = $1
				    AND decision IN ('hold', 'reject')
				    AND created_at > now() - ($2::int || ' seconds')::interval
				  ORDER BY created_at DESC
				  LIMIT 1`,
				[proposalId, gracePeriodSec],
			);

			if (rows.length > 0) {
				const row = rows[0];
				const secondsAgo = Math.round(
					(Date.now() - new Date(row.created_at).getTime()) / 1000,
				);
				return {
					isHeld: true,
					decision: row.decision,
					secondsAgo,
				};
			}
			return { isHeld: false };
		} catch (err) {
			console.error(
				`[StateMonitor] Error checking gate hold for proposal ${proposalId}: ${err}`,
			);
			// Fail-safe: assume held to avoid race
			return { isHeld: true, decision: "unknown", secondsAgo: 0 };
		}
	}

	async healthCheck(): Promise<boolean> {
		try {
			await query(`SELECT 1`);
			return true;
		} catch {
			return false;
		}
	}
}
