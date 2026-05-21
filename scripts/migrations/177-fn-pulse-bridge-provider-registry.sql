-- 177-fn-pulse-bridge-provider-registry.sql
--
-- Bridge presence_state (roadmap.agency) → provider_registry status when
-- the a2a-host fn_pulse fires. This was the recovery path the retired
-- per-agency liaisonHeartbeat() owned; without it, agencies that come
-- back online via the generic a2a-host stay stuck at provider_registry
-- status='offline'/'dormant' and the orchestrator's preflight (and the
-- resolveAgency matcher) rejects every offer for them.
--
-- Behavior:
--   p_state='online' or 'busy'  → provider_registry.status='active' (if it was offline/dormant),
--                                  last_seen_at refreshed, throttle/failure counters reset.
--   p_state='away'              → status untouched (transient), last_seen_at refreshed only.
--   p_state='offline'           → provider_registry status untouched. The downward
--                                  transition is owned by scanAndTransitionSilentAgencies
--                                  (active→dormant @5min, dormant→offline @30min) so the
--                                  guard rails on premature retirement stay intact.

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

  -- Migration 177: bridge to provider_registry. Without this the orchestrator
  -- preflight + resolveAgency reject every offer because pr.status stays
  -- 'offline' even though the a2a-host has the agency online. Column set
  -- mirrors the actual provider_registry schema (status, status_reason,
  -- last_seen_at, alert_sent_at, throttle_count, recent_failure_count,
  -- last_failure_at, updated_at).
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
      FROM roadmap_workforce.agent_registry ar
     WHERE pr.agency_id = ar.id
       AND ar.agent_identity = p_agency_id
       AND pr.status <> 'retired';
  ELSIF p_state = 'away' THEN
    UPDATE roadmap_workforce.provider_registry pr
       SET last_seen_at = now(),
           updated_at   = now()
      FROM roadmap_workforce.agent_registry ar
     WHERE pr.agency_id = ar.id
       AND ar.agent_identity = p_agency_id;
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
$function$;
