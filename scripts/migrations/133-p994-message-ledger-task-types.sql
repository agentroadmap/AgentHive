-- P994: Extend message_ledger_type_check to include typed A2A task protocol message types
ALTER TABLE roadmap.message_ledger
  DROP CONSTRAINT message_ledger_type_check;

ALTER TABLE roadmap.message_ledger
  ADD CONSTRAINT message_ledger_type_check CHECK (
    message_type = ANY (ARRAY[
      'text', 'task', 'notify', 'ack', 'error', 'event',
      'liaison', 'protocol_ping', 'protocol_pong',
      'task_request', 'task_ack', 'task_status', 'task_complete', 'task_error'
    ])
  );
