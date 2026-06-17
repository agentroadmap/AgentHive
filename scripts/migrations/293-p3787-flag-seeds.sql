-- P3787: First-wave hardcoded-constant flag seeds
-- Idempotent: DO NOTHING on conflict so re-runs are safe.

INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description, modified_by_did, owner_did)
VALUES
  ('DISPATCH_LOOP_THRESHOLD_PER_HOUR', 'global', '6',
   'Max unknown-failure squad_dispatch rows per (proposal, role) per hour before circuit-breaker pauses the proposal (P689).', 'system', 'system'),

  ('GATE_CONVERGENCE_MAX_BLOCKING', 'global', '3',
   'Max accumulated blocking reviews since last state transition before convergence guard pauses the proposal.', 'system', 'system'),

  ('GATE_CONVERGENCE_MAX_RUNS_PER_ROLE', 'global', '8',
   'Max per-role run attempts since last state transition before convergence guard pauses the proposal.', 'system', 'system'),

  ('FEDERATION_SYNC_POLL_MS', 'global', '30000',
   'Polling interval (ms) for federation peer sync cycles (AC-13 of P068).', 'system', 'system'),

  ('FEDERATION_QUARANTINE_THRESHOLD', 'global', '3',
   'Consecutive health-check failures before a federation peer is quarantined (AC-9 of P068).', 'system', 'system'),

  ('FEDERATION_PING_TIMEOUT_MS', 'global', '5000',
   'Timeout (ms) for federation peer ping requests (AC-12 of P068).', 'system', 'system'),

  ('SAGA_REPAIR_INTERVAL_MS', 'global', '60000',
   'Interval (ms) between saga repair-worker cycles (P495).', 'system', 'system'),

  ('SAGA_REPAIR_MAX_ATTEMPTS', 'global', '10',
   'Maximum repair attempts before a saga queue item is escalated to operator (P495).', 'system', 'system'),

  ('SAGA_REPAIR_MAX_BACKOFF_HOURS', 'global', '24',
   'Maximum exponential backoff duration (hours) for saga repair retries (P495).', 'system', 'system'),

  ('NOTIFICATION_POLL_MS', 'global', '30000',
   'Backstop polling interval (ms) for the notification router drain loop (P674).', 'system', 'system'),

  ('NOTIFICATION_BATCH_SIZE', 'global', '25',
   'Number of pending notification_queue rows claimed per drain cycle (P674).', 'system', 'system'),

  ('PROVIDER_HEALTH_TTL_MS', 'global', '30000',
   'TTL (ms) for provider health cache entries before they are considered stale.', 'system', 'system'),

  ('COLLABORATION_LEASE_TTL_MS', 'global', '1800000',
   'Default lease TTL (ms) for agent proposal leases (30 minutes).', 'system', 'system'),

  ('GATEWAY_WAKE_TIMEOUT_MS', 'global', '10000',
   'Timeout (ms) for transport gateway wake-up polling (P304).', 'system', 'system')

ON CONFLICT (flag_name, scope) DO NOTHING;
