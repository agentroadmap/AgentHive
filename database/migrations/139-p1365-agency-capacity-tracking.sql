-- P1365: Pre-emptive LLM throttle — agency capacity tracking
-- Stores rate-limit signal samples per provider/model/agency
-- Supports gradual backoff decisions based on remaining capacity headroom

CREATE TABLE IF NOT EXISTS roadmap_workforce.agency_capacity (
  provider          text NOT NULL,
  model             text NOT NULL,
  agency_id         text NOT NULL,
  requests_remaining bigint,
  tokens_remaining   bigint,
  requests_limit    bigint,
  tokens_limit      bigint,
  reset_at          timestamptz,
  last_sampled_at   timestamptz NOT NULL DEFAULT now(),
  burn_rate_per_sec numeric(14,6),
  throttle_action   text NOT NULL DEFAULT 'none'
    CHECK (throttle_action IN ('none','soft','hard','unknown')),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, agency_id)
);

CREATE INDEX IF NOT EXISTS idx_agency_capacity_provider_model
  ON roadmap_workforce.agency_capacity (provider, model);
CREATE INDEX IF NOT EXISTS idx_agency_capacity_throttle_action
  ON roadmap_workforce.agency_capacity (throttle_action)
  WHERE throttle_action <> 'none';
