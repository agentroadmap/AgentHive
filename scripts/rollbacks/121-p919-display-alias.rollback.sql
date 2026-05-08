-- Rollback for P919: Remove display_alias support

BEGIN;

-- Drop the partial unique index
DROP INDEX IF EXISTS roadmap_workforce.idx_agent_alias_active CASCADE;

-- Drop the audit column
ALTER TABLE roadmap_workforce.agent_registry
DROP COLUMN IF EXISTS alias_audit CASCADE;

-- Drop the display_alias column
ALTER TABLE roadmap_workforce.agent_registry
DROP COLUMN IF EXISTS display_alias CASCADE;

COMMIT;
