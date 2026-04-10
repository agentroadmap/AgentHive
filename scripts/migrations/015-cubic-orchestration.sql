-- Migration 015: Cubic Orchestration & Multi-LLM Routing (P058)
--
-- Creates the cubics table for bounded execution contexts.
-- Each cubic represents a work-cell: one proposal, one agent slot,
-- a Git worktree, a resource budget, and a lifecycle state machine.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap.cubics (
    cubic_id        TEXT PRIMARY KEY DEFAULT ('cubic-' || LP(FLOOR(RANDOM() * 999999)::INT::TEXT, 6, '0')),
    proposal_id     INTEGER REFERENCES roadmap.proposals(id) ON DELETE SET NULL,
    agent_identity  TEXT REFERENCES roadmap.agent_registry(agent_identity) ON DELETE SET NULL,
    worktree_path   TEXT NOT NULL,
    budget_usd      NUMERIC(10,4),
    status          TEXT NOT NULL DEFAULT 'idle'
                        CHECK (status IN ('idle', 'active', 'blocked', 'complete')),
    phase           TEXT NOT NULL DEFAULT 'design',
    lock_holder     TEXT,
    lock_phase      TEXT,
    locked_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at    TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    metadata        JSONB DEFAULT '{}'::jsonb
);

-- Index for listing cubics by status and agent
CREATE INDEX IF NOT EXISTS idx_cubics_status ON roadmap.cubics(status);
CREATE INDEX IF NOT EXISTS idx_cubics_agent ON roadmap.cubics(agent_identity);
CREATE INDEX IF NOT EXISTS idx_cubics_proposal ON roadmap.cubics(proposal_id);

-- Updated-at trigger
CREATE OR REPLACE FUNCTION roadmap.fn_cubic_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.metadata = COALESCE(NEW.metadata, '{}'::jsonb);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Grant access to application roles
GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.cubics TO roadmap_agent;
GRANT USAGE ON SCHEMA roadmap TO roadmap_agent;

COMMIT;
