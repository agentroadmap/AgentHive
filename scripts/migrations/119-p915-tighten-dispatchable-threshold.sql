-- P915: Tighten roadmap.v_agency_status dispatchable threshold from 10 minutes to 60 seconds
--
-- Root cause: migration 051 (P251) widened the dispatchable window to 10 minutes, allowing
-- a crashed hub to remain marked dispatchable for up to 10 minutes after its last heartbeat.
-- With a 30-second heartbeat cadence, 60 seconds = 2 missed heartbeats — well below the
-- 90-second dormancy mark — and is the tightest threshold that avoids false negatives.
--
-- Changes:
--   - Replaces roadmap.v_agency_status: 5 occurrences of interval '10 minutes' → '60 seconds'
--   - Adds composite index (status, last_heartbeat_at) for the hot dispatchable query path
--
-- Does NOT change roadmap.fn_check_agency_dormancy — its 15-minute sweep is out of scope.

BEGIN;

-- ─── 1. Tighten v_agency_status dispatchable window ──────────────────────────
-- liveness_state priority order (unchanged):
--   poke-pending       → open poke_attempt exists (CAS outcome IS NULL)
--   stale-unresponsive → last resolved poke timed out (no pong in 60s)
--   late-pong          → last resolved poke received pong AFTER timeout window
--   live-and-working   → active, fresh heartbeat (<60 sec), has active dispatch
--   live-but-idle      → active, fresh heartbeat (<60 sec), no active dispatch
--   offline            → everything else (dormant, paused, stale heartbeat)
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

-- ─── 2. Composite index for dispatchable query path ───────────────────────────
-- The hot query translates to: status = 'active' AND last_heartbeat_at > now() - 60s.
-- (status, last_heartbeat_at) serves this directly; the existing single-column indexes
-- (idx_agency_status and idx_agency_last_heartbeat) cannot serve the combined predicate.
CREATE INDEX IF NOT EXISTS idx_agency_status_heartbeat
    ON roadmap.agency(status, last_heartbeat_at DESC NULLS LAST);

COMMIT;
