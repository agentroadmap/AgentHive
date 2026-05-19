-- P915: Tighten v_agency_status dispatchable threshold from 10 minutes to 60 seconds
-- Motivation: a crashed hub remained dispatchable for up to 10 minutes; hiveCentral's
-- is_dispatchable() uses 60s. Align roadmap schema with the rest of the stack.
-- Also adds composite index for efficient dispatchable-query path.
--
-- DO NOT CHANGE: fn_check_agency_dormancy (15 min sweep) or checkAndMarkDormant TS
-- function (90s dormancy gate) — both are out of scope for this migration.

BEGIN;

-- ─── 1. Tighten v_agency_status ──────────────────────────────────────────────
-- Three occurrences of interval '10 minutes' → interval '60 seconds':
--   dispatchable boolean
--   liveness_state CASE: live-and-working branch  (<60s heartbeat, has dispatch)
--   liveness_state CASE: live-but-idle branch     (<60s heartbeat, no dispatch)
CREATE OR REPLACE VIEW roadmap.v_agency_status AS
SELECT
    a.agency_id,
    a.display_name,
    a.provider,
    a.host_id,
    a.status,
    a.last_heartbeat_at,
    EXTRACT(EPOCH FROM (now() - a.last_heartbeat_at)) AS silence_seconds,
    (
        a.status = 'active'
        AND a.last_heartbeat_at IS NOT NULL
        AND (now() - a.last_heartbeat_at) < interval '60 seconds'
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
            AND a.last_heartbeat_at IS NOT NULL
            AND (now() - a.last_heartbeat_at) < interval '60 seconds'
            AND active_dispatch.agency_id IS NOT NULL
            THEN 'live-and-working'
        WHEN a.status = 'active'
            AND a.last_heartbeat_at IS NOT NULL
            AND (now() - a.last_heartbeat_at) < interval '60 seconds'
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

-- ─── 2. Composite index for efficient dispatchable query ─────────────────────
-- Covers the WHERE status = 'active' AND last_heartbeat_at > now() - 60s pattern.
CREATE INDEX IF NOT EXISTS idx_agency_status_heartbeat
    ON roadmap.agency(status, last_heartbeat_at DESC NULLS LAST);

COMMIT;
