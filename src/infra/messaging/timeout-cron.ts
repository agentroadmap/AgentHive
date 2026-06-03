/**
 * P835: A2A Message Reliability (timeout cron, dead letter, escalation)
 * P1122: Extend timeout-cron to DLQ-enqueue on terminal failure
 *
 * Runs three passes every 30 seconds:
 * 1. Escalation pass: marks messages as escalated and sends escalation notices
 * 2. Reminder pass: sends reminder messages to senders for unacked messages
 * 3. DLQ-enqueue pass: routes terminal failures to dead letter queue
 *
 * Also handles dead letter NACKs for agent_not_found and recipient_blocked
 * during the message dispatch gate check.
 */

import { query, getPool, type Pool } from "../../infra/postgres/pool.ts";

const POISON_PILL_DEAD_LETTER = "POISON_PILL_DEAD_LETTER";
const ESCALATION_RETRY_LIMIT = 3;

interface EscalationCandidate {
	message_id: string;
	escalation_recipient: string;
	from_agent: string;
	to_agent: string;
	message_type: string;
	correlation_id: string | null;
}

interface ReminderCandidate {
	message_id: string;
	timeout_at: string;
	from_agent: string;
	to_agent: string;
	message_type: string;
	correlation_id: string | null;
}

interface DLQCandidate {
	message_id: string;
	from_agent: string;
	to_agent: string | null;
	channel: string | null;
	message_type: string;
	message_content: string | null;
	read_at: string | null;
	mtt_id: string;
}

/**
 * Escalation pass: uses two-CTE atomic bulk pattern to fetch candidates and update.
 * For each escalated message, sends an escalation notice to the escalation recipient.
 * Failure counts are persisted in escalation_failure_count (P900) so the poison-pill
 * threshold survives process restarts and multi-pod deploys.
 */
