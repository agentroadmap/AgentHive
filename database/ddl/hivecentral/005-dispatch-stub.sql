-- P595 coordination stub for P603 (dispatch schema)
-- Creates the dispatch schema and dispatch.work_claim table with the cost_snapshot JSONB
-- column required by AC-5. P603 will ADD further columns (agent task state, expiry, etc.);
-- this stub establishes the cost-snapshot contract and FK to hivecentral.model_route.
--
-- cost_snapshot shape (snapped at claim time, immutable after insert):
-- {
--   "route_name":              "claude-sonnet-4-6-anthropic",
--   "model_name":              "claude-sonnet-4-6",
--   "cost_per_1m_input":       3.000,
--   "cost_per_1m_output":      15.000,
--   "cost_per_1m_cache_write": 3.750,
--   "cost_per_1m_cache_hit":   0.300,
--   "snapshot_at":             "2026-04-27T00:00:00Z"
-- }
-- Rationale: route pricing changes over time; snapshots keep historical cost reports
-- consistent without locking the live model_route row.

BEGIN;

CREATE SCHEMA IF NOT EXISTS dispatch;

-- owner_did exempt: per-claim transactional billing record (not a managed catalog
-- entity). Ownership is conveyed by agent_identity; one row per work claim with an
-- immutable cost_snapshot audit. Not deprecated/retired — no lifecycle hygiene applies.
CREATE TABLE IF NOT EXISTS dispatch.work_claim (
    id             BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id    BIGINT,
    agent_identity TEXT,
    route_id       BIGINT       REFERENCES hivecentral.model_route(id) ON DELETE SET NULL,
    cost_snapshot  JSONB        NOT NULL DEFAULT '{}',
    claimed_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    released_at    TIMESTAMPTZ,
    metadata       JSONB        NOT NULL DEFAULT '{}'
);

COMMENT ON TABLE  dispatch.work_claim IS
    'P603 stub: atomic work claim with immutable cost snapshot. '
    'cost_snapshot freezes route pricing at claim time for consistent historical billing reports. '
    'P603 will extend this table with task-state, expiry, and concurrency columns.';
COMMENT ON COLUMN dispatch.work_claim.cost_snapshot IS
    'Pricing values snapped from hivecentral.model_route at claim time. '
    'Immutable after insert. Remains valid even after route is updated or deleted.';
COMMENT ON COLUMN dispatch.work_claim.route_id IS
    'FK to hivecentral.model_route; SET NULL on route delete. '
    'cost_snapshot provides permanent billing reference regardless of route lifecycle.';

CREATE INDEX IF NOT EXISTS idx_dispatch_work_claim_proposal
    ON dispatch.work_claim (proposal_id)
    WHERE proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_work_claim_agent
    ON dispatch.work_claim (agent_identity)
    WHERE agent_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_work_claim_claimed
    ON dispatch.work_claim (claimed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_work_claim_open
    ON dispatch.work_claim (id)
    WHERE released_at IS NULL;

-- ── cost_snapshot immutability guard ─────────────────────────────────────────
-- cost_snapshot is a billing audit record; any UPDATE that changes it is a bug.
-- Enforced at DB level so application bugs or ad-hoc migrations cannot silently
-- corrupt historical cost reports.

CREATE OR REPLACE FUNCTION dispatch.fn_guard_cost_snapshot()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.cost_snapshot IS DISTINCT FROM OLD.cost_snapshot THEN
        RAISE EXCEPTION
            'dispatch.work_claim.cost_snapshot is immutable after insert (claim id=%). '
            'Attempted update rejected — create a new claim instead.',
            OLD.id;
    END IF;
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_dispatch_guard_cost_snapshot') THEN
        CREATE TRIGGER trg_dispatch_guard_cost_snapshot
            BEFORE UPDATE ON dispatch.work_claim
            FOR EACH ROW EXECUTE FUNCTION dispatch.fn_guard_cost_snapshot();
    END IF;
END $$;

COMMIT;
