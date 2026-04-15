-- =============================================================================
-- 021-tool-agent-registry.sql
-- Description: Tool agent configuration table + seed data for P232
-- Date: 2026-04-14
-- Requires: 013-gate-pipeline-wiring.sql
--
-- Tool agents are zero-cost mechanical operators registered in agent_registry
-- with agent_type='tool'. This table stores their configuration, trigger
-- type, and operational parameters.
-- =============================================================================

BEGIN;

SET search_path TO roadmap, public;


-- ─── 1. Create tool_agent_config table ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.tool_agent_config (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity  text        NOT NULL,
    agent_type      text        NOT NULL DEFAULT 'tool',
    trigger_type    text        NOT NULL,  -- 'pg_notify', 'cron', 'queue'
    trigger_source  text        NULL,      -- channel name, cron expression, queue name
    handler_class   text        NOT NULL,  -- TypeScript class name for the handler
    is_active       bool        DEFAULT true NOT NULL,
    config          jsonb       DEFAULT '{}'::jsonb NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT tool_agent_config_pkey           PRIMARY KEY (id),
    CONSTRAINT tool_agent_config_identity_key    UNIQUE (agent_identity),
    CONSTRAINT tool_agent_config_type_check      CHECK (agent_type = 'tool'),
    CONSTRAINT tool_agent_config_trigger_check   CHECK (
        trigger_type IN ('pg_notify', 'cron', 'queue')
    )
);

COMMENT ON TABLE roadmap.tool_agent_config IS
    'Configuration for zero-cost tool agents. These are mechanical operators '
    'that run without LLM invocation — pg_notify listeners, cron jobs, and '
    'queue processors. Registered in agent_registry with agent_type=tool.';

COMMENT ON COLUMN roadmap.tool_agent_config.trigger_type IS
    'How the tool agent is activated: pg_notify (event-driven), '
    'cron (periodic), or queue (transition_queue entries).';

COMMENT ON COLUMN roadmap.tool_agent_config.handler_class IS
    'TypeScript class name that implements the ToolAgent interface. '
    'Resolved at startup by the tool agent registry.';

COMMENT ON COLUMN roadmap.tool_agent_config.config IS
    'JSONB configuration specific to each tool agent type. '
    'E.g., cron interval, pg_notify channel, queue batch size.';


-- ─── 2. Seed tool agent configurations ────────────────────────────────────────

-- State Monitor: evaluates AC pass rate and auto-advances proposals
INSERT INTO roadmap.tool_agent_config
    (agent_identity, trigger_type, trigger_source, handler_class, config)
VALUES (
    'tool/state-monitor',
    'pg_notify',
    'proposal_maturity_changed',
    'StateMonitor',
    '{
        "acPassThreshold": 1.0,
        "autoAdvance": true,
        "description": "Evaluates AC pass rate on proposal changes. Auto-advances maturity when all ACs pass."
    }'::jsonb
) ON CONFLICT (agent_identity) DO UPDATE SET
    trigger_source = EXCLUDED.trigger_source,
    handler_class = EXCLUDED.handler_class,
    config = EXCLUDED.config,
    updated_at = now();

-- Health Checker: monitors agent heartbeats and marks crashed agents
INSERT INTO roadmap.tool_agent_config
    (agent_identity, trigger_type, trigger_source, handler_class, config)
VALUES (
    'tool/health-checker',
    'cron',
    '*/60 * * * *',
    'HealthChecker',
    '{
        "staleThresholdSeconds": 300,
        "crashThresholdSeconds": 600,
        "description": "Pings agent heartbeats every 60s. Marks agents as crashed if no heartbeat for 10min."
    }'::jsonb
) ON CONFLICT (agent_identity) DO UPDATE SET
    trigger_source = EXCLUDED.trigger_source,
    handler_class = EXCLUDED.handler_class,
    config = EXCLUDED.config,
    updated_at = now();

-- Merge Executor: runs git merge for MERGE-stage transitions
INSERT INTO roadmap.tool_agent_config
    (agent_identity, trigger_type, trigger_source, handler_class, config)
VALUES (
    'tool/merge-executor',
    'queue',
    'transition_queue',
    'MergeExecutor',
    '{
        "queueFilter": "to_stage = '\''Merge'\''",
        "escalateOnConflict": true,
        "description": "Processes MERGE entries from transition_queue. Runs git merge and reports conflicts."
    }'::jsonb
) ON CONFLICT (agent_identity) DO UPDATE SET
    trigger_source = EXCLUDED.trigger_source,
    handler_class = EXCLUDED.handler_class,
    config = EXCLUDED.config,
    updated_at = now();

