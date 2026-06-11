-- P1091: Tiered Agent/Model Routing
--
-- Six coordinated changes:
-- 1. Create fn_tier_rank() function for tier ordering
-- 2. Extend tier CHECK constraint to include 'free'
-- 3. Add min_tier to agent_role_profile
-- 4. Add model_route_health table
-- 5. Add model_provider_health table
-- 6. Create v_route_health view
-- 7. Add model_accepted and backoff_state columns

-- ─────────────────────────────────────────────────────────────────────────────
-- AC-1: Tier rank function
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_tier_rank(tier text) RETURNS INTEGER AS $$
BEGIN
  RETURN CASE tier
    WHEN 'free' THEN 0
    WHEN 'lower' THEN 1
    WHEN 'mid' THEN 2
    WHEN 'frontier' THEN 3
    WHEN 'tool' THEN 99
    ELSE 99
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

-- Expression index for tier_rank (AC-1)
CREATE INDEX IF NOT EXISTS idx_model_routes_tier_rank
  ON roadmap.model_routes ((roadmap.fn_tier_rank(tier)))
  WHERE is_enabled = true;

-- Composite index for tier-aware cost ordering (AC-4)
CREATE INDEX IF NOT EXISTS idx_model_routes_tier_cost
  ON roadmap.model_routes (
    roadmap.fn_tier_rank(tier) ASC,
    COALESCE(cost_per_million_input, 0) ASC,
    priority ASC
  )
  WHERE is_enabled = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- AC-2: Extend tier CHECK constraint to allow 'free'
-- ─────────────────────────────────────────────────────────────────────────────

-- First, add backoff_state JSONB column (allows NULLs for pre-existing rows)
ALTER TABLE roadmap.model_routes
ADD COLUMN IF NOT EXISTS backoff_state JSONB;

-- Second, add model_accepted column (initially NULL)
ALTER TABLE roadmap.model_routes
ADD COLUMN IF NOT EXISTS model_accepted BOOLEAN;

-- Replace the tier CHECK constraint
ALTER TABLE roadmap.model_routes
DROP CONSTRAINT IF EXISTS model_routes_tier_check;

ALTER TABLE roadmap.model_routes
ADD CONSTRAINT model_routes_tier_check CHECK (
  tier IN ('free', 'frontier', 'mid', 'lower', 'tool')
);

-- Backfill existing tiers based on model names
-- copilot gpt-4.1, gpt-5-mini → 'free'
UPDATE roadmap.model_routes
SET tier = 'free'
WHERE model_name IN ('gpt-4.1', 'gpt-5-mini')
  AND route_provider = 'github'
  AND tier IS NULL;

-- claude-sonnet-4.5, gpt-4.1-codex → 'mid'
UPDATE roadmap.model_routes
SET tier = 'mid'
WHERE model_name IN ('claude-sonnet-4.5', 'gpt-4.1-codex', 'claude-sonnet-4-6')
  AND tier IS NULL;

-- gpt-4.1-mini/nano → 'lower'
UPDATE roadmap.model_routes
SET tier = 'lower'
WHERE model_name IN ('gpt-4.1-mini', 'gpt-4.1-nano', 'gemini-2.0-flash')
  AND tier IS NULL;

-- claude-opus-4-7, gpt-5.4, o3, claude-opus-4-6 → 'frontier'
UPDATE roadmap.model_routes
SET tier = 'frontier'
WHERE model_name IN ('claude-opus-4-7', 'gpt-5.4', 'o3', 'claude-opus-4-6')
  AND tier IS NULL;

-- Leave remaining NULLs as-is for investigation (as per AC-2)

-- ─────────────────────────────────────────────────────────────────────────────
-- AC-3: Add min_tier to agent_role_profile
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE roadmap.agent_role_profile
ADD COLUMN IF NOT EXISTS min_tier TEXT NOT NULL DEFAULT 'mid'
CHECK (min_tier IN ('free', 'lower', 'mid', 'frontier', 'tool'));

-- Partial index for fast tier lookups
CREATE INDEX IF NOT EXISTS idx_agent_role_profile_min_tier
  ON roadmap.agent_role_profile(min_tier)
  WHERE scope = 'global';

-- Backfill min_tier based on role type:
-- gate roles (skeptic-alpha, architecture-reviewer, skeptic-beta, reviewer-d1, gate-reviewer) → 'mid'
UPDATE roadmap.agent_role_profile
SET min_tier = 'mid'
WHERE role IN (
  'skeptic-alpha',
  'architecture-reviewer',
  'skeptic-beta',
  'reviewer-d1',
  'gate-reviewer'
);

