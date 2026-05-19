-- P798: Backfill missing tier values for o3 and o4-mini
-- o3 is OpenAI's frontier reasoning model; o4-mini is the standard-tier cost-efficient variant.

BEGIN;

UPDATE roadmap.model_metadata
SET tier = 'frontier'
WHERE model_name = 'o3'
  AND provider = 'openai'
  AND tier IS NULL;

UPDATE roadmap.model_metadata
SET tier = 'standard'
WHERE model_name = 'o4-mini'
  AND provider = 'openai'
  AND tier IS NULL;

COMMIT;
