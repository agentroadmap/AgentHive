-- P3310 — Child A: Dynamic task-difficulty / required-capability signal.
--
-- AC-1: a difficulty assessor runs when a work offer is minted and persists
-- difficulty_score ∈ [0,1] and required_capability_tier on the squad_dispatch
-- row. This migration adds those two columns. (task_class already exists with a
-- CHECK constraint matching the AC-3 enum — added by an earlier migration; we
-- do NOT redefine it here.)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint adds. Safe to
-- re-run. Author-only — NOT applied to live by this proposal.

BEGIN;

-- difficulty_score ∈ [0,1], nullable (legacy rows + offers minted before the
-- assessor was wired stay NULL; the matcher treats NULL as "unassessed").
ALTER TABLE roadmap_workforce.squad_dispatch
	ADD COLUMN IF NOT EXISTS difficulty_score double precision;

-- required_capability_tier reuses the P1005/P1091 tier vocabulary
-- (free < lower < mid < frontier). Stored as text to match the route-resolver
-- tier columns elsewhere in the schema.
ALTER TABLE roadmap_workforce.squad_dispatch
	ADD COLUMN IF NOT EXISTS required_capability_tier text;

-- Range guard for difficulty_score (NULL allowed). Added NOT VALID so the
-- migration never blocks on a full-table scan of legacy rows; new writes are
-- still checked.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'squad_dispatch_difficulty_score_check'
	) THEN
		ALTER TABLE roadmap_workforce.squad_dispatch
			ADD CONSTRAINT squad_dispatch_difficulty_score_check
			CHECK (difficulty_score IS NULL
			       OR (difficulty_score >= 0 AND difficulty_score <= 1))
			NOT VALID;
	END IF;
END $$;

-- Vocabulary guard for required_capability_tier (NULL allowed). Matches the
-- canonical tier ladder used by the P1091 route resolver.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'squad_dispatch_required_capability_tier_check'
	) THEN
		ALTER TABLE roadmap_workforce.squad_dispatch
			ADD CONSTRAINT squad_dispatch_required_capability_tier_check
			CHECK (required_capability_tier IS NULL
			       OR required_capability_tier IN ('free', 'lower', 'mid', 'frontier'))
			NOT VALID;
	END IF;
END $$;

-- Index so Child C (P3312 matcher) can filter open offers by required tier
-- without a full scan.
CREATE INDEX IF NOT EXISTS idx_squad_dispatch_required_tier
	ON roadmap_workforce.squad_dispatch (required_capability_tier, offer_status)
	WHERE offer_status = 'open';

COMMIT;
