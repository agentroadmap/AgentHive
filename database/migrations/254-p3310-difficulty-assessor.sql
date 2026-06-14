-- P3310: Dynamic difficulty assessor — persist difficulty_score, required_capability_tier,
-- and task_class on squad_dispatch at offer-mint time.
-- Also adds per-proposal task_class + tier_override columns as explicit override mechanism.

ALTER TABLE roadmap_workforce.squad_dispatch
  ADD COLUMN IF NOT EXISTS difficulty_score NUMERIC(4,3)
    CHECK (difficulty_score IS NULL OR (difficulty_score >= 0 AND difficulty_score <= 1)),
  ADD COLUMN IF NOT EXISTS required_capability_tier TEXT
    CHECK (required_capability_tier IS NULL OR required_capability_tier IN ('free','lower','mid','frontier','tool')),
  ADD COLUMN IF NOT EXISTS task_class TEXT
    CHECK (task_class IS NULL OR task_class IN ('mcp_protocol','code_dev','gate_review','triage','mechanical','research'));

COMMENT ON COLUMN roadmap_workforce.squad_dispatch.difficulty_score IS
  'P3310: weighted heuristic difficulty in [0,1], computed at offer-mint time.';
COMMENT ON COLUMN roadmap_workforce.squad_dispatch.required_capability_tier IS
  'P3310: minimum capability tier required (P1005/P1091 vocabulary: free/lower/mid/frontier/tool).';
COMMENT ON COLUMN roadmap_workforce.squad_dispatch.task_class IS
  'P3310: task category consumed by unified matcher (Child C P3312).';

-- Per-proposal explicit overrides: task_class tag and tier floor.
-- When set, these beat the heuristic on every offer minted for the proposal.
ALTER TABLE roadmap_proposal.proposal
  ADD COLUMN IF NOT EXISTS task_class TEXT
    CHECK (task_class IS NULL OR task_class IN ('mcp_protocol','code_dev','gate_review','triage','mechanical','research')),
  ADD COLUMN IF NOT EXISTS tier_override TEXT
    CHECK (tier_override IS NULL OR tier_override IN ('free','lower','mid','frontier','tool'));

COMMENT ON COLUMN roadmap_proposal.proposal.task_class IS
  'P3310: explicit task class; overrides heuristic when set.';
COMMENT ON COLUMN roadmap_proposal.proposal.tier_override IS
  'P3310: explicit tier floor; overrides heuristic-derived tier when set.';
