/**
 * P842: Hard Budget Enforcement per Agent (Principal-Based Spending Caps)
 *
 * Idempotent period reset job — runs every 5 minutes.
 * Resets expired budget periods (day, week, month) but NOT 'total'.
 */

import { query } from '../db/query.js';

/**
 * Reset budget periods that have crossed their boundary.
 *
 * Idempotent: safe to run every 5 minutes across multiple instances.
 *
 * Logic:
 * - 'day': resets if last_reset_at::date < now()::date
 * - 'week': resets if last_reset_at is NULL or more than 7 days old
 * - 'month': resets if last_reset_at is NULL or more than 30 days old
 * - 'total': never resets
 *
 * Clock skew tolerance: ±5 minutes (job runs every 5 minutes).
 * If clocks drift >5min, resets delayed; acceptable for daily periods.
 */
export async function resetExpiredBudgetPeriods(): Promise<void> {
	// Reset 'day' period: if last_reset_at crossed a date boundary
	await query(
		`UPDATE roadmap.principal_spending_cap
		 SET current_spent_usd_cents = 0, last_reset_at = NOW()
		 WHERE period = 'day' AND (last_reset_at IS NULL OR last_reset_at::date < now()::date)`,
		[]
	);

	// Reset 'week' period: if last_reset_at is >7 days old
	await query(
		`UPDATE roadmap.principal_spending_cap
		 SET current_spent_usd_cents = 0, last_reset_at = NOW()
		 WHERE period = 'week' AND (last_reset_at IS NULL OR last_reset_at < NOW() - INTERVAL '7 days')`,
		[]
	);

	// Reset 'month' period: if last_reset_at is >30 days old
	await query(
		`UPDATE roadmap.principal_spending_cap
		 SET current_spent_usd_cents = 0, last_reset_at = NOW()
		 WHERE period = 'month' AND (last_reset_at IS NULL OR last_reset_at < NOW() - INTERVAL '30 days')`,
		[]
	);

	// 'total' period never resets — cumulative cap for lifetime of budget row
}
