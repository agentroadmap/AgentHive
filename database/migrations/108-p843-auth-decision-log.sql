-- P843: Create control_identity.auth_decision_log table
--
-- Audit table that records every MCP tool call with its authentication outcome.
-- Used to track and enforce identity gates across all transports.

CREATE TABLE IF NOT EXISTS control_identity.auth_decision_log (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  principal_id TEXT,
  tool_name    TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'unauthenticated'))
);

CREATE INDEX IF NOT EXISTS idx_auth_decision_log_ts ON control_identity.auth_decision_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_auth_decision_log_principal ON control_identity.auth_decision_log(principal_id)
  WHERE principal_id IS NOT NULL;
