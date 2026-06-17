-- P3781 AC-13/AC-2: Remap runtime_flag categories from 8-value to 16-value taxonomy,
-- and seed rows for the 3 new env-override flags added to FlagKeys.
-- Idempotent: ON CONFLICT DO NOTHING for inserts; UPDATE is safe to re-run.

-- Remap 8-value → 16-value categories
UPDATE core.runtime_flag SET category = 'liaison'
WHERE category = 'a2a';

UPDATE core.runtime_flag SET category = 'pause_backoff'
WHERE category = 'pause';

UPDATE core.runtime_flag SET category = 'dispatch'
WHERE category = 'spawn'
   OR flag_name = 'USE_OFFER_DISPATCH';

UPDATE core.runtime_flag SET category = 'adaptive_matcher'
WHERE category = 'matcher';

UPDATE core.runtime_flag SET category = 'ui_ux'
WHERE category = 'tui';

UPDATE core.runtime_flag SET category = 'multi_tenant'
WHERE flag_name = 'ENABLE_MULTI_TENANT';

UPDATE core.runtime_flag SET category = 'audit'
WHERE flag_name = 'ENABLE_AUDIT_LOG';

-- Seed new FlagKeys as global rows (env-override flags; value_jsonb = JSON-encoded default)
INSERT INTO core.runtime_flag (flag_name, scope, value_jsonb, description, category)
VALUES
    ('AGENTHIVE_HOLD_WINDOW_MAX_SEC', 'global', '1800',
     'Maximum hold window in seconds before a rate-limited offer is released back to the pool',
     'dispatch'),
    ('AGENTHIVE_SELF_CLAIM_AGENCIES', 'global', '""',
     'Comma-separated list of agency IDs allowed to self-claim work offers',
     'liaison'),
    ('AGENTHIVE_LIAISON_LLM_TIMEOUT_MS', 'global', '30000',
     'Default LLM call timeout for liaison agents (ms); overridden per-provider by AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_{PROVIDER}',
     'liaison'),
    ('AGENTHIVE_PREMATURE_GATE_GUARD_ENABLED', 'global', 'false',
     'Guard against premature gate requests from proposals with zero passing ACs',
     'gate_governance')
ON CONFLICT (flag_name, scope) DO NOTHING;
