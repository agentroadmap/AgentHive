-- ============================================================
-- RFC State Machine Migration (Skeptic's Design — GQ77 Approved)
-- Date: 2026-04-04
-- Maturity: New
--
-- Maps to Roadmap_process.md state machine:
--   Draft → Review → Develop → Merge → Complete
--   Maturity: 0:New → 1:Active → 2:Mature → 3:Obsolete
--   Transitions: Mature | Decision | Wait for Dependency | Discard/Reject
--
-- GQ77 approved: "This is great, exactly what I hope to see"
-- ============================================================

BEGIN;

-- 1. Augment proposal with RFC state tracking
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS rfc_state text
  CHECK (rfc_state IN ('DRAFT','REVIEW','DEVELOP','MERGE','COMPLETE'));

ALTER TABLE proposal ADD COLUMN IF NOT EXISTS maturity_queue_position int DEFAULT 0;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS blocked_by_dependencies boolean DEFAULT false;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS accepted_criteria_count int DEFAULT 0;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS required_criteria_count int DEFAULT 0;
ALTER TABLE proposal ADD COLUMN IF NOT EXISTS priority int DEFAULT 0;

-- 2. State transition log (full audit trail)
CREATE TABLE IF NOT EXISTS proposal_state_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id bigint REFERENCES proposal(id),
  rfc_state_from text,
  rfc_state_to   text,
  maturity_from  int,
  maturity_to    int,
  triggered_by   text,
  transition_result text,  -- 'MATURE', 'DECISION_APPROVED', 'DECISION_REJECTED', 'WAITING_DEPENDENCY', 'DISCARDED'
  rationale      text,
  created_at     timestamptz DEFAULT now()
);
CREATE INDEX idx_state_log_proposal ON proposal_state_log(proposal_id);
CREATE INDEX idx_state_log_result ON proposal_state_log(transition_result);
CREATE INDEX idx_state_log_time ON proposal_state_log(created_at DESC);

-- 3. Acceptance criteria (defined at Review, verified at Develop→Merge)
CREATE TABLE IF NOT EXISTS proposal_criteria (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  criterion    text NOT NULL,
  met          boolean DEFAULT false,
  verified_by  text,
  verified_at  timestamptz
);
CREATE INDEX idx_criteria_proposal ON proposal_criteria(proposal_id);

-- 4. Review discussion / critique history
CREATE TABLE IF NOT EXISTS proposal_reviews (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
  reviewer     text NOT NULL,
  review_type  text,  -- 'critique', 'approves', 'requests_changes', 'questions'
  comment      text,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX idx_reviews_proposal ON proposal_reviews(proposal_id);
CREATE INDEX idx_reviews_reviewer ON proposal_reviews(reviewer);

-- 5. Dependencies between proposals
CREATE TABLE IF NOT EXISTS proposal_blocking (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  proposal_id bigint REFERENCES proposal(id),
  blocked_by  bigint REFERENCES proposal(id),
  dep_type    text DEFAULT 'blocks',  -- 'blocks', 'depends_on', 'relates'
  resolved    boolean DEFAULT false,
  resolved_at timestamptz
);
CREATE INDEX idx_blocking_proposal ON proposal_blocking(proposal_id);
CREATE INDEX idx_blocking_by ON proposal_blocking(blocked_by);
CREATE INDEX idx_blocking_unresolved ON proposal_blocking(proposal_id) WHERE resolved = false;

-- 6. Helper function: check if proposal is blocked
CREATE OR REPLACE FUNCTION proposal_is_blocked(p_proposal_id bigint)
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM proposal_blocking
    WHERE proposal_id = p_proposal_id AND resolved = false
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- 7. Trigger: auto-update blocked_by_dependencies flag
CREATE OR REPLACE FUNCTION update_blocked_flag()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.resolved = false THEN
      UPDATE proposal SET blocked_by_dependencies = true WHERE id = NEW.proposal_id;
    END IF;
    -- Re-check after update/resolve
    IF EXISTS (SELECT 1 FROM proposal_blocking WHERE proposal_id = NEW.proposal_id AND resolved = false) THEN
      UPDATE proposal SET blocked_by_dependencies = true WHERE id = NEW.proposal_id;
    ELSE
      UPDATE proposal SET blocked_by_dependencies = false WHERE id = NEW.proposal_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blocked_update ON proposal_blocking;
CREATE TRIGGER trg_blocked_update
  AFTER INSERT OR UPDATE ON proposal_blocking
  FOR EACH ROW EXECUTE FUNCTION update_blocked_flag();

COMMIT;
