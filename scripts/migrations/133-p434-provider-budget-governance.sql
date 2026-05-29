-- Migration 133 — P434: Provider Route and Budget Governance
-- Idempotent: all DDL uses IF NOT EXISTS / DO $$ guards.
--
-- Boundary notes:
--   roadmap_efficiency.budget_allowance  — untouched (legacy global/proposal/team scopes)
--   roadmap_efficiency.spending_log      — extended with nullable P434 columns
--   roadmap.model_routes                 — extended with nullable provider_account_id FK
--
-- Rollback: all new columns are nullable → existing rows unaffected.
--           Drop tables/functions in reverse order to unwind.

-- ─── 1. New tables ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.provider_account (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label               text        NOT NULL,
    plan_type           text        NOT NULL CHECK (plan_type IN ('token_plan','api_key_plan','subscription','local')),
    credential_ref      text,                        -- vault path or env var name, never raw secret
    credential_status   text        NOT NULL DEFAULT 'active'
                                    CHECK (credential_status IN ('active','rotating','expired','revoked')),
    owner_scope         text        NOT NULL DEFAULT 'global'
                                    CHECK (owner_scope IN ('global','project','agency')),
    owner_ref           text,                        -- project slug / agency identity when not global
    is_enabled          boolean     NOT NULL DEFAULT true,
    notes               text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap.plan_token_budget (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_account_id uuid        NOT NULL REFERENCES roadmap.provider_account(id) ON DELETE CASCADE,
    label               text        NOT NULL,
    total_token_budget  bigint      NOT NULL CHECK (total_token_budget > 0),
    consumed_tokens     bigint      NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
    remaining           bigint      GENERATED ALWAYS AS (total_token_budget - consumed_tokens) STORED,
    expires_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap.api_key_plan (
    id                          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_account_id         uuid        NOT NULL REFERENCES roadmap.provider_account(id) ON DELETE CASCADE,
    label                       text        NOT NULL,
    monthly_spend_cap_usd       numeric(14,2),
    current_month_spend_usd     numeric(14,6) NOT NULL DEFAULT 0,
    is_frozen                   boolean     NOT NULL DEFAULT false,
    reset_day_of_month          smallint    NOT NULL DEFAULT 1 CHECK (reset_day_of_month BETWEEN 1 AND 28),
    created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roadmap.model_catalog (
    id              bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider        text    NOT NULL,
    model_name      text    NOT NULL,
    display_name    text,
    context_window  integer,
    notes           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, model_name)
);

-- Hierarchical budget allowances (global → project → agency → provider_account → route → proposal → dispatch)
-- Replaces the cross-schema view roadmap.budget_allowance (view preserved in roadmap_efficiency unchanged).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'roadmap' AND table_name = 'budget_allowance'
          AND table_type = 'VIEW'
    ) THEN
        DROP VIEW roadmap.budget_allowance;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS roadmap.budget_allowance (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label               text        NOT NULL,
    scope_type          text        NOT NULL
                                    CHECK (scope_type IN ('global','project','agency','provider_account','route','proposal','dispatch')),
    scope_ref           text,                        -- UUID / identity matching scope_type
    daily_cap_usd       numeric(14,2),
    monthly_cap_usd     numeric(14,2),
    total_cap_usd       numeric(14,2),
    consumed_usd        numeric(14,6) NOT NULL DEFAULT 0,
    is_active           boolean     NOT NULL DEFAULT true,
    valid_from          timestamptz NOT NULL DEFAULT now(),
    valid_until         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope_type, scope_ref)
);

CREATE TABLE IF NOT EXISTS roadmap.context_policy (
    policy_id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    label                       text        NOT NULL,
    scope_type                  text        NOT NULL
                                            CHECK (scope_type IN ('global','project','agency','proposal')),
    scope_ref                   text,                -- UUID / slug matching scope_type
    max_prompt_tokens           integer     NOT NULL DEFAULT 100000,
    max_history_tokens          integer     NOT NULL DEFAULT 40000,
    retrieval_policy            text        NOT NULL DEFAULT 'none'
                                            CHECK (retrieval_policy IN ('none','kb_topk','semantic_chunk')),
    retrieval_topk              integer,
    summarization_policy        text        NOT NULL DEFAULT 'none'
                                            CHECK (summarization_policy IN ('none','rolling','snapshot')),
    truncation_behavior         text        NOT NULL DEFAULT 'tail'
                                            CHECK (truncation_behavior IN ('tail','head','smart')),
    attachment_policy_max_files integer,
    attachment_policy_max_bytes bigint,
    created_at                  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope_type, scope_ref)
);

