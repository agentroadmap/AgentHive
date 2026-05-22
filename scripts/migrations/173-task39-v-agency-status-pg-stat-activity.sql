-- Task #39 Phase A: v_agency_status learns the pg_stat_activity liveness signal.
--
-- Before: dispatchable = status='active' AND
--   (presence_state IN ('online','busy') OR last_heartbeat_at < 60 s).
-- After:  add pg_stat_activity LISTEN-session check as a third signal — A2A
--   host opens `agenthive-a2a-listen-<agency_id>` per attached agency; the row
--   disappears within seconds when the connection drops, giving sub-second
--   crash detection vs the 60-90 s heartbeat staleness window.
--
-- Same OR semantics (any signal alive → dispatchable). Phase B retires the
-- heartbeat-staleness half of the OR once the A2A presence-refresh shim is
-- removed (task #39 Phase B).

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
    -- dispatchable: ANY live signal counts.
    --   pg_stat_activity LISTEN — canonical crash detection (sub-second).
    --   presence_state — set on lifecycle events; stale on crash, fine otherwise.
    --   last_heartbeat_at < 60 s — transitional fallback (shim-dependent).
    a.status = 'active'::text AND (
      EXISTS (
        SELECT 1 FROM pg_stat_activity
         WHERE application_name = 'agenthive-a2a-listen-' || a.agency_id
      )
      OR a.presence_state = ANY (ARRAY['online'::text, 'busy'::text])
      OR (a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval)
    ) AS dispatchable,
    a.registered_at,
    a.metadata,
        CASE
            WHEN open_poke.id IS NOT NULL THEN 'poke-pending'::text
            WHEN last_poke.outcome = 'timed_out'::text THEN 'stale-unresponsive'::text
            WHEN last_poke.outcome = 'poke_late'::text THEN 'late-pong'::text
            -- Same predicate as dispatchable, mirrored in liveness_state
            WHEN a.status = 'active'::text AND (
              EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'agenthive-a2a-listen-' || a.agency_id)
              OR a.presence_state = ANY (ARRAY['online'::text, 'busy'::text])
              OR (a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval)
            ) AND active_dispatch.agency_id IS NOT NULL THEN 'live-and-working'::text
            WHEN a.status = 'active'::text AND (
              EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'agenthive-a2a-listen-' || a.agency_id)
              OR a.presence_state = ANY (ARRAY['online'::text, 'busy'::text])
              OR (a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval)
            ) THEN 'live-but-idle'::text
            ELSE 'offline'::text
        END AS liveness_state
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
           FROM roadmap_workforce.squad_dispatch sd
          WHERE sd.agent_identity = a.agency_id AND (sd.dispatch_status = ANY (ARRAY['assigned'::text, 'active'::text])) AND sd.completed_at IS NULL
         LIMIT 1) active_dispatch ON true
  WHERE a.status <> 'retired'::text;

COMMENT ON VIEW roadmap.v_agency_status IS
  'Per-agency liveness projection. dispatchable accepts pg_stat_activity LISTEN (canonical), presence_state, or last_heartbeat_at freshness. Heartbeat half retires when A2A presence-refresh shim does (task #39 Phase B).';

COMMIT;
