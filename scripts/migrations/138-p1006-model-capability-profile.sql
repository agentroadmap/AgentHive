/**
 * P1006: Model Capability Registry
 *
 * AC-1:  Creates roadmap_workforce.model_capability_profile with all required columns.
 * AC-2:  Seeds 9 canonical models with scored capability profiles.
 * AC-3:  Capability scores use 0-5 scale with CHECK constraints.
 * AC-4:  Extends roadmap.work_offer with capability requirement columns.
 * AC-11: can_spawn_workers column — true for anthropic/codex only.
 * AC-12: task_category column on work_offer with 8-value CHECK.
 * AC-9:  provider column enables cross-reference with host_model_policy.allowed_providers.
 */

BEGIN;

-- ─── AC-1: model_capability_profile table ────────────────────────────────────
-- Primary key: (provider, model_name) — natural key, no surrogate needed.
-- supports_long_context is a generated column derived from context_window_k.
CREATE TABLE IF NOT EXISTS roadmap_workforce.model_capability_profile (
  provider                    TEXT        NOT NULL,
  model_name                  TEXT        NOT NULL,
  cost_tier                   INTEGER     NOT NULL CHECK (cost_tier BETWEEN 0 AND 3),
  is_free                     BOOLEAN     NOT NULL DEFAULT FALSE,
  cost_per_1m_input_usd       NUMERIC(12,6),
  cost_per_1m_output_usd      NUMERIC(12,6),
  -- AC-3: 0=incapable 1=toy 2=adequate 3=solid 4=strong 5=best-in-class
  reasoning_score             INTEGER     NOT NULL DEFAULT 0 CHECK (reasoning_score BETWEEN 0 AND 5),
  code_quality_score          INTEGER     NOT NULL DEFAULT 0 CHECK (code_quality_score BETWEEN 0 AND 5),
  instruction_following_score INTEGER     NOT NULL DEFAULT 0 CHECK (instruction_following_score BETWEEN 0 AND 5),
  context_window_k            INTEGER,
  supports_tool_use           BOOLEAN     NOT NULL DEFAULT FALSE,
  supports_vision             BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Generated: true when context_window_k >= 100k tokens
  supports_long_context       BOOLEAN     GENERATED ALWAYS AS
                                (context_window_k IS NOT NULL AND context_window_k >= 100) STORED,
  rpm_limit                   INTEGER,
  tpm_limit                   INTEGER,
  avg_latency_class           TEXT,
  is_active                   BOOLEAN     NOT NULL DEFAULT TRUE,
  -- AC-11: true for anthropic and codex only; false for copilot, gemini
  can_spawn_workers           BOOLEAN     NOT NULL DEFAULT FALSE,
  notes                       TEXT,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model_name)
);

COMMENT ON COLUMN roadmap_workforce.model_capability_profile.reasoning_score IS
  'Scale 0-5: incapable, toy, adequate, solid, strong, best-in-class. '
  'Reflects complex reasoning, long-context synthesis, chain-of-thought capability.';
COMMENT ON COLUMN roadmap_workforce.model_capability_profile.code_quality_score IS
  'Scale 0-5: incapable, toy, adequate, solid, strong, best-in-class. '
  'Reflects code generation accuracy, bug rate, optimization quality.';
COMMENT ON COLUMN roadmap_workforce.model_capability_profile.instruction_following_score IS
  'Scale 0-5: incapable, toy, adequate, solid, strong, best-in-class. '
  'Reflects consistency in following system prompts, output format constraints, structured output.';
COMMENT ON COLUMN roadmap_workforce.model_capability_profile.can_spawn_workers IS
  'true if provider supports agent sub-spawning (anthropic, codex). false for gemini, copilot.';

CREATE INDEX IF NOT EXISTS idx_model_capability_profile_active
  ON roadmap_workforce.model_capability_profile (is_active);
CREATE INDEX IF NOT EXISTS idx_model_capability_profile_scores
  ON roadmap_workforce.model_capability_profile (reasoning_score, code_quality_score, instruction_following_score);

-- AC-2: Seed 9 canonical models
INSERT INTO roadmap_workforce.model_capability_profile
  (provider, model_name, cost_tier, is_free,
   cost_per_1m_input_usd, cost_per_1m_output_usd,
   reasoning_score, code_quality_score, instruction_following_score,
   context_window_k, supports_tool_use, supports_vision,
   rpm_limit, tpm_limit, avg_latency_class,
   can_spawn_workers, notes)
