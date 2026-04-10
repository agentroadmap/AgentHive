-- Migration 016: Pulse Fleet Observability (P063)
--
-- Tracks agent heartbeats, infers status from heartbeat patterns,
-- and provides fleet-level health metrics.
-- Each agent sends periodic heartbeats; the system infers
-- healthy/stale/offline/crashed status from heartbeat cadence.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap.agent_health (
    agent_identity    TEXT PRIMARY KEY REFERENCES roadmap.agent_registry(agent_identity) ON DELETE CASCADE,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status            TEXT NOT NULL DEFAULT 'healthy'
                        CHECK (status IN ('healthy', 'stale', 'offline', 'crashed')),
    current_task      TEXT,
    current_proposal  INTEGER REFERENCES roadmap.proposals(id) ON DELETE SET NULL,
    current_cubic     TEXT REFERENCES roadmap.cubics(cubic_id) ON DELETE SET NULL,
    cpu_percent       NUMERIC(5,2),
    memory_mb         INTEGER,
    active_model      TEXT,
    uptime_seconds    INTEGER,
    metadata          JSONB DEFAULT '{}'::jsonb,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Heartbeat history for trend analysis (rolling 24h window)
CREATE TABLE IF NOT EXISTS roadmap.agent_heartbeat_log (
    id                BIGSERIAL PRIMARY KEY,
    agent_identity    TEXT NOT NULL REFERENCES roadmap.agent_registry(agent_identity) ON DELETE CASCADE,
    heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cpu_percent       NUMERIC(5,2),
    memory_mb         INTEGER,
    active_model      TEXT,
    current_task      TEXT,
    metadata          JSONB DEFAULT '{}'::jsonb
);

-- Index for efficient heartbeat queries
CREATE INDEX IF NOT EXISTS idx_heartbeat_log_agent_time
    ON roadmap.agent_heartbeat_log(agent_identity, heartbeat_at DESC);

-- Auto-cleanup: prune heartbeat logs older than 7 days
CREATE OR REPLACE FUNCTION roadmap.fn_cleanup_old_heartbeats()
RETURNS void AS $$
BEGIN
    DELETE FROM roadmap.agent_heartbeat_log
    WHERE heartbeat_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- Updated-at trigger for agent_health
CREATE OR REPLACE FUNCTION roadmap.fn_agent_health_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_health_updated_at ON roadmap.agent_health;
CREATE TRIGGER trg_agent_health_updated_at
    BEFORE UPDATE ON roadmap.agent_health
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_agent_health_updated_at();

-- Grant access to application roles
GRANT SELECT, INSERT, UPDATE, DELETE ON roadmap.agent_health TO roadmap_agent;
GRANT SELECT, INSERT, DELETE ON roadmap.agent_heartbeat_log TO roadmap_agent;
GRANT USAGE ON SEQUENCE roadmap.agent_heartbeat_log_id_seq TO roadmap_agent;

COMMIT;
