-- Migration 072: P442 — Operator Stop and Cancel Controls
--
-- Adds first-class DB-backed stop controls for operators:
--
--   control_audit schema + operator_action_log
--     Immutable audit trail for every stop/cancel/suspend/drain/terminate action.
--
--   control_runtime.host_drain
--     Tracks active drain windows per host. No new dispatch claims are routed
--     to a host while drain_until > now(). Reversible via fn_resume_host.
--
--   Functions (all idempotent; all write to operator_action_log):
--     roadmap_workforce.fn_cancel_dispatch(dispatch_id, actor, reason)
--       → dispatch_status=cancelled; future claim attempts skip this row.
--         Returns 'ok' | 'noop' (already terminal) | 'error' (not found).
--
--     roadmap_workforce.fn_cancel_proposal_work(proposal_id, actor, reason)
--       → calls fn_cancel_dispatch for every non-terminal dispatch on proposal.
--
--     roadmap_workforce.fn_suspend_agency(agency_identity, actor, reason)
--       → agent_registry.status=suspended; blocks new claims for this agency
--         and its workers. Existing running claims continue uninterrupted.
--         Reversible via fn_resume_agency.
--
--     roadmap_workforce.fn_resume_agency(agency_identity, actor, reason)
--       → restores agency to active.
--
--     control_runtime.fn_drain_host(host, allow_grace_seconds, actor, reason)
--       → inserts/upserts host_drain row; no new claims accepted during window.
--         Reversible via fn_resume_host.
--
--     control_runtime.fn_resume_host(host, actor, reason)
--       → deletes host_drain row, lifting the drain window immediately.
--
--     roadmap_workforce.fn_terminate_worker(worker_identity, signal, actor, reason)
--       → marks the worker's active dispatch as failed + records termination
--         metadata. OS-level signal delivery is caller's responsibility.
--
--     roadmap.fn_suspend_provider_route(route_id, actor, reason)
--       → sets model_routes.is_enabled=false, blocking new claims on that route.
--         Reversible via fn_resume_provider_route.
--
--     roadmap.fn_resume_provider_route(route_id, actor, reason)
--       → re-enables a suspended route.
--
--   Updated fn_claim_work_offer (P281 original in migration 039):
--     New optional parameter p_service_host TEXT DEFAULT NULL.
--     Adds three guard checks before picking an offer:
--       1. Agency suspended → RAISE EXCEPTION 'agency_suspended:...'
--       2. Parent agency suspended (worker's agency_id) → same exception
--       3. Host draining → RAISE EXCEPTION 'host_draining:...'
--     Offer candidate filter now excludes dispatch_status='cancelled' rows.
--
-- Source of truth: agenthive DB (127.0.0.1:5432), schema roadmap_workforce / control_audit.
-- Migration boundary: this migration is the first to write control_audit; it is
--   safe to roll back by dropping the schema (no downstream FKs yet).
-- Required capabilities: operator-controls, workflow.

BEGIN;

-- ─── 1. control_audit schema ──────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS control_audit;
GRANT USAGE ON SCHEMA control_audit TO xiaomi;

-- ─── 2. operator_action_log ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS control_audit.operator_action_log (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor       TEXT        NOT NULL,
  verb        TEXT        NOT NULL CHECK (verb IN (
                'cancel_dispatch',
                'cancel_proposal_work',
                'suspend_agency',
                'resume_agency',
                'drain_host',
                'resume_host',
                'terminate_worker',
                'suspend_provider_route',
                'resume_provider_route'
              )),
  scope_type  TEXT        NOT NULL CHECK (scope_type IN (
                'dispatch', 'proposal', 'agency', 'host', 'worker', 'provider_route'
              )),
  scope_id    TEXT        NOT NULL,
  reason      TEXT,
  result      TEXT        NOT NULL CHECK (result IN ('ok', 'noop', 'error')),
  detail      TEXT,
  logged_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_op_action_log_scope
  ON control_audit.operator_action_log (scope_type, scope_id);

CREATE INDEX IF NOT EXISTS idx_op_action_log_actor
  ON control_audit.operator_action_log (actor, logged_at DESC);

CREATE INDEX IF NOT EXISTS idx_op_action_log_time
  ON control_audit.operator_action_log (logged_at DESC);

COMMENT ON TABLE control_audit.operator_action_log IS
  'P442: Immutable audit trail for all operator stop/cancel/suspend/drain/terminate actions.';

GRANT SELECT, INSERT ON control_audit.operator_action_log TO xiaomi;
GRANT USAGE ON SEQUENCE control_audit.operator_action_log_id_seq TO xiaomi;

-- ─── 3. host_drain table ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS control_runtime.host_drain (
  host                TEXT        PRIMARY KEY,
  drain_until         TIMESTAMPTZ NOT NULL,
  allow_grace_seconds INT         NOT NULL DEFAULT 0,
  drained_by          TEXT        NOT NULL,
  drain_reason        TEXT,
  set_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE control_runtime.host_drain IS
  'P442: Active drain windows per host. No new dispatch claims are routed while drain_until > now(). Reversible.';

GRANT SELECT, INSERT, UPDATE, DELETE ON control_runtime.host_drain TO xiaomi;

-- ─── 4. fn_cancel_dispatch ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_cancel_dispatch(
  p_dispatch_id BIGINT,
  p_actor       TEXT,
  p_reason      TEXT DEFAULT NULL
)
RETURNS TEXT   -- 'ok' | 'noop' | 'error'
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_status TEXT;
  v_result TEXT;
BEGIN
  SELECT dispatch_status INTO v_status
  FROM roadmap_workforce.squad_dispatch
  WHERE id = p_dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO control_audit.operator_action_log
      (actor, verb, scope_type, scope_id, reason, result, detail)
    VALUES
      (p_actor, 'cancel_dispatch', 'dispatch', p_dispatch_id::text,
       p_reason, 'error', 'dispatch not found');
    RETURN 'error';
  END IF;

  -- Idempotent: already in a terminal state
  IF v_status IN ('cancelled', 'completed', 'failed') THEN
    INSERT INTO control_audit.operator_action_log
      (actor, verb, scope_type, scope_id, reason, result, detail)
    VALUES
      (p_actor, 'cancel_dispatch', 'dispatch', p_dispatch_id::text,
       p_reason, 'noop', format('already terminal: %s', v_status));
    RETURN 'noop';
  END IF;

  UPDATE roadmap_workforce.squad_dispatch
  SET dispatch_status = 'cancelled',
      offer_status    = CASE
                          WHEN offer_status NOT IN ('delivered', 'failed', 'expired')
                          THEN 'failed'
                          ELSE offer_status
                        END,
      completed_at    = COALESCE(completed_at, now()),
      metadata        = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object(
                             'cancelled_at',   now()::text,
                             'cancel_reason',  COALESCE(p_reason, 'operator_cancel'),
                             'cancelled_by',   p_actor
                           )
  WHERE id = p_dispatch_id;

  -- Release any still-open proposal lease
  UPDATE roadmap_proposal.proposal_lease pl
  SET released_at    = COALESCE(pl.released_at, now()),
      release_reason = 'operator_cancelled'
  FROM roadmap_workforce.squad_dispatch sd
  WHERE sd.id       = p_dispatch_id
    AND sd.lease_id = pl.id
    AND pl.released_at IS NULL;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'cancel_dispatch', 'dispatch', p_dispatch_id::text, p_reason, 'ok', NULL);

  RETURN 'ok';
END;
$fn$;

-- ─── 5. fn_cancel_proposal_work ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_cancel_proposal_work(
  p_proposal_id BIGINT,
  p_actor       TEXT,
  p_reason      TEXT DEFAULT NULL
)
RETURNS TABLE (cancelled_count INT, noop_count INT)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_id        BIGINT;
  v_cancelled INT := 0;
  v_noop      INT := 0;
  v_res       TEXT;
BEGIN
  FOR v_id IN
    SELECT id
    FROM roadmap_workforce.squad_dispatch
    WHERE proposal_id    = p_proposal_id
      AND dispatch_status NOT IN ('cancelled', 'completed', 'failed')
    FOR UPDATE SKIP LOCKED
  LOOP
    v_res := roadmap_workforce.fn_cancel_dispatch(v_id, p_actor, p_reason);
    IF v_res = 'ok' THEN
      v_cancelled := v_cancelled + 1;
    ELSE
      v_noop := v_noop + 1;
    END IF;
  END LOOP;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'cancel_proposal_work', 'proposal', p_proposal_id::text, p_reason,
     CASE WHEN v_cancelled > 0 THEN 'ok' ELSE 'noop' END,
     format('cancelled=%s noop=%s', v_cancelled, v_noop));

  RETURN QUERY SELECT v_cancelled, v_noop;
END;
$fn$;

-- ─── 6. fn_suspend_agency ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_suspend_agency(
  p_agency_identity TEXT,
  p_actor           TEXT,
  p_reason          TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status
  FROM roadmap_workforce.agent_registry
  WHERE agent_identity = p_agency_identity
    AND agent_type     = 'agency'
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO control_audit.operator_action_log
      (actor, verb, scope_type, scope_id, reason, result, detail)
    VALUES
      (p_actor, 'suspend_agency', 'agency', p_agency_identity,
       p_reason, 'error', 'agency not found');
    RETURN 'error';
  END IF;

  IF v_status = 'suspended' THEN
    INSERT INTO control_audit.operator_action_log
      (actor, verb, scope_type, scope_id, reason, result, detail)
    VALUES
      (p_actor, 'suspend_agency', 'agency', p_agency_identity,
       p_reason, 'noop', 'already suspended');
    RETURN 'noop';
  END IF;

  UPDATE roadmap_workforce.agent_registry
  SET status     = 'suspended',
      updated_at = now()
  WHERE agent_identity = p_agency_identity;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'suspend_agency', 'agency', p_agency_identity, p_reason, 'ok', NULL);

  RETURN 'ok';
END;
$fn$;

-- ─── 7. fn_resume_agency ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_resume_agency(
  p_agency_identity TEXT,
  p_actor           TEXT,
  p_reason          TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_result TEXT;
BEGIN
  UPDATE roadmap_workforce.agent_registry
  SET status     = 'active',
      updated_at = now()
  WHERE agent_identity = p_agency_identity
    AND agent_type     = 'agency'
    AND status         = 'suspended';

  v_result := CASE WHEN FOUND THEN 'ok' ELSE 'noop' END;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'resume_agency', 'agency', p_agency_identity, p_reason, v_result, NULL);

  RETURN v_result;
END;
$fn$;

-- ─── 8. fn_drain_host ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION control_runtime.fn_drain_host(
  p_host                TEXT,
  p_allow_grace_seconds INT,
  p_actor               TEXT,
  p_reason              TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_drain_until TIMESTAMPTZ := now() + make_interval(secs => p_allow_grace_seconds);
BEGIN
  INSERT INTO control_runtime.host_drain
    (host, drain_until, allow_grace_seconds, drained_by, drain_reason)
  VALUES
    (p_host, v_drain_until, p_allow_grace_seconds, p_actor, p_reason)
  ON CONFLICT (host) DO UPDATE
    SET drain_until         = EXCLUDED.drain_until,
        allow_grace_seconds = EXCLUDED.allow_grace_seconds,
        drained_by          = EXCLUDED.drained_by,
        drain_reason        = EXCLUDED.drain_reason,
        set_at              = now();

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'drain_host', 'host', p_host, p_reason, 'ok',
     format('drain_until=%s grace_seconds=%s', v_drain_until, p_allow_grace_seconds));

  RETURN 'ok';
END;
$fn$;

-- ─── 9. fn_resume_host ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION control_runtime.fn_resume_host(
  p_host   TEXT,
  p_actor  TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_result TEXT;
BEGIN
  DELETE FROM control_runtime.host_drain WHERE host = p_host;
  v_result := CASE WHEN FOUND THEN 'ok' ELSE 'noop' END;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'resume_host', 'host', p_host, p_reason, v_result, NULL);

  RETURN v_result;
END;
$fn$;

-- ─── 10. fn_terminate_worker ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_terminate_worker(
  p_worker_identity TEXT,
  p_signal          TEXT DEFAULT 'SIGTERM',
  p_actor           TEXT DEFAULT 'operator',
  p_reason          TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_dispatch_id BIGINT;
  v_result      TEXT := 'noop';
BEGIN
  -- Find most-recent active dispatch for this worker
  SELECT id INTO v_dispatch_id
  FROM roadmap_workforce.squad_dispatch
  WHERE worker_identity  = p_worker_identity
    AND dispatch_status NOT IN ('cancelled', 'completed', 'failed')
  ORDER BY assigned_at DESC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF FOUND THEN
    UPDATE roadmap_workforce.squad_dispatch
    SET dispatch_status = 'failed',
        offer_status    = 'failed',
        completed_at    = COALESCE(completed_at, now()),
        metadata        = COALESCE(metadata, '{}'::jsonb)
                          || jsonb_build_object(
                               'terminated_at',     now()::text,
                               'terminate_reason',  COALESCE(p_reason, 'operator_terminate'),
                               'terminate_signal',  p_signal,
                               'terminated_by',     p_actor
                             )
    WHERE id = v_dispatch_id;

    -- Release any open proposal lease
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at    = COALESCE(pl.released_at, now()),
        release_reason = 'operator_terminated'
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id       = v_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;

    v_result := 'ok';
  END IF;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'terminate_worker', 'worker', p_worker_identity, p_reason, v_result,
     format('signal=%s dispatch_id=%s', p_signal, v_dispatch_id));

  RETURN v_result;
END;
$fn$;

-- ─── 11. fn_suspend_provider_route ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_suspend_provider_route(
  p_route_id BIGINT,
  p_actor    TEXT,
  p_reason   TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_enabled BOOLEAN;
BEGIN
  SELECT is_enabled INTO v_enabled
  FROM roadmap.model_routes
  WHERE id = p_route_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO control_audit.operator_action_log
      (actor, verb, scope_type, scope_id, reason, result, detail)
    VALUES
      (p_actor, 'suspend_provider_route', 'provider_route', p_route_id::text,
       p_reason, 'error', 'route not found');
    RETURN 'error';
  END IF;

  IF NOT v_enabled THEN
    INSERT INTO control_audit.operator_action_log
      (actor, verb, scope_type, scope_id, reason, result, detail)
    VALUES
      (p_actor, 'suspend_provider_route', 'provider_route', p_route_id::text,
       p_reason, 'noop', 'route already disabled');
    RETURN 'noop';
  END IF;

  UPDATE roadmap.model_routes
  SET is_enabled = false
  WHERE id = p_route_id;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'suspend_provider_route', 'provider_route', p_route_id::text,
     p_reason, 'ok', NULL);

  RETURN 'ok';
END;
$fn$;

-- ─── 12. fn_resume_provider_route ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_resume_provider_route(
  p_route_id BIGINT,
  p_actor    TEXT,
  p_reason   TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_result TEXT;
BEGIN
  UPDATE roadmap.model_routes
  SET is_enabled = true
  WHERE id       = p_route_id
    AND is_enabled = false;

  v_result := CASE WHEN FOUND THEN 'ok' ELSE 'noop' END;

  INSERT INTO control_audit.operator_action_log
    (actor, verb, scope_type, scope_id, reason, result, detail)
  VALUES
    (p_actor, 'resume_provider_route', 'provider_route', p_route_id::text,
     p_reason, v_result, NULL);

  RETURN v_result;
END;
$fn$;

-- ─── 13. fn_claim_work_offer — P442 guard additions ───────────────────────────
--
-- Replaces the migration 039 version (CREATE OR REPLACE).
-- New optional parameter: p_service_host TEXT DEFAULT NULL
--   If non-NULL and the host has an active drain window, the function raises
--   an exception rather than returning 0 rows, so the caller can distinguish
--   "draining" from "no available offers."
--
-- Guard evaluation order:
--   1. Agent registered?                  → foreign_key_violation
--   2. Agent or parent agency suspended?  → check_violation 'agency_suspended:...'
--   3. Service host draining?             → check_violation 'host_draining:...'
--   4. Pick a non-cancelled open offer    → 0 rows if none found

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_claim_work_offer(
  p_agent_identity        TEXT,
  p_required_capabilities JSONB DEFAULT '{}'::jsonb,
  p_lease_ttl_seconds     INT   DEFAULT 20,
  p_service_host          TEXT  DEFAULT NULL
)
RETURNS TABLE (
  dispatch_id      BIGINT,
  proposal_id      BIGINT,
  squad_name       TEXT,
  dispatch_role    TEXT,
  claim_token      UUID,
  claim_expires_at TIMESTAMPTZ,
  offer_version    INT,
  metadata         JSONB
)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_picked_id  BIGINT;
  v_new_token  UUID        := gen_random_uuid();
  v_expires    TIMESTAMPTZ := now() + make_interval(secs => p_lease_ttl_seconds);
  v_status     TEXT;
  v_agency_id  BIGINT;
  v_parent_status TEXT;
BEGIN
  -- Guard 1: agent must be registered
  SELECT ar.status, ar.agency_id
  INTO   v_status, v_agency_id
  FROM   roadmap_workforce.agent_registry ar
  WHERE  ar.agent_identity = p_agent_identity;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown agent_identity %', p_agent_identity
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Guard 2a: agent itself suspended
  IF v_status = 'suspended' THEN
    RAISE EXCEPTION 'agency_suspended: agent % is suspended, no new claims accepted', p_agent_identity
      USING ERRCODE = 'check_violation';
  END IF;

  -- Guard 2b: parent agency suspended (worker case)
  IF v_agency_id IS NOT NULL THEN
    SELECT status INTO v_parent_status
    FROM   roadmap_workforce.agent_registry
    WHERE  id = v_agency_id;

    IF v_parent_status = 'suspended' THEN
      RAISE EXCEPTION 'agency_suspended: parent agency of % is suspended, no new claims accepted', p_agent_identity
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Guard 3: host drain window
  IF p_service_host IS NOT NULL AND EXISTS (
    SELECT 1 FROM control_runtime.host_drain
    WHERE  host = p_service_host
      AND  drain_until > now()
  ) THEN
    RAISE EXCEPTION 'host_draining: host % is in active drain window, no new claims accepted', p_service_host
      USING ERRCODE = 'check_violation';
  END IF;

  -- Pick one open, non-cancelled offer whose capabilities match this agent
  WITH agent_caps AS (
    SELECT ac.capability
    FROM   roadmap_workforce.agent_capability ac
    JOIN   roadmap_workforce.agent_registry   ar ON ar.id = ac.agent_id
    WHERE  ar.agent_identity = p_agent_identity
  ),
  candidate AS (
    SELECT sd.id
    FROM   roadmap_workforce.squad_dispatch sd
    WHERE  sd.offer_status    = 'open'
      AND  sd.dispatch_status != 'cancelled'
      AND  (
        sd.required_capabilities = '{}'::jsonb
        OR NOT EXISTS (
          SELECT 1
          FROM   jsonb_array_elements_text(
                   COALESCE(sd.required_capabilities -> 'all', '[]'::jsonb)
                 ) req(cap)
          WHERE  req.cap NOT IN (SELECT capability FROM agent_caps)
        )
      )
    ORDER BY sd.assigned_at ASC
    FOR UPDATE OF sd SKIP LOCKED
    LIMIT 1
  )
  SELECT id INTO v_picked_id FROM candidate;

  IF v_picked_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE roadmap_workforce.squad_dispatch sd
  SET offer_status     = 'claimed',
      agent_identity   = p_agent_identity,
      claim_token      = v_new_token,
      claim_expires_at = v_expires,
      claimed_at       = now(),
      last_renewed_at  = now(),
      offer_version    = sd.offer_version + 1
  WHERE sd.id = v_picked_id;

  RETURN QUERY
  SELECT sd.id, sd.proposal_id, sd.squad_name, sd.dispatch_role,
         sd.claim_token, sd.claim_expires_at, sd.offer_version, sd.metadata
  FROM   roadmap_workforce.squad_dispatch sd
  WHERE  sd.id = v_picked_id;
END;
$fn$;

COMMIT;
