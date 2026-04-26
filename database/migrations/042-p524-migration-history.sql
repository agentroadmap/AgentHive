-- P524: Global DDL Migration Runner with Rollback Policy
-- Migration history table for controlling global DDL ordering and versioning

BEGIN;

-- Create migration_history table in roadmap schema
CREATE TABLE IF NOT EXISTS roadmap.migration_history (
    id BIGSERIAL PRIMARY KEY,
    filename TEXT UNIQUE NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    applied_at TIMESTAMPTZ,
    applied_by TEXT,
    environment TEXT NOT NULL,
    runtime_seconds INT,
    rollback_filename TEXT,
    status TEXT DEFAULT 'applied',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for query performance and constraints
CREATE INDEX IF NOT EXISTS idx_migration_history_filename ON roadmap.migration_history(filename);
CREATE INDEX IF NOT EXISTS idx_migration_history_status ON roadmap.migration_history(status);
CREATE INDEX IF NOT EXISTS idx_migration_history_environment ON roadmap.migration_history(environment);

-- Add unique constraint on filename (migration_history already has UNIQUE in column def)
-- Verify table is created with proper permissions
GRANT SELECT, INSERT, UPDATE ON roadmap.migration_history TO admin;
GRANT USAGE, SELECT ON SEQUENCE roadmap.migration_history_id_seq TO admin;

COMMIT;
