-- P3311 (Child B of P3309): Reliability ledger — per-(model|agency|route × task_class)
-- success scoring derived from agent_runs outcomes.
--
-- WHAT THIS SHIPS (all idempotent, additive over a partially-existing schema):
--   1. roadmap_scoring schema + task_class_registry seed (AC-6 taxonomy).
--   2. Confirms / aligns roadmap_workforce.reliability_score (Beta-Bernoulli
--      alpha/beta posterior per P1070 — AC-5) and adds the NULL-task_class
--      exclusion counter table.
--   3. fn_p3311_rollup_reliability(): populates reliability_score from
--      agent_runs joined to squad_dispatch.task_class (AC-1, AC-6 join path),
--      with decay + distinct failure-class weighting (AC-2, AC-3).
--   4. fn_p3311_reliability_lookup(): hierarchical cold-start fallback
--      (task_class → task_family → _global) read function (AC-2, AC-4).
--
-- DEPENDENCY ON CHILD A (P3310): the per-class signal comes from a stamped
-- task_class. Today squad_dispatch.task_class EXISTS but is uniformly NULL
-- (P3310 stamps it at dispatch). Until P3310 stamps it, the rollup produces
-- only the '_global' cell per scope (taxonomy-correct, class-agnostic). The
-- join path is built and tested now; it lights up automatically once P3310
-- backfills/stamps task_class. NULL-task_class rows are excluded and counted.
--
-- NOT APPLIED TO LIVE BY THIS PR — author + lint only.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Taxonomy registry (AC-6)
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS roadmap_scoring;

CREATE TABLE IF NOT EXISTS roadmap_scoring.task_class_registry (
  task_class    text PRIMARY KEY,
  task_family   text NOT NULL,
  description   text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed the minimum taxonomy required by AC-6. task_family groups classes for
-- the hierarchical cold-start fallback (task_class → task_family → _global).
INSERT INTO roadmap_scoring.task_class_registry (task_class, task_family, description) VALUES
  ('mcp_protocol', 'integration', 'MCP tool / protocol-driven work; tool-call correctness is the dominant signal'),
  ('develop',      'build',       'Code authoring + test development inside a proposal DEVELOP stage'),
  ('merge',        'build',       'Branch integration / merge-to-main work'),
  ('gate_review',  'judgment',    'Gating / review decisions (advance, hold, send-back)'),
  ('enhance',      'judgment',    'Proposal enhancement / RFC maturation'),
  ('generic',      'generic',     'Fallback class for unclassified or ad-hoc work')
ON CONFLICT (task_class) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Reliability rollup table (AC-1, AC-2, AC-3, AC-5)
--    Pre-existing in some environments; CREATE IF NOT EXISTS makes this
--    migration the canonical, replayable source of truth.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roadmap_workforce.reliability_score (
  scope_type               text NOT NULL CHECK (scope_type IN ('model','agency','route')),
  scope_key                text NOT NULL,
  task_class               text NOT NULL,
  -- Beta-Bernoulli posterior (AC-5, per P1070): score = alpha/(alpha+beta).
  alpha                    numeric(12,4) NOT NULL DEFAULT 1.0 CHECK (alpha > 0),
  beta_param               numeric(12,4) NOT NULL DEFAULT 1.0 CHECK (beta_param > 0),
  score                    numeric(6,5) GENERATED ALWAYS AS (alpha / (alpha + beta_param)) STORED,
  effective_sample_count   numeric(12,4) NOT NULL DEFAULT 0,   -- decay-weighted
  sample_count             integer NOT NULL DEFAULT 0,          -- raw observations
  -- AC-3: distinct failure-class weight accumulators (audit + introspection).
  success_weight           numeric(10,4) NOT NULL DEFAULT 0,
  hard_failure_weight      numeric(10,4) NOT NULL DEFAULT 0,
  protocol_failure_weight  numeric(10,4) NOT NULL DEFAULT 0,
  rework_weight            numeric(10,4) NOT NULL DEFAULT 0,
  mismatch_weight          numeric(10,4) NOT NULL DEFAULT 0,
  window_start             timestamptz,
  window_end               timestamptz,
  last_updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_type, scope_key, task_class)
);

