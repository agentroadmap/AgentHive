-- P659: Operator-as-Gate-Agent: dashboard write proxy + advance/hold/split/combine actions
-- Migration 202: Seed 'operator' and 'operator-dashboard' agent identities

-- Ensure 'operator' agent exists with correct attributes
-- Note: If 'operator' already exists (e.g., from prior seeding), this will not update it.
-- This is intentional to preserve existing operator configurations.
INSERT INTO roadmap_workforce.agent_registry (
    agent_identity,
    agent_type,
    role,
    status,
    project_id
) VALUES
    ('operator', 'human', 'operator', 'active', 1),
    ('operator-dashboard', 'tool', 'operator-dashboard', 'active', 1)
ON CONFLICT (agent_identity) DO NOTHING;

-- Verify the gate_decision_log table has the expected columns and constraints
-- (This is informational; the table should already exist from earlier migrations)
-- Expected:
--   - decision CHECK constraint: decision IN ('advance','hold','reject','waive','escalate')
--   - decided_by REFERENCES agent_registry(agent_identity)
--   - authority_agent REFERENCES agent_registry(agent_identity)
--   - No gate_level or ac_verification columns used for operator gate actions
