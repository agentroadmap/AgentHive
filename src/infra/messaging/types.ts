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
	"user_message",
	"throttle_decision",
	"capacity_query",
	"handoff_request",
	"capability_gap",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

export function isMessageType(value: unknown): value is MessageType {
	return (
		typeof value === "string" &&
		(MESSAGE_TYPES as readonly string[]).includes(value)
	);
}