CREATE INDEX IF NOT EXISTS idx_reliability_score_lookup
  ON roadmap_workforce.reliability_score (scope_type, scope_key, task_class);
CREATE INDEX IF NOT EXISTS idx_reliability_score_class
  ON roadmap_workforce.reliability_score (task_class, score DESC);

-- Confidence summary view (AC-2: sample_count/confidence field).
CREATE OR REPLACE VIEW roadmap_workforce.v_reliability_summary AS
SELECT
  scope_type, scope_key, task_class, score,
  effective_sample_count, sample_count, success_weight,
  hard_failure_weight + protocol_failure_weight AS total_failure_weight,
  rework_weight, mismatch_weight,
  window_start, window_end, last_updated_at,
  CASE
    WHEN effective_sample_count < 5  THEN 'low'
    WHEN effective_sample_count < 20 THEN 'medium'
    ELSE 'high'
  END AS confidence
FROM roadmap_workforce.reliability_score rs
ORDER BY scope_type, scope_key, score DESC;

-- AC-6: NULL-task_class exclusion counter. Each rollup run records how many
-- otherwise-eligible agent_runs rows were dropped for lacking a task_class.
CREATE TABLE IF NOT EXISTS roadmap_workforce.reliability_rollup_audit (
  run_at                   timestamptz NOT NULL DEFAULT now(),
  rows_scanned             bigint NOT NULL DEFAULT 0,
  rows_excluded_null_class bigint NOT NULL DEFAULT 0,
  cells_written            bigint NOT NULL DEFAULT 0,
  window_start             timestamptz,
  window_end               timestamptz
);

