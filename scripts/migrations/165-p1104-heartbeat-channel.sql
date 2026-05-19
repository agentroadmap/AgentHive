-- P1104 follow-up: dedicated agency_heartbeat channel for per-tick liveness
--
-- Background:
--   Migration 160 made fn_pulse emit pg_notify('agency_presence_changed')
--   ONLY on state transition. State changes are rare (~minutes apart);
--   heartbeats fire every 30s. Consumers that want event-driven liveness
--   (TUI, state-feed, dashboard) had no signal short of polling
--   agency.last_heartbeat_at.
--
--   Per architectural separation: heartbeats are presence signals, distinct
--   from state-transition events. They get their own channel.
--
-- Two notify channels after this migration:
--   agency_heartbeat         — every pulse (high-frequency; payload includes current state)
--   agency_presence_changed  — state transitions only (low-frequency; payload includes from/to)
--
-- Both remain completely separate from the message bus (message_ledger,
-- a2a_msg_*, msg_chan_*). Heartbeats have never been messages.

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

  -- Capture previous state before update so transition notify can fire correctly.
  SELECT presence_state INTO v_old
    FROM roadmap.agency
   WHERE agency_id = p_agency_id
     FOR UPDATE;

  -- Atomic update of heartbeat timestamp + presence state.
  UPDATE roadmap.agency
     SET last_heartbeat_at = now(),
         presence_state    = p_state
   WHERE agency_id = p_agency_id
   RETURNING presence_state INTO v_new;

  IF NOT FOUND THEN
    RAISE WARNING 'Agency % not found', p_agency_id;
    RETURN;
  END IF;

  -- Per-tick liveness signal. Fires on every pulse.
  PERFORM pg_notify(
    'agency_heartbeat',
    json_build_object(
      'agency_id', p_agency_id,
      'state',     v_new,
      'at',        now()::text
    )::text
  );

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
  'P1104: atomic heartbeat + presence_state update. Emits agency_heartbeat on every call (per-tick liveness) and agency_presence_changed only on state transition.';
