-- P1104: Presence state machine — presence_state column, fn_pulse, v_agency_status update
--
-- Adds four-state presence tracking (online/busy/away/offline) to roadmap.agency.
-- fn_pulse is called every ≤30s by active agencies; emits pg_notify on state change.
-- v_agency_status dispatchable predicate tightened to 60s AND presence_state check.
--
-- P1339 contributed provider_registry integration inside fn_pulse (bridged via
-- agency_identity); the body here reflects the combined live state so fresh
-- installations are consistent with production.

BEGIN;

-- ─── 1. presence_state column ────────────────────────────────────────────────
ALTER TABLE roadmap.agency
  ADD COLUMN IF NOT EXISTS presence_state TEXT NOT NULL DEFAULT 'offline'
  CHECK (presence_state IN ('online', 'busy', 'away', 'offline'));

-- ─── 2. fn_pulse ─────────────────────────────────────────────────────────────
-- Called every ≤30s by active agencies. Updates last_heartbeat_at + presence_state,
-- fires pg_notify('agency_presence_changed') on state transition.
CREATE OR REPLACE FUNCTION roadmap.fn_pulse(p_agency_id text, p_state text)
RETURNS void LANGUAGE plpgsql AS $$
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

  -- P1339: bridge to provider_registry via direct match on agency_identity.
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
END $$;

-- ─── 3. v_agency_status — presence-aware dispatchable predicate ───────────────
-- Dispatchable when status='active' AND (presence online/busy OR heartbeat <60s).
-- Preserves all existing columns and liveness_state logic.
CREATE OR REPLACE VIEW roadmap.v_agency_status AS
SELECT
    a.agency_id,
    a.display_name,
    a.provider,
    a.host_id,
    a.status,
    a.last_heartbeat_at,
    EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) AS silence_seconds,
    a.presence_state,
    (
        a.status = 'active'
        AND (
          a.presence_state IN ('online', 'busy')
          OR (
            a.last_heartbeat_at IS NOT NULL
            AND (now() - a.last_heartbeat_at) < interval '60 seconds'
          )
        )
    ) AS dispatchable,
    a.registered_at,
    a.metadata,
    CASE
        WHEN open_poke.id IS NOT NULL
            THEN 'poke-pending'
        WHEN last_poke.outcome = 'timed_out'
            THEN 'stale-unresponsive'
        WHEN last_poke.outcome = 'poke_late'
            THEN 'late-pong'
        WHEN a.status = 'active'
            AND (
              a.presence_state IN ('online', 'busy')
              OR (a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < interval '60 seconds')
            )
            AND active_dispatch.agency_id IS NOT NULL
            THEN 'live-and-working'
        WHEN a.status = 'active'
            AND (
              a.presence_state IN ('online', 'busy')
              OR (a.last_heartbeat_at IS NOT NULL AND (now() - a.last_heartbeat_at) < interval '60 seconds')
            )
            THEN 'live-but-idle'
        ELSE 'offline'
    END AS liveness_state
FROM roadmap.agency a
LEFT JOIN LATERAL (
    SELECT id
    FROM roadmap.liaison_poke_attempt
    WHERE agency_id = a.agency_id
      AND outcome IS NULL
    LIMIT 1
) open_poke ON true
LEFT JOIN LATERAL (
    SELECT outcome
    FROM roadmap.liaison_poke_attempt
    WHERE agency_id = a.agency_id
      AND outcome IS NOT NULL
    ORDER BY poked_at DESC
    LIMIT 1
) last_poke ON true
LEFT JOIN LATERAL (
    SELECT sd.agent_identity AS agency_id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.agent_identity = a.agency_id
      AND sd.dispatch_status IN ('assigned', 'active')
      AND sd.completed_at IS NULL
    LIMIT 1
) active_dispatch ON true
WHERE a.status <> 'retired';

-- ─── 4. Index for dispatchable query path ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_agency_status_heartbeat
    ON roadmap.agency(status, last_heartbeat_at DESC NULLS LAST);

COMMIT;
