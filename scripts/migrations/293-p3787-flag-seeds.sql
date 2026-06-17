-- P3787: First-wave hardcoded-constant flag seeds
-- Idempotent: DO NOTHING on conflict so re-runs are safe.

INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description)
VALUES
  ('DISPATCH_LOOP_THRESHOLD_PER_HOUR', 'global', '6',
   'Max unknown-failure squad_dispatch rows per (proposal, role) per hour before circuit-breaker pauses the proposal (P689).'),

  ('GATE_CONVERGENCE_MAX_BLOCKING', 'global', '3',
   'Max accumulated blocking reviews since last state transition before convergence guard pauses the proposal.'),

  ('GATE_CONVERGENCE_MAX_RUNS_PER_ROLE', 'global', '8',
   'Max per-role run attempts since last state transition before convergence guard pauses the proposal.'),

  ('FEDERATION_SYNC_POLL_MS', 'global', '30000',
   'Polling interval (ms) for federation peer sync cycles (AC-13 of P068).'),

  ('FEDERATION_QUARANTINE_THRESHOLD', 'global', '3',
   'Consecutive health-check failures before a federation peer is quarantined (AC-9 of P068).'),

  ('FEDERATION_PING_TIMEOUT_MS', 'global', '5000',
   'Timeout (ms) for federation peer ping requests (AC-12 of P068).'),

  ('SAGA_REPAIR_INTERVAL_MS', 'global', '60000',
   'Interval (ms) between saga repair-worker cycles (P495).'),

  ('SAGA_REPAIR_MAX_ATTEMPTS', 'global', '10',
   'Maximum repair attempts before a saga queue item is escalated to operator (P495).'),

  ('SAGA_REPAIR_MAX_BACKOFF_HOURS', 'global', '24',
   'Maximum exponential backoff duration (hours) for saga repair retries (P495).'),

  ('NOTIFICATION_POLL_MS', 'global', '30000',
   'Backstop polling interval (ms) for the notification router drain loop (P674).'),

  ('NOTIFICATION_BATCH_SIZE', 'global', '25',
   'Number of pending notification_queue rows claimed per drain cycle (P674).'),

  ('PROVIDER_HEALTH_TTL_MS', 'global', '30000',
   'TTL (ms) for provider health cache entries before they are considered stale.'),

  ('COLLABORATION_LEASE_TTL_MS', 'global', '1800000',
   'Default lease TTL (ms) for agent proposal leases (30 minutes).'),

  ('GATEWAY_WAKE_TIMEOUT_MS', 'global', '10000',
   'Timeout (ms) for transport gateway wake-up polling (P304).')

ON CONFLICT (flag_name) DO NOTHING;
