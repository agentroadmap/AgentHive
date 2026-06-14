-- Migration 269: P3313 AC-1 — extend route_decision_log with adaptive-matcher columns
-- Adds the four axis scores + chosen_reason so every matchWorkToRoute decision is auditable.
-- Additive-only; all columns nullable so existing rows are unaffected.

ALTER TABLE roadmap.route_decision_log
  ADD COLUMN IF NOT EXISTS difficulty_score      NUMERIC(4,3)
    CHECK (difficulty_score IS NULL OR (difficulty_score >= 0 AND difficulty_score <= 1)),
  ADD COLUMN IF NOT EXISTS required_tier         TEXT
    CHECK (required_tier IS NULL OR required_tier IN ('free','lower','mid','frontier','tool')),
  ADD COLUMN IF NOT EXISTS reliability_score     NUMERIC(4,3)
    CHECK (reliability_score IS NULL OR (reliability_score >= 0 AND reliability_score <= 1)),
  ADD COLUMN IF NOT EXISTS cost_rank             SMALLINT,
  ADD COLUMN IF NOT EXISTS chosen_reason         TEXT,
  ADD COLUMN IF NOT EXISTS task_class            TEXT;

COMMENT ON COLUMN roadmap.route_decision_log.difficulty_score IS
  'P3313: difficulty score [0,1] of the work item at match time (from P3310 assessor).';
COMMENT ON COLUMN roadmap.route_decision_log.required_tier IS
  'P3313: minimum tier derived from difficulty_score (P1005 tier vocabulary).';
COMMENT ON COLUMN roadmap.route_decision_log.reliability_score IS
  'P3313: reliability score [0,1] of the chosen route for this task_class (from P3311 ledger).';
COMMENT ON COLUMN roadmap.route_decision_log.cost_rank IS
  'P3313: 1-based rank of chosen route by cost among eligible candidates (1=cheapest).';
COMMENT ON COLUMN roadmap.route_decision_log.chosen_reason IS
  'P3313: human-readable rationale for why this route was selected.';
COMMENT ON COLUMN roadmap.route_decision_log.task_class IS
  'P3313: task classification at match time (mcp_protocol/code_dev/gate_review/etc.).';

-- Fast lookups for the operator dashboard (AC-5)
CREATE INDEX IF NOT EXISTS idx_rdl_task_class
  ON roadmap.route_decision_log (task_class)
  WHERE task_class IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rdl_chosen_route_class
  ON roadmap.route_decision_log (chosen_route_id, task_class, decided_at DESC)
  WHERE chosen_route_id IS NOT NULL AND task_class IS NOT NULL;
