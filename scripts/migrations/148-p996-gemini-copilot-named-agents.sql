-- env: prod
-- P996 — Named agent registry: gemini (g*) and copilot (p*) permanent agents
BEGIN;

-- Gemini agents: g* prefix per P996 naming convention
-- Male names = builders (started by default), female names = skeptics (inactive, review cycles only)
INSERT INTO roadmap_workforce.agent_registry
  (agent_identity, agent_type, role, preferred_provider, host_affinity, status)
VALUES
  ('george', 'agency', 'gemini-agent', 'gemini', 'bot', 'inactive'),
  ('glen',   'agency', 'gemini-agent', 'gemini', 'bot', 'inactive'),
  ('grace',  'agency', 'gemini-agent', 'gemini', 'bot', 'inactive'),
  ('gina',   'agency', 'gemini-agent', 'gemini', 'bot', 'inactive'),
  -- Copilot agents: p* prefix
  ('pete',   'agency', 'copilot-agent', 'copilot', 'bot', 'inactive'),
  ('pablo',  'agency', 'copilot-agent', 'copilot', 'bot', 'inactive'),
  ('petra',  'agency', 'copilot-agent', 'copilot', 'bot', 'inactive')
ON CONFLICT (agent_identity) DO UPDATE SET
  agent_type        = EXCLUDED.agent_type,
  role              = EXCLUDED.role,
  preferred_provider = EXCLUDED.preferred_provider,
  host_affinity     = EXCLUDED.host_affinity;
  -- Do NOT overwrite status

-- Retire old provider_registry rows for legacy identities so the resolver ignores them.
-- agent_registry rows are left intact (identity records); stopping the service prevents re-registration.
UPDATE roadmap_workforce.provider_registry pr
SET status = 'retired',
    status_reason = 'Replaced by P996 named agent',
    updated_at = now()
FROM roadmap_workforce.agent_registry ar
WHERE pr.agency_id = ar.id
  AND ar.agent_identity IN (
    'gemini-agency-bot',
    'gemini/agency-bot',
    'gemini/agency-bot-2',
    'copilot-agency-gary',
    'copilot/agency-gary'
  );

COMMIT;
