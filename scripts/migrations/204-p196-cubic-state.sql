-- P196: Cubic Lifecycle Management — cubic_state table, trigger, and audit schema
-- Migration 204: Ensure cubic_state table, lifecycle tracking, and audit trail
--
-- This migration formalizes the cubic_state table for tracking cubic lifecycle:
-- - ACTIVE: cubic is in use
-- - IDLE: inactive for 5+ minutes
-- - COMPLETED: cubic work finished but not yet archived
-- - ARCHIVED: stale for 30+ minutes, eligible for cleanup
--
-- A trigger on cubics table auto-creates cubic_state rows on INSERT.
-- The CubicIdleDetector and CubicCleanupService use cubic_state to manage lifecycle.
--
-- Additionally:
-- - cubic_cleanup_audit table logs all cleanup actions
-- - fn_init_cubic_state() trigger function ensures rows are created
--
-- The lifecycle thresholds are defined in CubicIdleDetector:
-- - IDLE_TIMEOUT_MS = 5 minutes
-- - STALE_TIMEOUT_MS = 30 minutes

BEGIN;

-- 1. Ensure cubic_state table exists with correct schema
CREATE TABLE IF NOT EXISTS roadmap.cubic_state (
	cubic_id text PRIMARY KEY REFERENCES roadmap.cubics(cubic_id) ON DELETE CASCADE,
	phase text NOT NULL DEFAULT 'ACTIVE',
	lifecycle_status text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle_status IN ('ACTIVE', 'IDLE', 'COMPLETED', 'ARCHIVED')),
	last_activity_at timestamp with time zone NOT NULL DEFAULT now(),
	idle_since timestamp with time zone
);

-- 2. Create indexes for lifecycle queries (if not exists)
CREATE INDEX IF NOT EXISTS idx_cubic_state_lifecycle_status
	ON roadmap.cubic_state(lifecycle_status) WHERE lifecycle_status != 'ARCHIVED';

CREATE INDEX IF NOT EXISTS idx_cubic_state_activity_age
	ON roadmap.cubic_state(last_activity_at) WHERE lifecycle_status IN ('ACTIVE', 'IDLE');

-- 3. Ensure the trigger function exists and is current
CREATE OR REPLACE FUNCTION roadmap.fn_init_cubic_state()
RETURNS TRIGGER AS $$
BEGIN
	-- Auto-create cubic_state row on INSERT into cubics
	INSERT INTO roadmap.cubic_state (cubic_id, phase, lifecycle_status, last_activity_at, idle_since)
	VALUES (NEW.cubic_id, 'RUNNING', 'ACTIVE', now(), NULL)
	ON CONFLICT (cubic_id) DO NOTHING;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Recreate the trigger (idempotent)
DROP TRIGGER IF EXISTS trg_cubic_state_init ON roadmap.cubics;
CREATE TRIGGER trg_cubic_state_init
	AFTER INSERT ON roadmap.cubics
	FOR EACH ROW
	EXECUTE FUNCTION roadmap.fn_init_cubic_state();

-- 5. Ensure cubic_cleanup_audit table exists (for AC-8 audit trail)
CREATE TABLE IF NOT EXISTS roadmap.cubic_cleanup_audit (
	id bigserial PRIMARY KEY,
	cubic_id text NOT NULL REFERENCES roadmap.cubics(cubic_id) ON DELETE CASCADE,
	action text NOT NULL CHECK (action IN ('PRESERVED', 'DELETED', 'LEASE_RELEASED', 'FORCE_REAP', 'ORPHANED', 'ARCHIVED')),
	orphan_rule smallint,
	reason text,
	recovery_path text,
	worktree_path text,
	actor text DEFAULT 'system',
	proposal_id integer,
	created_at timestamp with time zone DEFAULT now()
);

-- 6. Index for audit queries
CREATE INDEX IF NOT EXISTS idx_cubic_cleanup_audit_cubic_id
	ON roadmap.cubic_cleanup_audit(cubic_id);

CREATE INDEX IF NOT EXISTS idx_cubic_cleanup_audit_created_at
	ON roadmap.cubic_cleanup_audit(created_at DESC);

COMMIT;

-- Verification:
--   SELECT COUNT(*) FROM roadmap.cubic_state;
--   SELECT COUNT(*) FROM roadmap.cubic_cleanup_audit;
--   SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema='roadmap' AND event_object_table='cubics';
--   Expected: cubic_state table exists, trg_cubic_state_init trigger is active
