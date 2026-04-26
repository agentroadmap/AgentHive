-- P525: Structured Agent Error Catalog with Auto-Recovery
-- Creates error catalog and error log tables for structured error handling

-- Agent Error Catalog: all known error codes with recovery strategies
CREATE TABLE IF NOT EXISTS roadmap.agent_error_catalog (
  code TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error', 'critical')),
  retryable BOOLEAN NOT NULL,
  transient BOOLEAN NOT NULL,
  recovery_strategy TEXT NOT NULL CHECK (recovery_strategy IN (
    'auto_retry_immediate',
    'auto_retry_with_backoff',
    'escalate_to_operator',
    'mark_failed',
    'request_assistance'
  )),
  recovery_hint TEXT,
  runbook_url TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Agent Error Log: timestamped record of all agent errors with deduplication
CREATE TABLE IF NOT EXISTS roadmap.agent_error_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT now(),
  code TEXT NOT NULL REFERENCES roadmap.agent_error_catalog(code) ON DELETE RESTRICT,
  agent_identity TEXT NOT NULL,
  proposal_id BIGINT,
  dispatch_id BIGINT,
  payload JSONB,
  dedup_key TEXT,
  dedup_count INT DEFAULT 1,
  resolved_at TIMESTAMP,
  recovery_action TEXT
);

-- Index for deduplication query (code, agent_identity, proposal_id within 60s)
CREATE INDEX IF NOT EXISTS idx_agent_error_log_dedup
  ON roadmap.agent_error_log(dedup_key, timestamp DESC);

-- Index for listing recent errors by agent
CREATE INDEX IF NOT EXISTS idx_agent_error_log_agent_time
  ON roadmap.agent_error_log(agent_identity, timestamp DESC);

-- Index for listing errors by severity
CREATE INDEX IF NOT EXISTS idx_agent_error_log_severity
  ON roadmap.agent_error_log(code, timestamp DESC);

-- Seed 15 known errors from session
INSERT INTO roadmap.agent_error_catalog (
  code, domain, severity, retryable, transient,
  recovery_strategy, recovery_hint, runbook_url
) VALUES
  ('AGENTHIVE.DB.FK_CONSTRAINT_REVIEWER', 'db', 'error', true, false, 'auto_retry_with_backoff', 'FK violation in gate_decision_log; auto-register reviewer first (P521)', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-FK-Constraint-Reviewer'),
  ('AGENTHIVE.MCP.HANDLER_PARAM_INVALID', 'mcp', 'error', false, false, 'escalate_to_operator', 'MCP handler wrong param name; check mcp_handler_param_quirks.md', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-MCP-Param-Invalid'),
  ('AGENTHIVE.MCP.TIMEOUT_SSE', 'mcp', 'warn', true, true, 'auto_retry_with_backoff', 'SSE transport timeout; MCP unresponsive; retry with exponential backoff', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-MCP-Timeout'),
  ('AGENTHIVE.AGENT.DISPATCH_STALE_STATE', 'agent', 'error', true, false, 'auto_retry_immediate', 'cubic_dispatch orphaned; state registry leak (P522); dispose and reload', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Dispatch-Stale-State'),
  ('AGENTHIVE.AGENT.TIMEOUT_SUBAGENT', 'agent', 'error', true, true, 'escalate_to_operator', 'Subagent deadline exceeded; check cubic logs and escalate', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Subagent-Timeout'),
  ('AGENTHIVE.DISPATCH.POOL_LEAK_NOTIFY', 'dispatch', 'critical', true, false, 'auto_retry_immediate', 'NOTIFY pool exhaustion; reload connection pool (P522)', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Pool-Leak'),
  ('AGENTHIVE.PROPOSAL.TYPE_CHANGE_REJECTED', 'proposal', 'warn', false, false, 'request_assistance', 'Proposal type change blocked; use fn_reconcile_proposal_type (P461)', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Type-Change-Rejected'),
  ('AGENTHIVE.PROPOSAL.WORKFLOW_MISSING', 'proposal', 'error', true, false, 'auto_retry_immediate', 'Workflow missing after fn_spawn_workflow; INSERT into workflows (P460)', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Workflow-Missing'),
  ('AGENTHIVE.GATE.VERDICT_GATE_DECISION_RACE', 'gate', 'error', true, false, 'auto_retry_with_backoff', 'Gate decision timing race; retry with backoff (MCP timing)', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Gate-Decision-Race'),
  ('AGENTHIVE.DEPENDENCY.CYCLE_DETECTED', 'dependency', 'error', false, false, 'escalate_to_operator', 'DAG cycle detected; fn_check_dag_cycle fired; manual unwinding required', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Cycle-Detected'),
  ('AGENTHIVE.DEPENDENCY.TYPE_INVALID', 'dependency', 'error', false, false, 'mark_failed', 'dependency_type invalid; must be blocks/relates/duplicates/supersedes (P470)', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Type-Invalid'),
  ('AGENTHIVE.AUTH.SUDO_SILENT_FAIL', 'auth', 'critical', false, false, 'escalate_to_operator', 'sudo failed silently (no stderr, exit 1); escalate manually', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Sudo-Silent-Fail'),
  ('AGENTHIVE.CONFIG.CONNECTION_TIMEOUT_PG', 'config', 'error', true, true, 'auto_retry_with_backoff', 'PostgreSQL connection timeout; check PG_CONNECTION_TIMEOUT_MS config', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-PG-Timeout'),
  ('AGENTHIVE.VALIDATION.CHECK_CONSTRAINT_VERDICT', 'validation', 'error', false, false, 'mark_failed', 'Verdict CHECK constraint violated; invalid verdict for type', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Verdict-Constraint'),
  ('AGENTHIVE.JITI.MODULE_NOT_FOUND', 'jiti', 'error', true, false, 'auto_retry_immediate', 'jiti module resolution failed; reload jiti cache and retry', 'https://gitlab.local/agenthive/agenthive/-/wiki/P525-Module-Not-Found')
ON CONFLICT (code) DO NOTHING;
