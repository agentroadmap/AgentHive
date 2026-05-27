-- P1393 hotfix: exclude paused proposals from v_mature_queue.
--
-- scanQueues feeds from this view; without the pause filter it picks up
-- paused proposals every tick, calls postWorkOffer (which now throws
-- ProposalPausedError), and burns CPU/log/throw cycles on noise that the
-- circuit breaker created in the first place.
--
-- The postWorkOffer guard is the structural barrier (other callers of
-- postWorkOffer don't go through this view). This filter is the upstream cut.
--
-- Evidence 2026-05-26: P1135 (paused since 2026-05-24) was getting fresh
-- squad_dispatch INSERTs every ~30s from scanQueues. With this filter +
-- the postWorkOffer guard, scanQueues stops fetching the row entirely.

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
  LEFT JOIN (
      SELECT pd.from_proposal_id AS proposal_id, count(*) AS blocker_count
        FROM roadmap_proposal.proposal_dependencies pd
       WHERE pd.resolved = false AND pd.dependency_type = 'blocks'
       GROUP BY pd.from_proposal_id
  ) bc ON bc.proposal_id = p.id
  LEFT JOIN (
      SELECT pd.to_proposal_id AS proposal_id, count(*) AS dep_count
        FROM roadmap_proposal.proposal_dependencies pd
       WHERE pd.resolved = false AND pd.dependency_type = 'blocks'
       GROUP BY pd.to_proposal_id
  ) dc ON dc.proposal_id = p.id
 WHERE p.maturity = 'mature'::text
   AND p.status <> 'COMPLETE'::text
   AND p.gate_scanner_paused = false        -- P1393: skip paused proposals
 ORDER BY bc.blocker_count DESC NULLS LAST, p.created_at;
