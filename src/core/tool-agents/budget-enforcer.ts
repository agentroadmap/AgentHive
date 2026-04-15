/**
 * Budget Enforcer — zero-cost spending cap enforcer.
 *
 * Reacts to spending_log inserts via pg_notify. Checks if the agent's
 * daily spending cap has been exceeded and freezes dispatch if so.
 */

import { query } from "../../infra/postgres/pool.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

interface BudgetEnforcerConfig {
	freezeOnExceed?: boolean;
}

interface SpendingRow {
	agent_identity: string;
	cost_usd: number;
}

interface CapRow {
	agent_identity: string;
	daily_limit_usd: number;
	is_frozen: boolean;
}

export class BudgetEnforcer implements ToolAgent {
	identity = "tool/budget-enforcer";
	capabilities = ["spending-cap", "budget-freeze", "cost-monitoring"];

	private readonly freezeOnExceed: boolean;

	constructor(config: Record<string, unknown>) {
		const cfg = config as BudgetEnforcerConfig;
		this.freezeOnExceed = cfg.freezeOnExceed ?? true;
	}

	async invoke(task: ToolTask): Promise<ToolResult> {
		const agentIdentity = task.payload.agentIdentity as string | undefined;

		if (!agentIdentity) {
			return {
				success: true,
				output: "No agent identity provided, skipping budget check",
				tokensUsed: 0,
			};
		}

		// Get daily spending for this agent (today)
		const { rows: spending } = await query<SpendingRow>(
			`SELECT agent_identity, COALESCE(SUM(cost_usd), 0) as cost_usd
			   FROM roadmap.spending_log
			  WHERE agent_identity = $1
			    AND created_at >= date_trunc('day', now())
			  GROUP BY agent_identity`,
			[agentIdentity],
		);

		const totalSpent = spending.length > 0 ? Number(spending[0].cost_usd) : 0;

		// Get the agent's cap
		const { rows: caps } = await query<CapRow>(
			`SELECT agent_identity, daily_limit_usd, is_frozen
			   FROM roadmap.spending_caps
			  WHERE agent_identity = $1`,
			[agentIdentity],
		);

		if (caps.length === 0) {
			return {
				success: true,
				output: `No spending cap defined for ${agentIdentity} — spent $${totalSpent.toFixed(4)} today`,
				tokensUsed: 0,
			};
		}

		const cap = caps[0];
		const dailyLimit = Number(cap.daily_limit_usd);

		if (totalSpent >= dailyLimit) {
			if (this.freezeOnExceed && !cap.is_frozen) {
				await query(
					`UPDATE roadmap.spending_caps
					    SET is_frozen = true,
					        frozen_reason = 'Daily cap exceeded: $' || $2::text,
					        updated_at = now()
					  WHERE agent_identity = $1`,
					[agentIdentity, totalSpent.toFixed(4)],
				);

				return {
					success: true,
					output: `FROZEN ${agentIdentity}: $${totalSpent.toFixed(4)} / $${dailyLimit.toFixed(2)} daily cap exceeded`,
					tokensUsed: 0,
				};
			}

			return {
				success: true,
				output: `${agentIdentity}: $${totalSpent.toFixed(4)} / $${dailyLimit.toFixed(2)} (CAP EXCEEDED)`,
				tokensUsed: 0,
			};
		}

		return {
			success: true,
			output: `${agentIdentity}: $${totalSpent.toFixed(4)} / $${dailyLimit.toFixed(2)} (${((totalSpent / dailyLimit) * 100).toFixed(1)}%)`,
			tokensUsed: 0,
		};
	}

	async healthCheck(): Promise<boolean> {
		try {
			await query(`SELECT 1 FROM roadmap.spending_caps LIMIT 1`);
			return true;
		} catch {
			return false;
		}
	}
}
