-- Migration 295: P3787 — seed runtime flags for hardcoded-constant first wave
-- Idempotent: ON CONFLICT (flag_name, scope) DO NOTHING
-- Default values match the original hardcoded literals exactly (AC-2 default-parity).

INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description, updated_by)
VALUES
  -- Dispatch circuit-breaker tunables (post-work-offer.ts)
  ('DISPATCH_LOOP_THRESHOLD_PER_HOUR',       'global', '6',       'Circuit-breaker: max (proposal, role) dispatches per hour before pausing',                              'migration-295'),
  ('GATE_CONVERGENCE_MAX_BLOCKING',          'global', '3',       'Convergence guard: max blocking reviews before proposal is paused',                                     'migration-295'),
  ('GATE_CONVERGENCE_MAX_RUNS_PER_ROLE',     'global', '8',       'Convergence guard: max per-role runs since last state/maturity transition before pausing',              'migration-295'),

  -- Federation-sync tunables (infrastructure/federation-sync.ts)
  ('FEDERATION_SYNC_POLL_INTERVAL_MS',       'global', '30000',   'Cross-instance federation sync poll interval (ms)',                                                     'migration-295'),
  ('FEDERATION_HEALTH_QUARANTINE_THRESHOLD', 'global', '3',       'Consecutive health-check failures before quarantining a federation peer',                               'migration-295'),
  ('FEDERATION_PING_TIMEOUT_MS',             'global', '5000',    'Timeout for federation peer health pings (ms)',                                                         'migration-295'),

  -- Saga repair-worker tunables (saga/repair-worker.ts)
  ('SAGA_REPAIR_INTERVAL_MS',                'global', '60000',   'Saga repair-worker polling interval (ms)',                                                              'migration-295'),
  ('SAGA_REPAIR_MAX_ATTEMPTS',               'global', '10',      'Max retry attempts before escalating a failed saga to CRITICAL',                                        'migration-295'),
  ('SAGA_REPAIR_MAX_BACKOFF_HOURS',          'global', '24',      'Hard cap on saga repair exponential backoff (hours)',                                                   'migration-295'),

  -- Notification-router tunables (notifications/router.ts)
  ('NOTIFICATION_ROUTER_POLL_MS',            'global', '30000',   'Notification router backstop poll interval (ms)',                                                       'migration-295'),
  ('NOTIFICATION_ROUTER_BATCH_SIZE',         'global', '25',      'Max notifications per drain batch',                                                                     'migration-295'),
  ('NOTIFICATION_ROUTER_MAX_ATTEMPTS',       'global', '5',       'Max dispatch attempts before a notification is moved to DLQ',                                          'migration-295'),

  -- Messaging gateway tunables (messaging/gateway/registry.ts)
  ('MESSAGING_WAKE_TIMEOUT_MS',              'global', '10000',   'Max wait for a transport adapter to become active (ms)',                                                 'migration-295'),

  -- DEFER entries: seeds only, no consumer swap (sync constructor context)
  ('PROVIDER_HEALTH_CACHE_TTL_MS',           'global', '30000',   'Provider health cache TTL (ms); requires restart to take effect',                                       'migration-295'),
  ('AGENT_PROPOSAL_LEASE_TTL_MS',            'global', '1800000', 'Default agent proposal lease TTL (ms); requires restart to take effect',                                'migration-295')

ON CONFLICT (flag_name, scope) DO NOTHING;
