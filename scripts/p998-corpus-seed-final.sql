-- P998: Final Corpus Seeding Script
-- Systematically classify remaining unmapped proposals into proposal_migration_map
-- Run with: psql -d agenthive -f scripts/p998-corpus-seed-final.sql

-- =============================================================================
-- Handle all remaining unmapped proposals with clean classification logic
-- =============================================================================

WITH unmapped_analysis AS (
  SELECT
    p.id,
    p.display_id,
    p.title,
    p.status,
    p.maturity,
    p.type,
    (
      CASE WHEN COUNT(ac.id) = 0 THEN '[]'::jsonb
      ELSE COALESCE(
        json_agg(
          json_build_object('type', 'ac', 'proposal_id', ac.proposal_id, 'item_number', ac.item_number)
          ORDER BY ac.item_number
        ) FILTER (WHERE ac.status IN ('pass', 'waived')),
        '[]'::json
      )::jsonb
      END
    ) as ac_evidence,
    COUNT(ac.id) as total_acs,
    COUNT(CASE WHEN ac.status IN ('pass', 'waived') THEN 1 END) as ac_complete_count
  FROM roadmap_proposal.proposal p
  LEFT JOIN roadmap_proposal.proposal_acceptance_criteria ac ON ac.proposal_id = p.id
  WHERE NOT EXISTS (
    SELECT 1 FROM roadmap_proposal.proposal_migration_map pmm
    WHERE pmm.legacy_proposal_row_id = p.id
  )
  GROUP BY p.id, p.display_id, p.title, p.status, p.maturity, p.type
)
INSERT INTO roadmap_proposal.proposal_migration_map (
  legacy_proposal_id,
  legacy_proposal_row_id,
  classification,
  rationale,
  evidence_refs,
  reviewed_by,
  reviewed_at,
  created_by
)
SELECT
  ua.display_id,
  ua.id,
  CASE
    -- COMPLETE with all ACs pass/waived: delivered_evidence
    WHEN ua.status = 'COMPLETE' AND ua.total_acs > 0 AND ua.ac_complete_count = ua.total_acs THEN 'delivered_evidence'
    -- COMPLETE with no ACs: reauthor_needed (no audit trail)
    WHEN ua.status = 'COMPLETE' AND ua.total_acs = 0 THEN 'reauthor_needed'
    -- Maturity=obsolete: obsolete
    WHEN ua.maturity = 'obsolete' THEN 'obsolete'
    -- Architecture type: retained (review needed for pillar assignment)
    WHEN ua.type = 'architecture' THEN 'retained'
    -- Default: retained
    ELSE 'retained'
  END as classification,
  CASE
    WHEN ua.status = 'COMPLETE' AND ua.total_acs > 0 AND ua.ac_complete_count = ua.total_acs THEN
      'COMPLETE; ' || ua.ac_complete_count || '/' || ua.total_acs || ' ACs pass/waived'
    WHEN ua.status = 'COMPLETE' AND ua.total_acs = 0 THEN
      'COMPLETE with no AC audit trail'
    WHEN ua.maturity = 'obsolete' THEN
      'Maturity: obsolete; Status: ' || ua.status
    WHEN ua.type = 'architecture' THEN
      'Architecture ' || ua.status || '; maturity: ' || ua.maturity
    ELSE
      'Status: ' || ua.status || '; Type: ' || ua.type || '; Maturity: ' || ua.maturity
  END as rationale,
  (CASE
    WHEN ua.status = 'COMPLETE' AND ua.total_acs > 0 AND ua.ac_complete_count = ua.total_acs THEN ua.ac_evidence
    ELSE '[]'::jsonb
  END) as evidence_refs,
  'claude-bot-gary-gating' as reviewed_by,
  now() as reviewed_at,
  'claude-bot-gary-gating' as created_by
FROM unmapped_analysis ua
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- =============================================================================
-- Summary Statistics
-- =============================================================================

SELECT
  '--- P998 Corpus Seeding Complete ---' as status;

SELECT
  classification,
  COUNT(*) as count,
  SUM(CASE WHEN reviewed_by IS NOT NULL THEN 1 ELSE 0 END) as reviewed,
  SUM(CASE WHEN evidence_refs != '[]'::jsonb THEN 1 ELSE 0 END) as with_evidence
FROM roadmap_proposal.proposal_migration_map
GROUP BY classification
ORDER BY count DESC;

SELECT
  'Total mapped in migration_map:' as metric,
  COUNT(*)::text as value
FROM roadmap_proposal.proposal_migration_map;

SELECT
  'Total proposals in corpus:' as metric,
  COUNT(*)::text as value
FROM roadmap_proposal.proposal;

SELECT
  'Still unmapped:' as metric,
  (SELECT COUNT(*)
   FROM roadmap_proposal.proposal p
   WHERE NOT EXISTS (
     SELECT 1 FROM roadmap_proposal.proposal_migration_map pmm
     WHERE pmm.legacy_proposal_row_id = p.id
   )
  )::text as value;

-- Show unresolved (incomplete evidence)
SELECT
  'Unresolved (no evidence or not reviewed):' as metric,
  COUNT(*)::text as value
FROM roadmap_proposal.proposal_migration_map
WHERE reviewed_by IS NULL OR reviewed_at IS NULL OR evidence_refs = '[]'::jsonb;
