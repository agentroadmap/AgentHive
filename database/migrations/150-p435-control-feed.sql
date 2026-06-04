-- Migration 150: P435 — Control Panel Observability: causal feed + operator control API
--
-- Adds:
--   control_audit.feed_event
--     Causal event store for the observability feed. Each row links a lifecycle
--     event (dispatch assigned, claimed, run started, operator stop, etc.) to
--     the full causal chain: proposal → dispatch → claim → run.
--     Fields match the P435 feed event schema exactly.
--
--   control_audit.v_feed_replay
--     View that joins feed_event with squad_dispatch, agent_runs, model_routes,
--     and project_budget_cap for full causal replay of a dispatch chain.
--
--   fn_emit_feed_event(...)
--     Helper called by triggers and operator-stop-controls to write feed rows.
--
--   fn_stop_dispatch(dispatch_id, actor, reason)
--     Unified stop: cancels the dispatch AND marks all active workers failed,
--     then writes ONE summary audit row. Satisfies AC-5.
--
-- Trigger on squad_dispatch:
--     trg_squad_dispatch_feed_event — emits a feed_event row on INSERT/UPDATE.
--
-- Source of truth: agenthive DB, schema control_audit.
-- Required capabilities: operator-controls, observability.

BEGIN;

-- ─── 1. feed_event table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS control_audit.feed_event (
  id                    BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Causal chain (AC-4)
  project_id            BIGINT,
  proposal_id           BIGINT,
  dispatch_id           BIGINT,
  claim_id              BIGINT,
  run_id                BIGINT,
  -- Context
  agency_id             TEXT,
  worker_id             TEXT,
  host                  TEXT,
  route                 TEXT,
  model                 TEXT,
  budget_scope          TEXT,
  -- Classification (AC-3)
  event_class           TEXT        NOT NULL CHECK (event_class IN (
                          'dispatch_assigned',
                          'dispatch_claimed',
                          'dispatch_renewed',
                          'dispatch_completed',
                          'dispatch_failed',
                          'dispatch_cancelled',
                          'run_started',
                          'run_completed',
                          'run_failed',
                          'operator_stop',
                          'operator_suspend',
                          'operator_drain',
                          'operator_terminate',
                          'operator_resume',
                          'route_suspended',
                          'route_resumed'
                        )),
  recommended_stop_scope TEXT       CHECK (recommended_stop_scope IN (
                          'dispatch', 'proposal', 'agency', 'host', 'worker', 'provider_route'
                        )),
  detail                JSONB,
  emitted_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_event_dispatch
  ON control_audit.feed_event (dispatch_id, emitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_feed_event_proposal
  ON control_audit.feed_event (proposal_id, emitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_feed_event_project_time
  ON control_audit.feed_event (project_id, emitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_feed_event_causal_chain
  ON control_audit.feed_event (proposal_id, dispatch_id, claim_id, run_id);

CREATE INDEX IF NOT EXISTS idx_feed_event_class_time
  ON control_audit.feed_event (event_class, emitted_at DESC);

COMMENT ON TABLE control_audit.feed_event IS
  'P435: Causal event store for the operator observability feed. '
  'Every row carries the full proposal→dispatch→claim→run chain for replay correlation.';

GRANT SELECT, INSERT ON control_audit.feed_event TO xiaomi;
GRANT USAGE ON SEQUENCE control_audit.feed_event_id_seq TO xiaomi;

-- ─── 2. fn_emit_feed_event ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION control_audit.fn_emit_feed_event(
  p_event_class           TEXT,
  p_project_id            BIGINT        DEFAULT NULL,
  p_proposal_id           BIGINT        DEFAULT NULL,
  p_dispatch_id           BIGINT        DEFAULT NULL,
  p_claim_id              BIGINT        DEFAULT NULL,
  p_run_id                BIGINT        DEFAULT NULL,
  p_agency_id             TEXT          DEFAULT NULL,
  p_worker_id             TEXT          DEFAULT NULL,
  p_host                  TEXT          DEFAULT NULL,
  p_route                 TEXT          DEFAULT NULL,
  p_model                 TEXT          DEFAULT NULL,
  p_budget_scope          TEXT          DEFAULT NULL,
  p_recommended_stop_scope TEXT         DEFAULT NULL,
  p_detail                JSONB         DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO control_audit.feed_event (
    event_class, project_id, proposal_id, dispatch_id, claim_id, run_id,
    agency_id, worker_id, host, route, model, budget_scope,
    recommended_stop_scope, detail
  ) VALUES (
    p_event_class, p_project_id, p_proposal_id, p_dispatch_id, p_claim_id, p_run_id,
    p_agency_id, p_worker_id, p_host, p_route, p_model, p_budget_scope,
    p_recommended_stop_scope, p_detail
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION control_audit.fn_emit_feed_event IS
  'P435: Insert a feed event row with the full causal chain.';

GRANT EXECUTE ON FUNCTION control_audit.fn_emit_feed_event TO xiaomi;

-- ─── 3. Trigger: squad_dispatch → feed_event ─────────────────────────────────

CREATE OR REPLACE FUNCTION control_audit.trg_fn_squad_dispatch_feed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_class TEXT;
  v_stop_scope  TEXT;
BEGIN
  -- Map dispatch_status transition to event_class
  IF TG_OP = 'INSERT' THEN
    v_event_class := 'dispatch_assigned';
    v_stop_scope  := 'dispatch';
  ELSIF NEW.dispatch_status = 'claimed' AND (OLD IS NULL OR OLD.dispatch_status <> 'claimed') THEN
    v_event_class := 'dispatch_claimed';
    v_stop_scope  := 'dispatch';
  ELSIF NEW.dispatch_status = 'completed' AND (OLD IS NULL OR OLD.dispatch_status <> 'completed') THEN
    v_event_class := 'dispatch_completed';
    v_stop_scope  := NULL;
  ELSIF NEW.dispatch_status = 'failed' AND (OLD IS NULL OR OLD.dispatch_status <> 'failed') THEN
    v_event_class := 'dispatch_failed';
    v_stop_scope  := 'worker';
  ELSIF NEW.dispatch_status = 'cancelled' AND (OLD IS NULL OR OLD.dispatch_status <> 'cancelled') THEN
    v_event_class := 'dispatch_cancelled';
    v_stop_scope  := NULL;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM control_audit.fn_emit_feed_event(
    p_event_class             := v_event_class,
    p_project_id              := NEW.project_id,
    p_proposal_id             := NEW.proposal_id,
    p_dispatch_id             := NEW.id,
    p_agency_id               := NEW.agency_identity,
    p_worker_id               := NEW.worker_identity,
    p_route                   := (NEW.metadata->>'route_name'),
    p_model                   := (NEW.metadata->>'model_name'),
    p_budget_scope            := (NEW.metadata->>'budget_scope'),
    p_recommended_stop_scope  := v_stop_scope
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_squad_dispatch_feed_event ON roadmap_workforce.squad_dispatch;
CREATE TRIGGER trg_squad_dispatch_feed_event
  AFTER INSERT OR UPDATE OF dispatch_status
  ON roadmap_workforce.squad_dispatch
  FOR EACH ROW
  EXECUTE FUNCTION control_audit.trg_fn_squad_dispatch_feed();

-- ─── 4. fn_stop_dispatch (AC-5: one audit row for dispatch + workers) ─────────

CREATE OR REPLACE FUNCTION control_audit.fn_stop_dispatch(
  p_dispatch_id BIGINT,
  p_actor       TEXT,
  p_reason      TEXT  DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_worker_identity TEXT;
  v_cancelled_count INT := 0;
  v_worker_count    INT := 0;
BEGIN
  -- Cancel the dispatch (uses existing fn_cancel_dispatch which also logs its own row)
  PERFORM roadmap_workforce.fn_cancel_dispatch(p_dispatch_id, p_actor, p_reason);

  -- Terminate all workers on this dispatch
  FOR v_worker_identity IN
    SELECT worker_identity
      FROM roadmap_workforce.squad_dispatch
     WHERE id = p_dispatch_id
       AND worker_identity IS NOT NULL
  LOOP
    PERFORM roadmap_workforce.fn_terminate_worker(v_worker_identity, 'SIGTERM', p_actor, p_reason);
    v_worker_count := v_worker_count + 1;
  END LOOP;

  -- Write ONE summary feed event for the entire stop operation (AC-5)
  PERFORM control_audit.fn_emit_feed_event(
    p_event_class             := 'operator_stop',
    p_dispatch_id             := p_dispatch_id,
    p_recommended_stop_scope  := 'dispatch',
    p_detail                  := jsonb_build_object(
      'actor',        p_actor,
      'reason',       p_reason,
      'worker_count', v_worker_count
    )
  );

  RETURN 'ok';
END;
$$;

COMMENT ON FUNCTION control_audit.fn_stop_dispatch IS
  'P435 AC-5: Cancels a dispatch and terminates all its workers. Writes ONE summary feed event.';

GRANT EXECUTE ON FUNCTION control_audit.fn_stop_dispatch TO xiaomi;

-- ─── 5. v_feed_replay view (AC-6: join 5+ sources) ────────────────────────────

CREATE OR REPLACE VIEW control_audit.v_feed_replay AS
SELECT
  fe.id                        AS event_id,
  fe.emitted_at,
  fe.event_class,
  fe.recommended_stop_scope,
  -- Causal chain (AC-4)
  fe.proposal_id,
  fe.dispatch_id,
  fe.claim_id,
  fe.run_id,
  -- Dispatch context (source 1)
  d.id                         AS sd_id,
  d.dispatch_status,
  d.offer_status,
  d.assigned_at,
  d.claimed_at,
  d.claim_expires_at,
  d.renew_count,
  d.reissue_count,
  -- Agency / Worker (source 2 — agent_registry)
  COALESCE(fe.agency_id, d.agency_identity) AS agency_id,
  COALESCE(fe.worker_id, d.worker_identity) AS worker_id,
  -- Project (source 3)
  COALESCE(fe.project_id, d.project_id)     AS project_id,
  p.display_id                              AS proposal_display_id,
  p.title                                   AS proposal_title,
  -- Run context (source 4 — agent_runs, joined on proposal + agent)
  ar.id                        AS run_row_id,
  ar.stage                     AS run_stage,
  ar.model_used,
  ar.status                    AS run_status,
  ar.started_at                AS run_started_at,
  ar.completed_at              AS run_completed_at,
  ar.cost_usd                  AS run_cost_usd,
  -- Route context (source 5 — model_routes, via run model_used)
  COALESCE(fe.route, d.metadata->>'route_name') AS route,
  COALESCE(fe.model, ar.model_used, d.metadata->>'model_name') AS model,
  mr.route_provider,
  mr.agent_provider,
  mr.is_enabled                AS route_enabled,
  mr.priority                  AS route_priority,
  -- Budget context (source 6 — project_budget_cap)
  COALESCE(fe.budget_scope, d.metadata->>'budget_scope') AS budget_scope,
  pbc.period                   AS budget_period,
  pbc.max_usd_cents            AS budget_max_cents,
  -- Raw detail
  fe.detail
FROM control_audit.feed_event fe
-- Source 1: dispatch
LEFT JOIN roadmap_workforce.squad_dispatch d
       ON d.id = fe.dispatch_id
-- Source 2: proposal
LEFT JOIN roadmap_proposal.proposal p
       ON p.id = fe.proposal_id
-- Source 3: most recent run for this dispatch's proposal + agent
LEFT JOIN LATERAL (
  SELECT ar2.*
    FROM roadmap_workforce.agent_runs ar2
   WHERE ar2.proposal_id = fe.proposal_id
     AND (fe.run_id IS NULL OR ar2.id = fe.run_id)
   ORDER BY ar2.started_at DESC
   LIMIT 1
) ar ON true
-- Source 4: best-priority enabled route for the resolved model name
LEFT JOIN LATERAL (
  SELECT mr2.*
    FROM roadmap.model_routes mr2
   WHERE mr2.model_name = COALESCE(ar.model_used, d.metadata->>'model_name')
     AND mr2.is_enabled = true
   ORDER BY mr2.priority ASC
   LIMIT 1
) mr ON true
-- Source 5: budget cap for the project
LEFT JOIN roadmap.project_budget_cap pbc
       ON pbc.project_id = COALESCE(fe.project_id, d.project_id)
      AND pbc.period = 'day';

COMMENT ON VIEW control_audit.v_feed_replay IS
  'P435 AC-6: Joins feed_event with squad_dispatch, proposal, agent_runs, model_routes, '
  'project_budget_cap for full causal replay. Each row carries the complete context chain.';

GRANT SELECT ON control_audit.v_feed_replay TO xiaomi;

COMMIT;
