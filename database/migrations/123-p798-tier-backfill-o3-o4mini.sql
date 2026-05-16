-- Migration 123: P798 AC-1 residual — backfill tier for o3 and o4-mini
--
-- Phase 1 migration (121) left two production rows unclassified:
--   o3       → 'frontier'  (OpenAI reasoning model, same tier as gpt-4o/claude-*)
--   o4-mini  → 'standard'  (OpenAI small/efficient variant, same tier as gpt-4o-mini)

BEGIN;

UPDATE roadmap.model_metadata
   SET tier = 'frontier'
 WHERE model_name = 'o3'
   AND provider   = 'openai'
   AND tier IS NULL;

UPDATE roadmap.model_metadata
   SET tier = 'standard'
 WHERE model_name = 'o4-mini'
   AND provider   = 'openai'
   AND tier IS NULL;

COMMIT;