-- ─── 2. Extend roadmap.model_routes ──────────────────────────────────────────

ALTER TABLE roadmap.model_routes
    ADD COLUMN IF NOT EXISTS provider_account_id uuid
        REFERENCES roadmap.provider_account(id) ON DELETE SET NULL;

-- ─── 3. Extend roadmap_efficiency.spending_log + update view ──────────────────

DO $$
DECLARE col text;
BEGIN
    FOR col IN SELECT c FROM UNNEST(ARRAY[
        'dispatch_id',
        'input_tokens',
        'output_tokens',
        'cache_tokens',
        'provider_account_id',
        'route_id',
        'budget_scope',
        'context_policy_id'
    ]) AS c
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'roadmap_efficiency'
              AND table_name   = 'spending_log'
              AND column_name  = col
        ) THEN
            CASE col
                WHEN 'dispatch_id'        THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN dispatch_id        bigint;
                WHEN 'input_tokens'       THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN input_tokens        integer;
                WHEN 'output_tokens'      THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN output_tokens       integer;
                WHEN 'cache_tokens'       THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN cache_tokens        integer NOT NULL DEFAULT 0;
                WHEN 'provider_account_id'THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN provider_account_id uuid;
                WHEN 'route_id'           THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN route_id            bigint;
                WHEN 'budget_scope'       THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN budget_scope        text;
                WHEN 'context_policy_id'  THEN ALTER TABLE roadmap_efficiency.spending_log ADD COLUMN context_policy_id  uuid;
            END CASE;
        END IF;
    END LOOP;
END $$;

-- Drop old roadmap.spending_log view and recreate with new columns + INSTEAD OF trigger
DROP VIEW IF EXISTS roadmap.spending_log;

CREATE VIEW roadmap.spending_log AS
    SELECT id, agent_identity, proposal_id, model_name, cost_usd, token_count,
           run_id, budget_id, created_at, provider,
           dispatch_id, input_tokens, output_tokens, cache_tokens,
           provider_account_id, route_id, budget_scope, context_policy_id
      FROM roadmap_efficiency.spending_log;

CREATE OR REPLACE FUNCTION roadmap.fn_spending_log_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO roadmap_efficiency.spending_log
        (agent_identity, proposal_id, dispatch_id, route_id, provider_account_id,
         input_tokens, output_tokens, cache_tokens, cost_usd, budget_scope, context_policy_id,
         model_name, token_count)
    VALUES
        (NEW.agent_identity, NEW.proposal_id, NEW.dispatch_id, NEW.route_id,
         NEW.provider_account_id, NEW.input_tokens, NEW.output_tokens,
         COALESCE(NEW.cache_tokens, 0), NEW.cost_usd, NEW.budget_scope,
         NEW.context_policy_id, NEW.model_name,
         COALESCE(NEW.input_tokens, 0) + COALESCE(NEW.output_tokens, 0) + COALESCE(NEW.cache_tokens, 0));
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_spending_log_p434_insert ON roadmap.spending_log;
CREATE TRIGGER trg_spending_log_p434_insert
    INSTEAD OF INSERT ON roadmap.spending_log
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_spending_log_insert();

-- ─── 4. PG functions ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_check_route_policy(
    p_agent_provider text,
    p_model_name     text
) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
              FROM roadmap.model_routes mr
         LEFT JOIN roadmap.provider_account pa ON pa.id = mr.provider_account_id
             WHERE mr.agent_provider = p_agent_provider
               AND mr.is_enabled = true
               AND (p_model_name IS NULL OR mr.model_name = p_model_name)
               AND (mr.provider_account_id IS NULL OR pa.is_enabled = true)
        ) THEN NULL
        ELSE 'ROUTE_POLICY_MISSING'
    END;
$$;

CREATE OR REPLACE FUNCTION roadmap.fn_check_budget_headroom(
    p_cost_usd           numeric,
    p_provider_account_id uuid,
    p_scope_ids          jsonb
) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_scope text;
    v_scopes text[] := ARRAY['global','project','agency','provider_account','route','proposal','dispatch'];
    v_scope_ref text;
    v_daily_cap numeric;
    v_monthly_cap numeric;
    v_consumed numeric;
    v_now timestamptz := now();