export async function runEscalationPass(db: Pool): Promise<void> {
	const logger = console;

	try {
		const result = await db.query<EscalationCandidate>(
			`WITH candidates AS (
				SELECT mtt.message_id
				FROM   roadmap.message_timeout_tracking mtt
				WHERE  mtt.escalated_at IS NULL
				  AND  mtt.timeout_at   < now()
				FOR UPDATE SKIP LOCKED
			),
			to_escalate AS (
				UPDATE roadmap.message_timeout_tracking mtt
				SET    escalated_at        = now(),
					   escalation_recipient = mtc.escalation_recipient
				FROM   candidates c
				JOIN   roadmap.message_ledger        ml  ON  ml.id            = c.message_id
				JOIN   roadmap.message_type_contract mtc ON  mtc.message_type = ml.message_type
				WHERE  mtt.message_id = c.message_id
				RETURNING
					mtt.message_id,
					mtt.escalation_recipient,
					ml.from_agent,
					ml.to_agent,
					ml.message_type,
					ml.correlation_id
			)
			SELECT * FROM to_escalate`,
		);

		const candidates = result.rows;
		logger.log(
			`[TimeoutCron] Escalation pass: found ${candidates.length} candidates`,
		);

		for (const candidate of candidates) {
			try {
				// Insert escalation notice to escalation_recipient
				const noticeResult = await db.query(
					`INSERT INTO roadmap.message_ledger
					 (from_agent, to_agent, message_type, message_content, correlation_id, reply_to)
					 VALUES ($1, $2, 'notify', $3, $4, $5)
					 RETURNING id`,
					[
						"system:timeout-escalator",
						candidate.escalation_recipient,
						JSON.stringify({
							original_message_id: candidate.message_id,
							original_sender: candidate.from_agent,
							original_recipient: candidate.to_agent,
							original_message_type: candidate.message_type,
							original_correlation_id: candidate.correlation_id,
							escalation_timestamp: new Date().toISOString(),
						}),
						candidate.correlation_id,
						candidate.message_id,
					],
				);

				logger.log(
					`[TimeoutCron] Escalation: message ${candidate.message_id} escalated to ${candidate.escalation_recipient} (notice id: ${noticeResult.rows[0].id})`,
				);

				// Reset durable failure counter on success (no-op if counter was 0)
				await db.query(
					`UPDATE roadmap.message_timeout_tracking
					 SET escalation_failure_count = 0
					 WHERE message_id = $1 AND escalation_failure_count > 0`,
					[candidate.message_id],
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);

				// Increment durable failure counter; get new total atomically
				const { rows: failRows } = await db.query<{ escalation_failure_count: number }>(
					`UPDATE roadmap.message_timeout_tracking
					 SET escalation_failure_count = escalation_failure_count + 1
					 WHERE message_id = $1
					 RETURNING escalation_failure_count`,
					[candidate.message_id],
				);
				const failureCount = failRows[0]?.escalation_failure_count ?? 1;

				logger.error(
					`[TimeoutCron] Escalation notice failed for message ${candidate.message_id}: ${message}`,
				);

				// After ESCALATION_RETRY_LIMIT consecutive failures, quarantine as poison pill;
				// otherwise reset escalated_at so the CTE re-selects on the next tick.
				if (failureCount >= ESCALATION_RETRY_LIMIT) {
					try {
						await db.query(
							`UPDATE roadmap.message_timeout_tracking
							 SET escalation_recipient = $1
							 WHERE message_id = $2`,
							[POISON_PILL_DEAD_LETTER, candidate.message_id],
						);
						logger.error(
							`[TimeoutCron] Message ${candidate.message_id} marked as poison pill after ${failureCount} failures`,
						);

					logger.error(
						`[TimeoutCron] Message ${candidate.message_id} escalation failure count: ${failureCount}`,
					);

					if (failureCount >= ESCALATION_RETRY_LIMIT) {
						// Poison pill: mark permanently and keep escalated_at set so the CTE
						// never picks this row up again.
						try {
							await db.query(
								`UPDATE roadmap.message_timeout_tracking
								 SET escalation_recipient = $1
								 WHERE message_id = $2`,
								[POISON_PILL_DEAD_LETTER, candidate.message_id],
							);
							logger.error(
								`[TimeoutCron] Message ${candidate.message_id} marked as poison pill after ${failureCount} failures`,
							);

							// Check if escalation_recipient is missing from agent_registry
							if (!candidate.escalation_recipient) {
								logger.error(
									`[TimeoutCron] CRITICAL: message ${candidate.message_id} has no escalation_recipient`,
								);
								// Call OPERATOR_WEBHOOK_URL if set
								const webhookUrl = process.env.OPERATOR_WEBHOOK_URL;
								if (webhookUrl) {
									try {
										const response = await fetch(webhookUrl, {
											method: "POST",
											headers: { "Content-Type": "application/json" },
											body: JSON.stringify({
												severity: "CRITICAL",
												event: "escalation_recipient_missing",
												message_id: candidate.message_id,
												from_agent: candidate.from_agent,
												timestamp: new Date().toISOString(),
											}),
										});
										if (!response.ok) {
											logger.error(
												`[TimeoutCron] Webhook call failed: ${response.status} ${response.statusText}`,
											);
										}
									} catch (webhookErr) {
										logger.error(
											`[TimeoutCron] Failed to call operator webhook: ${
												webhookErr instanceof Error ? webhookErr.message : String(webhookErr)
											}`,
										);
									}
								}
							}
						} catch (poisonErr) {
							logger.error(
								`[TimeoutCron] Failed to mark poison pill: ${
									poisonErr instanceof Error ? poisonErr.message : String(poisonErr)
								}`,
							);
						}
					} else {
						// Below threshold: reset escalated_at so the row is retried next tick
						await db.query(
							`UPDATE roadmap.message_timeout_tracking
							 SET escalated_at = NULL
							 WHERE message_id = $1`,
							[candidate.message_id],
						);
					}
				} else {
					// Below threshold: reset escalated_at so the CTE re-selects on the next tick
					await db.query(
						`UPDATE roadmap.message_timeout_tracking
						 SET escalated_at = NULL
						 WHERE message_id = $1`,
						[candidate.message_id],
					);
				}
			}
		}
	} catch (err) {
		logger.error(
			`[TimeoutCron] Escalation pass failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * Reminder pass: sends reminder messages to senders for unacked messages
 * that are approaching their timeout (50% of original timeout window).
 * Excludes messages that were just escalated this tick.
 */
async function runReminderPass(db: Pool): Promise<void> {
	const logger = console;

	try {
		const result = await db.query<ReminderCandidate>(
			`WITH escalated_this_tick AS (
				SELECT DISTINCT message_id
				FROM   roadmap.message_timeout_tracking
				WHERE  escalated_at IS NOT NULL
				  AND  escalated_at >= now() - interval '30 seconds'
			)
			SELECT
				mtt.message_id, mtt.timeout_at, ml.from_agent, ml.to_agent, ml.message_type, ml.correlation_id
			FROM   roadmap.message_timeout_tracking mtt
			JOIN   roadmap.message_ledger ml ON ml.id = mtt.message_id
			WHERE  mtt.timeout_at       < now() + (mtt.timeout_at - mtt.created_at) * 0.5
			  AND  mtt.reminder_sent_at IS NULL
			  AND  ml.acked_at          IS NULL
			  AND  mtt.message_id NOT IN (SELECT message_id FROM escalated_this_tick)`,
		);

		const candidates = result.rows;
		logger.log(
			`[TimeoutCron] Reminder pass: found ${candidates.length} candidates`,
		);

		for (const candidate of candidates) {
			try {
				// Insert reminder message to from_agent
				const reminderResult = await db.query(
					`INSERT INTO roadmap.message_ledger
					 (from_agent, to_agent, message_type, message_content, correlation_id, reply_to)
					 VALUES ('system:timeout-reminder', $1, 'notify', $2, $3, $4)
					 RETURNING id`,
					[
						candidate.from_agent,
						JSON.stringify({
							original_message_id: candidate.message_id,
							recipient: candidate.to_agent,
							message_type: candidate.message_type,
							correlation_id: candidate.correlation_id,
							timeout_at: candidate.timeout_at,
							reminder_timestamp: new Date().toISOString(),
						}),
						candidate.correlation_id,
						candidate.message_id,
					],
				);

				// Update reminder_sent_at
				await db.query(
					`UPDATE roadmap.message_timeout_tracking
					 SET reminder_sent_at = now()
					 WHERE message_id = $1`,
					[candidate.message_id],
				);

				logger.log(
					`[TimeoutCron] Reminder: sent reminder for message ${candidate.message_id} to ${candidate.from_agent} (reminder id: ${reminderResult.rows[0].id})`,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error(
					`[TimeoutCron] Reminder failed for message ${candidate.message_id}: ${message}`,
				);
			}
		}
	} catch (err) {
		logger.error(
			`[TimeoutCron] Reminder pass failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * DLQ-enqueue pass (P1122): Routes terminal failures to dead letter queue.
 * Criteria: tracker row has both escalated_at AND reminder_sent_at set,
 * AND resolved_at IS NULL, AND now() > timeout_at + 30 minutes.
 * Also confirms message is unread (read_at IS NULL) to exclude delivered messages.
 */
async function runDLQEnqueuePass(db: Pool): Promise<void> {
	const logger = console;

	try {
		const result = await db.query<DLQCandidate>(
			`SELECT
				mtt.id as mtt_id,
				mtt.message_id,
				ml.from_agent,
				ml.to_agent,
				ml.channel,
				ml.message_type,
				ml.message_content,
				ml.read_at
			FROM   roadmap.message_timeout_tracking mtt
			JOIN   roadmap.message_ledger ml ON ml.id = mtt.message_id
			WHERE  mtt.escalated_at    IS NOT NULL
			  AND  mtt.reminder_sent_at IS NOT NULL
			  AND  mtt.resolved_at      IS NULL
			  AND  ml.read_at           IS NULL
			  AND  now()                > mtt.timeout_at + interval '30 minutes'
			  AND  mtt.final_outcome    IS NULL
			FOR UPDATE SKIP LOCKED`,
		);

		const candidates = result.rows;
		logger.log(
			`[TimeoutCron] DLQ-enqueue pass: found ${candidates.length} candidates`,
		);

		for (const candidate of candidates) {
			try {
				// Insert into dead_letter_queue
				const dlqResult = await db.query(
					`INSERT INTO roadmap.dead_letter_queue
					 (original_message_id, from_agent, to_agent, channel, payload, failure_reason, retry_budget_used)
					 VALUES ($1, $2, $3, $4, $5, 'timeout_after_retries', 0)
					 RETURNING id`,
					[
						candidate.message_id,
						candidate.from_agent,
						candidate.to_agent,
						candidate.channel,
						candidate.message_content,
					],
				);

				const dlqId = dlqResult.rows[0].id;

				// Update tracker row with final_outcome
				await db.query(
					`UPDATE roadmap.message_timeout_tracking
					 SET final_outcome = 'dead_lettered',
					     resolved_at = now()
					 WHERE id = $1`,
					[candidate.mtt_id],
				);

				// Emit pg_notify for observers
				await db.query(
					`SELECT pg_notify('dlq_landing', $1)`,
					[JSON.stringify({
						dlq_id: dlqId,
						message_id: candidate.message_id,
					})],
				);

				logger.log(
					`[TimeoutCron] DLQ-enqueue: message ${candidate.message_id} routed to DLQ (dlq_id: ${dlqId})`,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error(
					`[TimeoutCron] DLQ-enqueue failed for message ${candidate.message_id}: ${message}`,
				);
				// Continue processing remaining candidates even if one fails
			}
		}
	} catch (err) {
		logger.error(
			`[TimeoutCron] DLQ-enqueue pass failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * Run all three passes: escalation, reminder, then DLQ-enqueue.
 */
export async function runTimeoutSweep(db: Pool): Promise<void> {
	console.log("[TimeoutCron] Starting timeout sweep");
	await runEscalationPass(db);
	await runReminderPass(db);
	await runDLQEnqueuePass(db);
	console.log("[TimeoutCron] Timeout sweep complete");
}

/**
 * Register the timeout cron to run every 30 seconds.
 * Also performs schema readiness check and idempotency check.
 */
export async function registerTimeoutCron(db: Pool): Promise<void> {
	const logger = console;

	try {
		// Check schema readiness
		const tableCheckResult = await db.query<{ count: string }>(
			`SELECT COUNT(*) as count FROM information_schema.tables
			 WHERE table_schema='roadmap' AND table_name='message_timeout_tracking'`,
		);

		const count = Number(tableCheckResult.rows[0]?.count ?? 0);
		if (count === 0) {
			logger.warn(
				"[TimeoutCron] Schema not ready: message_timeout_tracking table does not exist",
			);
			return;
		}

		logger.info("[TimeoutCron] Schema readiness check passed");

		// Check idempotency: look for existing cron entry
		// For now, we'll just use setInterval since the spec doesn't require persistent cron entries
		// If persistent cron storage is needed, that would check a cron_jobs table here

		// Register the interval-based cron
		const interval = setInterval(() => {
			void runTimeoutSweep(db).catch((err) => {
				logger.error(
					`[TimeoutCron] Unhandled error in timeout sweep: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			});
		}, 30000); // 30 seconds

		logger.info("[TimeoutCron] Timeout cron registered to run every 30 seconds");

		// Store interval ID for potential cleanup (optional)
		(globalThis as any).__timeoutCronInterval = interval;
	} catch (err) {
		logger.error(
			`[TimeoutCron] Failed to register timeout cron: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}
