/**
 * P1107: Listener subscription reconciliation watchdog.
 * Identifies drift between roadmap.listener_subscription rows and actual
 * live backends in pg_stat_activity. Cleans up stale rows and reports drift.
 *
 * Exit codes:
 *   0 = clean (no drift detected or cleaned)
 *   1 = drift detected after cleanup attempt
 *   2 = database error
 */

import { query } from "../src/infra/postgres/pool.ts";

interface SubscriptionRow {
	agent_identity: string;
	channel: string;
	established_pid: number;
	established_at: string;
}

interface DriftReport {
	agent_identity: string;
	channel: string;
	drift_reason: string;
}

async function reconcile(): Promise<{ cleanRows: number; driftRows: DriftReport[] }> {
	const cleanRows: number[] = [];
	const driftRows: DriftReport[] = [];

	try {
		// Fetch all subscription rows
		const { rows: subscriptions } = await query<SubscriptionRow>(
			`SELECT agent_identity, channel, established_pid, established_at
			 FROM roadmap.listener_subscription
			 ORDER BY established_at DESC`,
		);

		if (subscriptions.length === 0) {
			console.log("✓ No active listener subscriptions.");
			return { cleanRows: 0, driftRows: [] };
		}

		// Fetch all live backend PIDs
		const { rows: backends } = await query<{ pid: number }>(
			`SELECT pid FROM pg_stat_activity WHERE state != 'disabled'`,
		);
		const livePids = new Set(backends.map((b) => b.pid));

		// Check each subscription row
		for (const sub of subscriptions) {
			const pidAlive = livePids.has(sub.established_pid);

			if (!pidAlive) {
				driftRows.push({
					agent_identity: sub.agent_identity,
					channel: sub.channel,
					drift_reason: `pid=${sub.established_pid} not in pg_stat_activity (agency died or restarted)`,
				});

				// Remove stale row
				try {
					await query(
						`DELETE FROM roadmap.listener_subscription
						  WHERE agent_identity = $1 AND channel = $2`,
						[sub.agent_identity, sub.channel],
					);
					cleanRows.push(sub.established_pid);
				} catch (err) {
					console.warn(
						`⚠ Failed to delete stale row (${sub.agent_identity}, ${sub.channel}):`,
						err,
					);
				}
			}
		}

		// Report results
		if (driftRows.length === 0) {
			console.log(
				`✓ All ${subscriptions.length} listener subscriptions healthy.`,
			);
		} else {
			console.log(
				`⚠ Found ${driftRows.length} drift row(s); cleaned ${cleanRows.length}:`,
			);
			for (const drift of driftRows) {
				console.log(
					`  - ${drift.agent_identity}:${drift.channel} — ${drift.drift_reason}`,
				);
			}
		}

		return { cleanRows: cleanRows.length, driftRows };
	} catch (err) {
		console.error("✗ Database error during reconciliation:", err);
		throw err;
	}
}

async function main() {
	try {
		const result = await reconcile();
		if (result.driftRows.length === 0) {
			process.exit(0);
		} else {
			process.exit(1);
		}
	} catch {
		process.exit(2);
	}
}

main();
