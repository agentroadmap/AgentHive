-- Seed: bootstrap host record for the primary operator host.
-- Adapt host_name and metadata to match the actual server.
-- Idempotent via ON CONFLICT DO NOTHING.

INSERT INTO core.host (host_name, role, owner_did, notes)
VALUES ('bot', 'mixed', 'did:agenthive:system', 'Primary operator host running all AgentHive services')
ON CONFLICT (host_name) DO NOTHING;

INSERT INTO core.project (slug, display_name, schema_name, owner_did, description)
VALUES (
  'agentHive',
  'AgentHive',
  'agentHive',
  'did:agenthive:system',
  'AgentHive self-development project — proposals, workflow, and agents for building AgentHive itself'
)
ON CONFLICT (slug) DO NOTHING;