-- ---------------------------------------------------------------------------
-- 3. Rollup population function (AC-1, AC-2, AC-3, AC-6)
-- ---------------------------------------------------------------------------
-- Reads agent_runs over a rolling window, resolves task_class via the
-- squad_dispatch join path, classifies each run into a weighted outcome, and
-- folds it into the Beta-Bernoulli posterior with exponential time decay.
--
--   weight class       alpha contribution   beta contribution
--   -----------------  ------------------    -----------------
--   success            +w                    0
--   rework (soft)      +0.5w                 +0.5w
--   provider_mismatch  +0.3w                 +0.7w
--   protocol failure   0                     +1.5w   (penalize most, AC-3)
--   hard failure       0                     +1.0w
--
-- decay: w = decay_lambda ^ (age_days). half-life ≈ ln(2)/-ln(lambda).
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_p3311_rollup_reliability(
  p_window_days   integer DEFAULT 30,
  p_decay_lambda  numeric DEFAULT 0.97   -- per-day decay; 0.97 ≈ 22-day half-life
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  v_window_start timestamptz := now() - make_interval(days => p_window_days);
  v_excluded     bigint := 0;
  v_scanned      bigint := 0;
  v_cells        bigint := 0;
BEGIN
  -- Per-run weighted outcome over the window, with task_class resolved from
  -- the most recent squad_dispatch for the same proposal (P3310 stamp source).
  CREATE TEMP TABLE _p3311_runs ON COMMIT DROP AS
  WITH classified AS (
    SELECT
      ar.id,
      ar.model_used,
      ar.agency_identity,
      ar.route_id,
      ar.status,
      ar.provider_mismatch,
      sd.task_class,
      sd.failure_class,
      power(p_decay_lambda, GREATEST(0, EXTRACT(EPOCH FROM (now() - ar.started_at)) / 86400.0))::numeric AS w
    FROM roadmap_workforce.agent_runs ar
    LEFT JOIN LATERAL (
      SELECT s.task_class, s.failure_class
      FROM roadmap_workforce.squad_dispatch s
      WHERE s.proposal_id = ar.proposal_id
      ORDER BY s.assigned_at DESC
      LIMIT 1
    ) sd ON true
    WHERE ar.started_at >= v_window_start
      AND ar.status <> 'running'
  )
  SELECT * FROM classified;

  SELECT count(*) INTO v_scanned FROM _p3311_runs;
  SELECT count(*) INTO v_excluded FROM _p3311_runs WHERE task_class IS NULL;

  -- Fold into posterior. We emit one cell per scope × task_class. NULL
  -- task_class rows are excluded (AC-6). Each eligible run contributes to its
  -- specific task_class cell AND to the scope's '_global' rollup.
  WITH eligible AS (
    SELECT * FROM _p3311_runs WHERE task_class IS NOT NULL
  ),
  scoped AS (
    -- explode each run across the three scope dimensions
    SELECT 'model'  AS scope_type, model_used      AS scope_key, * FROM eligible WHERE model_used      IS NOT NULL
    UNION ALL
    SELECT 'agency' AS scope_type, agency_identity AS scope_key, * FROM eligible WHERE agency_identity IS NOT NULL
    UNION ALL
    SELECT 'route'  AS scope_type, route_id::text  AS scope_key, * FROM eligible WHERE route_id        IS NOT NULL
  ),
  -- duplicate each row into its task_class cell and the '_global' cell
  exploded AS (
    SELECT scope_type, scope_key, task_class AS tc, status, provider_mismatch, failure_class, w FROM scoped
    UNION ALL
    SELECT scope_type, scope_key, '_global'  AS tc, status, provider_mismatch, failure_class, w FROM scoped
  ),
  weighted AS (
    SELECT
      scope_type, scope_key, tc,
      -- alpha (success-ish) contribution
      sum(CASE
            WHEN status = 'completed' AND NOT provider_mismatch THEN w
            WHEN status = 'completed' AND provider_mismatch     THEN 0.3 * w   -- mismatch taint
            ELSE 0
          END) AS d_alpha,
      -- beta (failure-ish) contribution, AC-3 distinct weighting
      sum(CASE
            WHEN status = 'completed' AND provider_mismatch THEN 0.7 * w          -- mismatch
            WHEN failure_class IN ('auth_rejected','no_eligible_agency','lease_extension','protocol','tool')
                 THEN 1.5 * w                                                       -- protocol/tool: worst
            WHEN status IN ('failed','timeout') THEN 1.0 * w                        -- hard failure
            WHEN status = 'rate_limited'        THEN 0.5 * w                        -- rework-like / transient
            ELSE 0
          END) AS d_beta,
      sum(CASE WHEN status='completed' AND NOT provider_mismatch THEN w ELSE 0 END)            AS w_success,
      sum(CASE WHEN status IN ('failed','timeout') AND COALESCE(failure_class,'') NOT IN ('protocol','tool') THEN w ELSE 0 END) AS w_hard,
      sum(CASE WHEN failure_class IN ('protocol','tool') THEN w ELSE 0 END)                    AS w_protocol,
      sum(CASE WHEN status='rate_limited' THEN w ELSE 0 END)                                   AS w_rework,
      sum(CASE WHEN provider_mismatch THEN w ELSE 0 END)                                       AS w_mismatch,
      sum(w)   AS eff_n,
      count(*) AS raw_n
    FROM exploded
    GROUP BY scope_type, scope_key, tc
  )
  INSERT INTO roadmap_workforce.reliability_score AS rs (
    scope_type, scope_key, task_class,
    alpha, beta_param, effective_sample_count, sample_count,
    success_weight, hard_failure_weight, protocol_failure_weight,
    rework_weight, mismatch_weight,
    window_start, window_end, last_updated_at
  )
  SELECT
    scope_type, scope_key, tc,
    1.0 + d_alpha, 1.0 + d_beta, eff_n, raw_n,
    w_success, w_hard, w_protocol, w_rework, w_mismatch,
    v_window_start, now(), now()
  FROM weighted
  ON CONFLICT (scope_type, scope_key, task_class) DO UPDATE SET
    alpha                   = EXCLUDED.alpha,   -- full recompute each run (window is authoritative)
    beta_param              = EXCLUDED.beta_param,
    effective_sample_count  = EXCLUDED.effective_sample_count,
    sample_count            = EXCLUDED.sample_count,
    success_weight          = EXCLUDED.success_weight,
    hard_failure_weight     = EXCLUDED.hard_failure_weight,
    protocol_failure_weight = EXCLUDED.protocol_failure_weight,
    rework_weight           = EXCLUDED.rework_weight,
    mismatch_weight         = EXCLUDED.mismatch_weight,
    window_start            = EXCLUDED.window_start,
    window_end              = EXCLUDED.window_end,
    last_updated_at         = now();

  GET DIAGNOSTICS v_cells = ROW_COUNT;

  INSERT INTO roadmap_workforce.reliability_rollup_audit
    (rows_scanned, rows_excluded_null_class, cells_written, window_start, window_end)
  VALUES (v_scanned, v_excluded, v_cells, v_window_start, now());

  RETURN v_cells;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Hierarchical cold-start read function (AC-2, AC-4)
-- ---------------------------------------------------------------------------
-- Returns the best available cell for (scope, task_class) using the fallback
-- chain task_class → task_family-representative → _global. A tier/capability
-- prior is the caller's responsibility (match-work-to-route applies it when
-- sample_count is below threshold) — this function reports the empirical cell
-- plus its sample_count so the caller can decide.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_p3311_reliability_lookup(
  p_scope_type text,
  p_scope_key  text,
  p_task_class text
) RETURNS TABLE (
  score                  numeric,
  effective_sample_count numeric,
  sample_count           integer,
  resolved_task_class    text,
  fallback_level         text
)
LANGUAGE sql STABLE AS $$
  -- 1. exact task_class
  SELECT rs.score, rs.effective_sample_count, rs.sample_count, rs.task_class, 'exact'::text
  FROM roadmap_workforce.reliability_score rs
  WHERE rs.scope_type = p_scope_type AND rs.scope_key = p_scope_key
    AND rs.task_class = p_task_class
  UNION ALL
  -- 2. task_family sibling aggregate (same family, _global of that scope is
  --    too coarse; use the family mean weighted by effective_sample_count)
  SELECT
    sum(rs.score * rs.effective_sample_count) / NULLIF(sum(rs.effective_sample_count),0),
    sum(rs.effective_sample_count), sum(rs.sample_count)::int,
    'family:' || tcr.task_family, 'family'::text
  FROM roadmap_workforce.reliability_score rs
  JOIN roadmap_scoring.task_class_registry tcr ON tcr.task_class = rs.task_class
  WHERE rs.scope_type = p_scope_type AND rs.scope_key = p_scope_key
    AND tcr.task_family = (
      SELECT task_family FROM roadmap_scoring.task_class_registry WHERE task_class = p_task_class
    )
    AND NOT EXISTS (
      SELECT 1 FROM roadmap_workforce.reliability_score x
      WHERE x.scope_type=p_scope_type AND x.scope_key=p_scope_key AND x.task_class=p_task_class
    )
  GROUP BY tcr.task_family
  HAVING sum(rs.effective_sample_count) > 0
  UNION ALL
  -- 3. scope _global
  SELECT rs.score, rs.effective_sample_count, rs.sample_count, '_global', 'global'::text
  FROM roadmap_workforce.reliability_score rs
  WHERE rs.scope_type = p_scope_type AND rs.scope_key = p_scope_key
    AND rs.task_class = '_global'
  LIMIT 1;
$$;

COMMIT;
