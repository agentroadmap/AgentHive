-- 195-p2404-coldwake-poke-liveness-guard.sql
-- P2404: Reconcile liveness poke with cold-wake liaisons.
--
-- Problem: roadmap.v_agency_status.liveness_state evaluated
--   last_poke.outcome='timed_out' -> 'stale-unresponsive'
-- BEFORE the heartbeat-freshness branch. Cold-wake liaisons (parked sessions
-- woken only by <channel> events, P1437/V3-C6) cannot answer a synchronous
-- out-of-band liaison_poke_attempt ping, so every poke times out -- even while
-- their heartbeat is sub-second fresh and dispatchable=t. A stale timed-out
-- poke therefore overrode a fresh heartbeat, rendering healthy, actively
-- dispatching agencies as "0 live agencies" in the dashboard.
--
-- Fix: gate the 'stale-unresponsive' and 'late-pong' branches on the poke being
-- NEWER than the last heartbeat. A heartbeat that postdates a failed poke is
-- positive proof of life and must win. The last_poke lateral now also selects
-- poked_at for the comparison. dispatchable is unchanged (already heartbeat-only,
-- per 186-p1104). Display/diagnostic only -- no routing impact.
--
-- Idempotent (CREATE OR REPLACE VIEW). Related: P915 (same view, dispatchable
-- threshold), 186-p1104-dispatchable-heartbeat-only.sql, P1437 (cold-wake floor).

SET search_path = roadmap, roadmap_workforce, public;

CREATE OR REPLACE VIEW roadmap.v_agency_status AS
 SELECT a.agency_id,
    a.display_name,
    a.provider,
    a.host_id,
    a.status,
    a.last_heartbeat_at,
    EXTRACT(epoch FROM now() - a.last_heartbeat_at) AS silence_seconds,
    a.presence_state,
    a.status = 'active'::text AND a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval AS dispatchable,
    a.registered_at,
    a.metadata,
        CASE
            WHEN open_poke.id IS NOT NULL THEN 'poke-pending'::text
            WHEN last_poke.outcome = 'timed_out'::text AND (a.last_heartbeat_at IS NULL OR last_poke.poked_at > a.last_heartbeat_at) THEN 'stale-unresponsive'::text
            WHEN last_poke.outcome = 'poke_late'::text AND (a.last_heartbeat_at IS NULL OR last_poke.poked_at > a.last_heartbeat_at) THEN 'late-pong'::text
            WHEN a.status = 'active'::text AND a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval AND active_dispatch.agency_id IS NOT NULL THEN 'live-and-working'::text
            WHEN a.status = 'active'::text AND a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval THEN 'live-but-idle'::text
            ELSE 'offline'::text
        END AS liveness_state,
    (EXISTS ( SELECT 1
           FROM pg_stat_activity
          WHERE pg_stat_activity.application_name = ('agenthive-a2a-listen-'::text || a.agency_id))) AS has_live_listener
   FROM agency a
     LEFT JOIN LATERAL ( SELECT liaison_poke_attempt.id
           FROM liaison_poke_attempt
          WHERE liaison_poke_attempt.agency_id = a.agency_id AND liaison_poke_attempt.outcome IS NULL
         LIMIT 1) open_poke ON true
     LEFT JOIN LATERAL ( SELECT liaison_poke_attempt.outcome,
            liaison_poke_attempt.poked_at
           FROM liaison_poke_attempt
          WHERE liaison_poke_attempt.agency_id = a.agency_id AND liaison_poke_attempt.outcome IS NOT NULL
          ORDER BY liaison_poke_attempt.poked_at DESC
         LIMIT 1) last_poke ON true
     LEFT JOIN LATERAL ( SELECT sd.agent_identity AS agency_id
           FROM squad_dispatch sd
          WHERE sd.agent_identity = a.agency_id AND (sd.dispatch_status = ANY (ARRAY['assigned'::text, 'active'::text])) AND sd.completed_at IS NULL
         LIMIT 1) active_dispatch ON true
  WHERE a.status <> 'retired'::text;
