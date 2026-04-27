-- ============================================================
-- P594 — hiveCentral.agency schema
-- Registry of work-execution contexts: provider, agency, session,
-- capacity, and liaison message kind catalog.
-- ============================================================
-- Target DB:  hiveCentral
-- Depends on: 001-core.sql (core schema), 002-identity.sql (P593)
-- ============================================================

-- Pre-flight: fail loudly if dependencies are absent
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core') THEN
    RAISE EXCEPTION '003-agency.sql requires core schema; apply 001-core.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'identity') THEN
    RAISE EXCEPTION '003-agency.sql requires identity schema (P593); apply 002-identity.sql first';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS agency;

COMMENT ON SCHEMA agency IS
  'Work-execution context registry for hiveCentral: provider directory, agency instances, '
  'sessions with dormancy state machine, capacity envelopes, and A2A message kind catalog.';

-- ============================================================
-- agency.agency_provider — CLI binary directory
-- Provider quirks live in metadata JSONB, not new columns.
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.agency_provider (
  provider_id        TEXT         PRIMARY KEY,
  display_name       TEXT         NOT NULL,
  binary_path        TEXT,
  default_args       JSONB        NOT NULL DEFAULT '[]',
  supported_features TEXT[]       NOT NULL DEFAULT '{}',
  metadata           JSONB        NOT NULL DEFAULT '{}',
  owner_did          TEXT         NOT NULL,
  lifecycle_status   TEXT         NOT NULL DEFAULT 'active'
                                 CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at      TIMESTAMPTZ,
  retire_after       TIMESTAMPTZ,
  notes              TEXT
);

COMMENT ON TABLE agency.agency_provider IS
  'Registry of CLI providers that can spawn agencies. One row per provider binary variant.';

-- ============================================================
-- agency.agency — instances bound to identity.principal
-- principal_did TEXT FK → identity.principal(did) [P593 PK]
-- signing_key_id BIGINT FK → identity.principal_key(id)
-- host_id BIGINT FK → core.host(host_id)
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.agency (
  agency_id          TEXT         PRIMARY KEY,
  display_name       TEXT         NOT NULL,
  provider_id        TEXT         NOT NULL REFERENCES agency.agency_provider(provider_id),
  principal_did      TEXT         NOT NULL REFERENCES identity.principal(did),
  signing_key_id     BIGINT       REFERENCES identity.principal_key(id),
  host_id            BIGINT       NOT NULL REFERENCES core.host(host_id),
  capabilities       TEXT[]       NOT NULL DEFAULT '{}',
  status_reason      TEXT,
  last_heartbeat_at  TIMESTAMPTZ,
  registered_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  metadata           JSONB        NOT NULL DEFAULT '{}',
  owner_did          TEXT         NOT NULL,
  lifecycle_status   TEXT         NOT NULL DEFAULT 'active'
                                 CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at      TIMESTAMPTZ,
  retire_after       TIMESTAMPTZ,
  notes              TEXT
);

COMMENT ON TABLE agency.agency IS
  'Agency instances — each bound to an identity.principal DID and a host. '
  'Status is tracked via agency_session.dormancy_state, not a status column here.';

-- ============================================================
-- agency.agency_session — heartbeats + dormancy state machine
-- silence_seconds NOT a GENERATED column: now() is STABLE not
-- IMMUTABLE — PostgreSQL rejects it in GENERATED AS STORED.
-- Exposed via v_agency_session view instead (AC-9).
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.agency_session (
  session_id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id               TEXT         NOT NULL REFERENCES agency.agency(agency_id),
  liaison_host            INET,
  started_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ended_at                TIMESTAMPTZ,
  end_reason              TEXT,
  last_heartbeat_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  dormancy_state          TEXT         NOT NULL DEFAULT 'active'
                                       CHECK (dormancy_state IN ('active','dormant','reconnecting','paused')),
  reconnect_grace_until   TIMESTAMPTZ,
  heartbeat_failure_count INT          NOT NULL DEFAULT 0,
  metadata                JSONB        NOT NULL DEFAULT '{}',
  owner_did               TEXT         NOT NULL,
  lifecycle_status        TEXT         NOT NULL DEFAULT 'active'
                                       CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at           TIMESTAMPTZ,
  retire_after            TIMESTAMPTZ,
  notes                   TEXT
);

COMMENT ON TABLE agency.agency_session IS
  'One row per agency lifecycle session. Open sessions have ended_at IS NULL. '
  'dormancy_state drives the reconnect + DR state machine.';

-- View exposes silence_seconds computed at read time (AC-9)
CREATE OR REPLACE VIEW agency.v_agency_session AS
  SELECT *,
    EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - last_heartbeat_at))::int AS silence_seconds
  FROM agency.agency_session;

