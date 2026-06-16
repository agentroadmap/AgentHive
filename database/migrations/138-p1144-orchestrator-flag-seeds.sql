-- P1144: Seed orchestrator runtime flags into core.runtime_flag.
-- All values default to the same hardcoded literals they replaced;
-- operators can UPDATE rows to tune without code edits or service restarts.

BEGIN;

INSERT INTO core.runtime_flag
    (flag_name, value_jsonb, scope, lifecycle_status, description)
VALUES
    ('ORCHESTRATOR_SCAN_BATCH_LIMIT',     '20',     'global', 'active', 'scanQueues batch size per tick'),
    ('ORCHESTRATOR_STALL_THRESHOLD_HOURS','4',      'global', 'active', 'Hours before mature proposal escalated'),
    ('ORCHESTRATOR_STALL_BATCH_LIMIT',    '5',      'global', 'active', 'Max stalls processed per tick'),
    ('ORCHESTRATOR_OFFER_REAP_MS',        '60000',  'global', 'active', 'Offer reap interval (ms)'),
    ('ORCHESTRATOR_POKE_IDLE_MIN',        '5',      'global', 'active', 'Minutes idle before poke'),
    ('ORCHESTRATOR_POKE_STORM_CAP',       '10',     'global', 'active', 'Max pokes per cycle'),
    ('ORCHESTRATOR_SHUTDOWN_DRAIN_MS',    '240000', 'global', 'active', 'Bounded wait for drain on SIGTERM (ms)'),
    ('ORCHESTRATOR_IMPLICIT_GATE_POLL_MS','30000',  'global', 'active', 'Implicit gate poll interval (ms)'),
    ('ORCHESTRATOR_ENHANCER_REVISE_MS',   '90000',  'global', 'active', 'Enhancer-revise loop interval (ms)'),
    ('ORCHESTRATOR_RECONCILER_MS',        '30000',  'global', 'active', 'Reconciler loop interval (ms)'),
    ('ORCHESTRATOR_STALE_ROW_REAPER_MS',  '300000', 'global', 'active', 'Stale-row reaper interval (ms)'),
    ('ORCHESTRATOR_STUCK_WORKER_MS',      '60000',  'global', 'active', 'Stuck-worker watchdog interval (ms)'),
    ('ORCHESTRATOR_HEARTBEAT_MS',         '60000',  'global', 'active', 'Orchestrator heartbeat interval (ms)'),
    ('ORCHESTRATOR_OFFER_CLAIM_ENABLED',  'true',   'global', 'active', 'Kill switch: false disables offer-claim loop')
ON CONFLICT (flag_name, scope) DO NOTHING;

COMMIT;
