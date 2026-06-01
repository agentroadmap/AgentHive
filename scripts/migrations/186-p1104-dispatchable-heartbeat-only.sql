-- 186-p1104-dispatchable-heartbeat-only.sql
-- Wedge under the P1132 a2a-host cutover story (folds into the P1129/P1437/P1438 line).
--
-- PROBLEM: roadmap.v_agency_status.dispatchable was an OR of three arms:
--     status='active' AND (
--         EXISTS(agenthive-a2a-listen-<id> in pg_stat_activity)   -- listener existence
--         OR presence_state IN ('online','busy')                 -- stored presence (never flips offline)
--         OR last_heartbeat_at fresh < 60s )                     -- heartbeat freshness
--   The first two arms are stale-prone: presence_state has no authoritative writer tied to the
--   LISTEN-session lifecycle (C5/P1437 AC-4 was waived on P1104 substrate; the a2a-host writer
--   lands in P1438/C6), so a long-dead agency (e.g. claudemac: no listener, heartbeat 6.7d stale,
--   presence_state='online') still reported dispatchable=true and kept receiving work.
--
-- FIX (the honest-liveness wedge): dispatch eligibility is HEARTBEAT-DERIVED only.
--   dispatchable := status='active' AND last_heartbeat_at IS NOT NULL AND now()-last_heartbeat_at < 60s
--   The same predicate gates the liveness_state 'live-*' branches.
--   presence_state stays as a column and listener existence is surfaced as a NEW diagnostic column
--   (has_live_listener) — both visible for debugging, but NEITHER is sufficient for dispatchability.
--
-- This decouples presence HONESTY from the full a2a-host cutover (which remains P1438/C6).
-- Reversible: re-apply 173-task39-v-agency-status-pg-stat-activity.sql to restore the OR predicate.

BEGIN;

CREATE OR REPLACE VIEW roadmap.v_agency_status AS
 SELECT a.agency_id,
    a.display_name,
    a.provider,
    a.host_id,
    a.status,
    a.last_heartbeat_at,
    EXTRACT(epoch FROM now() - a.last_heartbeat_at) AS silence_seconds,
    a.presence_state,
    -- DISPATCHABLE: heartbeat-derived only. presence_state / listener existence are NOT sufficient.
    (a.status = 'active'::text
        AND a.last_heartbeat_at IS NOT NULL
        AND (now() - a.last_heartbeat_at) < '00:01:00'::interval) AS dispatchable,
    a.registered_at,
    a.metadata,
        CASE
            WHEN open_poke.id IS NOT NULL THEN 'poke-pending'::text
            WHEN last_poke.outcome = 'timed_out'::text THEN 'stale-unresponsive'::text
            WHEN last_poke.outcome = 'poke_late'::text THEN 'late-pong'::text
            -- 'live-*' branches now require fresh heartbeat (same predicate as dispatchable).
            WHEN a.status = 'active'::text
                AND a.last_heartbeat_at IS NOT NULL
                AND (now() - a.last_heartbeat_at) < '00:01:00'::interval
                AND active_dispatch.agency_id IS NOT NULL THEN 'live-and-working'::text
            WHEN a.status = 'active'::text
                AND a.last_heartbeat_at IS NOT NULL
                AND (now() - a.last_heartbeat_at) < '00:01:00'::interval THEN 'live-but-idle'::text
            ELSE 'offline'::text
        END AS liveness_state,
    -- DIAGNOSTIC ONLY (not a dispatch condition): is there a live PG LISTEN session for this agency?
    -- Appended at end so CREATE OR REPLACE VIEW preserves existing column order.
    EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE pg_stat_activity.application_name = ('agenthive-a2a-listen-'::text || a.agency_id)
    ) AS has_live_listener
   FROM agency a
     LEFT JOIN LATERAL ( SELECT liaison_poke_attempt.id
           FROM liaison_poke_attempt
          WHERE liaison_poke_attempt.agency_id = a.agency_id AND liaison_poke_attempt.outcome IS NULL
         LIMIT 1) open_poke ON true
     LEFT JOIN LATERAL ( SELECT liaison_poke_attempt.outcome
           FROM liaison_poke_attempt
          WHERE liaison_poke_attempt.agency_id = a.agency_id AND liaison_poke_attempt.outcome IS NOT NULL
          ORDER BY liaison_poke_attempt.poked_at DESC
         LIMIT 1) last_poke ON true
     LEFT JOIN LATERAL ( SELECT sd.agent_identity AS agency_id
           FROM squad_dispatch sd
          WHERE sd.agent_identity = a.agency_id AND (sd.dispatch_status = ANY (ARRAY['assigned'::text, 'active'::text])) AND sd.completed_at IS NULL
         LIMIT 1) active_dispatch ON true
  WHERE a.status <> 'retired'::text;

COMMIT;
