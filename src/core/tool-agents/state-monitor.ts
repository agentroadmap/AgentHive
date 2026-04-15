/**
 * State Monitor — zero-cost AC pass rate evaluator.
 *
 * Listens for proposal maturity changes via pg_notify and evaluates whether
 * all acceptance criteria have passed. If the pass rate meets the threshold
 * (default: 100%), auto-advances the proposal maturity to 'mature'.
 */

import { query } from "../../infra/postgres/pool.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

interface StateMonitorConfig {
	acPassThreshold?: number;
	autoAdvance?: boolean;
}

interface AcRow {
	item_number: number;
	status: string;
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

		// Count total and passed ACs
		const { rows: acRows } = await query<AcRow>(
			`SELECT item_number, status
			   FROM roadmap.acceptance_criteria
			  WHERE proposal_id = $1`,
			[proposalId],
		);

		if (acRows.length === 0) {
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
			return {
				success: true,
				output: `Proposal ${proposalId}: ${passed}/${total} ACs pass (${(rate * 100).toFixed(0)}%) — below threshold ${(this.acPassThreshold * 100).toFixed(0)}%`,
				tokensUsed: 0,
			};
		}

		// All ACs pass — auto-advance maturity
		if (this.autoAdvance) {
			await query(
				`UPDATE roadmap.proposal
				    SET maturity = 'mature',
				        modified_at = now()
				  WHERE id = $1
				    AND maturity != 'mature'`,
				[proposalId],
			);

			return {
				success: true,
				output: `Proposal ${proposalId}: ${passed}/${total} ACs pass — maturity set to 'mature'`,
				tokensUsed: 0,
			};
		}

		return {
			success: true,
			output: `Proposal ${proposalId}: ${passed}/${total} ACs pass (${(rate * 100).toFixed(0)}%)`,
			tokensUsed: 0,
		};
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
