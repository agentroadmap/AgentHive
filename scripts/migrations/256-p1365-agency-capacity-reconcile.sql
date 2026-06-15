-- P1365: agency_capacity table — RECONSTRUCTED from live schema 2026-06-12 (relay R2).
-- Original migration file '218-p1365-agency-capacity.sql' was applied ad-hoc and the file lost;
-- this file reconciles the repo with applied state. Idempotent.
CREATE TABLE IF NOT EXISTS roadmap_workforce.agency_capacity (
    provider text NOT NULL,
    model text NOT NULL,
    agency_id text NOT NULL,
    requests_remaining bigint,
    tokens_remaining bigint,
    requests_limit bigint,
    tokens_limit bigint,
    reset_at timestamp with time zone,
    last_sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    burn_rate_per_sec numeric(14,6),
    throttle_action text DEFAULT 'none'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    headroom_pct numeric(5,2),
    p_skip numeric(5,3) DEFAULT 0.0 NOT NULL,
    CONSTRAINT agency_capacity_p_skip_check CHECK (((p_skip >= (0)::numeric) AND (p_skip <= (1)::numeric))),
    CONSTRAINT agency_capacity_throttle_action_check CHECK ((throttle_action = ANY (ARRAY['none'::text, 'soft'::text, 'hard'::text, 'unknown'::text]))),
    CONSTRAINT agency_capacity_pkey PRIMARY KEY (provider, model, agency_id)
);
CREATE INDEX IF NOT EXISTS idx_agency_capacity_provider_model ON roadmap_workforce.agency_capacity USING btree (provider, model);
COMMENT ON COLUMN roadmap_workforce.agency_capacity.headroom_pct IS 'Minimum of requests/tokens headroom percentage (0-100). Null if capacity data unavailable. Used by soft-throttle backoff logic.';
COMMENT ON COLUMN roadmap_workforce.agency_capacity.p_skip IS 'Skip probability for soft-throttle: stochastic rejection rate applied to spawns. Range [0, 1]. 0 = no throttle, 1 = hard-throttle equivalent.';
