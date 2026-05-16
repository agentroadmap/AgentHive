-- P1104 consolidation: agency_heartbeat channel has ONE emitter
--
-- Background:
--   Migration 165 added a pg_notify('agency_heartbeat', ...) emit inside
--   fn_pulse(). But roadmap.agency already had trig_agency_heartbeat_notify
--   (fn_agency_heartbeat_notify) firing the same channel on every
--   last_heartbeat_at change. Every pulse therefore produced TWO
--   notifications with slightly different payload schemas — confusing for
--   consumers and double-noisy.
--
-- Resolution:
--   1. Strip the duplicate pg_notify('agency_heartbeat', ...) out of
--      fn_pulse(). fn_pulse keeps emitting agency_presence_changed on
--      transitions only.
--   2. Extend the existing trigger fn_agency_heartbeat_notify to include
--      presence_state in its payload (additive; old payload keys 'status'
--      and 'heartbeat_at' preserved; new key 'presence_state' added).
--   3. Single canonical emitter for agency_heartbeat is now the trigger,
--      which fires regardless of whether the heartbeat went through
--      fn_pulse or a legacy UPDATE path. Cleaner separation.

-- Part 1: trim fn_pulse back to its non-redundant emits

CREATE OR REPLACE FUNCTION roadmap.fn_pulse(
  p_agency_id text,
  p_state     text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_old text;
  v_new text;
BEGIN
  IF p_state NOT IN ('online', 'busy', 'away', 'offline') THEN
    RAISE EXCEPTION 'Invalid presence state: %', p_state;
  END IF;

  SELECT presence_state INTO v_old
    FROM roadmap.agency
   WHERE agency_id = p_agency_id
     FOR UPDATE;

  -- The UPDATE below triggers fn_agency_heartbeat_notify which fires
  -- the canonical agency_heartbeat pg_notify. fn_pulse does NOT emit
  -- on agency_heartbeat directly.
  UPDATE roadmap.agency
     SET last_heartbeat_at = now(),
         presence_state    = p_state
   WHERE agency_id = p_agency_id
   RETURNING presence_state INTO v_new;

  IF NOT FOUND THEN
    RAISE WARNING 'Agency % not found', p_agency_id;
    RETURN;
  END IF;

  -- Transition event. Fires only when state actually changed.
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
  'P1104: atomic heartbeat + presence_state update. agency_heartbeat fires via roadmap.fn_agency_heartbeat_notify trigger on the UPDATE. agency_presence_changed fires from this function only on actual state transition.';

-- Part 2: extend the trigger payload to include presence_state (additive)

CREATE OR REPLACE FUNCTION roadmap.fn_agency_heartbeat_notify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Only fire when last_heartbeat_at actually changed (skip on no-op UPDATE).
    IF NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at THEN
        PERFORM pg_notify(
            'agency_heartbeat',
            json_build_object(
                'agency_id',       NEW.agency_id,
                'status',          NEW.status,
                'presence_state',  NEW.presence_state,
                'heartbeat_at',    NEW.last_heartbeat_at
            )::text
        );
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_agency_heartbeat_notify() IS
  'P1104: sole emitter for the agency_heartbeat pg_notify channel. Payload includes lifecycle status AND presence_state. Fires on every last_heartbeat_at change regardless of whether the source is fn_pulse or a legacy heartbeat path.';
