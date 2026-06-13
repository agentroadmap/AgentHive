-- P1445 (Layer 2): atomic worktree allocation.
--
-- One row per registered git worktree. The orchestrator claims a FREE worktree
-- for a dispatch via the C1 pattern (FOR UPDATE SKIP LOCKED) so two concurrent
-- dispatches can never share a working directory. Reuses the proposal_lease
-- model: a worktree is reclaimed on dispatch completion or by a stale-lease
-- reaper.
--
-- Lease state (follows the P1445 design):
--   free    → released_at IS NOT NULL  → is_active = false  (claimable)
--   claimed → released_at IS NULL      → is_active = true
--
-- Idempotent: guarded with IF NOT EXISTS.

BEGIN;

CREATE TABLE IF NOT EXISTS roadmap.worktree_lease (
	id              BIGSERIAL PRIMARY KEY,
	worktree_name   TEXT NOT NULL UNIQUE,
	worktree_path   TEXT NOT NULL,
	-- FK to the real dispatch table (roadmap_workforce.squad_dispatch, not
	-- roadmap.squad_dispatch as the proposal text said). SET NULL so reaping a
	-- dispatch doesn't delete the worktree row.
	dispatch_id     BIGINT REFERENCES roadmap_workforce.squad_dispatch(id) ON DELETE SET NULL,
	proposal_id     BIGINT,
	agent_identity  TEXT,
	claimed_at      TIMESTAMPTZ,
	expires_at      TIMESTAMPTZ,
	-- NULL = claimed (is_active), non-NULL = free. New rows default to free via
	-- NOW(); a claim sets this back to NULL, so the column MUST be nullable.
	released_at     TIMESTAMPTZ DEFAULT NOW(),
	release_reason  TEXT,
	is_active       BOOLEAN GENERATED ALWAYS AS (released_at IS NULL) STORED
);

-- Fast scan for the next claimable (free) worktree.
CREATE INDEX IF NOT EXISTS idx_worktree_lease_free
	ON roadmap.worktree_lease (worktree_name)
	WHERE released_at IS NOT NULL;

COMMENT ON TABLE roadmap.worktree_lease IS
	'P1445: one row per registered git worktree; atomic claim via FOR UPDATE SKIP LOCKED so concurrent dispatches never share a working directory.';

COMMIT;
