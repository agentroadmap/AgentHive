/**
 * P1105 — User registry seed (AC-10)
 *
 * Idempotent INSERT for user/gary agent entry into roadmap.agent_registry.
 *
 * AC-10: A row exists in roadmap.agent_registry where agent_type='user'.
 * This migration registers the system user identity so msg_send/msg_reply
 * can identify user/* agents for bearer token verification (AC-27).
 *
 * host_id: Uses the default 'localhost' for the operator host.
 * This can be overridden per deployment if using a different cluster_name.
 */

INSERT INTO roadmap.agent_registry (
	agent_identity,
	agent_type,
	host_id,
	status,
	created_at
)
VALUES (
	'user/gary',
	'user',
	'localhost',
	'active',
	now()
)
ON CONFLICT (agent_identity) DO NOTHING;
