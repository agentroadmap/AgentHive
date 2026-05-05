-- P595 coordination stub for P604 (observability schema)
-- Reserves observability.model_routing_outcome with the three structured fields
-- named in AC-8: selection_reason_kind, candidate_routes_scored, evaluation_policy_id.
-- P604 will define full routing logic and may add columns; this stub establishes
-- the FK to hivecentral.model_route and the queryable decision trace contract.

BEGIN;

CREATE SCHEMA IF NOT EXISTS observability;

CREATE TABLE IF NOT EXISTS observability.model_routing_outcome (
    id                      BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Context
    work_claim_id           BIGINT,      -- FK to dispatch.work_claim; loose until P603/P604 align
    agent_identity          TEXT,
    proposal_id             BIGINT,

    -- Selected route
    selected_route_id       BIGINT       REFERENCES hivecentral.model_route(id) ON DELETE SET NULL,

    -- AC-8 structured decision trace fields
    selection_reason_kind   TEXT         NOT NULL,
    -- Enumerated values (deterministic label, queryable without prose parsing):
    --   default           — chosen because is_default=true and no other signal
    --   capability_match  — chosen for a specific model_capability requirement
    --   cost_optimal      — lowest projected cost among qualified candidates
    --   fallback          — primary route failed, fallback_route_id activated
    --   policy_override   — human or operator explicitly overrode selector
    --   manual            — agent specified route directly (bypassed selector)

    candidate_routes_scored JSONB,
    -- Array of all candidates evaluated before selection:
    -- [{
    --   "route_id": 1,
    --   "route_name": "...",
    --   "score": 0.87,
    --   "disqualified": false,
    --   "disqualified_reason": null
    -- }, ...]

    evaluation_policy_id    BIGINT,      -- Reserved FK to policy table; P604 adds the constraint

    host                    TEXT,
    decided_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT selection_reason_kind_valid CHECK (
        selection_reason_kind IN (
            'default', 'capability_match', 'cost_optimal',
            'fallback', 'policy_override', 'manual'
        )
    )
);

COMMENT ON TABLE  observability.model_routing_outcome IS
    'P604 coordination stub: structured routing decision record. Answers why-this-route for every dispatch invocation.';
COMMENT ON COLUMN observability.model_routing_outcome.selection_reason_kind IS
    'Enumerated reason kind — deterministic label queryable without parsing prose. '
    'Constraint enforces the 6-value vocabulary.';
COMMENT ON COLUMN observability.model_routing_outcome.candidate_routes_scored IS
    'All candidates evaluated with their scores and disqualification reasons. Enables routing audits and selector tuning.';
COMMENT ON COLUMN observability.model_routing_outcome.evaluation_policy_id IS
    'Reserved FK to the policy snapshot that governed this evaluation. '
    'P604 will add the referenced table and formalize the FK constraint.';

CREATE INDEX IF NOT EXISTS idx_obs_routing_proposal
    ON observability.model_routing_outcome (proposal_id)
    WHERE proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_obs_routing_decided
    ON observability.model_routing_outcome (decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_obs_routing_selected_route
    ON observability.model_routing_outcome (selected_route_id)
    WHERE selected_route_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_obs_routing_kind
    ON observability.model_routing_outcome (selection_reason_kind);

COMMIT;
