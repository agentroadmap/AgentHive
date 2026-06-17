-- P3787: Hardcoded-constant migration — seed first-wave core/infra literals as runtime flags
-- Idempotent: ON CONFLICT DO NOTHING; safe to re-run.

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, description) VALUES
  ('DISPATCH_LOOP_THRESHOLD_PER_HOUR', '6', 'global', 'active',
   'Circuit breaker: max failed runs for (proposal, role) in the last hour before pausing'),

  ('GATE_CONVERGENCE_MAX_BLOCKING', '3', 'global', 'active',
   'Convergence guard: max blocking reviews before pausing proposal since last state/maturity transition'),

  ('GATE_CONVERGENCE_MAX_RUNS_PER_ROLE', '8', 'global', 'active',
   'Convergence guard: max per-role dispatch attempts since last state/maturity transition before pausing'),

  ('FEDERATION_SYNC_POLL_INTERVAL_MS', '30000', 'global', 'active',
   'Federation peer sync poll interval in milliseconds (default 30 s)'),

  ('FEDERATION_HEALTH_QUARANTINE_THRESHOLD', '3', 'global', 'active',
   'Consecutive health-check failures before a federation peer is quarantined'),

  ('FEDERATION_PING_TIMEOUT_MS', '5000', 'global', 'active',
   'Timeout in milliseconds for federation peer ping/health requests'),

  ('SAGA_REPAIR_INTERVAL_MS', '60000', 'global', 'active',
   'Repair worker poll interval in milliseconds (default 60 s)'),

  ('SAGA_REPAIR_MAX_ATTEMPTS', '10', 'global', 'active',
   'Max repair attempts before a saga item is escalated to operator'),

  ('SAGA_REPAIR_MAX_BACKOFF_HOURS', '24', 'global', 'active',
   'Hard ceiling on saga repair exponential backoff in hours (default 24 h)'),

  ('NOTIFICATION_POLL_INTERVAL_MS', '30000', 'global', 'active',
   'Notification router poll interval in milliseconds (backstop for missed pg_notify)'),

  ('NOTIFICATION_BATCH_SIZE', '25', 'global', 'active',
   'Max notifications claimed per drain cycle (LIMIT in notification_queue SELECT)'),

  ('PROVIDER_HEALTH_TTL_MS', '30000', 'global', 'active',
   'Provider health cache TTL in milliseconds (entries older than this are stale)'),

  ('AGENT_PROPOSAL_LEASE_TTL_MS', '1800000', 'global', 'active',
   'AgentProposalSystem in-memory lease TTL in milliseconds (default 30 min)'),

  ('TRANSPORT_WAKE_TIMEOUT_MS', '10000', 'global', 'active',
   'Max wait in milliseconds for a transport adapter to come online before failing wakeUp()')

ON CONFLICT (flag_name) DO NOTHING;
