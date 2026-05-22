-- P465: Subscription-aware claim policy — agency capacity configuration.
--
-- roadmap.agency_capacity_config  — per-agency policy overrides (safety_margin,
--   refuse_below_slots). Window quota data lives in agency.metadata.capacity_envelope
--   (populated by the liaison heartbeat via the CapacityEnvelope JSONB contract).
--
-- The subscription-policy module (src/infra/agency/subscription-policy.ts) reads
-- this table to get per-agency safety margins and slot floors; the envelope windows
-- themselves arrive via heartbeat and are stored in the existing metadata JSONB column.

BEGIN;

-- ─── 1. agency_capacity_config ───────────────────────────────────────────────
-- Per-agency policy config. Row is optional — missing row means use defaults
-- (DEFAULT_SAFETY_MARGIN=0.15, DEFAULT_REFUSE_BELOW_SLOTS=1).

CREATE TABLE IF NOT EXISTS roadmap.agency_capacity_config (
    id                  bigserial     PRIMARY KEY,
    agency_id           text          NOT NULL REFERENCES roadmap.agency(agency_id) ON DELETE CASCADE,
    safety_margin       numeric(5,4)  NOT NULL DEFAULT 0.15
                            CHECK (safety_margin >= 0 AND safety_margin < 1),
    refuse_below_slots  int           NOT NULL DEFAULT 1
                            CHECK (refuse_below_slots >= 0),
    is_enabled          boolean       NOT NULL DEFAULT true,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    updated_at          timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (agency_id)
);

COMMENT ON TABLE roadmap.agency_capacity_config IS
    'P465: Per-agency subscription policy overrides. '
    'safety_margin: refuse when projected post-claim margin < this fraction (default 0.15). '
    'refuse_below_slots: refuse when free_claim_slots < this value (default 1). '
    'Window quota data lives in roadmap.agency.metadata->capacity_envelope.';

COMMENT ON COLUMN roadmap.agency_capacity_config.safety_margin IS
    'Refuse new claims when projected margin on any window < safety_margin. Default 0.15 (15%).';

COMMENT ON COLUMN roadmap.agency_capacity_config.refuse_below_slots IS
    'Refuse new claims when capacity_envelope.free_claim_slots < this value. Default 1.';

-- AC-6: mark dispatches paused mid-flight because a provider hard-limit fired.
ALTER TABLE roadmap_workforce.squad_dispatch
    ADD COLUMN IF NOT EXISTS paused_at_provider_limit BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN roadmap_workforce.squad_dispatch.paused_at_provider_limit IS
    'P465 AC-6: true when a provider hard-limit was detected mid-flight and the '
    'liaison flagged this dispatch as paused rather than failed so it can be resumed.';

COMMIT;
