-- P1411: centralize the dispatch pause invariant for selector paths.
--
-- Dispatch, gate, claim, spawn, and stall selectors should use this view when
-- choosing candidate proposals. By-id lookups and UI/listing reads should stay
-- on roadmap_proposal.proposal so paused proposals remain visible.

CREATE OR REPLACE VIEW roadmap_proposal.v_dispatchable_proposal AS
SELECT *
  FROM roadmap_proposal.proposal
 WHERE gate_scanner_paused = false;

COMMENT ON VIEW roadmap_proposal.v_dispatchable_proposal IS
  'P1411: proposal rows eligible for automatic dispatch/gate/claim/spawn selectors; excludes gate_scanner_paused proposals.';

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
    FROM roadmap_proposal.v_dispatchable_proposal p
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
    'pipeline. Excludes terminal-status proposals (COMPLETE) and proposals paused '
    'by gate_scanner_paused through v_dispatchable_proposal (P1411).';