COMMENT ON VIEW agency.v_agency_session IS
  'agency_session with silence_seconds (seconds since last heartbeat, or since ended_at). '
  'GENERATED AS STORED is forbidden: now() is STABLE not IMMUTABLE.';

-- ============================================================
-- agency.agency_capacity — dispatch load envelope
-- Exactly one active row per agency enforced via partial unique index.
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.agency_capacity (
  capacity_id        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id          TEXT         NOT NULL REFERENCES agency.agency(agency_id),
  max_concurrent     INT          NOT NULL DEFAULT 1 CHECK (max_concurrent > 0),
  current_load       INT          NOT NULL DEFAULT 0 CHECK (current_load >= 0),
  accepted_tags      TEXT[]       NOT NULL DEFAULT '{}',
  rejected_tags      TEXT[]       NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  owner_did          TEXT         NOT NULL,
  lifecycle_status   TEXT         NOT NULL DEFAULT 'active'
                                 CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at      TIMESTAMPTZ,
  retire_after       TIMESTAMPTZ,
  notes              TEXT,
  CONSTRAINT chk_load_within_capacity CHECK (current_load <= max_concurrent)
);

COMMENT ON TABLE agency.agency_capacity IS
  'Dispatch capacity envelope. One active row per agency. '
  'current_load managed atomically by claim_capacity / release_capacity.';

-- ============================================================
-- agency.liaison_message_kind_catalog — JSONSchema-validated A2A vocab
-- 4-value category; direction includes ''any'' for bidirectional kinds.
-- 21 kinds: 20 from migration 047 + protocol_resync (AC-19).
-- ============================================================
CREATE TABLE IF NOT EXISTS agency.liaison_message_kind_catalog (
  kind_id            TEXT         PRIMARY KEY,
  category           TEXT         NOT NULL
                                 CHECK (category IN ('lifecycle','workflow','error','telemetry')),
  direction          TEXT         NOT NULL
                                 CHECK (direction IN ('orchestrator->liaison','liaison->orchestrator','any')),
  payload_schema     JSONB        NOT NULL,
  is_deprecated      BOOLEAN      NOT NULL DEFAULT false,
  owner_did          TEXT         NOT NULL,
  lifecycle_status   TEXT         NOT NULL DEFAULT 'active'
                                 CHECK (lifecycle_status IN ('active','deprecated','retired')),
  deprecated_at      TIMESTAMPTZ,
  retire_after       TIMESTAMPTZ,
  notes              TEXT
);

COMMENT ON TABLE agency.liaison_message_kind_catalog IS
  '21-kind catalog of A2A message kinds with JSONSchema payload validation. '
  'Seeded in migration 061. Append-only; new kinds must be INSERT-ed.';

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_agency_session_agency_id
  ON agency.agency_session(agency_id);

-- Active-open sessions by dormancy state + recency (sweep query)
CREATE INDEX IF NOT EXISTS idx_agency_session_dormancy
  ON agency.agency_session(dormancy_state, last_heartbeat_at)
  WHERE ended_at IS NULL;

-- Reconnecting sessions expiry lookup
CREATE INDEX IF NOT EXISTS idx_agency_session_reconnect
  ON agency.agency_session(reconnect_grace_until)
  WHERE dormancy_state = 'reconnecting';

CREATE INDEX IF NOT EXISTS idx_agency_provider_id
  ON agency.agency(provider_id);

CREATE INDEX IF NOT EXISTS idx_agency_principal_did
  ON agency.agency(principal_did);

CREATE INDEX IF NOT EXISTS idx_agency_host_id
  ON agency.agency(host_id);

CREATE INDEX IF NOT EXISTS idx_agency_heartbeat
  ON agency.agency(last_heartbeat_at);

-- Exactly one active capacity row per agency
CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_capacity_unique
  ON agency.agency_capacity(agency_id)
  WHERE lifecycle_status = 'active';

-- ============================================================
-- Functions — all SECURITY DEFINER, search_path locked
-- ============================================================

