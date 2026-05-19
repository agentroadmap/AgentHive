-- Migration 145: Exclude COMPLETE proposals from v_mature_queue
--
-- Problem: v_mature_queue filtered only on maturity = 'mature', so proposals
-- that reached COMPLETE status but still have maturity = 'mature' (a maturity
-- reset that never happened) would continue to appear in the gate-scan queue
-- and receive repeated dispatch offers that immediately expire.
--
-- Fix: add AND p.status NOT IN ('COMPLETE') so terminal proposals are never
-- fed back into the dispatch pipeline regardless of their maturity column.

CREATE OR REPLACE VIEW roadmap_proposal.v_mature_queue AS
  SELECT p.id,
     p.display_id,
     p.type,
     p.title,
     p.status,
     p.maturity,
     p.priority,
     p.created_at,
     COALESCE(bc.blocker_count, 0::bigint) AS blocks_count,
     COALESCE(dc.dep_count, 0::bigint) AS depends_on_count
    FROM roadmap_proposal.proposal p
      LEFT JOIN ( SELECT proposal_dependencies.from_proposal_id AS proposal_id,
             count(*) AS blocker_count
            FROM roadmap_proposal.proposal_dependencies
           WHERE proposal_dependencies.resolved = false AND proposal_dependencies.dependency_type = 'blocks'::text
           GROUP BY proposal_dependencies.from_proposal_id) bc ON bc.proposal_id = p.id
      LEFT JOIN ( SELECT proposal_dependencies.to_proposal_id AS proposal_id,
             count(*) AS dep_count
            FROM roadmap_proposal.proposal_dependencies
           WHERE proposal_dependencies.resolved = false AND proposal_dependencies.dependency_type = 'blocks'::text
           GROUP BY proposal_dependencies.to_proposal_id) dc ON dc.proposal_id = p.id
   WHERE p.maturity = 'mature'::text
     AND p.status NOT IN ('COMPLETE')
   ORDER BY bc.blocker_count DESC NULLS LAST, p.created_at;

COMMENT ON VIEW roadmap_proposal.v_mature_queue IS
    'Proposals with maturity=''mature'' that are ready for the gate-scan dispatch '
    'pipeline. Excludes terminal-status proposals (COMPLETE) so they cannot be '
    're-dispatched after completion (migration 145).';
