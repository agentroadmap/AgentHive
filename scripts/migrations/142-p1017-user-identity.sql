-- P1017 AC-10: Register USER as a first-class agent identity.
--
-- roadmap.agent_registry is a VIEW over roadmap_workforce.agent_registry.
-- The underlying table has a CHECK constraint on agent_type that must be
-- expanded to include 'user' before inserting the operator identity row.

-- Step 1: expand agent_type CHECK constraint to include 'user'.
ALTER TABLE roadmap_workforce.agent_registry
    DROP CONSTRAINT IF EXISTS agent_registry_type_check;

ALTER TABLE roadmap_workforce.agent_registry
    ADD CONSTRAINT agent_registry_type_check
        CHECK (agent_type = ANY (ARRAY[
            'human', 'llm', 'tool', 'hybrid', 'agency',
            'workforce', 'coordinator', 'user'
        ]::text[]));

-- Step 2: insert operator USER identity.
INSERT INTO roadmap_workforce.agent_registry (
    agent_identity,
    agent_type,
    role,
    skills,
    status,
    trust_tier
) VALUES (
    'user/gary',
    'user',
    'operator',
    '["orchestration", "review", "escalation"]'::jsonb,
    'active',
    'authority'
)
ON CONFLICT (agent_identity) DO UPDATE
    SET agent_type  = EXCLUDED.agent_type,
        role        = EXCLUDED.role,
        trust_tier  = EXCLUDED.trust_tier,
        updated_at  = now();

-- Verify: SELECT agent_identity, agent_type, trust_tier
--         FROM roadmap.agent_registry WHERE agent_type='user';
