-- P1104: Presence state machine function and view update
-- AC-7: fn_pulse() atomically updates last_heartbeat_at + presence_state
-- AC-8: pg_notify fires on state change within 1s
-- AC-9: v_agency_status dispatchable threshold 10min → 60s

-- Part (a): fn_pulse function
CREATE OR REPLACE FUNCTION roadmap.fn_pulse(
  p_agency_id text,
  p_state text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_old text;
  v_new text;
BEGIN
  -- Validate state input
  IF p_state NOT IN ('online', 'busy', 'away', 'offline') THEN
    RAISE EXCEPTION 'Invalid presence state: %', p_state;
  END IF;

  -- Capture previous state before update so notify fires only on transition (AC-8)
  SELECT presence_state INTO v_old FROM roadmap.agency
   WHERE agency_id = p_agency_id FOR UPDATE;

  -- Atomic update of heartbeat + presence (presence_state is TEXT with CHECK from migration 159)
  UPDATE roadmap.agency
     SET last_heartbeat_at = now(),
         presence_state    = p_state
   WHERE agency_id = p_agency_id
   RETURNING presence_state INTO v_new;

  IF NOT FOUND THEN
    RAISE WARNING 'Agency % not found', p_agency_id;
    RETURN;
  END IF;

  -- Emit notification ONLY on state change (AC-8 requires within 1s of change)
  IF v_old IS DISTINCT FROM v_new THEN
    PERFORM pg_notify(
      'agency_presence_changed',
      json_build_object(
        'agency_id', p_agency_id,
        'from',      v_old,
        'to',        v_new,
        'at',        now()::text
      )::text
    );
  END IF;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_pulse(text, text) IS
  'Atomically pulse agency heartbeat and update presence state. Emits pg_notify on each call.';

-- Part (b): recreate v_agency_status with 60s dispatchable threshold.
-- (No presence_state_enum needed; migration 159 made presence_state TEXT with CHECK.)
--
-- Drop and recreate v_agency_status with 60s dispatchable threshold
DROP VIEW IF EXISTS roadmap.v_agency_status CASCADE;

CREATE VIEW roadmap.v_agency_status AS
SELECT
  a.agency_id,
  a.display_name,
  a.provider,
  a.host_id,
  a.status,
  a.last_heartbeat_at,
  EXTRACT(epoch FROM (now() - a.last_heartbeat_at)) AS silence_seconds,
  a.presence_state,
  ((a.status = 'active'::text) AND (a.last_heartbeat_at IS NOT NULL) AND ((now() - a.last_heartbeat_at) < '00:01:00'::interval)) AS dispatchable,
  a.registered_at,
  a.metadata,
  CASE
    WHEN (open_poke.id IS NOT NULL) THEN 'poke-pending'::text
    WHEN (last_poke.outcome = 'timed_out'::text) THEN 'stale-unresponsive'::text
    WHEN (last_poke.outcome = 'poke_late'::text) THEN 'late-pong'::text
    WHEN ((a.status = 'active'::text) AND (a.last_heartbeat_at IS NOT NULL) AND ((now() - a.last_heartbeat_at) < '00:01:00'::interval) AND (active_dispatch.agency_id IS NOT NULL)) THEN 'live-and-working'::text
    WHEN ((a.status = 'active'::text) AND (a.last_heartbeat_at IS NOT NULL) AND ((now() - a.last_heartbeat_at) < '00:01:00'::interval)) THEN 'live-but-idle'::text
    ELSE 'offline'::text
  END AS liveness_state
FROM (((roadmap.agency a
  LEFT JOIN LATERAL (
    SELECT liaison_poke_attempt.id
    FROM liaison_poke_attempt
    WHERE ((liaison_poke_attempt.agency_id = a.agency_id) AND (liaison_poke_attempt.outcome IS NULL))
    LIMIT 1
  ) open_poke ON (true))
  LEFT JOIN LATERAL (
    SELECT liaison_poke_attempt.outcome
    FROM liaison_poke_attempt
    WHERE ((liaison_poke_attempt.agency_id = a.agency_id) AND (liaison_poke_attempt.outcome IS NOT NULL))
    ORDER BY liaison_poke_attempt.poked_at DESC
    LIMIT 1
  ) last_poke ON (true))
  LEFT JOIN LATERAL (
    SELECT sd.agent_identity AS agency_id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE ((sd.agent_identity = a.agency_id) AND (sd.dispatch_status = ANY (ARRAY['assigned'::text, 'active'::text])) AND (sd.completed_at IS NULL))
    LIMIT 1
  ) active_dispatch ON (true))
WHERE (a.status <> 'retired'::text);

COMMENT ON VIEW roadmap.v_agency_status IS
  'Agency status snapshot: dispatchable iff active heartbeat within 60s. Includes presence_state for state machine queries.';
