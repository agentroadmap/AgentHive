/**
 * P1006: Model Capability Registry — model_capability_profile and work_offer.capability_requirements
 * 
 * Creates:
 * - roadmap_workforce.model_capability_profile: canonical model metadata with capability scores
 * - roadmap.work_offer.capability_requirements: offer constraints for routing
 * 
 * AC-1: Table with provider, model_name, cost_tier, reasoning/code/instruction scores, supports_tool_use, supports_vision, can_spawn_workers
 * AC-2: Seed 9 models with appropriate scores (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5, codex-5.5, gpt-4.1, gpt-4.1-mini, gpt-5-mini, gemini-2.0-flash, gemini-2.5-pro)
 * AC-3: Capability score scale 0-5 (incapable, toy, adequate, solid, strong, best-in-class)
 * AC-4: work_offer table with capability requirement columns
 */

BEGIN;

-- Create model_capability_profile table
CREATE TABLE IF NOT EXISTS roadmap_workforce.model_capability_profile (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  cost_tier INT NOT NULL DEFAULT 2 CHECK (cost_tier BETWEEN 0 AND 3),
  is_free BOOLEAN NOT NULL DEFAULT FALSE,
  reasoning_score INT NOT NULL DEFAULT 3 CHECK (reasoning_score BETWEEN 0 AND 5),
  code_quality_score INT NOT NULL DEFAULT 3 CHECK (code_quality_score BETWEEN 0 AND 5),
  instruction_following_score INT NOT NULL DEFAULT 3 CHECK (instruction_following_score BETWEEN 0 AND 5),
  context_window_k INT,
  supports_tool_use BOOLEAN NOT NULL DEFAULT TRUE,
  supports_vision BOOLEAN NOT NULL DEFAULT FALSE,
  can_spawn_workers BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (provider, model_name)
);

-- Create index for active models filtering
CREATE INDEX idx_model_capability_active ON roadmap_workforce.model_capability_profile (is_active) WHERE is_active = TRUE;

-- Create index for capability score queries
CREATE INDEX idx_model_capability_scores ON roadmap_workforce.model_capability_profile (reasoning_score, code_quality_score, instruction_following_score);

-- AC-2: Seed canonical models with their capability scores
INSERT INTO roadmap_workforce.model_capability_profile 
  (provider, model_name, cost_tier, is_free, reasoning_score, code_quality_score, instruction_following_score, 
   context_window_k, supports_tool_use, supports_vision, can_spawn_workers, is_active, notes)
VALUES
  -- Anthropic models
  ('anthropic', 'claude-opus-4-7', 3, FALSE, 5, 5, 5, 200, TRUE, TRUE, TRUE, TRUE, 'Best-in-class reasoning and instruction following'),
  ('anthropic', 'claude-sonnet-4-6', 2, FALSE, 4, 4, 5, 200, TRUE, TRUE, TRUE, TRUE, 'Strong code quality and instruction following'),
  ('anthropic', 'claude-haiku-4-5', 1, FALSE, 3, 3, 4, 100, TRUE, FALSE, TRUE, TRUE, 'Lightweight model without vision support'),
  -- Codex models
  ('codex', 'codex-5.5', 2, FALSE, 4, 5, 4, 150, TRUE, FALSE, TRUE, TRUE, 'Excellent code quality scores'),
  -- Copilot models (GPT-based, cannot spawn workers)
  ('copilot', 'gpt-4.1', 2, FALSE, 4, 4, 4, 128, TRUE, FALSE, FALSE, TRUE, 'Standard GPT-4.1 with copilot backend'),
  ('copilot', 'gpt-4.1-mini', 0, TRUE, 2, 2, 3, 128, TRUE, FALSE, FALSE, TRUE, 'Free tier-0 model without spawn capability'),
  ('copilot', 'gpt-5-mini', 0, TRUE, 2, 2, 3, 128, TRUE, FALSE, FALSE, TRUE, 'Free tier-0 GPT-5 mini variant'),
  -- Google models (Gemini, no spawn capability)
  ('gemini', 'gemini-2.0-flash', 1, FALSE, 3, 3, 4, 200, TRUE, TRUE, FALSE, TRUE, 'Fast model with vision support, no spawn'),
  ('gemini', 'gemini-2.5-pro', 2, FALSE, 4, 4, 4, 200, TRUE, TRUE, FALSE, TRUE, 'Advanced Gemini model, no spawn capability')
ON CONFLICT (provider, model_name) DO NOTHING;

-- Extend work_offer table with capability requirements (if not already present)
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS min_reasoning_score INT DEFAULT NULL CHECK (min_reasoning_score BETWEEN 0 AND 5);
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS min_code_quality_score INT DEFAULT NULL CHECK (min_code_quality_score BETWEEN 0 AND 5);
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS min_instruction_following_score INT DEFAULT NULL CHECK (min_instruction_following_score BETWEEN 0 AND 5);
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS min_context_window_k INT DEFAULT NULL;
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS requires_tool_use BOOLEAN DEFAULT FALSE;
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS requires_vision BOOLEAN DEFAULT FALSE;
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS max_cost_tier INT DEFAULT 3 CHECK (max_cost_tier BETWEEN 0 AND 3);
ALTER TABLE roadmap.work_offer ADD COLUMN IF NOT EXISTS task_category TEXT DEFAULT NULL;

-- Add CHECK constraint for task_category if not already present
ALTER TABLE roadmap.work_offer ADD CONSTRAINT ck_task_category CHECK (task_category IS NULL OR task_category IN ('mechanical', 'testing', 'implementation', 'analysis', 'architecture', 'review'));

COMMIT;
