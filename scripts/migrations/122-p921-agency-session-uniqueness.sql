-- P921 — Active liaison session uniqueness for roadmap.agency_liaison_session.
-- DEPENDS ON: P913 hotfix merged first (separate proposal)

BEGIN;

WITH dups AS (
  SELECT session_id, agency_id,
         ROW_NUMBER() OVER (PARTITION BY agency_id ORDER BY started_at DESC) AS rn
    FROM roadmap.agency_liaison_session
   WHERE ended_at IS NULL
)
UPDATE roadmap.agency_liaison_session s
   SET ended_at = now(), end_reason = 'backfill_pre_uniqueness_index'
  FROM dups
 WHERE s.session_id = dups.session_id AND dups.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_session_one_active
    ON roadmap.agency_liaison_session(agency_id) WHERE ended_at IS NULL;

COMMIT;
