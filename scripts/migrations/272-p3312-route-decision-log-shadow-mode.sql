-- Migration 269: P3312 — route_decision_log shadow mode columns (AC-8)
--
-- Adds three nullable/defaulted columns so matchWorkToRoute can log its choice
-- alongside the legacy resolveModelRoute choice WITHOUT changing dispatch behavior.
--
-- shadow_mode = true  → ADAPTIVE_MATCHER_ENABLED=false: matcher logged, legacy used.
-- shadow_mode = false → ADAPTIVE_MATCHER_ENABLED=true:  matcher choice is acted on.
--
-- All columns are nullable or have a DEFAULT, so existing rows and concurrent
-- inserts are unaffected (additive, non-blocking — no NOT NULL without DEFAULT).
--
-- Verified against live schema 2026-06-14 (admin@agenthive):
--   roadmap.route_decision_log(id, proposal_id, role, agency_identity,
--     chosen_route_id, eliminated_routes, decided_at) — the three columns below
--     are confirmed absent (information_schema.columns returned 0 rows).

BEGIN;

ALTER TABLE roadmap.route_decision_log
  ADD COLUMN IF NOT EXISTS matcher_choice JSONB,
  ADD COLUMN IF NOT EXISTS legacy_choice  JSONB,
  ADD COLUMN IF NOT EXISTS shadow_mode    BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN roadmap.route_decision_log.matcher_choice IS
  'P3312: JSONB of the matchWorkToRoute result (ranked candidate list or no_eligible_route). NULL when the matcher did not run.';

COMMENT ON COLUMN roadmap.route_decision_log.legacy_choice IS
  'P3312: JSONB of the legacy resolveModelRoute choice. NULL when not in shadow mode.';

COMMENT ON COLUMN roadmap.route_decision_log.shadow_mode IS
  'P3312: true when ADAPTIVE_MATCHER_ENABLED=false — matcher choice was logged but the legacy choice was acted on.';

-- Index to quickly find shadow-mode rows for operator diff queries.
CREATE INDEX IF NOT EXISTS idx_route_decision_log_shadow
  ON roadmap.route_decision_log (shadow_mode, decided_at DESC)
  WHERE shadow_mode = true;

COMMIT;
