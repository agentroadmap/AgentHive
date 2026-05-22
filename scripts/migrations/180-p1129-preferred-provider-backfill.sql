-- P1129 AC-9: Backfill preferred_provider for agency rows where it is NULL.
-- Sets preferred_provider = agent_cli for agencies that have an agent_cli
-- declared but no preferred_provider yet. Safe to run multiple times.

UPDATE roadmap_workforce.agent_registry
SET    preferred_provider = agent_cli,
       updated_at         = now()
WHERE  agent_type         = 'agency'
  AND  preferred_provider IS NULL
  AND  agent_cli          IS NOT NULL
  AND  agent_cli          != '';
