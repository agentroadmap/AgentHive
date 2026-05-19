-- P798: Backfill missing tier values for o3 and o4-mini.
--
-- Both models had NULL tier in model_metadata. Their routes are currently
-- is_enabled=false so no active dispatch is affected, but the missing tier
-- breaks model_route_view tier-filtered queries and violates the CHECK constraint
-- intention (all production models should be classified).
--
-- Source: P798 design audit 2026-05-16, Gap 1.

BEGIN;

UPDATE roadmap.model_metadata
SET    tier = 'frontier'
WHERE  model_name = 'o3'
  AND  provider   = 'openai'
  AND  tier IS NULL;

UPDATE roadmap.model_metadata
SET    tier = 'standard'
WHERE  model_name = 'o4-mini'
  AND  provider   = 'openai'
  AND  tier IS NULL;

COMMIT;
