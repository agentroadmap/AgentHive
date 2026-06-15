/**
 * P1103: Schema governance — canonical message type taxonomy
 *
 * Single source of truth for all valid message_type values in roadmap.message_ledger.
 * Must stay in sync with the CHECK constraint defined in migration 158-p1103-message-type-taxonomy.sql.
 *
 * Sync is validated by scripts/check-message-type-drift.ts, which compares this enum
 * to the actual pg_constraint definition on every test run.
 */

/** All 19 canonical message types for A2A and liaison messaging. */
export const MESSAGE_TYPES = [
  'text',           // plain conversational message
  'task',           // task assignment with optional action payload
  'notify',         // one-way notification (no reply expected)
  'ack',            // acknowledgement of a received message
  'error',          // error notification
  'event',          // system or lifecycle event
  'liaison',        // liaison-specific protocol message
  'protocol_ping',  // liveness check (P251)
  'protocol_pong',  // liveness response (P251)
  'task_request',   // task request from liaison to orchestrator
  'task_ack',       // task acknowledgement
  'task_status',    // task status update
  'task_complete',  // task completion notification
  'task_error',     // task error report
  'user_message',   // P1105: USER first-class identity
  'throttle_decision', // P1376: soft-throttle decision feed
  'capacity_query', // P1438 C6 AC-17: on-demand capacity probe
  'handoff_request',// P1438 C6 AC-17: targeted/specialized work handoff
  'capability_gap', // P1438 C6 AC-17: no agency can serve a capability
] as const;

/** Derived type from MESSAGE_TYPES tuple. */
export type MessageType = typeof MESSAGE_TYPES[number];

/**
 * Validate a string against the canonical message type enum.
 * Used by insertMessage() and drift checks.
 */
export function isValidMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && MESSAGE_TYPES.includes(value as MessageType);
}
