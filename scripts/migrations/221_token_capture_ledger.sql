-- Migration 221: Wire CLI Token Capture into Existing Budget Tables (P1018)
--
-- Schema changes needed to support per-spawn token usage recording:
-- 1. Add cost_source column to agent_budget_ledger (real vs estimated)
-- 2. Add context columns for cost attribution by stage/gate
-- 3. Backfill model_metadata with pricing for active models
-- 4. Create fn_canonical_cost_bucket() function for cost attribution
-- 5. Create v_proposal_cost_by_stage view for per-proposal breakdown

-- ──────────────────────────────────────────────────────────────────────────────
-- PART 1: Add cost_source column to agent_budget_ledger
-- ──────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_efficiency'
      AND table_name = 'agent_budget_ledger'
      AND column_name = 'cost_source'
  ) THEN
    ALTER TABLE roadmap_efficiency.agent_budget_ledger
      ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'estimated'
      CHECK (cost_source IN ('real', 'estimated'));
    CREATE INDEX idx_agent_budget_ledger_cost_source
      ON roadmap_efficiency.agent_budget_ledger(cost_source);
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- PART 2: Add context columns for stage/gate attribution
-- ──────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_efficiency'
      AND table_name = 'agent_budget_ledger'
      AND column_name = 'proposal_status_at_run'
  ) THEN
    ALTER TABLE roadmap_efficiency.agent_budget_ledger
      ADD COLUMN proposal_status_at_run TEXT,
      ADD COLUMN agent_role_at_run TEXT,
      ADD COLUMN gate_at_run TEXT;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- PART 3: Backfill model_metadata with pricing for active models
-- ──────────────────────────────────────────────────────────────────────────────
-- This uses public pricing as of 2026-06 for common providers.
-- Values are in cost per million tokens.

UPDATE roadmap.model_metadata SET
  cost_per_million_input = COALESCE(cost_per_million_input,
    CASE provider
      WHEN 'anthropic' THEN
        CASE model_name
          WHEN 'claude-3-5-sonnet-20241022' THEN 3.0
          WHEN 'claude-3-5-haiku-20241022' THEN 0.8
          WHEN 'claude-3-opus-20250219' THEN 15.0
          WHEN 'claude-3-sonnet-20240229' THEN 3.0
          WHEN 'claude-3-haiku-20240307' THEN 0.8
          ELSE NULL
        END
      WHEN 'openai' THEN
        CASE model_name
          WHEN 'gpt-4o-2024-11-20' THEN 7.5
          WHEN 'gpt-4-turbo' THEN 10.0
          WHEN 'gpt-4' THEN 30.0
          WHEN 'gpt-3.5-turbo' THEN 0.5
          ELSE NULL
        END
      WHEN 'google' THEN
        CASE model_name
          WHEN 'gemini-2.0-flash-thinking-exp' THEN 10.0
          WHEN 'gemini-2.0-flash' THEN 0.075
          WHEN 'gemini-1.5-pro' THEN 3.5
          WHEN 'gemini-1.5-flash' THEN 0.075
          ELSE NULL
        END
      ELSE NULL
    END
  ),
  cost_per_million_output = COALESCE(cost_per_million_output,
    CASE provider
      WHEN 'anthropic' THEN
        CASE model_name
          WHEN 'claude-3-5-sonnet-20241022' THEN 15.0
          WHEN 'claude-3-5-haiku-20241022' THEN 4.0
          WHEN 'claude-3-opus-20250219' THEN 75.0
          WHEN 'claude-3-sonnet-20240229' THEN 15.0
          WHEN 'claude-3-haiku-20240307' THEN 4.0
          ELSE NULL
        END
      WHEN 'openai' THEN
        CASE model_name
          WHEN 'gpt-4o-2024-11-20' THEN 30.0
          WHEN 'gpt-4-turbo' THEN 30.0
          WHEN 'gpt-4' THEN 60.0
          WHEN 'gpt-3.5-turbo' THEN 1.5
          ELSE NULL
        END
      WHEN 'google' THEN
        CASE model_name
          WHEN 'gemini-2.0-flash-thinking-exp' THEN 30.0
          WHEN 'gemini-2.0-flash' THEN 0.3
          WHEN 'gemini-1.5-pro' THEN 10.5
          WHEN 'gemini-1.5-flash' THEN 0.3
          ELSE NULL
        END
      ELSE NULL
    END
  )
