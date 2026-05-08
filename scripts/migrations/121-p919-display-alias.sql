-- P919: Tiered Agent Identity — Display Alias support
--
-- Adds human-readable display_alias column to agent_registry with partial unique index
-- to enable alias reuse after crash-restart (when prior owner transitions to inactive).
--
-- Aliases are for UI/journalctl only; identity remains the routing key.

BEGIN;

-- AC-7: Add nullable display_alias column
ALTER TABLE roadmap_workforce.agent_registry
ADD COLUMN IF NOT EXISTS display_alias TEXT;

-- AC-1: Partial unique index — only active agents hold unique aliases
-- PostgreSQL allows multiple NULLs in this index, enabling multiple inactive agents
-- and multiple active agents without aliases (AC-11).
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_alias_active
ON roadmap_workforce.agent_registry(display_alias)
WHERE status = 'active'
  AND display_alias IS NOT NULL;

-- Add JSONB audit column to track alias claim/release history (AC-4)
ALTER TABLE roadmap_workforce.agent_registry
ADD COLUMN IF NOT EXISTS alias_audit JSONB DEFAULT '[]'::jsonb;

COMMIT;
