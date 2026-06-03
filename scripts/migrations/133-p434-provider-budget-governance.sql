-- P434: Provider Route and Budget Governance
-- Source of truth: roadmap.* schema in agenthive DB (single-DB mode; migrates to hiveControl at P501/P429).
-- Migration boundary: all new tables are in roadmap.* and NEVER roadmap_efficiency.*.
--   roadmap_efficiency.budget_allowance (global-only, model-scoped) is left UNTOUCHED.
--   roadmap.model_routes and roadmap.spending_log are extended with NULLABLE FK columns only
--   (no backfill, zero-downtime, double-apply safe via IF NOT EXISTS guards).
-- Required capabilities: model-routing, spending.

-- ─── New Tables ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.provider_account (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  plan_type         TEXT        NOT NULL CHECK (plan_type IN ('token_plan', 'api_key_plan', 'subscription', 'local')),
  credential_ref    TEXT,
  credential_status TEXT        NOT NULL DEFAULT 'active'
                    CHECK (credential_status IN ('active', 'expired', 'revoked', 'rotating')),
  owner_scope       TEXT        NOT NULL DEFAULT 'global'
                    CHECK (owner_scope IN ('global', 'project', 'agency')),
  is_enabled        BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.provider_account IS
  'Credential-scoped billing container. credential_ref stores vault/env path — never raw secrets.';

CREATE TABLE IF NOT EXISTS roadmap.plan_token_budget (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id UUID        NOT NULL REFERENCES roadmap.provider_account(id) ON DELETE CASCADE,
  total_token_budget  BIGINT      NOT NULL,
  consumed_tokens     BIGINT      NOT NULL DEFAULT 0,
  remaining           BIGINT      GENERATED ALWAYS AS (total_token_budget - consumed_tokens) STORED,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN roadmap.plan_token_budget.remaining IS
  'Auto-computed: total_token_budget - consumed_tokens. Increment consumed_tokens; never set remaining directly.';

CREATE TABLE IF NOT EXISTS roadmap.api_key_plan (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id       UUID        NOT NULL REFERENCES roadmap.provider_account(id) ON DELETE CASCADE,
  monthly_spend_cap_usd     NUMERIC(12,4),
  current_month_spend_usd   NUMERIC(12,4) NOT NULL DEFAULT 0,
  is_frozen                 BOOLEAN       NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.api_key_plan IS
  'PAYG metered plan. is_frozen and monthly_spend_cap_usd enforced by pre-spawn governance check.';

CREATE TABLE IF NOT EXISTS roadmap.model_catalog (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       TEXT    NOT NULL,
  model_name     TEXT    NOT NULL,
  display_name   TEXT,
  context_window INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model_name)
);

COMMENT ON TABLE roadmap.model_catalog IS
  'Canonical descriptive model metadata (display, capability). Separate from runtime route.';

-- Seed from roadmap.model_metadata for continuity
INSERT INTO roadmap.model_catalog (provider, model_name, display_name, context_window)
SELECT mm.provider, mm.model_name, mm.display_name, mm.context_window
  FROM roadmap.model_metadata mm
ON CONFLICT (provider, model_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS roadmap.budget_allowance (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type      TEXT        NOT NULL
                  CHECK (scope_type IN ('global','project','repo','agency','provider_account','route','proposal','dispatch','run')),
  scope_ref       TEXT,
  daily_cap_usd   NUMERIC(12,4),
  monthly_cap_usd NUMERIC(12,4),
  is_enabled      BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.budget_allowance IS
  'Hierarchical budget caps across 9 scope types. Global seed: $20/day, $100/month.';

-- Global seed (idempotent)
INSERT INTO roadmap.budget_allowance (scope_type, scope_ref, daily_cap_usd, monthly_cap_usd)
VALUES ('global', NULL, 20.00, 100.00)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS roadmap.context_policy (
  policy_id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type                 TEXT        NOT NULL
                             CHECK (scope_type IN ('global','project','agency','proposal')),
  scope_ref                  TEXT,
  max_prompt_tokens          INT         NOT NULL,
  max_history_tokens         INT         NOT NULL,
  retrieval_policy           TEXT        NOT NULL DEFAULT 'none',
  retrieval_topk             INT,
  summarization_policy       TEXT        NOT NULL DEFAULT 'none',
  truncation_behavior        TEXT        NOT NULL DEFAULT 'tail',
  attachment_policy_max_files INT,
  attachment_policy_max_bytes BIGINT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.context_policy IS
  'Per-scope context window configuration. Global seed: 100k prompt / 40k history.';

-- Global seed (idempotent)
INSERT INTO roadmap.context_policy (scope_type, scope_ref, max_prompt_tokens, max_history_tokens)
VALUES ('global', NULL, 100000, 40000)
ON CONFLICT DO NOTHING;

-- ─── Extensions to roadmap.model_routes ───────────────────────────────────────
-- All columns nullable: existing rows keep NULL, no backfill, zero-downtime.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'provider_account_id'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN provider_account_id UUID REFERENCES roadmap.provider_account(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'agent_cli'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN agent_cli TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'cli_path'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN cli_path TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'spawn_toolsets'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN spawn_toolsets TEXT[];
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'api_key_env'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN api_key_env TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'api_key_fallback_env'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN api_key_fallback_env TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'base_url_env'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN base_url_env TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'capabilities'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN capabilities TEXT[];
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'model_routes'
       AND column_name = 'objective_rating'
  ) THEN
    ALTER TABLE roadmap.model_routes ADD COLUMN objective_rating NUMERIC(3,2);
  END IF;
END $$;

-- ─── Extensions to roadmap.spending_log ───────────────────────────────────────
-- All new columns nullable; existing rows unaffected; double-apply safe.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'spending_log'
       AND column_name = 'provider_account_id'
  ) THEN
    ALTER TABLE roadmap.spending_log ADD COLUMN provider_account_id UUID REFERENCES roadmap.provider_account(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'spending_log'
       AND column_name = 'route_id'
  ) THEN
    ALTER TABLE roadmap.spending_log ADD COLUMN route_id INT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'spending_log'
       AND column_name = 'budget_scope'
  ) THEN
    ALTER TABLE roadmap.spending_log ADD COLUMN budget_scope TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'spending_log'
       AND column_name = 'context_policy_id'
  ) THEN
    ALTER TABLE roadmap.spending_log ADD COLUMN context_policy_id UUID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'roadmap' AND table_name = 'spending_log'
       AND column_name = 'cache_tokens'
  ) THEN
    ALTER TABLE roadmap.spending_log ADD COLUMN cache_tokens INT;
  END IF;
END $$;

-- ─── PG Functions ─────────────────────────────────────────────────────────────

-- fn_check_route_policy: returns 'ROUTE_POLICY_MISSING' or NULL.
-- Checks that at least one enabled model_route with an active provider_account
-- exists for the given agent_provider and (optionally) model_name.
CREATE OR REPLACE FUNCTION roadmap.fn_check_route_policy(
  p_agent_provider TEXT,
  p_model_name     TEXT
) RETURNS TEXT AS $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*)
    INTO v_count
    FROM roadmap.model_routes mr
    LEFT JOIN roadmap.provider_account pa ON pa.id = mr.provider_account_id
   WHERE mr.is_enabled = true
     AND mr.agent_provider = p_agent_provider
     AND (p_model_name IS NULL OR mr.model_name = p_model_name)
     AND (
           mr.provider_account_id IS NULL  -- legacy route without account ref is allowed
           OR (
                pa.is_enabled = true
            AND pa.credential_status NOT IN ('expired', 'revoked')
           )
         );

  IF v_count = 0 THEN
    RETURN 'ROUTE_POLICY_MISSING';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- fn_check_budget_headroom: walks global→project→agency→provider_account→route→proposal→dispatch.
