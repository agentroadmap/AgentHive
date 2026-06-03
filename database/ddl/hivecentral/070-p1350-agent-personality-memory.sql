-- 2026-05-26 P1350-B: Personality + long-term memory schema for permanent agents
-- Adds personality and memory_pointer columns to workforce.agent
-- See proposal P1352

BEGIN;

ALTER TABLE workforce.agent
    ADD COLUMN IF NOT EXISTS personality JSONB,
    ADD COLUMN IF NOT EXISTS memory_pointer JSONB,
    ADD COLUMN IF NOT EXISTS persona_version INT;

COMMENT ON COLUMN workforce.agent.personality IS
    'Curated personality: {principles[], voice, biases[], examples[]}. Operator-curated; not self-modified.';
COMMENT ON COLUMN workforce.agent.memory_pointer IS
    'Memory pointer: {kind: "fs"|"vector"|"kb", location, namespace}. Operator-curated; not self-modified.';
COMMENT ON COLUMN workforce.agent.persona_version IS
    'Monotonic persona version. Orchestrator can prefer newer revisions.';

COMMIT;
