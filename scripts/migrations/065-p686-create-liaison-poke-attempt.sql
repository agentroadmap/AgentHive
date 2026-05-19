-- P686: Schema-drift hotfix — port migration 051 (P251 poke/pong liveness) to active runner path
--
-- Root cause: database/migrations/051-p251-poke-pong-liveness.sql was never applied because the
-- active migration runner (scripts/run-migration.ts) reads from scripts/migrations/, not
-- database/migrations/. This migration ports 051 verbatim into the active runner path.
--
-- Creates:
--   - roadmap.liaison_poke_attempt   (poke/pong audit table)
--   - roadmap.agent_lifecycle_log    (liveness event audit log)
--   - kind catalog entries for liaison_poke / liaison_pong
--   - Rebuilt roadmap.v_agency_status with liveness_state + 60-second dispatchable window (tightened by P915)
--   - Rebuilt roadmap.fn_check_agency_dormancy: 15-minute threshold, poke-pending exclusion

BEGIN;

-- ─── 1. CHECK constraint on agency.status ────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_agency_status'
          AND conrelid = 'roadmap.agency'::regclass
    ) THEN
        ALTER TABLE roadmap.agency
            ADD CONSTRAINT chk_agency_status
            CHECK (status IN ('unknown', 'active', 'throttled', 'paused', 'dormant', 'retired'))
            NOT VALID;
    END IF;
END $$;

-- ─── 2. Poke attempt audit table ─────────────────────────────────────────────
-- Records every poke emitted by the orchestrator watchdog.
-- CAS guard: outcome IS NULL means the poke is still open.
CREATE TABLE IF NOT EXISTS roadmap.liaison_poke_attempt (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agency_id       text NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    poke_message_id uuid NOT NULL,              -- message_id in roadmap.liaison_message
    poked_at        timestamptz NOT NULL DEFAULT now(),
    timeout_at      timestamptz NOT NULL,       -- poked_at + 60s
    pong_received_at timestamptz,
    outcome         text CHECK (outcome IN ('resolved', 'timed_out', 'poke_late', 'cancelled')),
    resolved_at     timestamptz
);

-- Partial index for open pokes — the hot path for watchdog queries
CREATE INDEX IF NOT EXISTS idx_poke_attempt_agency_open
    ON roadmap.liaison_poke_attempt (agency_id)
    WHERE outcome IS NULL;

CREATE INDEX IF NOT EXISTS idx_poke_attempt_poked_at
    ON roadmap.liaison_poke_attempt (poked_at DESC);

CREATE INDEX IF NOT EXISTS idx_poke_attempt_outcome
    ON roadmap.liaison_poke_attempt (outcome, resolved_at DESC NULLS LAST);

-- ─── 3. Agent lifecycle log ───────────────────────────────────────────────────
-- Durable audit log for liveness events: reactivation, poke, pong, timeout.
-- Intentionally soft-ref (no FK) so records survive agency deletion.
CREATE TABLE IF NOT EXISTS roadmap.agent_lifecycle_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agency_id   text NOT NULL,
    event_type  text NOT NULL,  -- auto_reactivated | poke_sent | pong_received | poke_timed_out | poke_late | poke_cancelled
    event_at    timestamptz NOT NULL DEFAULT now(),
    details     jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_log_agency
    ON roadmap.agent_lifecycle_log (agency_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_lifecycle_log_event_type
    ON roadmap.agent_lifecycle_log (event_type, event_at DESC);

-- ─── 4. Poke/pong kind catalog entries ───────────────────────────────────────
INSERT INTO roadmap.liaison_message_kind_catalog
    (kind, direction, category, payload_schema, description)
VALUES
    (
        'liaison_poke',
        'orchestrator->liaison',
        'control',
        '{"nonce": "uuid", "idle_threshold_min": "integer"}'::jsonb,
        'Challenge-response liveness probe sent by orchestrator to stale agency'
    ),
    (
        'liaison_pong',
        'liaison->orchestrator',
        'telemetry',
        '{"nonce": "uuid", "capacity_envelope": {}, "in_flight_count": "integer"}'::jsonb,
        'Response to liaison_poke carrying current capacity state'
    )
ON CONFLICT (kind) DO NOTHING;

-- ─── 5. Rebuild v_agency_status ──────────────────────────────────────────────
-- Adds liveness_state (6 states). Dispatchable window tightened to 60 seconds by P915.
--
-- liveness_state priority order:
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

-- ─── 6. Rebuild fn_check_agency_dormancy ─────────────────────────────────────
-- 15-minute silence threshold (was 90 seconds in P464).
-- Poke-pending agencies are excluded: watchdog controls their fate.
CREATE OR REPLACE FUNCTION roadmap.fn_check_agency_dormancy()
RETURNS void AS $$
BEGIN
    UPDATE roadmap.agency
    SET
        status = 'dormant',
        status_reason = 'No heartbeat > 15m'
    WHERE
        status IN ('active', 'throttled')
        AND last_heartbeat_at IS NOT NULL
        AND (now() - last_heartbeat_at) > interval '15 minutes'
        AND NOT EXISTS (
            SELECT 1
            FROM roadmap.liaison_poke_attempt lpa
            WHERE lpa.agency_id = roadmap.agency.agency_id
              AND lpa.outcome IS NULL
        );
END;
$$ LANGUAGE plpgsql;

COMMIT;
