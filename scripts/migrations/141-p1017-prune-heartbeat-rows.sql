-- P1017 AC-2: Prune historical heartbeat mirror rows from message_ledger.
-- Heartbeats are now handled exclusively via fn_pulse / agency.last_heartbeat_at.
-- These rows are forensic noise — safe to delete; presence state is tracked in agency table.
-- Verification: SELECT count(*) FROM roadmap.message_ledger WHERE message_type='event' AND message_content='heartbeat' → 0

DELETE FROM roadmap.message_ledger
WHERE message_type = 'event'
  AND message_content = 'heartbeat';
