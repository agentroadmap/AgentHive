/**
 * P304: dead-letter queue helpers.
 *
 * moveToDlq replaces escalateDispatchFailure in router.ts when
 * newAttempts >= MAX_ATTEMPTS.
 */

import type { Pool } from 'pg';

import type { OutboundMessage } from './adapter.ts';

export async function moveToDlq(
  db: Pool,
  msg: OutboundMessage,
  attemptCount: number,
  errorCode?: string,
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE roadmap.notification_queue
          SET status = 'failed'
        WHERE id = $1`,
      [msg.notificationId],
    );
    await client.query(
      `INSERT INTO roadmap.notification_dlq
         (notification_id, channel, last_error, attempt_count)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (notification_id) DO UPDATE
         SET last_error        = EXCLUDED.last_error,
             attempt_count     = EXCLUDED.attempt_count,
             last_attempted_at = now()`,
      [msg.notificationId, msg.channel, errorCode ?? 'unknown', attemptCount],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await checkDlqDepthAndAlert(db);
}

export async function checkDlqDepthAndAlert(db: Pool): Promise<void> {
  const { rows } = await db.query<{ depth: string }>(
    `SELECT COUNT(*) AS depth
       FROM roadmap.notification_dlq
      WHERE resolved_at IS NULL`,
  );
  const depth = parseInt(rows[0].depth, 10);
  if (depth > 10) {
    await db.query(
      `INSERT INTO roadmap.notification_queue
         (channel, title, body, severity, status)
       SELECT 'discord', 'DLQ Depth Alert', $1, 'URGENT', 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM roadmap.notification_queue
           WHERE channel = 'discord'
             AND title = 'DLQ Depth Alert'
             AND status = 'pending'
             AND created_at > now() - interval '1 hour'
        )`,
      [`Dead-letter queue has ${depth} unresolved entries. Immediate operator attention required.`],
    );
  }
}
