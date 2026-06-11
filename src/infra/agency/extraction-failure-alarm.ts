/**
 * P1018 AC-13: Extraction-failure alarm
 *
 * Monitors token extraction success rates per provider. When failures exceed
 * 5% in a 1-hour rolling window, fires a notification to the operator.
 *
 * Uses extraction_failure_tracking table to track per-run successes, and
 * extraction_failure_alarm_cooldown to avoid notification spam (1 per hour per provider).
 *
 * Called from record-spawn-usage.ts after each spawn completes.
 */

import { query } from "../postgres/pool.ts";

// Optional logger - provide your own or use console
const obs = {
	log: (payload: Record<string, unknown>) => {
		// Swallow in production, log to console if needed
		if (process.env.DEBUG_EXTRACTION_ALARM) {
			console.log("[extraction-alarm]", payload);
		}
	},
};

export interface ExtractionFailureAlarmInput {
	/** Provider name (anthropic, openai, google, copilot). */
	provider: string;
	/** Agent run ID that just completed. */
	agentRunId: number;
	/** TRUE if extraction succeeded (non-NULL tokens returned). */
	extractionSuccess: boolean;
	/** Override for test injection. */
	exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export interface ExtractionFailureAlarmResult {
	/** TRUE if alarm was triggered. */
	alarmTriggered: boolean;
	/** Failure rate percent (if computed). */
	failureRatePercent: number | null;
	/** Diagnostic message. */
	message: string;
}

const FAILURE_THRESHOLD_PERCENT = 5.0;
const ALARM_COOLDOWN_MINUTES = 60;

/**
 * Check extraction failure rate and fire alarm if threshold breached.
 *
 * Process:
 * 1. Record this run's extraction success/failure
 * 2. Query failure rate over last 1 hour
 * 3. If rate > 5%, check cooldown
 * 4. If not in cooldown, insert notification and update cooldown
 *
 * Returns result object with alarmTriggered flag.
 * Non-fatal: failures don't block offer completion.
 */
export async function checkExtractionFailureAlarm(
	input: ExtractionFailureAlarmInput,
): Promise<ExtractionFailureAlarmResult> {
	const exec = input.exec ?? query;

	try {
		// Step 1: Record this run's extraction success
		await exec(
			`INSERT INTO roadmap.extraction_failure_tracking (
			   provider, agent_run_id, extraction_success, recorded_at
			 ) VALUES ($1, $2, $3, now())`,
			[input.provider, input.agentRunId, input.extractionSuccess],
		);

		// Step 2: Compute failure rate over last hour
		const rateResult = (await exec(
			`SELECT
			   failure_count, total_count, failure_rate_percent
			 FROM roadmap.v_extraction_failure_rate
			 WHERE provider = $1`,
			[input.provider],
		)) as {
			rows: Array<{
				failure_count: number;
				total_count: number;
				failure_rate_percent: number;
			}>;
		};

		const rateRow = rateResult.rows[0];
		if (!rateRow || rateRow.total_count === 0) {
			return {
				alarmTriggered: false,
				failureRatePercent: null,
				message: `No extraction data yet for provider=${input.provider}`,
			};
		}

		const failureRatePercent = rateRow.failure_rate_percent;

		// Step 3: Check threshold
		if (failureRatePercent <= FAILURE_THRESHOLD_PERCENT) {
			return {
				alarmTriggered: false,
				failureRatePercent,
				message: `Extraction success rate OK: ${100 - failureRatePercent}% (threshold: ${100 - FAILURE_THRESHOLD_PERCENT}%)`,
			};
		}

		// Step 4: Check cooldown to avoid spam
		const cooldownResult = (await exec(
			`SELECT last_alarm_at FROM roadmap.extraction_failure_alarm_cooldown
			 WHERE provider = $1`,
			[input.provider],
		)) as { rows: Array<{ last_alarm_at: string }> };

		const lastAlarmAt = cooldownResult.rows[0]?.last_alarm_at;
		if (lastAlarmAt) {
			const lastAlarmTime = new Date(lastAlarmAt).getTime();
			const nowTime = Date.now();
			const minutesElapsed = (nowTime - lastAlarmTime) / 1000 / 60;

			if (minutesElapsed < ALARM_COOLDOWN_MINUTES) {
				return {
					alarmTriggered: false,
					failureRatePercent,
					message: `Alarm suppressed by cooldown (${minutesElapsed.toFixed(1)} min < ${ALARM_COOLDOWN_MINUTES} min)`,
				};
			}
		}

		// Step 5: Fire notification
		const notificationResult = (await exec(
			`INSERT INTO roadmap.notification_queue (
			   kind, title, body, severity, status, payload, metadata
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7)
			 RETURNING id`,
			[
				"token_extraction_failures",
				`Token extraction failure rate high: ${input.provider}`,
				`Extraction failures for provider ${input.provider} reached ${failureRatePercent.toFixed(2)}% ` +
					`(threshold: ${FAILURE_THRESHOLD_PERCENT}%) over the last hour. ` +
					`Failures: ${rateRow.failure_count}/${rateRow.total_count} runs. ` +
					`Check adapter for output format changes or provider API changes.`,
				"ALERT",
				"pending",
				JSON.stringify({
					provider: input.provider,
					failure_count: rateRow.failure_count,
					total_count: rateRow.total_count,
					failure_rate_percent: failureRatePercent,
					threshold_percent: FAILURE_THRESHOLD_PERCENT,
				}),
				{ triggered_at: new Date().toISOString() },
			],
		)) as { rows: Array<{ id: number }> };

		const notificationId = notificationResult.rows[0]?.id;

		// Step 6: Update cooldown
		await exec(
			`INSERT INTO roadmap.extraction_failure_alarm_cooldown (
			   provider, last_alarm_at, alarm_count, updated_at
			 ) VALUES ($1, now(), 1, now())
			 ON CONFLICT (provider) DO UPDATE SET
			   last_alarm_at = now(),
			   alarm_count = alarm_count + 1,
			   updated_at = now()`,
			[input.provider],
		);

		obs.log({
			level: "warn",
			message: `Extraction failure alarm triggered for provider=${input.provider}`,
			payload: {
				notification_id: notificationId,
				failure_rate_percent: failureRatePercent,
				failure_count: rateRow.failure_count,
				total_count: rateRow.total_count,
			},
		});

		return {
			alarmTriggered: true,
			failureRatePercent,
			message: `Alarm fired: notification #${notificationId}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		obs.log({
			level: "error",
			message: `checkExtractionFailureAlarm failed for provider=${input.provider}`,
			error: message,
		});

		// Non-fatal: return the error in the result but don't throw
		return {
			alarmTriggered: false,
			failureRatePercent: null,
			message: `Alarm check failed: ${message}`,
		};
	}
}
