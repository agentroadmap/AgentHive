-- P926 AC-8: Umbrella closeout checker function
-- Verifies whether an architectural umbrella proposal is eligible for COMPLETE
-- (all children in terminal state: COMPLETE or maturity=obsolete)

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_check_umbrella_closeout(
  p_umbrella_id BIGINT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_all_complete BOOLEAN;
  v_children_count INTEGER;
  v_terminal_count INTEGER;
BEGIN
  -- Count total children (proposals with parent_id = umbrella_id)
  SELECT COUNT(*)
  INTO v_children_count
  FROM roadmap_proposal.proposal
  WHERE parent_id = p_umbrella_id;

  -- If no children, umbrella is trivially eligible
  IF v_children_count = 0 THEN
    RETURN TRUE;
  END IF;

  -- Count children in terminal state
  -- Terminal = status='COMPLETE' OR maturity='obsolete'
  SELECT COUNT(*)
  INTO v_terminal_count
  FROM roadmap_proposal.proposal
  WHERE parent_id = p_umbrella_id
    AND (status = 'COMPLETE' OR maturity = 'obsolete');

  -- Return TRUE if all children are terminal
  RETURN (v_terminal_count = v_children_count);
END;
$$ LANGUAGE plpgsql STABLE;

-- Verification query (commented; operator runs manually before MERGE gate):
-- SELECT
--   p.id,
--   p.display_id,
--   p.title,
--   roadmap_proposal.fn_check_umbrella_closeout(p.id) AS eligible_for_closeout
-- FROM roadmap_proposal.proposal p
-- WHERE p.id IN (744, 890);
--
-- Expected result (when all children terminal):
-- | id  | display_id | title | eligible_for_closeout |
-- |-----+------------+-------+-----------------------|
-- | 744 | P744       | ... | t                     |
-- | 890 | P890       | ... | t                     |
