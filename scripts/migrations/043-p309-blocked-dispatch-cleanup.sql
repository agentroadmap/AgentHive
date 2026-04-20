-- P309: Clean up pre-P281 blocked dispatches
-- 2961 dispatches with dispatch_status='blocked' from the pre-offer/claim/lease era.
-- These have completed_at set but dispatch_status='blocked', so the stale reaper (P269)
-- never cleans them (it only reaps WHERE completed_at IS NULL).
--
-- This migration cancels them all and tags metadata for audit.

UPDATE roadmap_workforce.squad_dispatch
SET dispatch_status = 'cancelled',
    metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'cleaned_at', to_jsonb(now()),
            'cleaned_reason', 'P309: pre-P281 blocked dispatch cleanup'
        )
WHERE dispatch_status = 'blocked';