-- enhancers and developers → 'mid'
UPDATE roadmap.agent_role_profile
SET min_tier = 'mid'
WHERE role IN ('enhancer', 'developer', 'architect', 'hotfix');

-- researchers, drafters, enrichment_agents → 'lower'
UPDATE roadmap.agent_role_profile
SET min_tier = 'lower'
WHERE role IN ('researcher', 'drafter', 'enrichment_agent', 'triage');

-- explorations → 'free'
UPDATE roadmap.agent_role_profile
SET min_tier = 'free'
WHERE role IN ('exploration', 'research-fetch');

-- D1/D2-prep gates (architect/skeptic at REVIEW maturity=mature) → 'frontier'
-- (This requires a more complex query, leaving to operator override if needed)

-- ─────────────────────────────────────────────────────────────────────────────
-- AC-6: model_route_health table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_workforce.model_route_health (
  id BIGSERIAL PRIMARY KEY,
  route_id BIGINT NOT NULL REFERENCES roadmap.model_routes(id) ON DELETE CASCADE,
  probed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  model_accepted BOOLEAN,
  has_quota BOOLEAN,
  sample_request_ms INTEGER,
  error_class TEXT,
  probe_kind TEXT NOT NULL DEFAULT 'cheap_probe'
);

-- Partial index on (route_id, probed_at DESC) for quota-walled queries
CREATE INDEX IF NOT EXISTS idx_model_route_health_route_probed
  ON roadmap_workforce.model_route_health (route_id, probed_at DESC)
  WHERE has_quota = false;

-- Unique constraint to prevent duplicate probes
ALTER TABLE roadmap_workforce.model_route_health
ADD CONSTRAINT uq_model_route_health_route_probed UNIQUE (route_id, probed_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- AC-20: model_provider_health table (provider-level quota pooling)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap_workforce.model_provider_health (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  last_quota_hit_at TIMESTAMP WITH TIME ZONE,
  estimated_recovery_at TIMESTAMP WITH TIME ZONE,
  shared_quota_remaining INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- AC-19: v_route_health view (operator dashboard)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW roadmap.v_route_health AS
SELECT
  mr.id as route_id,
  mr.model_name,
  mr.tier,
  mr.agent_provider,
  mr.is_enabled,
  mr.cooldown_until,
  mrh.probed_at as last_probe_at,
  (CASE
    WHEN mrh.probed_at IS NOT NULL THEN
      CASE
        WHEN mrh.model_accepted = false THEN 'model_rejected'
        WHEN mrh.has_quota = false THEN 'quota_exhausted'
        WHEN mrh.error_class IS NOT NULL THEN 'probe_error'
        ELSE 'ok'
      END
    ELSE 'never_probed'
  END) as last_probe_outcome,
  mrh.has_quota as has_quota_last,
  (SELECT COUNT(*)
    FROM roadmap_workforce.model_route_health
    WHERE route_id = mr.id
      AND probed_at > now() - interval '24 hours'
      AND CASE
        WHEN mrh_inner.probed_at IS NOT NULL THEN
          CASE
            WHEN mrh_inner.model_accepted = false THEN false
            WHEN mrh_inner.has_quota = false THEN true
            ELSE false
          END
        ELSE false
      END
  ) as downshift_count_24h
FROM roadmap.model_routes mr
LEFT JOIN LATERAL (
  SELECT *
  FROM roadmap_workforce.model_route_health
  WHERE route_id = mr.id
  ORDER BY probed_at DESC
  LIMIT 1
) mrh ON true;

-- ─────────────────────────────────────────────────────────────────────────────
-- AC-17: Trigger to prevent setting is_enabled=false on quota issues
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_enforce_cooldown_semantics()
RETURNS TRIGGER AS $$
BEGIN
  -- Prevent disabling a route with model_accepted=true (that's a quota state, use cooldown_until instead)
  IF NEW.is_enabled = false
     AND OLD.is_enabled = true
     AND NEW.model_accepted IS NOT NULL
     AND NEW.model_accepted = true
  THEN
    RAISE EXCEPTION 'cannot disable a route with model_accepted=true; this is a quota state, use cooldown_until instead';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_cooldown_semantics ON roadmap.model_routes;
CREATE TRIGGER trg_enforce_cooldown_semantics
  BEFORE UPDATE ON roadmap.model_routes
  FOR EACH ROW
  EXECUTE FUNCTION roadmap.fn_enforce_cooldown_semantics();

-- ─────────────────────────────────────────────────────────────────────────────
-- Grant permissions (if needed)
-- ─────────────────────────────────────────────────────────────────────────────

-- view is publicly readable
GRANT SELECT ON roadmap.v_route_health TO PUBLIC;
