-- P3840: Unified dispatch pool view.
--
-- Single projection of ALL dispatchable proposals tagged with offer_kind.
-- Extends v_dispatchable_proposal (which already filters gate_scanner_paused=false).
--
-- offer_kind derivation:
--   maturity = 'mature'                          → 'gate-review'
--   maturity IN ('new','active'), DRAFT status   → 'enhance'
--   maturity IN ('new','active'), REVIEW status  → 'review'
--   maturity IN ('new','active'), DEVELOP status → 'develop'
--   maturity IN ('new','active'), MERGE status   → 'merge'
--
-- All other combinations (terminal states, obsolete maturity, deliberation,
-- null offer_kind) are excluded by the WHERE clause.
--
-- The NOT EXISTS guard excludes proposals already covered by an active/open
-- dispatch so the pool is safe to dispatch without additional deduplication.

CREATE OR REPLACE VIEW roadmap_proposal.v_unified_dispatch_pool AS
SELECT
  p.*,
  CASE
    WHEN p.maturity = 'mature' THEN 'gate-review'
    WHEN p.maturity IN ('new', 'active') THEN
      CASE LOWER(p.status)
        WHEN 'draft'   THEN 'enhance'
        WHEN 'review'  THEN 'review'
        WHEN 'develop' THEN 'develop'
        WHEN 'merge'   THEN 'merge'
        ELSE NULL
      END
    ELSE NULL
  END AS offer_kind
FROM roadmap_proposal.v_dispatchable_proposal p
WHERE p.maturity <> 'obsolete'
  AND LOWER(p.status) NOT IN ('complete', 'deliberation')
  AND (
    p.maturity = 'mature'
    OR (
      p.maturity IN ('new', 'active')
      AND LOWER(p.status) IN ('draft', 'review', 'develop', 'merge')
    )
  )
  -- Exclude proposals already covered by a live dispatch
  AND NOT EXISTS (
    SELECT 1
      FROM roadmap_workforce.squad_dispatch sd
     WHERE sd.proposal_id = p.id
       AND sd.dispatch_status IN ('open', 'active', 'assigned', 'blocked')
       AND sd.completed_at IS NULL
  );

COMMENT ON VIEW roadmap_proposal.v_unified_dispatch_pool IS
  'P3840: Unified dispatch pool — all proposals eligible for an immediate offer, '
  'tagged with offer_kind. gate-review for mature; enhance/review/develop/merge for '
  'new/active by state. Extends v_dispatchable_proposal (gate_scanner_paused excluded). '
  'Excludes terminal states, obsolete maturity, deliberation, and proposals with live dispatches.';
