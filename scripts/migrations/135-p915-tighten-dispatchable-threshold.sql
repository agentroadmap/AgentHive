-- P915: Add composite index for v_agency_status dispatchable query path
--
-- Context: the view threshold change (10 min → 60 s) was originally scoped here,
-- but migrations 171 (p1132-v-agency-status-presence-state) and 173
-- (task39-v-agency-status-pg-stat-activity) superseded the view definition and
-- already emit the 60-second window.  Applying a CREATE OR REPLACE VIEW here
-- would strip the presence_state column and pg_stat_activity subquery added by
-- those later migrations.  This migration therefore only adds the missing index.
--
-- DO NOT CHANGE: fn_check_agency_dormancy (15 min sweep) or checkAndMarkDormant
-- TS function (90s dormancy gate) — both are out of scope for this proposal.

BEGIN;

-- Composite index for efficient dispatchable query:
--   WHERE status = 'active' AND last_heartbeat_at > now() - 60s
CREATE INDEX IF NOT EXISTS idx_agency_status_heartbeat
    ON roadmap.agency(status, last_heartbeat_at DESC NULLS LAST);

COMMIT;
