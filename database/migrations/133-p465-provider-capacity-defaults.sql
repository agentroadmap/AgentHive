-- Migration 133: P465 — Provider-level capacity defaults + hard-limit pause columns
--
-- AC-8: roadmap.provider_capacity_defaults (provider-level inheritance)
-- AC-6: squad_dispatch.paused_at_provider_limit flag for hard rate-limit pauses
--
-- Prerequisite: migration 132-p465-agency-capacity-config.sql (agency_capacity_config table)

BEGIN;

-- ── AC-8: Provider-level defaults (inherited by agency if no per-agency row) ───

CREATE TABLE IF NOT EXISTS roadmap.provider_capacity_defaults (
    provider                     text         PRIMARY KEY,
    windows                      jsonb        NOT NULL DEFAULT '[]'::jsonb,
    safety_margin                numeric(4,3) NOT NULL DEFAULT 0.15,
    refuse_below_slots           integer      NOT NULL DEFAULT 1,
    default_cost_estimate_tokens bigint       NOT NULL DEFAULT 50000,
    CONSTRAINT pcd_safety_margin_range CHECK (safety_margin BETWEEN 0 AND 1)
);

COMMENT ON TABLE roadmap.provider_capacity_defaults IS
    'P465 AC-8: Provider-level capacity defaults. agency_capacity_config inherits these when no per-agency row exists.';

COMMENT ON COLUMN roadmap.provider_capacity_defaults.windows IS
    'JSONB array of {window_kind, quota_tokens, quota_requests} — window_kind: 5h|daily|weekly|monthly|custom.';

COMMENT ON COLUMN roadmap.provider_capacity_defaults.safety_margin IS
    'Fraction of quota to keep as safety buffer. Claim refused if projected margin < this value (default 0.15 = 15%).';

COMMENT ON COLUMN roadmap.provider_capacity_defaults.default_cost_estimate_tokens IS
    'Conservative per-dispatch token estimate used when actual cost is unknown (default 50 000 tokens).';

-- ── AC-7 addendum: default_cost_estimate_tokens on existing agency_capacity_config ─

ALTER TABLE roadmap.agency_capacity_config
    ADD COLUMN IF NOT EXISTS default_cost_estimate_tokens bigint NOT NULL DEFAULT 50000;

COMMENT ON COLUMN roadmap.agency_capacity_config.default_cost_estimate_tokens IS
    'P465: Conservative per-dispatch token estimate used when actual cost is unknown (default 50 000 tokens).';

-- ── AC-6: Hard provider rate-limit pause tracking on dispatch records ──────────

ALTER TABLE roadmap_workforce.squad_dispatch
    ADD COLUMN IF NOT EXISTS paused_at_provider_limit  boolean     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS provider_limit_paused_at  timestamptz;

COMMENT ON COLUMN roadmap_workforce.squad_dispatch.paused_at_provider_limit IS
    'P465 AC-6: TRUE when the in-flight claim was paused because the provider returned a hard rate limit (429).';

COMMENT ON COLUMN roadmap_workforce.squad_dispatch.provider_limit_paused_at IS
    'P465 AC-6: Timestamp when the hard-limit pause was recorded. resume_eligible_at is carried in the claim_paused message.';

COMMIT;
