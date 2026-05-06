-- Migration 101: P843 — control_identity schema + auth_decision_log
--
-- Stores every MCP tool call auth decision for audit and debugging.
-- Writes are best-effort (fire-and-forget) from _writeAuthDecisionLog().

BEGIN;

CREATE SCHEMA IF NOT EXISTS control_identity;

CREATE TABLE IF NOT EXISTS control_identity.auth_decision_log (
  id           BIGSERIAL PRIMARY KEY,
  principal_id TEXT,
  tool_name    TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'unauthenticated')),
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_decision_log_principal
  ON control_identity.auth_decision_log (principal_id, decided_at DESC);

CREATE INDEX IF NOT EXISTS idx_auth_decision_log_tool
  ON control_identity.auth_decision_log (tool_name, decided_at DESC);

COMMENT ON TABLE control_identity.auth_decision_log IS
  'P843: Audit log for every MCP tool call auth decision. Populated by _writeAuthDecisionLog().';

COMMIT;
