-- P1131 AC-10: Historical cluster detection
-- Replays the 7-day window using the same logic as the trigger.
-- Shows clusters that would have triggered the >=3-approves-in-60s alarm.
--
-- Run: psql -d agenthive -f scripts/audits/find-historical-clusters.sql
--
-- Known clusters to confirm:
--   2026-05-16 00:57:06 UTC  gate-reviewer  6 approves in <1s
--   2026-05-16 23:55:33 UTC  gate-reviewer  12 approves in 27s

WITH windowed AS (
  SELECT
    r.id,
    r.proposal_id,
    r.reviewer_identity,
    r.reviewed_at,
    r.verdict,
    count(*) OVER (
      PARTITION BY r.reviewer_identity
      ORDER BY r.reviewed_at
      RANGE BETWEEN interval '60 seconds' PRECEDING AND CURRENT ROW
    ) AS window_count
  FROM roadmap_proposal.proposal_reviews r
  WHERE r.verdict = 'approve'
    AND r.reviewed_at >= now() - interval '7 days'
),
cluster_rows AS (
  SELECT *
  FROM windowed
  WHERE window_count >= 3
    AND window_count % 3 = 0  -- milestone rows only (matches trigger logic)
)
SELECT
  c.reviewer_identity,
  c.window_count                               AS approve_count,
  c.reviewed_at                                AS milestone_at,
  c.proposal_id                                AS latest_proposal_id,
  p.display_id,
  p.title
FROM cluster_rows c
LEFT JOIN roadmap_proposal.proposal p ON p.id = c.proposal_id
ORDER BY c.reviewed_at;
