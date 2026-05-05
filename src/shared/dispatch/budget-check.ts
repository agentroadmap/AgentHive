/**
 * P842: Hard Budget Enforcement per Agent (Principal-Based Spending Caps)
 *
 * Phase 2 stub implementations. Phase 3 enforcement (in callTool) is gated on P484 COMPLETE.
 */

import { agentContextStorage } from '../identity/agent-context';

/**
 * BudgetExceededError: thrown when agent or project budget cap is exceeded.
 *
 * Deliberately redacted for external callers — does NOT expose:
 *  - principal_id
 *  - actual balance or max_usd_cents
 *  - period or reset details
 */
export class BudgetExceededError extends Error {
	readonly cap_type: 'project_cap' | 'agent_cap';

	constructor(cap_type: 'project_cap' | 'agent_cap') {
		super('[P842] Budget exceeded');
		this.name = 'BudgetExceededError';
		this.cap_type = cap_type;
	}
}

/**
 * Check if an agent can spend an estimated amount against their principal budget cap.
 *
 * Phase 3 implementation (gated on P484 COMPLETE):
 * 1. Query principal_spending_cap for (principal_id, project_id, period)
 * 2. If no row exists: pass (fail-open — uncapped by default)
 * 3. If current_spent_usd_cents + estimated > max_usd_cents: throw BudgetExceededError('agent_cap')
 * 4. Check period boundary: if last_reset_at is stale, re-check live
 *
 * TODO(P842-Phase3): integrate checkBudgetAtomic() from allowlist-check.ts after P484 ships
 */
export async function checkAgentBudget(
	principal_id: string,
	project_id: string,
	estimated_cost_usd_cents: number
): Promise<void> {
	// Phase 3 implementation — currently a stub
	// Implementation deferred until P484 COMPLETE
}

/**
 * Record actual spend against principal budget cap after successful tool execution.
 *
 * Phase 3 implementation (gated on P484 COMPLETE):
 * 1. UPDATE principal_spending_cap SET current_spent_usd_cents = current_spent_usd_cents + actual_cost
 * 2. INSERT into dispatch_route_audit with:
 *    - budget_decision = 'approved'
 *    - agent_budget_remaining_cents = (max_usd_cents - new_spent)
 *
 * Non-blocking: failures to record spend should not fail the tool call,
 * but should be logged for operator visibility.
 *
 * TODO(P842-Phase3): coordinate with P484 project-level record flow
 */
export async function recordAgentSpend(
	principal_id: string,
	project_id: string,
	actual_cost_usd_cents: number
): Promise<void> {
	// Phase 3 implementation — currently a stub
	// Implementation deferred until P484 COMPLETE
}
