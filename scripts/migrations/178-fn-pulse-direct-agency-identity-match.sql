-- 178-fn-pulse-direct-agency-identity-match.sql
--
-- P1339 D2 remediation. Two changes vs migration 177:
--
-- 1. Drop the JOIN through roadmap_workforce.agent_registry.
--    roadmap_workforce.provider_registry already has agency_identity TEXT
--    (1:1 with agent_registry.agent_identity via the FK agency_id BIGINT).
--    Direct `WHERE pr.agency_identity = p_agency_id` is correct and faster.
--    The JOIN in migration 177 was defensive but redundant given the FK.
--
-- 2. Add explicit comments on status='throttled' behavior.
--    Throttle is operator-set governance state (rate limit / budget pause).
--    A fresh heartbeat is NOT sufficient to clear it. fn_pulse leaves
--    throttled rows untouched on 'online'/'busy' pulses; operators must
--    resume via the resume action.
--
-- The behavior is otherwise identical to migration 177. CREATE OR REPLACE
-- so the function body is swapped atomically without taking the function
-- out of service.

CREATE OR REPLACE FUNCTION roadmap.fn_pulse(p_agency_id text, p_state text)
  RETURNS void
  LANGUAGE plpgsql
AS $function$
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
  -- the canonical agency_heartbeat pg_notify.
  UPDATE roadmap.agency
     SET last_heartbeat_at = now(),
         presence_state    = p_state
   WHERE agency_id = p_agency_id
   RETURNING presence_state INTO v_new;

  IF NOT FOUND THEN
    RAISE WARNING 'Agency % not found', p_agency_id;
    RETURN;
  END IF;

  -- P1339 D2 remediation: bridge to provider_registry via direct match
  -- on agency_identity. No JOIN through agent_registry needed.
  --
  -- Status transitions on 'online'/'busy':
  --   offline   -> active   (recovery, counters reset)
  --   dormant   -> active   (recovery, counters reset)
  --   throttled -> throttled  (UNCHANGED — operator-set governance)
  --   retired   -> retired    (UNCHANGED — terminal)
  --   active    -> active     (refresh last_seen_at only; counters preserved)
  IF p_state IN ('online', 'busy') THEN
    UPDATE roadmap_workforce.provider_registry pr
       SET last_seen_at         = now(),
           status               = CASE
                                    WHEN pr.status IN ('offline','dormant') THEN 'active'
                                    ELSE pr.status
                                  END,
           status_reason        = CASE
                                    WHEN pr.status IN ('offline','dormant') THEN 'a2a-host fn_pulse recovery'
                                    ELSE pr.status_reason
                                  END,
           alert_sent_at        = CASE
                                    WHEN pr.status IN ('offline','dormant') THEN NULL
                                    ELSE pr.alert_sent_at
                                  END,
           throttle_count       = CASE
                                    WHEN pr.status IN ('offline','dormant') THEN 0
                                    ELSE pr.throttle_count
                                  END,
           recent_failure_count = CASE
                                    WHEN pr.status IN ('offline','dormant') THEN 0
                                    ELSE pr.recent_failure_count
                                  END,
           last_failure_at      = CASE
                                    WHEN pr.status IN ('offline','dormant') THEN NULL
                                    ELSE pr.last_failure_at
                                  END,
           updated_at           = now()
     WHERE pr.agency_identity = p_agency_id
       AND pr.status NOT IN ('retired', 'throttled');
  ELSIF p_state = 'away' THEN
    UPDATE roadmap_workforce.provider_registry
       SET last_seen_at = now(),
           updated_at   = now()
     WHERE agency_identity = p_agency_id;
  END IF;

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
$function$;
