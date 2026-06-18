-- P3782: Add category column to core.runtime_flag
-- Additive, idempotent. No data loss. Backfill by flag_name prefix.
-- ON CONFLICT uses correct composite PK (flag_name, scope).

ALTER TABLE core.runtime_flag
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general';

-- Backfill known flag groups by name prefix
UPDATE core.runtime_flag SET category = 'orchestrator'
WHERE flag_name LIKE 'ORCHESTRATOR_%'
   OR flag_name = 'PROPOSAL_STATE_MONITOR_GRACE_PERIOD_SEC';

UPDATE core.runtime_flag SET category = 'a2a'
WHERE flag_name LIKE 'A2A_%'
   OR flag_name LIKE 'LIAISON_%'
   OR flag_name = 'AGENCY_OFFER_CLAIM_ENABLED';

UPDATE core.runtime_flag SET category = 'pause'
WHERE flag_name LIKE 'PAUSE_%';

UPDATE core.runtime_flag SET category = 'spawn'
WHERE flag_name LIKE 'SPAWN_%';

UPDATE core.runtime_flag SET category = 'matcher'
WHERE flag_name = 'ADAPTIVE_MATCHER_ENABLED';

UPDATE core.runtime_flag SET category = 'tui'
WHERE flag_name = 'AGENTHIVE_COCKPIT_LAYOUT';

UPDATE core.runtime_flag SET category = 'feature'
WHERE flag_name IN (
    'USE_OFFER_DISPATCH',
    'ENABLE_MULTI_TENANT',
    'ENABLE_AUDIT_LOG'
);