VALUES
  -- Anthropic (can_spawn_workers=true)
  ('anthropic', 'claude-opus-4-7',   3, FALSE,  3.0,  15.0, 5, 5, 5, 200, TRUE,  TRUE,  10000, 1000000, 'moderate', TRUE,
   'Best-in-class reasoning and instruction following'),
  ('anthropic', 'claude-sonnet-4-6', 2, FALSE,  3.0,  15.0, 4, 4, 5, 200, TRUE,  TRUE,  10000, 1000000, 'fast',     TRUE,
   'Strong code quality and instruction following'),
  ('anthropic', 'claude-haiku-4-5',  1, FALSE,  0.8,   4.0, 3, 3, 4, 100, TRUE,  FALSE, 10000, 1000000, 'fast',     TRUE,
   'Lightweight model without vision support'),
  -- Codex (can_spawn_workers=true)
  ('codex',     'codex-5.5',         2, FALSE,  2.0,   8.0, 4, 5, 4, 150, TRUE,  FALSE, 15000,  500000, 'moderate', TRUE,
   'Excellent code quality scores'),
  -- Copilot / GPT (can_spawn_workers=false)
  ('copilot',   'gpt-4.1',           2, FALSE,  3.0,   6.0, 4, 4, 4, 128, TRUE,  TRUE,   5000,  100000, 'moderate', FALSE,
   'Standard GPT-4.1 with copilot backend'),
  ('copilot',   'gpt-4.1-mini',      0, TRUE,   0.0,   0.0, 2, 2, 3, 128, TRUE,  FALSE, 10000, 1000000, 'fast',     FALSE,
   'Free tier-0 model without spawn capability'),
  ('copilot',   'gpt-5-mini',        0, TRUE,   0.0,   0.0, 2, 2, 3, 128, TRUE,  FALSE, 10000, 1000000, 'fast',     FALSE,
   'Free tier-0 GPT-5 mini variant'),
  -- Gemini (can_spawn_workers=false)
  ('gemini',    'gemini-2.0-flash',  1, TRUE,   0.0,   0.0, 3, 3, 4, 100, TRUE,  TRUE,   5000, 1000000, 'fast',     FALSE,
   'Fast model with vision support, no spawn'),
  ('gemini',    'gemini-2.5-pro',    2, FALSE,  2.5,   7.5, 4, 4, 4, 100, TRUE,  TRUE,   5000, 1000000, 'moderate', FALSE,
   'Advanced Gemini model, no spawn capability')
ON CONFLICT (provider, model_name) DO UPDATE SET
  cost_tier                   = EXCLUDED.cost_tier,
  is_free                     = EXCLUDED.is_free,
  cost_per_1m_input_usd       = EXCLUDED.cost_per_1m_input_usd,
  cost_per_1m_output_usd      = EXCLUDED.cost_per_1m_output_usd,
  reasoning_score             = EXCLUDED.reasoning_score,
  code_quality_score          = EXCLUDED.code_quality_score,
  instruction_following_score = EXCLUDED.instruction_following_score,
  context_window_k            = EXCLUDED.context_window_k,
  supports_tool_use           = EXCLUDED.supports_tool_use,
  supports_vision             = EXCLUDED.supports_vision,
  rpm_limit                   = EXCLUDED.rpm_limit,
  tpm_limit                   = EXCLUDED.tpm_limit,
  avg_latency_class           = EXCLUDED.avg_latency_class,
  can_spawn_workers           = EXCLUDED.can_spawn_workers,
  notes                       = EXCLUDED.notes,
  updated_at                  = now();

-- ─── AC-3, AC-4, AC-12: work_offer capability requirement columns ─────────────
-- AC-12: task_category with 8-value enum (mechanical, liaison, workspace are no-spawn;
--        testing, implementation, analysis, architecture, review require can_spawn_workers=true).
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS task_category                   TEXT    NOT NULL DEFAULT 'mechanical';
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS min_reasoning_score             INTEGER NOT NULL DEFAULT 0
    CHECK (min_reasoning_score BETWEEN 0 AND 5);
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS min_code_quality_score          INTEGER NOT NULL DEFAULT 0
    CHECK (min_code_quality_score BETWEEN 0 AND 5);
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS min_instruction_following_score INTEGER NOT NULL DEFAULT 0
    CHECK (min_instruction_following_score BETWEEN 0 AND 5);
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS min_context_window_k            INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS requires_tool_use               BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS requires_vision                 BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE roadmap.work_offer
  ADD COLUMN IF NOT EXISTS max_cost_tier                   INTEGER NOT NULL DEFAULT 3
    CHECK (max_cost_tier BETWEEN 0 AND 3);

-- AC-12 CHECK: add if not present (idempotent via DROP IF EXISTS before CREATE)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_schema = 'roadmap' AND table_name = 'work_offer'
      AND constraint_name = 'work_offer_task_category_check'
  ) THEN
    ALTER TABLE roadmap.work_offer
      ADD CONSTRAINT work_offer_task_category_check
        CHECK (task_category IN (
          'mechanical', 'liaison', 'workspace',
          'testing', 'implementation', 'analysis', 'architecture', 'review'
        ));
  END IF;
END $$;

-- ─── AC-15: Copilot agent capabilities — job_family seeding ─────────────────
-- Copilot agents (pete, pablo, paul) handle only: mechanical, workspace, liaison.
-- Testing, implementation, analysis, architecture, review are excluded —
-- enforced upstream by can_spawn_workers=false on model_capability_profile.

-- Ensure paul has a provider_registry row (pete/pablo were seeded in P996).
INSERT INTO roadmap_workforce.provider_registry (agency_id, agency_identity, capabilities)
SELECT ar.id, ar.agent_identity, '{"job_family": ["mechanical", "workspace", "liaison"]}'::jsonb
FROM roadmap_workforce.agent_registry ar
WHERE ar.agent_identity = 'paul'
  AND NOT EXISTS (
    SELECT 1 FROM roadmap_workforce.provider_registry pr WHERE pr.agency_id = ar.id
  );

-- Update capabilities for all three copilot agents.
UPDATE roadmap_workforce.provider_registry pr
SET capabilities = jsonb_set(
      capabilities,
      '{job_family}',
      '["mechanical", "workspace", "liaison"]'
    ),
    updated_at = now()
FROM roadmap_workforce.agent_registry ar
WHERE pr.agency_id = ar.id
  AND ar.agent_identity IN ('pete', 'pablo', 'paul');

COMMIT;