-- Test Runner: runs npm test and reports results
INSERT INTO roadmap.tool_agent_config
    (agent_identity, trigger_type, trigger_source, handler_class, config)
VALUES (
    'tool/test-runner',
    'queue',
    'transition_queue',
    'TestRunner',
    '{
        "queueFilter": "metadata->>'\''action'\'' = '\''test'\''",
        "testTimeout": 120000,
        "description": "Runs npm test for proposals in Develop stage. Parses results and writes to DB."
    }'::jsonb
) ON CONFLICT (agent_identity) DO UPDATE SET
    trigger_source = EXCLUDED.trigger_source,
    handler_class = EXCLUDED.handler_class,
    config = EXCLUDED.config,
    updated_at = now();

-- Cubic Cleaner: expires idle cubics and cleans worktree dirs
INSERT INTO roadmap.tool_agent_config
    (agent_identity, trigger_type, trigger_source, handler_class, config)
VALUES (
    'tool/cubic-cleaner',
    'cron',
    '*/15 * * * *',
    'CubicCleaner',
    '{
        "idleTimeoutMinutes": 60,
        "cleanupWorktree": true,
        "description": "Expires idle cubics every 15min. Removes stale worktree directories."
    }'::jsonb
) ON CONFLICT (agent_identity) DO UPDATE SET
    trigger_source = EXCLUDED.trigger_source,
    handler_class = EXCLUDED.handler_class,
    config = EXCLUDED.config,
    updated_at = now();

-- Budget Enforcer: checks daily spending cap and blocks dispatch
INSERT INTO roadmap.tool_agent_config
    (agent_identity, trigger_type, trigger_source, handler_class, config)
VALUES (
    'tool/budget-enforcer',
    'pg_notify',
    'spending_log_insert',
    'BudgetEnforcer',
    '{
        "checkOnInsert": true,
        "freezeOnExceed": true,
        "description": "Checks daily spending cap on each spending_log insert. Blocks dispatch if exceeded."
    }'::jsonb
) ON CONFLICT (agent_identity) DO UPDATE SET
    trigger_source = EXCLUDED.trigger_source,
    handler_class = EXCLUDED.handler_class,
    config = EXCLUDED.config,
    updated_at = now();


-- ─── 3. Ensure tool agents exist in agent_registry ────────────────────────────

INSERT INTO roadmap.agent_registry
    (agent_identity, agent_type, capabilities, status)
VALUES
    ('tool/state-monitor', 'tool',
     '["state-transition","ac-evaluation","auto-advance"]'::jsonb, 'active'),
    ('tool/health-checker', 'tool',
     '["heartbeat","crash-detection","agent-status"]'::jsonb, 'active'),
    ('tool/merge-executor', 'tool',
     '["git-merge","conflict-detection","branch-integration"]'::jsonb, 'active'),
    ('tool/test-runner', 'tool',
     '["test-execution","result-parsing","coverage"]'::jsonb, 'active'),
    ('tool/cubic-cleaner', 'tool',
     '["cubic-expiry","worktree-cleanup","resource-reclamation"]'::jsonb, 'active'),
    ('tool/budget-enforcer', 'tool',
     '["spending-cap","budget-freeze","cost-monitoring"]'::jsonb, 'active')
ON CONFLICT (agent_identity) DO UPDATE SET
    agent_type = EXCLUDED.agent_type,
    capabilities = EXCLUDED.capabilities,
    status = EXCLUDED.status;


-- ─── 4. Add pg_notify trigger for spending_log inserts ────────────────────────
-- Fires 'spending_log_insert' channel so Budget Enforcer can react.

CREATE OR REPLACE FUNCTION roadmap.fn_notify_spending_log()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('spending_log_insert', jsonb_build_object(
        'agent_identity', NEW.agent_identity,
        'cost_usd', NEW.cost_usd,
        'proposal_id', NEW.proposal_id,
        'ts', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )::text);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_spending_log_notify ON roadmap.spending_log;
CREATE TRIGGER trg_spending_log_notify
    AFTER INSERT ON roadmap.spending_log
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_notify_spending_log();


COMMIT;

-- ─── Verification ─────────────────────────────────────────────────────────────
-- SELECT agent_identity, trigger_type, handler_class, is_active
--   FROM roadmap.tool_agent_config ORDER BY id;
--
-- SELECT agent_identity, agent_type, status
--   FROM roadmap.agent_registry WHERE agent_type = 'tool';