BEGIN
    -- Check provider_account is active when specified
    IF p_provider_account_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM roadmap.provider_account
             WHERE id = p_provider_account_id AND is_enabled = true
               AND credential_status IN ('active','rotating')
        ) THEN
            RETURN 'ROUTE_POLICY_MISSING';
        END IF;
    END IF;

    -- Walk scope chain from broadest to narrowest
    FOREACH v_scope IN ARRAY v_scopes LOOP
        v_scope_ref := CASE v_scope
            WHEN 'provider_account' THEN p_provider_account_id::text
            ELSE p_scope_ids ->> v_scope
        END;

        SELECT ba.daily_cap_usd, ba.monthly_cap_usd,
               ba.consumed_usd
          INTO v_daily_cap, v_monthly_cap, v_consumed
          FROM roadmap.budget_allowance ba
         WHERE ba.scope_type = v_scope
           AND ba.is_active = true
           AND (ba.scope_ref IS NULL OR ba.scope_ref = v_scope_ref)
           AND (v_scope_ref IS NOT NULL OR v_scope = 'global')
           AND (ba.valid_until IS NULL OR ba.valid_until > v_now)
         ORDER BY ba.id
         LIMIT 1;

        IF FOUND THEN
            IF v_daily_cap IS NOT NULL AND (v_consumed + p_cost_usd) > v_daily_cap THEN
                RETURN 'BUDGET_EXHAUSTED:' || v_scope;
            END IF;
            IF v_monthly_cap IS NOT NULL AND (v_consumed + p_cost_usd) > v_monthly_cap THEN
                RETURN 'BUDGET_EXHAUSTED:' || v_scope;
            END IF;
        END IF;
    END LOOP;

    RETURN NULL;
END $$;

-- ─── 5. Seed global budget_allowance and context_policy ───────────────────────

INSERT INTO roadmap.budget_allowance
    (label, scope_type, scope_ref, daily_cap_usd, monthly_cap_usd, is_active)
VALUES
    ('global-default', 'global', NULL, 20.00, 100.00, true)
ON CONFLICT DO NOTHING;

INSERT INTO roadmap.context_policy
    (label, scope_type, scope_ref,
     max_prompt_tokens, max_history_tokens,
     retrieval_policy, summarization_policy, truncation_behavior)
VALUES
    ('global-default', 'global', NULL,
     100000, 40000,
     'none', 'none', 'tail')
ON CONFLICT DO NOTHING;

-- ─── 6. Seed model_catalog from existing model_metadata ──────────────────────

INSERT INTO roadmap.model_catalog (provider, model_name)
    SELECT provider, model_name FROM roadmap.model_metadata
    ON CONFLICT DO NOTHING;

-- ─── 7. Ensure unique constraints exist (safe if already added) ───────────────

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'budget_allowance_scope_type_scope_ref_key'
           AND conrelid = 'roadmap.budget_allowance'::regclass
    ) THEN
        ALTER TABLE roadmap.budget_allowance
            ADD CONSTRAINT budget_allowance_scope_type_scope_ref_key
            UNIQUE (scope_type, scope_ref);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'context_policy_scope_type_scope_ref_key'
           AND conrelid = 'roadmap.context_policy'::regclass
    ) THEN
        ALTER TABLE roadmap.context_policy
            ADD CONSTRAINT context_policy_scope_type_scope_ref_key
            UNIQUE (scope_type, scope_ref);
    END IF;
END $$;

-- ─── 8. Grants ────────────────────────────────────────────────────────────────

DO $$
DECLARE r text;
BEGIN
    FOR r IN SELECT unnest(ARRAY['admin','andy','xiaomi','gary']) LOOP
        BEGIN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON roadmap.provider_account TO %I', r);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON roadmap.plan_token_budget TO %I', r);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON roadmap.api_key_plan TO %I', r);
            EXECUTE format('GRANT SELECT, INSERT ON roadmap.model_catalog TO %I', r);
            EXECUTE format('GRANT SELECT, INSERT, UPDATE ON roadmap.budget_allowance TO %I', r);
            EXECUTE format('GRANT SELECT, INSERT ON roadmap.context_policy TO %I', r);
            EXECUTE format('GRANT SELECT ON roadmap.spending_log TO %I', r);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
    END LOOP;
END $$;
