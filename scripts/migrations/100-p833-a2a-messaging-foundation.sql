-- P833: A2A Messaging Foundation
-- Adds P833 columns to message_ledger, creates message_type_contract + message_timeout_tracking,
-- registers cross-provider agency identities, and grants mutual trust for A2A communication.

BEGIN;

-- 1. Add P833 extended columns to message_ledger
ALTER TABLE roadmap.message_ledger
  ADD COLUMN IF NOT EXISTS correlation_id TEXT,
  ADD COLUMN IF NOT EXISTS sig_verified TEXT DEFAULT 'pending'
    CHECK (sig_verified IN ('pending', 'verified', 'failed')),
  ADD COLUMN IF NOT EXISTS provider_sig TEXT,
  ADD COLUMN IF NOT EXISTS provider_sig_salt BYTEA;

-- 2. message_type_contract — controls ack requirements and timeout escalation
CREATE TABLE IF NOT EXISTS roadmap.message_type_contract (
    message_type        TEXT PRIMARY KEY,
    ack_required        BOOLEAN NOT NULL DEFAULT false,
    timeout_seconds     INT,
    escalation_recipient TEXT
);

INSERT INTO roadmap.message_type_contract (message_type, ack_required, timeout_seconds, escalation_recipient) VALUES
  ('text',   false, NULL,  NULL),
  ('task',   true,  300,   'liaison_hub'),
  ('notify', false, NULL,  NULL),
  ('ack',    false, NULL,  NULL),
  ('error',  false, NULL,  NULL),
  ('event',  false, NULL,  NULL)
ON CONFLICT DO NOTHING;

-- 3. message_timeout_tracking — escalation tracking for ack-required messages
CREATE TABLE IF NOT EXISTS roadmap.message_timeout_tracking (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id           BIGINT NOT NULL
                           REFERENCES roadmap.message_ledger(id) ON DELETE CASCADE,
    timeout_at           TIMESTAMP WITH TIME ZONE NOT NULL,
    escalation_recipient TEXT,
    resolved_at          TIMESTAMP WITH TIME ZONE,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_message_timeout_message_id
    ON roadmap.message_timeout_tracking(message_id);

-- 4. Register copilot/agency-gary as a known agency agent
INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, trust_tier)
VALUES ('copilot/agency-gary', 'agency', 'known')
ON CONFLICT (agent_identity) DO UPDATE SET trust_tier = 'known';

-- 5. Upgrade claude/agency-bot to known tier (was restricted)
UPDATE roadmap_workforce.agent_registry
SET trust_tier = 'known'
WHERE agent_identity = 'claude/agency-bot';

-- 6. Grant mutual trusted relationship for cross-provider A2A messaging
INSERT INTO roadmap_workforce.agent_trust
    (agent_identity, trusted_agent, trust_level, granted_by, reason)
VALUES
    ('claude/agency-bot', 'copilot/agency-gary', 'trusted', 'gary',
     'cross-provider A2A communication — joint proposal review capability'),
    ('copilot/agency-gary', 'claude/agency-bot', 'trusted', 'gary',
     'cross-provider A2A communication — joint proposal review capability')
ON CONFLICT (agent_identity, trusted_agent) DO UPDATE
    SET trust_level = EXCLUDED.trust_level,
        reason      = EXCLUDED.reason,
        updated_at  = now();

COMMIT;
