-- P3000 AC-10d: operator quota dispatch override
-- Allows an operator to grant a one-shot (or standing) bypass of the quota
-- subscription policy for a specific agent identity. Single-use rows are
-- atomically consumed at claim time via UPDATE...FOR UPDATE SKIP LOCKED.

CREATE TABLE IF NOT EXISTS roadmap_workforce.quota_dispatch_override (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_identity  text NOT NULL
    REFERENCES roadmap_workforce.agent_registry(agent_identity) ON DELETE CASCADE,
  granted_by      text NOT NULL,
  override_reason text,
  single_use      boolean NOT NULL DEFAULT true,
  used_at         timestamp with time zone,   -- NULL = not yet consumed
  expires_at      timestamp with time zone NOT NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now()
);

-- Partial index: only unconsumed rows are eligible; keeps the hot-path lookup fast.
CREATE INDEX IF NOT EXISTS idx_quota_override_agent_active
  ON roadmap_workforce.quota_dispatch_override (agent_identity, used_at, expires_at)
  WHERE used_at IS NULL;
