-- P1017 AC-10: Register USER as a first-class agent identity type.
-- Extends agent_type CHECK to include 'user', then aligns user/gary to that type.
-- Verification: SELECT agent_identity FROM roadmap.agent_registry WHERE agent_type='user'

-- Extend the CHECK constraint to allow 'user' as a valid agent type
ALTER TABLE roadmap_workforce.agent_registry
  DROP CONSTRAINT agent_registry_type_check;

ALTER TABLE roadmap_workforce.agent_registry
  ADD CONSTRAINT agent_registry_type_check
    CHECK (agent_type = ANY (ARRAY[
      'human'::text, 'llm'::text, 'tool'::text, 'hybrid'::text,
      'agency'::text, 'workforce'::text, 'coordinator'::text, 'user'::text
    ]));

-- Align the existing user/gary row to the canonical 'user' type
UPDATE roadmap_workforce.agent_registry
   SET agent_type = 'user',
       role       = 'operator',
       status     = 'active'
 WHERE agent_identity = 'user/gary';

-- Safety: insert if somehow the row is missing
INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role, status, skills, trust_tier)
SELECT 'user/gary', 'user', 'operator', 'active', '["messaging","oversight"]'::jsonb, 'authority'
WHERE NOT EXISTS (
  SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_identity = 'user/gary'
);
