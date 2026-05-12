-- env: prod
-- P995 — Named agent registry: host_affinity column + permanent named agents
BEGIN;

-- Add host_affinity to track which host each named agent is expected on
ALTER TABLE roadmap_workforce.agent_registry
  ADD COLUMN IF NOT EXISTS host_affinity TEXT;

COMMENT ON COLUMN roadmap_workforce.agent_registry.host_affinity IS
  'Preferred host for this agent (e.g. ''bot''). NULL means no affinity constraint. Used by orchestrator to route spawn requests.';

-- Seed 13 permanent named agents.
-- All start as inactive; selfRegisterAgency() upserts status to active on boot.
-- Flat identities (no slash) are directly routable: msg_send(to_agent:''adam'') works without resolution.

INSERT INTO roadmap_workforce.agent_registry
  (agent_identity, agent_type, role, preferred_provider, host_affinity, status)
VALUES
  -- Claude agents on bot
  ('adam',    'agency', 'claude-agent', 'anthropic', 'bot', 'inactive'),
  ('andy',    'agency', 'claude-agent', 'anthropic', 'bot', 'inactive'),
  ('alan',    'agency', 'claude-agent', 'anthropic', 'bot', 'inactive'),
  ('alex',    'agency', 'claude-agent', 'anthropic', 'bot', 'inactive'),
  ('andrew',  'agency', 'claude-agent', 'anthropic', 'bot', 'inactive'),
  ('alice',   'agency', 'claude-agent', 'anthropic', 'bot', 'inactive'),
  ('ana',     'agency', 'claude-agent', 'anthropic', 'bot', 'inactive'),
  -- Codex agents on bot
  ('cooper',  'agency', 'codex-agent',  'codex',     'bot', 'inactive'),
  ('carter',  'agency', 'codex-agent',  'codex',     'bot', 'inactive'),
  ('calvin',  'agency', 'codex-agent',  'codex',     'bot', 'inactive'),
  ('clark',   'agency', 'codex-agent',  'codex',     'bot', 'inactive'),
  ('cory',    'agency', 'codex-agent',  'codex',     'bot', 'inactive'),
  ('chloe',   'agency', 'codex-agent',  'codex',     'bot', 'inactive')
ON CONFLICT (agent_identity) DO UPDATE SET
  agent_type        = EXCLUDED.agent_type,
  role              = EXCLUDED.role,
  preferred_provider = EXCLUDED.preferred_provider,
  host_affinity     = EXCLUDED.host_affinity
  -- Do NOT overwrite status: if already active, keep active
;

COMMIT;
