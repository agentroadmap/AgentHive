-- P1132 / P1133 step 1: transitional update to roadmap.v_agency_status.
--
-- Before: `dispatchable` was true when last_heartbeat_at < 60 s (timer-driven).
-- After:  `dispatchable` is true when presence_state IN ('online','busy') OR
--         last_heartbeat_at < 60 s — accepting BOTH signals during consumer
--         migration so neither side breaks.
--
-- The downstream consumer migration (alias-manager, liaison-service, poke
-- watchdog, etc.) can land incrementally. Once all are reading presence_state
-- directly, the A2A host presence-refresh shim retires and this view drops
-- the last_heartbeat_at half of the OR.
--
-- P1133 commitment: zero hardcoded constants in code. The 60 s freshness
-- window is still hardcoded INSIDE this view body because it's a SQL DDL
-- constant, not a runtime value. Moving it to core.runtime_flag would
-- require a fn_dispatchability() function. Out of scope for this transitional
-- migration; flagged for follow-on retirement when the heartbeat OR-half drops.

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
    -- dispatchable: ANY of the live signals.
    -- presence_state IN ('online','busy') is the canonical signal (A2A maintains it).
    -- last_heartbeat_at < 60 s is the transitional fallback (kept until A2A
    -- presence-refresh shim retires; see P1133 step 4).
    -- status='active' still required either way (operator-set lifecycle).
    a.status = 'active'::text AND (
      a.presence_state = ANY (ARRAY['online'::text, 'busy'::text])
      OR (a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval)
    ) AS dispatchable,
    a.registered_at,
    a.metadata,
        CASE
            WHEN open_poke.id IS NOT NULL THEN 'poke-pending'::text
            WHEN last_poke.outcome = 'timed_out'::text THEN 'stale-unresponsive'::text
            WHEN last_poke.outcome = 'poke_late'::text THEN 'late-pong'::text
            -- 'live-and-working' / 'live-but-idle' now use the same dispatchable predicate
            WHEN a.status = 'active'::text AND (
              a.presence_state = ANY (ARRAY['online'::text, 'busy'::text])
              OR (a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < '00:01:00'::interval)
            ) AND active_dispatch.agency_id IS NOT NULL THEN 'live-and-working'::text
            WHEN a.status = 'active'::text AND (
              a.presence_state = ANY (ARRAY['online'::text, 'busy'::text])
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
  'Per-agency liveness projection. dispatchable accepts presence_state (canonical) OR last_heartbeat_at freshness (transitional). The heartbeat half drops when A2A presence-refresh shim retires (P1132 step 4).';

COMMIT;
