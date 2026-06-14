-- 268-p3313-feedback-loop.sql
-- P3313 (Child D of P3309 adaptive matching group):
--   Closed feedback loop + decision log + reliability floor + governance.
--
-- Dependencies (concurrent siblings, read-only here):
--   * P3311 roadmap_workforce.reliability_score  (Beta α/β ledger)  -> AC-2 write target
--   * P3310 task_class column (squad_dispatch.task_class)            -> task_class dimension
--   * P3312 matcher reads reliability_floor (this file) + reliability_score
--   * P772  roadmap.route_decision_log                              -> AC-1 extend
--
-- Collision-safety: P3312 (Child C) ALSO adds columns to route_decision_log
--   (matcher_choice / legacy_choice / shadow_mode = SHADOW columns).
--   Ours are the PER-AXIS decision fields. All ADD COLUMN IF NOT EXISTS so the
--   two migrations can land in any order without conflict.
--
-- Idempotent: safe to re-run. SELECT/DDL only; no destructive ops.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- AC-1: Extend route_decision_log with adaptive-matcher per-axis decision fields
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE roadmap.route_decision_log
  ADD COLUMN IF NOT EXISTS task_class        text,
  ADD COLUMN IF NOT EXISTS difficulty_score  numeric(6,4),   -- P3310 difficulty signal [0..1]
  ADD COLUMN IF NOT EXISTS required_tier     integer,        -- min capability tier demanded
  ADD COLUMN IF NOT EXISTS reliability_score numeric(6,5),   -- P3311 score of chosen route at decision time
  ADD COLUMN IF NOT EXISTS cost_rank         integer,        -- 1 = cheapest among candidates
  ADD COLUMN IF NOT EXISTS chosen_reason     text,           -- 'best_score' | 'exploration' | 'floor_block' | 'override_pin' | ...
  ADD COLUMN IF NOT EXISTS was_exploration   boolean NOT NULL DEFAULT false;  -- AC-4 anti-starvation flag

COMMENT ON COLUMN roadmap.route_decision_log.chosen_reason IS
  'P3313: why this route won — best_score | exploration | floor_block | override_pin | override_ban | only_candidate';

CREATE INDEX IF NOT EXISTS idx_route_decision_log_task_class
  ON roadmap.route_decision_log (task_class, decided_at DESC)
  WHERE task_class IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- AC-3: reliability_floor(task_class -> min_score) config table
