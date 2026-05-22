-- P1144 AC-1: Seed 14 orchestrator tunables into core.runtime_flag so operators
-- can adjust every poll interval and threshold via SQL without code edits or restarts.
--
-- Foundation:
--   Migration 170: core.runtime_flag table + NOTIFY trigger
--   Migration 174 (task #40): flag_name column + scope + lifecycle_status + partial index
--
-- All rows use scope='global' and lifecycle_status='active'.  The resolver's
-- priority chain (project → host → agency → global) means a scoped override
-- row can shadow any of these globals per-project or per-agency without
-- touching this seed.
--
-- value_jsonb stores JSONB literals: numeric flags are JSON numbers ('20'),
-- boolean flags are JSON booleans ('true').
--
-- After this migration, loadOrchestratorFlags() in orchestrator.ts calls
-- config.get(FlagKeys.ORCHESTRATOR_*) for each key; the resolver queries
-- WHERE flag_name=$1 AND scope=$2 AND lifecycle_status='active'.

INSERT INTO core.runtime_flag (flag_name, value_jsonb, scope, lifecycle_status, description) VALUES
  ('ORCHESTRATOR_SCAN_BATCH_LIMIT',      '20',       'global', 'active', 'scanQueues batch size per tick'),
  ('ORCHESTRATOR_STALL_THRESHOLD_HOURS', '4',        'global', 'active', 'Hours before a mature proposal is escalated as stalled'),
  ('ORCHESTRATOR_STALL_BATCH_LIMIT',     '5',        'global', 'active', 'Max stalls processed per tick'),
  ('ORCHESTRATOR_OFFER_REAP_MS',         '60000',    'global', 'active', 'Offer reap interval (ms)'),
  ('ORCHESTRATOR_POKE_IDLE_MIN',         '5',        'global', 'active', 'Minutes of agency silence before a poke is emitted'),
  ('ORCHESTRATOR_POKE_STORM_CAP',        '10',       'global', 'active', 'Max pokes emitted per watchdog tick'),
  ('ORCHESTRATOR_SHUTDOWN_DRAIN_MS',     '240000',   'global', 'active', 'Bounded wait for in-flight dispatches on SIGTERM (ms)'),
  ('ORCHESTRATOR_IMPLICIT_GATE_POLL_MS', '30000',    'global', 'active', 'Implicit gate poll interval (ms); set 0 to disable'),
  ('ORCHESTRATOR_ENHANCER_REVISE_MS',    '90000',    'global', 'active', 'Enhancer-revise autonomous loop interval (ms); set 0 to disable'),
  ('ORCHESTRATOR_RECONCILER_MS',         '30000',    'global', 'active', 'Stranded-advance reconciler interval (ms); set 0 to disable'),
  ('ORCHESTRATOR_STALE_ROW_REAPER_MS',   '300000',   'global', 'active', 'Stale-row reaper interval (ms); set 0 to disable'),
  ('ORCHESTRATOR_STUCK_WORKER_MS',       '60000',    'global', 'active', 'Stuck-worker watchdog interval (ms); set 0 to disable'),
  ('ORCHESTRATOR_HEARTBEAT_MS',          '60000',    'global', 'active', 'Observability heartbeat interval (ms); set 0 to disable'),
  ('ORCHESTRATOR_OFFER_CLAIM_ENABLED',   'true',     'global', 'active', 'Kill switch: false disables the offer-claim loop')
ON CONFLICT (flag_name, scope) DO NOTHING;
