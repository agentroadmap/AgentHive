-- env: prod
-- Registry cleanup: retire 8,400+ ephemeral workforce workers and superseded generic agency identities.
-- Named permanent agents (adam, alan, alex, andrew, alice, ana, andy,
--   cooper, carter, calvin, clark, cory, chloe,
--   george, glen, grace, gina,
--   pete, pablo, petra, paul) are left untouched.
-- claude/agency-orchestrator (liaison) is left untouched.
BEGIN;

-- status enum: active | inactive | suspended  (no 'retired')
-- Use 'inactive' to suppress from dispatch queues and dashboard active lists.

-- 1. Deactivate all ephemeral workforce-type spawn records (hermes/*, claude/*/worker-*, etc.)
UPDATE roadmap_workforce.agent_registry
SET    status        = 'inactive',
       updated_at    = now()
WHERE  agent_type    = 'workforce';

-- 2. Deactivate test fixture agency entries (test/* and a2a-xproc-*)
UPDATE roadmap_workforce.agent_registry
SET    status        = 'inactive',
       updated_at    = now()
WHERE  agent_type    = 'agency'
  AND  (agent_identity LIKE 'test/%'
        OR agent_identity LIKE 'a2a-xproc-%');

-- 3. Deactivate old generic agency identities superseded by permanent named agents.
--    provider_registry rows were already retired in migrations 134/136.
UPDATE roadmap_workforce.agent_registry
SET    status        = 'inactive',
       updated_at    = now()
WHERE  agent_type    = 'agency'
  AND  agent_identity IN (
    -- old hermes/xiaomi agency parent (workers retired above via workforce type)
    'hermes/agency-xiaomi',
    'hermes',
    'worker-6044',
    -- old copilot generic
    'copilot/agency-gary',
    'copilot-agency-gary',
    -- old codex generic
    'codex/agency-bot',
    'codex-agency-bot',
    'codex/agency-codex-one',
    -- old claude generic
    'claude/agency-bot',
    'claude/claude-code',
    'claude-agency-bot',
    -- old gemini generic
    'gemini/agency-bot',
    'gemini/agency-bot-2',
    'gemini-agency-bot',
    -- other old generic
    'agency-bot',
    'ccs46ant-bot-archi-a'
  );

-- 4. Deactivate old llm/developer and llm/reviewer pool entries (batch-spawned, never cleaned).
UPDATE roadmap_workforce.agent_registry
SET    status        = 'inactive',
       updated_at    = now()
WHERE  agent_type    = 'llm'
  AND  status        = 'active';

-- Verify: named agency agents still active
-- SELECT agent_identity, role, status FROM roadmap_workforce.agent_registry
-- WHERE agent_type='agency' AND status != 'retired' ORDER BY created_at;

COMMIT;