WHERE is_active = true
  AND (cost_per_million_input IS NULL OR cost_per_million_output IS NULL);

-- ──────────────────────────────────────────────────────────────────────────────
-- PART 4: Create fn_canonical_cost_bucket() function
-- ──────────────────────────────────────────────────────────────────────────────
-- Maps (proposal_status, agent_role, gate) tuples to canonical cost buckets.
-- Used for consistent cost attribution across runs with different contexts.

CREATE OR REPLACE FUNCTION roadmap.fn_canonical_cost_bucket(
  p_status TEXT,
  p_role TEXT,
  p_gate TEXT
) RETURNS TEXT AS $$
BEGIN
  -- Rule 1: if gate is set, bucket is 'gate' (overrides status/role)
  IF p_gate IS NOT NULL AND p_gate IN ('D1', 'D2', 'D3', 'D4') THEN
    RETURN 'gate';
  END IF;

  -- Rule 2: if status is DRAFT and no gate, bucket is 'draft'
  IF p_status = 'DRAFT' AND p_gate IS NULL THEN
    RETURN 'draft';
  END IF;

  -- Rule 3: if status is REVIEW or DEVELOP, role is NOT a reviewer/architect, and no gate
  IF p_status IN ('REVIEW', 'DEVELOP')
    AND p_role NOT IN ('skeptic-alpha', 'skeptic-beta', 'architecture-reviewer', 'gate-reviewer')
    AND p_gate IS NULL THEN
    RETURN 'develop';
  END IF;

  -- Rule 4: if status is MERGE and no gate
  IF p_status = 'MERGE' AND p_gate IS NULL THEN
    RETURN 'merge';
  END IF;

  -- Rule 5: everything else is 'other'
  RETURN 'other';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ──────────────────────────────────────────────────────────────────────────────
-- PART 5: Create v_proposal_cost_by_stage view
-- ──────────────────────────────────────────────────────────────────────────────
-- Per-proposal cost breakdown by canonical bucket, with token aggregates.

CREATE OR REPLACE VIEW roadmap.v_proposal_cost_by_stage AS
SELECT
  l.proposal_id,
  p.display_id,
  p.title,
  p.status,
  roadmap.fn_canonical_cost_bucket(
    COALESCE(l.proposal_status_at_run, p.status),
    l.agent_role_at_run,
    l.gate_at_run
  ) AS bucket,
  SUM(l.cost_usd) AS bucket_cost_usd,
  SUM(l.tokens_in) AS bucket_tokens_in,
  SUM(l.tokens_out) AS bucket_tokens_out,
  COUNT(*) AS run_count,
  COUNT(*) FILTER (WHERE r.status = 'completed') AS completed_count
FROM roadmap_efficiency.agent_budget_ledger l
LEFT JOIN roadmap_proposal.proposal p ON p.id = l.proposal_id
LEFT JOIN roadmap_workforce.agent_runs r ON r.id = l.agent_run_id
GROUP BY l.proposal_id, p.display_id, p.title, p.status,
         l.proposal_status_at_run, l.agent_role_at_run, l.gate_at_run
ORDER BY p.display_id, bucket;

-- ──────────────────────────────────────────────────────────────────────────────
-- PART 6: Ensure agent_runs columns are nullable/default properly
-- ──────────────────────────────────────────────────────────────────────────────
-- The agent_runs.tokens_in/out columns should exist and allow NULL for
-- backward compatibility with old runs that predate this writer.

DO $$ BEGIN
  -- Ensure tokens_in/out columns exist in roadmap_workforce.agent_runs
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce'
      AND table_name = 'agent_runs'
      AND column_name = 'tokens_in'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_runs ADD COLUMN tokens_in INTEGER DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'roadmap_workforce'
      AND table_name = 'agent_runs'
      AND column_name = 'tokens_out'
  ) THEN
    ALTER TABLE roadmap_workforce.agent_runs ADD COLUMN tokens_out INTEGER DEFAULT 0;
  END IF;
END $$;

-- ──────────────────────────────────────────────────────────────────────────────
-- Done: Migration 221 complete
-- ──────────────────────────────────────────────────────────────────────────────