-- Returns 'BUDGET_EXHAUSTED:<scope>' or NULL (all scopes clear).
-- Also checks provider_account liveness when p_provider_account_id is given.
CREATE OR REPLACE FUNCTION roadmap.fn_check_budget_headroom(
  p_cost_usd            NUMERIC,
  p_provider_account_id UUID,
  p_scope_ids           JSONB
) RETURNS TEXT AS $$
DECLARE
  v_scope       TEXT;
  v_scope_ref   TEXT;
  v_daily_cap   NUMERIC;
  v_scope_types TEXT[] := ARRAY['global','project','agency','provider_account','route','proposal','dispatch'];
BEGIN
  -- Liveness check for the named provider account
  IF p_provider_account_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM roadmap.provider_account
       WHERE id = p_provider_account_id
         AND is_enabled = true
         AND credential_status NOT IN ('expired', 'revoked')
    ) THEN
      RETURN 'ROUTE_POLICY_MISSING';
    END IF;
  END IF;

  FOREACH v_scope IN ARRAY v_scope_types LOOP
    -- Resolve scope_ref from the provided JSON map
    IF v_scope = 'global' THEN
      v_scope_ref := NULL;
    ELSIF v_scope = 'provider_account' THEN
      v_scope_ref := p_provider_account_id::TEXT;
    ELSE
      v_scope_ref := p_scope_ids->>(v_scope);
    END IF;

    -- Skip scopes not requested (except global, which is always checked)
    IF v_scope <> 'global' AND v_scope_ref IS NULL THEN
      CONTINUE;
    END IF;

    -- Check daily cap for this scope
    SELECT daily_cap_usd
      INTO v_daily_cap
      FROM roadmap.budget_allowance
     WHERE scope_type = v_scope
       AND (v_scope = 'global' OR scope_ref = v_scope_ref)
       AND is_enabled = true
     LIMIT 1;

    IF FOUND AND v_daily_cap IS NOT NULL AND p_cost_usd > v_daily_cap THEN
      RETURN 'BUDGET_EXHAUSTED:' || v_scope;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT ON roadmap.provider_account   TO roadmap_agent;
GRANT SELECT ON roadmap.plan_token_budget  TO roadmap_agent;
GRANT SELECT ON roadmap.api_key_plan       TO roadmap_agent;
GRANT SELECT ON roadmap.model_catalog      TO roadmap_agent;
GRANT SELECT ON roadmap.budget_allowance   TO roadmap_agent;
GRANT SELECT ON roadmap.context_policy     TO roadmap_agent;

GRANT EXECUTE ON FUNCTION roadmap.fn_check_route_policy(TEXT, TEXT)       TO roadmap_agent;
GRANT EXECUTE ON FUNCTION roadmap.fn_check_budget_headroom(NUMERIC, UUID, JSONB) TO roadmap_agent;