-- is_dispatchable: TRUE iff agency is active, has live session, recent
-- heartbeat, and an active capacity row with headroom.
-- Explicit policy: missing capacity row → FALSE (not dispatchable).
CREATE OR REPLACE FUNCTION agency.is_dispatchable(p_agency_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agency, pg_catalog
AS $$
DECLARE
  v_lifecycle  TEXT;
  v_state      TEXT;
  v_heartbeat  TIMESTAMPTZ;
  v_load       INT;
  v_max        INT;
BEGIN
  SELECT lifecycle_status INTO v_lifecycle
  FROM agency.agency WHERE agency_id = p_agency_id;
  IF NOT FOUND OR v_lifecycle != 'active' THEN RETURN FALSE; END IF;

  SELECT dormancy_state, last_heartbeat_at INTO v_state, v_heartbeat
  FROM agency.agency_session
  WHERE agency_id = p_agency_id AND ended_at IS NULL
  ORDER BY started_at DESC LIMIT 1;
  IF NOT FOUND OR v_state != 'active' THEN RETURN FALSE; END IF;
  IF v_heartbeat < now() - interval '60 seconds' THEN RETURN FALSE; END IF;

  SELECT current_load, max_concurrent INTO v_load, v_max
  FROM agency.agency_capacity
  WHERE agency_id = p_agency_id AND lifecycle_status = 'active';
  IF NOT FOUND THEN RETURN FALSE; END IF;

  RETURN v_load < v_max;
END;
$$;

-- session_heartbeat: update heartbeat timestamp and propagate to agency.
-- paused sessions are no-ops (operator must use liaison_resume).
-- reconnecting sessions within grace window transition back to active.
CREATE OR REPLACE FUNCTION agency.session_heartbeat(p_session_id UUID, p_agency_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agency, pg_catalog
AS $$
DECLARE
  v_state        TEXT;
  v_grace_until  TIMESTAMPTZ;
BEGIN
  SELECT dormancy_state, reconnect_grace_until INTO v_state, v_grace_until
  FROM agency.agency_session
  WHERE session_id = p_session_id AND agency_id = p_agency_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_heartbeat: session % not found or agency_id mismatch', p_session_id;
  END IF;

  IF v_state = 'paused' THEN RETURN; END IF;

  IF v_state = 'reconnecting' THEN
    IF v_grace_until IS NOT NULL AND now() <= v_grace_until THEN
      UPDATE agency.agency_session
      SET dormancy_state           = 'active',
          last_heartbeat_at        = now(),
          heartbeat_failure_count  = 0,
          reconnect_grace_until    = NULL
      WHERE session_id = p_session_id;
    ELSE
      PERFORM agency.mark_dormant(p_session_id, 'reconnect_grace_expired_on_heartbeat');
      RETURN;
    END IF;
  ELSE
    UPDATE agency.agency_session
    SET last_heartbeat_at       = now(),
        heartbeat_failure_count = 0
    WHERE session_id = p_session_id AND dormancy_state = 'active';
  END IF;

  UPDATE agency.agency
  SET last_heartbeat_at = now()
  WHERE agency_id = p_agency_id;
END;
$$;

-- list_stale_sessions: STABLE — no side effects, used by sweep coordinator.
-- SKIP LOCKED lives in the sweep block, not here.
CREATE OR REPLACE FUNCTION agency.list_stale_sessions(p_stale_after_seconds INT DEFAULT 60)
RETURNS SETOF agency.v_agency_session
LANGUAGE sql
SECURITY DEFINER
SET search_path = agency, pg_catalog
STABLE
AS $$
  SELECT * FROM agency.v_agency_session
  WHERE dormancy_state = 'active'
    AND ended_at IS NULL
    AND last_heartbeat_at < now() - (p_stale_after_seconds || ' seconds')::interval;
$$;

-- mark_dormant: acquires xact-scoped advisory lock (INT4,INT4) per AC-12.
-- Auto-releases on COMMIT/ROLLBACK — no manual unlock needed.
CREATE OR REPLACE FUNCTION agency.mark_dormant(p_session_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agency, pg_catalog
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('agency_session')::int4,
    hashtext(p_session_id::text)::int4
  );
  UPDATE agency.agency_session
  SET dormancy_state = 'dormant',
      ended_at       = COALESCE(ended_at, now()),
      end_reason     = COALESCE(end_reason, p_reason)
  WHERE session_id = p_session_id
    AND dormancy_state IN ('active', 'reconnecting');
END;
$$;

-- mark_reconnecting: transitions active session to reconnecting during DR.
-- Raises WARNING (not EXCEPTION) if session not in active state.
CREATE OR REPLACE FUNCTION agency.mark_reconnecting(p_session_id UUID, p_grace_until TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agency, pg_catalog
AS $$
BEGIN
  UPDATE agency.agency_session
  SET dormancy_state        = 'reconnecting',
      reconnect_grace_until = p_grace_until
  WHERE session_id = p_session_id
    AND dormancy_state = 'active'
    AND ended_at IS NULL;
  IF NOT FOUND THEN
    RAISE WARNING 'mark_reconnecting: session % not in active state or not found', p_session_id;
  END IF;
END;
$$;

-- claim_capacity: atomically increment current_load via single UPDATE.
-- Single-statement WHERE prevents SELECT+UPDATE race.
-- Returns TRUE if slot claimed, FALSE if at-capacity or no active row.
CREATE OR REPLACE FUNCTION agency.claim_capacity(p_agency_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agency, pg_catalog
AS $$
DECLARE
  v_capacity_id UUID;
BEGIN
  UPDATE agency.agency_capacity
  SET current_load = current_load + 1,
      updated_at   = now()
  WHERE agency_id        = p_agency_id
    AND lifecycle_status = 'active'
    AND current_load     < max_concurrent
  RETURNING capacity_id INTO v_capacity_id;
  RETURN FOUND;
END;
$$;

-- release_capacity: GREATEST(0, current_load-1) prevents underflow on
-- duplicate release; CHECK constraint would raise without this floor.
CREATE OR REPLACE FUNCTION agency.release_capacity(p_agency_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agency, pg_catalog
AS $$
BEGIN
  UPDATE agency.agency_capacity
  SET current_load = GREATEST(0, current_load - 1),
      updated_at   = now()
  WHERE agency_id        = p_agency_id
    AND lifecycle_status = 'active';
END;
$$;

-- ============================================================
-- Dormancy sweep — cluster-safe (AC-5, AC-12)
-- Session-level pg_try_advisory_lock for coordinator election.
-- Xact-level lock per row inside mark_dormant.
-- Run every 30s via pg_cron or application loop.
-- ============================================================
-- (This is the canonical sweep body; application invokes it verbatim.)
-- DO $$
-- DECLARE
--   lock_acquired BOOLEAN;
--   stale         RECORD;
-- BEGIN
--   SELECT pg_try_advisory_lock(
--     hashtext('agency_dormancy_sweep')::int4,
--     0::int4
--   ) INTO lock_acquired;
--   IF NOT lock_acquired THEN RETURN; END IF;
--   BEGIN
--     FOR stale IN
--       SELECT session_id FROM agency.agency_session
--       WHERE dormancy_state = 'active' AND ended_at IS NULL
--         AND last_heartbeat_at < now() - interval '60 seconds'
--       FOR UPDATE SKIP LOCKED
--     LOOP
--       PERFORM agency.mark_dormant(stale.session_id, 'stale_timeout');
--     END LOOP;
--     FOR stale IN
--       SELECT session_id FROM agency.agency_session
--       WHERE dormancy_state = 'reconnecting' AND reconnect_grace_until < now()
--       FOR UPDATE SKIP LOCKED
--     LOOP
--       PERFORM agency.mark_dormant(stale.session_id, 'reconnect_grace_expired');
--     END LOOP;
--   EXCEPTION WHEN OTHERS THEN
--     PERFORM pg_advisory_unlock(hashtext('agency_dormancy_sweep')::int4, 0::int4);
--     RAISE;
--   END;
--   PERFORM pg_advisory_unlock(hashtext('agency_dormancy_sweep')::int4, 0::int4);
-- END $$;

-- ============================================================
-- RLS — agency_session: agencies see only their own sessions
-- ============================================================
ALTER TABLE agency.agency_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency.agency_session FORCE ROW LEVEL SECURITY;

CREATE POLICY agency_session_self_access ON agency.agency_session
  FOR ALL TO agenthive_agency
  USING (agency_id = current_setting('app.current_agency_id', true));

-- ============================================================
-- Role grants (IF EXISTS pattern per 001-core.sql RV6)
-- BYPASSRLS is a role attribute, not a privilege (RV9).
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA agency TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON agency.agency, agency.agency_session, agency.agency_capacity
      TO agenthive_orchestrator;
    GRANT SELECT ON agency.agency_provider, agency.liaison_message_kind_catalog
      TO agenthive_orchestrator;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agency TO agenthive_orchestrator;
    ALTER ROLE agenthive_orchestrator BYPASSRLS;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA agency TO agenthive_agency;
    GRANT SELECT, UPDATE ON agency.agency_session TO agenthive_agency;
    GRANT SELECT ON agency.agency, agency.agency_capacity TO agenthive_agency;
    GRANT EXECUTE ON FUNCTION agency.session_heartbeat TO agenthive_agency;
    -- claim_capacity and release_capacity are orchestrator-only; not granted here
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_a2a') THEN
    GRANT USAGE ON SCHEMA agency TO agenthive_a2a;
    GRANT SELECT ON agency.liaison_message_kind_catalog TO agenthive_a2a;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA agency TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA agency TO agenthive_observability;
  END IF;
END $$;

-- Lifecycle-only tables: revoke DELETE from PUBLIC
REVOKE DELETE ON agency.agency FROM PUBLIC;
REVOKE DELETE ON agency.agency_session FROM PUBLIC;
REVOKE DELETE ON agency.liaison_message_kind_catalog FROM PUBLIC;
