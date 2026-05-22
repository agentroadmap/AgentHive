-- P798 AC-1: Backfill model_metadata.tier for o3 and o4-mini.
-- Both routes are currently is_enabled=false so no dispatch is blocked,
-- but NULL tier violates the data-integrity contract.

BEGIN;

UPDATE roadmap.model_metadata
SET tier = 'frontier'
WHERE model_name = 'o3' AND provider = 'openai' AND tier IS NULL;

UPDATE roadmap.model_metadata
SET tier = 'standard'
WHERE model_name = 'o4-mini' AND provider = 'openai' AND tier IS NULL;

COMMIT;