--   Seeded conservatively: high-blast-radius classes get HIGH floors,
--   mechanical/triage get LOW floors. A downshift crossing a floor is BLOCKED
--   and emits an alert (never silent) — see fn_check_reliability_floor below.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS roadmap_workforce.reliability_floor (
  task_class   text         PRIMARY KEY,
  min_score    numeric(6,5) NOT NULL CHECK (min_score >= 0 AND min_score <= 1),
  rationale    text         NOT NULL DEFAULT '',
  is_hard      boolean      NOT NULL DEFAULT true,   -- hard floor blocks; soft floor only warns
  updated_by   text         NOT NULL DEFAULT 'migration:268-p3313',
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_workforce.reliability_floor IS
  'P3313 AC-3: per-task_class minimum reliability score. Read by P3312 matcher. '
  'A route whose score is below the floor for a HARD class must not be chosen for that class; '
  'an attempt to do so is blocked and an alert is emitted (reliability_floor_alert).';

-- Conservative seeds. High-blast-radius => high floor; cheap/mechanical => low floor.
INSERT INTO roadmap_workforce.reliability_floor (task_class, min_score, rationale, is_hard) VALUES
  ('gate_review',  0.85, 'Gate decisions advance proposals irreversibly; require proven reliability.', true),
  ('merge',        0.85, 'Merges touch shared main with high blast radius.',                            true),
  ('architecture', 0.80, 'Architecture choices are expensive to reverse downstream.',                   true),
  ('develop',      0.65, 'Feature build; reversible via review/revert but still costly.',               true),
  ('review',       0.70, 'Reviewer gates quality before merge.',                                        true),
  ('mcp_protocol', 0.75, 'MCP tool-call correctness is structural; protocol failures cascade.',         true),
  ('triage',       0.35, 'Triage is low-stakes classification; cheap models acceptable.',               false),
  ('mechanical',   0.30, 'Deterministic floor work; reliability matters little.',                       false),
  ('_global',      0.50, 'Default floor for any task_class without an explicit row.',                   false)
ON CONFLICT (task_class) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- AC-4: exploration headroom config (reuses the P3000 reserved-headroom idea:
--   reserve a fraction of traffic for low-but-improving routes so they are not
--   starved out of the ledger entirely). Per task_class with a global default.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS roadmap_workforce.exploration_headroom (
  task_class        text         PRIMARY KEY,
  epsilon           numeric(5,4) NOT NULL DEFAULT 0.10 CHECK (epsilon >= 0 AND epsilon <= 1),
  min_sample_target integer      NOT NULL DEFAULT 20,    -- below this effective sample count a route is "under-explored"
  updated_at        timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_workforce.exploration_headroom IS
  'P3313 AC-4: reserved exploration fraction (epsilon) per task_class. The matcher should '
  'route epsilon of traffic to under-explored (low effective_sample_count) but non-floor-violating '
  'routes so a low-but-improving route still receives traffic. Reuses P3000 reserved-headroom pattern.';

INSERT INTO roadmap_workforce.exploration_headroom (task_class, epsilon, min_sample_target) VALUES
  ('_global',      0.10, 20),
  ('triage',       0.20, 15),   -- cheap class: explore aggressively
  ('mechanical',   0.20, 15),
  ('gate_review',  0.03, 40),   -- high-stakes: explore sparingly, demand more samples
  ('merge',        0.03, 40),
  ('architecture', 0.05, 35)
ON CONFLICT (task_class) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- AC-3 enforcement: floor check that BLOCKS and emits an alert (never silent).
--   Returns TRUE if the (scope,task_class) candidate is ALLOWED, FALSE if blocked.
--   On a HARD-floor violation it records a reliability_floor_alert row, RAISES a
--   WARNING, and pg_notify's 'reliability_floor_alert' so the block is observable.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS roadmap_workforce.reliability_floor_alert (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_class  text         NOT NULL,
  scope_type  text         NOT NULL,
  scope_key   text         NOT NULL,
  observed    numeric(6,5) NOT NULL,
  floor       numeric(6,5) NOT NULL,
  blocked     boolean      NOT NULL,        -- true = candidate was rejected
  context     jsonb        NOT NULL DEFAULT '{}'::jsonb,
  fired_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reliability_floor_alert_recent
  ON roadmap_workforce.reliability_floor_alert (fired_at DESC);

COMMENT ON TABLE roadmap_workforce.reliability_floor_alert IS
  'P3313 AC-3: audit of every floor evaluation that crossed a floor. blocked=true rows are '
  'hard-floor rejections (never silent — also RAISE WARNING + pg_notify).';

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_check_reliability_floor(
  p_task_class text,
  p_scope_type text,
  p_scope_key  text,
  p_observed   numeric,
  p_context    jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  v_floor   numeric(6,5);
  v_hard    boolean;
BEGIN
  -- Resolve floor: explicit class row, else _global default.
  SELECT min_score, is_hard INTO v_floor, v_hard
  FROM roadmap_workforce.reliability_floor
  WHERE task_class = p_task_class;

  IF NOT FOUND THEN
    SELECT min_score, is_hard INTO v_floor, v_hard
    FROM roadmap_workforce.reliability_floor
    WHERE task_class = '_global';
  END IF;

  -- No floor configured at all => allow (defensive; _global is always seeded).
  IF v_floor IS NULL THEN
    RETURN true;
  END IF;

  -- Above floor => allowed, no alert.
  IF p_observed >= v_floor THEN
    RETURN true;
  END IF;

  -- Below floor: record the crossing (never silent).
  INSERT INTO roadmap_workforce.reliability_floor_alert
    (task_class, scope_type, scope_key, observed, floor, blocked, context)
  VALUES
    (p_task_class, p_scope_type, p_scope_key, p_observed, v_floor, v_hard, COALESCE(p_context, '{}'::jsonb));

  PERFORM pg_notify(
    'reliability_floor_alert',
    json_build_object(
      'task_class', p_task_class,
      'scope_type', p_scope_type,
      'scope_key',  p_scope_key,
      'observed',   p_observed,
      'floor',      v_floor,
      'blocked',    v_hard
    )::text
  );

  IF v_hard THEN
    RAISE WARNING 'P3313 reliability floor BLOCK: %/% score=% < floor=% for task_class=%',
      p_scope_type, p_scope_key, p_observed, v_floor, p_task_class;
    RETURN false;   -- BLOCKED
  ELSE
    RAISE WARNING 'P3313 reliability floor SOFT-WARN: %/% score=% < floor=% for task_class=% (allowed)',
      p_scope_type, p_scope_key, p_observed, v_floor, p_task_class;
    RETURN true;    -- soft floor: warned but allowed
  END IF;
END;
$function$;

COMMENT ON FUNCTION roadmap_workforce.fn_check_reliability_floor(text,text,text,numeric,jsonb) IS
  'P3313 AC-3: returns TRUE if candidate may be chosen for task_class, FALSE if a HARD floor blocks it. '
  'Always records a reliability_floor_alert + pg_notify on any floor crossing (never silent).';

-- ════════════════════════════════════════════════════════════════════════════
-- AC-2 (backend): closed-loop incremental ledger update.
--   P3311 fn_refresh_reliability_scores is a FULL batch recompute — too heavy
--   to run per-run. This is the incremental single-cell Beta bump invoked by the
--   post-run hook (recordReliabilityOutcome). A recorded failure raises β, which
--   lowers score = α/(α+β) on the next read. Decay of priors is left to the
--   periodic batch refresh; this gives an immediate, monotonic-on-failure signal.
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_record_run_outcome(
  p_scope_type text,         -- 'model' | 'agency' | 'route'
  p_scope_key  text,
  p_task_class text,
  p_outcome    text,         -- 'success' | 'hard_failure' | 'protocol_failure' | 'rework' | 'mismatch'
  p_weight     numeric DEFAULT 1.0
) RETURNS TABLE(score numeric, alpha numeric, beta_param numeric)
LANGUAGE plpgsql
AS $function$
DECLARE
  v_tc        text := COALESCE(NULLIF(p_task_class, ''), '_global');
  v_w         numeric := GREATEST(COALESCE(p_weight, 1.0), 0);
  v_dalpha    numeric := 0;
  v_dbeta     numeric := 0;
  v_dsuccess  numeric := 0;
  v_dhard     numeric := 0;
  v_dproto    numeric := 0;
  v_drework   numeric := 0;
  v_dmismatch numeric := 0;
BEGIN
  IF p_scope_type NOT IN ('model','agency','route') THEN
    RAISE EXCEPTION 'fn_record_run_outcome: invalid scope_type %', p_scope_type;
  END IF;

  -- Map outcome to Beta increment + per-signal weight column.
  CASE p_outcome
    WHEN 'success'          THEN v_dalpha := v_w; v_dsuccess := v_w;
    WHEN 'hard_failure'     THEN v_dbeta  := v_w; v_dhard    := v_w;
    WHEN 'protocol_failure' THEN v_dbeta  := v_w * 0.8; v_dproto := v_w * 0.8;
    WHEN 'rework'           THEN v_dbeta  := v_w * 0.4; v_drework := v_w * 0.4;
    WHEN 'mismatch'         THEN v_dbeta  := v_w * 0.2; v_dmismatch := v_w * 0.2;
    ELSE
      RAISE EXCEPTION 'fn_record_run_outcome: invalid outcome %', p_outcome;
  END CASE;

  INSERT INTO roadmap_workforce.reliability_score AS rs (
    scope_type, scope_key, task_class,
    alpha, beta_param,
    effective_sample_count, sample_count,
    success_weight, hard_failure_weight, protocol_failure_weight,
    rework_weight, mismatch_weight,
    window_start, window_end, last_updated_at
  ) VALUES (
    p_scope_type, p_scope_key, v_tc,
    -- Cold-start prior 5/5 (matches P3311 fn_get_reliability default) plus this outcome.
    5.0 + v_dalpha, 5.0 + v_dbeta,
    v_w, 1,
    v_dsuccess, v_dhard, v_dproto, v_drework, v_dmismatch,
    now(), now(), now()
  )
  ON CONFLICT (scope_type, scope_key, task_class) DO UPDATE SET
    alpha                   = rs.alpha + v_dalpha,
    beta_param              = rs.beta_param + v_dbeta,
    effective_sample_count  = rs.effective_sample_count + v_w,
    sample_count            = rs.sample_count + 1,
    success_weight          = rs.success_weight + v_dsuccess,
    hard_failure_weight     = rs.hard_failure_weight + v_dhard,
    protocol_failure_weight = rs.protocol_failure_weight + v_dproto,
    rework_weight           = rs.rework_weight + v_drework,
    mismatch_weight         = rs.mismatch_weight + v_dmismatch,
    window_end              = now(),
    last_updated_at         = now();

  RETURN QUERY
    SELECT rs.score, rs.alpha, rs.beta_param
    FROM roadmap_workforce.reliability_score rs
    WHERE rs.scope_type = p_scope_type
      AND rs.scope_key  = p_scope_key
      AND rs.task_class = v_tc;
END;
$function$;

COMMENT ON FUNCTION roadmap_workforce.fn_record_run_outcome(text,text,text,text,numeric) IS
  'P3313 AC-2: closed-loop incremental Beta update for a single (scope,task_class) cell. '
  'Called by the post-run hook. Failures raise beta_param, lowering score on next read.';

-- ════════════════════════════════════════════════════════════════════════════
-- AC-5: operator surfaces — override (pin/ban) table + recent-decisions view.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS roadmap_workforce.route_match_override (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_class   text         NOT NULL,
  route_id     integer      NOT NULL,
  mode         text         NOT NULL CHECK (mode IN ('pin','ban')),
  reason       text         NOT NULL DEFAULT '',
  created_by   text         NOT NULL,         -- audited actor
  created_at   timestamptz  NOT NULL DEFAULT now(),
  expires_at   timestamptz,                   -- NULL = until manually cleared
  cleared_at   timestamptz,
  cleared_by   text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_route_match_override_active
  ON roadmap_workforce.route_match_override (task_class, route_id)
  WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_match_override_active
  ON roadmap_workforce.route_match_override (task_class)
  WHERE cleared_at IS NULL;

COMMENT ON TABLE roadmap_workforce.route_match_override IS
  'P3313 AC-5: operator pin/ban of a route for a task_class. Read by the matcher (P3312). '
  'pin = force this route; ban = exclude this route. Audited (created_by / cleared_by).';

-- Recent match decisions joined with the chosen route's current reliability.
CREATE OR REPLACE VIEW roadmap_workforce.v_match_decisions AS
SELECT
  rdl.id,
  rdl.decided_at,
  rdl.proposal_id,
  rdl.role,
  rdl.agency_identity,
  rdl.task_class,
  rdl.chosen_route_id,
  rdl.difficulty_score,
  rdl.required_tier,
  rdl.reliability_score        AS reliability_at_decision,
  rs.score                     AS reliability_now,
  rdl.cost_rank,
  rdl.chosen_reason,
  rdl.was_exploration,
  jsonb_array_length(rdl.eliminated_routes) AS eliminated_count
FROM roadmap.route_decision_log rdl
LEFT JOIN roadmap_workforce.reliability_score rs
  ON rs.scope_type = 'route'
 AND rs.scope_key  = rdl.chosen_route_id::text
 AND rs.task_class = COALESCE(rdl.task_class, '_global')
ORDER BY rdl.decided_at DESC;

COMMENT ON VIEW roadmap_workforce.v_match_decisions IS
  'P3313 AC-5: dashboard data source — recent adaptive-match decisions with the chosen route''s '
  'reliability at decision time vs. now. Pair with v_reliability_summary for the per-(model,task_class) panel.';

COMMIT;
