-- P1105 — User registry seed (AC-10)
--
-- Idempotent INSERT for user/gary agent entry into roadmap.agent_registry.
--
-- AC-10: A row exists in roadmap.agent_registry where agent_type='user'.
-- This migration registers the system user identity so msg_send/msg_reply
-- can identify user/* agents for bearer token verification (AC-27).
--
-- agent_registry actual column set verified: id, agent_identity, agent_type,
-- role, skills, preferred_model, status, github_handle, ..., trust_tier.
-- No host_id column exists here.

INSERT INTO roadmap.agent_registry (
	agent_identity,
	agent_type,
	role,
	status,
	trust_tier,
	created_at
)
VALUES (
	'user/gary',
	'user',
	'operator',
	'active',
	'authority',
	now()
)
ON CONFLICT (agent_identity) DO NOTHING;
