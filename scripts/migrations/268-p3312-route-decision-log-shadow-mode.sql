-- Migration 268: P3312 — route_decision_log shadow mode columns (AC-8)
--
-- Adds three nullable columns so matchWorkToRoute can log its choice alongside
-- the legacy resolver choice without changing dispatch behavior.
--
-- shadow_mode = false (default) means ADAPTIVE_MATCHER_ENABLED=true — matcher wins.
-- shadow_mode = true means ADAPTIVE_MATCHER_ENABLED=false — matcher logs but does not act.
--
-- All columns are nullable / have defaults so existing rows and concurrent inserts
-- are unaffected (additive, non-blocking).

BEGIN;

ALTER TABLE roadmap.route_decision_log
  ADD COLUMN IF NOT EXISTS matcher_choice JSONB,
  ADD COLUMN IF NOT EXISTS legacy_choice  JSONB,
  ADD COLUMN IF NOT EXISTS shadow_mode    BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN roadmap.route_decision_log.matcher_choice IS
  'P3312: JSONB payload of the matchWorkToRoute ranked candidate list (null when matcher did not run).';

COMMENT ON COLUMN roadmap.route_decision_log.legacy_choice IS
  'P3312: JSONB payload of the legacy resolveModelRoute result (null when shadow mode is off).';

COMMENT ON COLUMN roadmap.route_decision_log.shadow_mode IS
  'P3312: true when ADAPTIVE_MATCHER_ENABLED=false — matcher logged but legacy choice used.';

-- Index to quickly find shadow-mode rows for operator diff queries.
CREATE INDEX IF NOT EXISTS idx_route_decision_log_shadow
  ON roadmap.route_decision_log (shadow_mode, decided_at DESC)
  WHERE shadow_mode = true;

COMMIT;
