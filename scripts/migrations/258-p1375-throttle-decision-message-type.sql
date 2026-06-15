-- P1375 (P1365-C): allow throttle-decision audit rows in message_ledger.
-- logThrottleDecision (capacity-filter.ts) INSERTs message_type='throttle_decision';
-- the check constraint predates it, so every audit write failed silently since
-- the P1365 merge. Adds the value; no data change.

ALTER TABLE roadmap.message_ledger
  DROP CONSTRAINT message_ledger_type_check;

ALTER TABLE roadmap.message_ledger
  ADD CONSTRAINT message_ledger_type_check CHECK (message_type = ANY (ARRAY[
    'text'::text, 'task'::text, 'notify'::text, 'ack'::text, 'error'::text,
    'event'::text, 'liaison'::text, 'protocol_ping'::text, 'protocol_pong'::text,
    'task_request'::text, 'task_ack'::text, 'task_error'::text, 'task_status'::text,
    'user_message'::text, 'throttle_decision'::text
  ]));

-- trig_room_acl requires room_membership for system:* channels; without this
-- grant the audit INSERT raises ROOM_ACL_DENIED (third stacked blocker —
-- after the type-check value and the from_agent FK identity).
INSERT INTO roadmap.room_membership (channel, agent_identity, granted_by)
SELECT 'system:capacity-throttle', 'orchestrator', 'migration-258'
WHERE NOT EXISTS (
  SELECT 1 FROM roadmap.room_membership
  WHERE channel = 'system:capacity-throttle'
    AND agent_identity = 'orchestrator' AND revoked_at IS NULL
);
