-- 294 — P3840: v_unified_dispatch_pool view
--
-- Extends v_dispatchable_proposal (already excludes paused/COMPLETE/obsolete)
-- with offer_kind tagging so the orchestrator can dispatch work offers for ALL
-- non-terminal proposals from a single query, not just the mature queue.
--
-- offer_kind mapping:
--   maturity='mature'                              → gate-review
--   maturity IN ('new','active') + status=DRAFT   → enhance
--   maturity IN ('new','active') + status=REVIEW  → review
--   maturity IN ('new','active') + status=DEVELOP → develop
--   maturity IN ('new','active') + status=MERGE   → merge
--
-- Active-dispatch guard (dispatch.id IS NULL) mirrors claimImplicitGateReady,
-- preventing double-posting when an offer is already open for the proposal.
--
-- Rows whose status falls outside the dispatch allowlist (e.g. TRIAGE, FIX that
-- haven't been explicitly added) are excluded by the WHERE clause.

CREATE OR REPLACE VIEW roadmap_proposal.v_unified_dispatch_pool AS
SELECT
    p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.maturity,
    p.priority,
    p.created_at,
    p.modified_at,
    CASE
        WHEN p.maturity = 'mature'
             THEN 'gate-review'
        WHEN LOWER(p.status) = 'draft'
             THEN 'enhance'
        WHEN LOWER(p.status) = 'review'
             THEN 'review'
        WHEN LOWER(p.status) = 'develop'
             THEN 'develop'
        WHEN LOWER(p.status) = 'merge'
             THEN 'merge'
    END AS offer_kind
FROM roadmap_proposal.v_dispatchable_proposal p
LEFT JOIN LATERAL (
    SELECT sd.id
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.proposal_id = p.id
      AND sd.dispatch_status IN ('active', 'open', 'assigned')
      AND sd.completed_at IS NULL
    ORDER BY sd.assigned_at DESC
    LIMIT 1
) dispatch ON true
WHERE dispatch.id IS NULL
  AND (
    LOWER(p.status) IN ('draft', 'review', 'develop', 'merge')
    OR (LOWER(p.status) = 'deliberation' AND p.type = 'governance-amendment')
  );

COMMENT ON VIEW roadmap_proposal.v_unified_dispatch_pool IS
    'P3840: all non-terminal, non-paused, non-obsolete proposals without an active '
    'squad_dispatch offer, tagged with offer_kind per (status, maturity). Used by '
    'scanQueues() when ORCHESTRATOR_UNIFIED_POOL_ENABLED=true to post work/gate '
    'offers for every dispatchable proposal from a single query.';
