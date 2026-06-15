-- 283-p1028-post-review-schema.sql
-- P1028: Post-Completion Review Sessions — Scheduled Validation of Completed Proposals
--
-- Adds the post-completion-review machinery to roadmap_proposal.proposal:
--   * enable_post_review   — opt-in flag (default true; false for hotfix/issue types)
--   * review_scheduled_at  — when the deferred review session becomes eligible
--   * review_delay_hours   — dwell between COMPLETE and review eligibility (default 24)
--   * review_verdict       — null=pending | 'confirmed' | 'needs_iteration' | 'follow_on'
--   * review_version       — bumped on reschedule so postWorkOffer() idempotency key differs
--   * review_attempts      — needs_iteration counter (escalate to operator after 3)
--
-- Also extends proposal_maturity_check to accept the new 'validated' value, and
-- installs a BEFORE UPDATE trigger that stamps review_scheduled_at on the first
-- transition into COMPLETE (when enable_post_review=true).
--
-- AC-10/AC-19: 181 and 233 and 254 are ALL taken; this uses the next genuinely
--              free global number (283; highest prior is 282).
-- AC-12/AC-21: the ONLY maturity CHECK is proposal_maturity_check (origin 055-p748);
--              the _trans_from/to_check constraints and a maturity-audit table do
--              NOT exist, so nothing else is altered. Verified live via pg_constraint.
--
-- Purely additive. Idempotent: re-running against the live DB is a no-op
-- (IF NOT EXISTS guards + CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER).
-- NOTE: outer transaction is supplied by the migration runner; no inner BEGIN/COMMIT.

-- ── 1. Columns (idempotent) ──────────────────────────────────────────────────
ALTER TABLE roadmap_proposal.proposal
	ADD COLUMN IF NOT EXISTS enable_post_review  BOOLEAN     NOT NULL DEFAULT true,
	ADD COLUMN IF NOT EXISTS review_scheduled_at TIMESTAMPTZ,
	ADD COLUMN IF NOT EXISTS review_delay_hours  INTEGER     NOT NULL DEFAULT 24,
	ADD COLUMN IF NOT EXISTS review_verdict      TEXT,
	ADD COLUMN IF NOT EXISTS review_version      INTEGER     NOT NULL DEFAULT 1,
	ADD COLUMN IF NOT EXISTS review_attempts     INTEGER     NOT NULL DEFAULT 0;

-- AC-2/AC-11: hotfix & issue proposals are exempt by default. Backfill existing
-- rows of those types to false (additive correction, not data loss). Operators
-- can still override per-proposal afterwards.
UPDATE roadmap_proposal.proposal
	SET enable_post_review = false
	WHERE type IN ('hotfix', 'issue') AND enable_post_review = true;

-- ── 2. Maturity CHECK constraint: add 'validated' ────────────────────────────
-- Drop + recreate (constraints have no CREATE OR REPLACE). Guarded so re-run is safe.
ALTER TABLE roadmap_proposal.proposal
	DROP CONSTRAINT IF EXISTS proposal_maturity_check;
ALTER TABLE roadmap_proposal.proposal
	ADD CONSTRAINT proposal_maturity_check
	CHECK (maturity = ANY (ARRAY['new'::text, 'active'::text, 'mature'::text, 'obsolete'::text, 'validated'::text]));

-- review_verdict domain guard (null = pending).
ALTER TABLE roadmap_proposal.proposal
	DROP CONSTRAINT IF EXISTS proposal_review_verdict_check;
ALTER TABLE roadmap_proposal.proposal
	ADD CONSTRAINT proposal_review_verdict_check
	CHECK (review_verdict IS NULL OR review_verdict = ANY (ARRAY['confirmed'::text, 'needs_iteration'::text, 'follow_on'::text]));

-- ── 3. Trigger: stamp review_scheduled_at on first COMPLETE transition ────────
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_schedule_post_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	-- Fire only on the first transition INTO COMPLETE, when post-review is enabled,
	-- and only if a schedule hasn't already been stamped (idempotent re-completes).
	IF NEW.status = 'COMPLETE'
		AND COALESCE(OLD.status, '') <> 'COMPLETE'
		AND NEW.enable_post_review = true
		AND NEW.review_scheduled_at IS NULL
	THEN
		NEW.review_scheduled_at := now() + (COALESCE(NEW.review_delay_hours, 24) * interval '1 hour');
	END IF;
	RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_schedule_post_review ON roadmap_proposal.proposal;
CREATE TRIGGER trg_schedule_post_review
	BEFORE UPDATE ON roadmap_proposal.proposal
	FOR EACH ROW
	EXECUTE FUNCTION roadmap_proposal.fn_schedule_post_review();

-- ── 4. Partial index for the scan tick (AC-4 hot query) ──────────────────────
CREATE INDEX IF NOT EXISTS idx_proposal_post_review_due
	ON roadmap_proposal.proposal (review_scheduled_at)
	WHERE status = 'COMPLETE' AND enable_post_review = true AND review_verdict IS NULL;
