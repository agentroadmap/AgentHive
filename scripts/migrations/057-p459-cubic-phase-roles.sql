/**
 * P459: cubic_create role allocation by phase
 *
 * Blocks gate/review/ship phases from receiving hardcoded [coder, reviewer] slots.
 * Introduces roadmap.cubic_phase_roles table to define default and allowed roles per phase.
 *
 * Changes:
 * 1. New table cubic_phase_roles (phase, default_roles, allowed_roles)
 * 2. Update cubic_create handler to validate agent_role against allowed_roles
 * 3. Return typed error {ok:false, error:'phase_role_mismatch', ...} on mismatch
 * 4. Fallback to default_roles if no agent_identity provided
 *
 * AC:
 * - AC1: cubic_create with agent_identity validates role per phase
 * - AC2: cubic_create without agent_identity uses phase defaults
 * - AC3: Mismatch returns typed error (not silent substitution)
 * - AC4: All 4 phases have correct slot lists
 * - AC5: P281/P289 dispatch flow continues to work
 */

-- Create cubic_phase_roles table
CREATE TABLE IF NOT EXISTS roadmap.cubic_phase_roles (
    phase TEXT PRIMARY KEY,
    default_roles TEXT[] NOT NULL,
    allowed_roles TEXT[] NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed phase role definitions
-- design → architect/skeptic/pm focus
-- build → coder/tester focus
-- test → tester/qa focus
-- ship → deployer/ops focus
DELETE FROM roadmap.cubic_phase_roles; -- Clear if re-running
INSERT INTO roadmap.cubic_phase_roles (phase, default_roles, allowed_roles) VALUES
    ('design', ARRAY['skeptic', 'architect', 'pm'], ARRAY['skeptic', 'architect', 'pm', 'reviewer']),
    ('build', ARRAY['coder', 'tester'], ARRAY['coder', 'tester', 'reviewer']),
    ('test', ARRAY['tester', 'qa'], ARRAY['tester', 'qa', 'reviewer']),
    ('ship', ARRAY['deployer', 'ops'], ARRAY['deployer', 'ops', 'reviewer'])
ON CONFLICT (phase) DO UPDATE SET
    default_roles = EXCLUDED.default_roles,
    allowed_roles = EXCLUDED.allowed_roles,
    updated_at = NOW();

-- Create index for phase lookups
CREATE INDEX IF NOT EXISTS idx_cubic_phase_roles_phase ON roadmap.cubic_phase_roles(phase);

-- Add comment for clarity
COMMENT ON TABLE roadmap.cubic_phase_roles IS 'P459: Phase-driven role allocation for cubics';
COMMENT ON COLUMN roadmap.cubic_phase_roles.default_roles IS 'Default roles assigned when no agent_identity provided';
COMMENT ON COLUMN roadmap.cubic_phase_roles.allowed_roles IS 'Allowed roles for this phase (validation constraint)';
