-- P1729: Cumulative gate convergence guard
--
-- Add columns to track state/maturity transitions and implement a cumulative
-- convergence guard that pauses proposals when blocking review count or
-- per-role run count exceeds thresholds since the last state/maturity transition.

-- 1. Add state_changed_at column to proposal to track last state or maturity transition
ALTER TABLE roadmap_proposal.proposal
  ADD COLUMN IF NOT EXISTS state_changed_at timestamp with time zone
    DEFAULT now();

-- 2. Create view v_gated_by_convergence for operator triage
CREATE OR REPLACE VIEW roadmap_proposal.v_gated_by_convergence AS
SELECT
  p.id,
  p.display_id,
  p.title,
  p.status,
  p.maturity,
  p.gate_paused_reason,
  p.gate_paused_at,
  EXTRACT(EPOCH FROM (now() - p.state_changed_at)) / 3600.0 AS since_transition_hours,
  (SELECT count(*)::int
     FROM roadmap_proposal.proposal_reviews pr
    WHERE pr.proposal_id = p.id
      AND pr.is_blocking = true
      AND pr.reviewed_at > p.state_changed_at
  ) AS blocking_review_count,
  (SELECT count(*)::int
     FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.proposal_id = p.id
      AND sd.agent_identity IS NOT NULL
      AND sd.assigned_at > p.state_changed_at
  ) AS per_role_run_count
FROM roadmap_proposal.proposal p
WHERE p.gate_scanner_paused = true
  AND p.gate_paused_by = 'convergence_guard'
ORDER BY p.id DESC;

-- 3. Create function to reset convergence counters on state/maturity transition
CREATE OR REPLACE FUNCTION fn_reset_convergence_counters()
RETURNS TRIGGER AS $$
BEGIN
  -- Reset state_changed_at whenever status or maturity changes
  IF (OLD.status != NEW.status) OR (OLD.maturity != NEW.maturity) THEN
    NEW.state_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Create or replace trigger to fire on state/maturity changes
DROP TRIGGER IF EXISTS trg_proposal_convergence_reset ON roadmap_proposal.proposal;
CREATE TRIGGER trg_proposal_convergence_reset
  BEFORE UPDATE ON roadmap_proposal.proposal
  FOR EACH ROW
  EXECUTE FUNCTION fn_reset_convergence_counters();

-- 5. Backfill state_changed_at for existing proposals
-- Set it to the timestamp of the latest audit entry (StatusChange or maturity change)
UPDATE roadmap_proposal.proposal p
SET state_changed_at = (
  SELECT MAX((audit_entry->>'TS')::timestamp with time zone)
  FROM (
    SELECT jsonb_array_elements(audit) AS audit_entry
    FROM roadmap_proposal.proposal
    WHERE id = p.id
  ) sub
  WHERE audit_entry->>'Activity' IN ('StatusChange', 'MaturityChange')
)
WHERE state_changed_at = (now()::date)::timestamp; -- Only rows that are using the default

-- For rows without a StatusChange/MaturityChange in audit, use the created_at (via first audit entry)
UPDATE roadmap_proposal.proposal p
SET state_changed_at = (
  SELECT (audit_entry->>'TS')::timestamp with time zone
  FROM (
    SELECT jsonb_array_elements(audit) AS audit_entry
    FROM roadmap_proposal.proposal
    WHERE id = p.id
  ) sub
  ORDER BY audit_entry->>'TS' ASC
  LIMIT 1
)
WHERE state_changed_at = (now()::date)::timestamp;
