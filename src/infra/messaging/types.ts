/**
 * P1017 AC-24: Canonical MessageType enum — single source of truth for
 * message_ledger.message_type. Must stay in sync with the DB CHECK constraint
 * `message_ledger_type_check`. Run `scripts/check-message-type-drift.ts` in CI
 * to detect drift.
 */

export const MESSAGE_TYPES = [
	"text",
	"task",
	"notify",
	"ack",
	"error",
	"event",
	"liaison",
	"protocol_ping",
	"protocol_pong",
	"task_request",
	"task_ack",
	"task_status",
	"task_complete",
	"task_error",
	"user_message", // P1105: USER first-class identity
	"throttle_decision", // P1376: soft-throttle decision feed
	"capacity_query", // P1438 C6 AC-17: on-demand capacity probe
	"handoff_request", // P1438 C6 AC-17: targeted/specialized work handoff
	"capability_gap", // P1438 C6 AC-17: no agency can serve a capability
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export function isMessageType(value: unknown): value is MessageType {
	return (
		typeof value === "string" &&
		(MESSAGE_TYPES as readonly string[]).includes(value)
	);
}
