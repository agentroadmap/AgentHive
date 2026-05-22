-- P1105: Seed user/gary into principal_identity so bearer-token auth works
-- for USER-type senders on msg_send.
--
-- principal_kind='operator' is the only kind that accepts bound-bearer tokens
-- (verifyBoundBearer path). The pi_kind_check constraint does not permit 'user',
-- so we use 'operator' as the hosting kind — the identity binding is enforced
-- by principal_id='user/gary' matching the token's sub claim, not the kind label.

INSERT INTO roadmap.principal_identity
    (principal_id, principal_kind, credential_kind, metadata)
VALUES
    ('user/gary', 'operator', 'oauth', '{"source": "p1105_seed", "agent_type": "user"}'::jsonb)
ON CONFLICT (principal_id) DO NOTHING;
