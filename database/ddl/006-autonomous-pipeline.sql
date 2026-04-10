-- 006-autonomous-pipeline.sql
-- Description: Autonomous agent pipeline — 7 new tables + NOTIFY triggers
-- Date: 2026-04-07
-- Requires: 005-trigger-fix.sql
--
-- Tables added:
--   agent_runs           — execution audit log per agent invocation
--   research_cache       — shared research memory with pgvector embeddings
--   decision_queue       — pending gate evaluation requests (D1–D4)
--   transition_queue     — approved stage transitions waiting to execute
--   agent_budget_ledger  — real-time per-proposal spend tracking
--   agent_conflicts      — disagreement escalation log
--   notification_queue   — USER/human alert delivery (INFO→CRITICAL)
--
-- Triggers added:
--   trg_notify_maturity_change   — NOTIFY on proposal.maturity_level change
--   trg_budget_threshold_notify  — NOTIFY at 20% and 5% budget remaining
--
-- Extensions required: vector (pgvector), pg_trgm

BEGIN;

-- ─── Extensions ──────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- pgvector: uncomment if available in your Postgres installation:
-- CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Table 1: agent_runs ─────────────────────────────────────────────────────
-- Execution audit log for every autonomous agent invocation.

CREATE TABLE IF NOT EXISTS agent_runs (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint REFERENCES proposal(id) ON DELETE SET NULL,
    display_id      text,                          -- denormalized for query convenience
    agent_identity  text NOT NULL,
    stage           text NOT NULL,
    model_used      text NOT NULL,
    tokens_in       int DEFAULT 0,
    tokens_out      int DEFAULT 0,
    cost_usd        numeric(10,6) DEFAULT 0,
    duration_ms     int,
    status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','failed','cancelled')),
    error_detail    text,
    input_hash      text,                          -- SHA256 of assembled context (for dedup)
    output_summary  text,                          -- first 500 chars of agent output
    started_at      timestamptz DEFAULT now() NOT NULL,
    completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_proposal ON agent_runs(proposal_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_started  ON agent_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status   ON agent_runs(status) WHERE status = 'running';

-- ─── Table 2: research_cache ─────────────────────────────────────────────────
-- Shared research memory across agents. Supports vector similarity search
-- (pgvector) and keyword fallback (pg_trgm).

CREATE TABLE IF NOT EXISTS research_cache (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint REFERENCES proposal(id) ON DELETE CASCADE,
    agent_identity  text NOT NULL,
    topic           text NOT NULL,
    content         text NOT NULL,
    source_url      text,
    source_type     text DEFAULT 'web_fetch'
                    CHECK (source_type IN ('web_fetch','codebase_scan','adr','manual','agent_synthesis')),
    relevance_score numeric(4,3) DEFAULT 0.5,
    -- embedding vector(1536),   -- uncomment when pgvector is available
    tags            text[],
    is_superseded   boolean DEFAULT false NOT NULL,
    expires_at      timestamptz,
    created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_cache_proposal
    ON research_cache(proposal_id) WHERE is_superseded = false;

CREATE INDEX IF NOT EXISTS idx_research_cache_topic_trgm
    ON research_cache USING gin (topic gin_trgm_ops) WHERE is_superseded = false;

CREATE INDEX IF NOT EXISTS idx_research_cache_source_type
    ON research_cache(source_type, created_at DESC) WHERE is_superseded = false;

-- Note: HNSW vector index — add after pgvector extension is enabled:
-- CREATE INDEX CONCURRENTLY idx_research_embedding
--     ON research_cache USING hnsw (embedding vector_cosine_ops)
--     WITH (m = 16, ef_construction = 64);

-- ─── Table 3: decision_queue ─────────────────────────────────────────────────
-- Pending gate evaluation requests. The trigger mechanism for D1–D4.
-- Working agents INSERT here; the gate evaluator (AI or USER) processes rows.

CREATE TABLE IF NOT EXISTS decision_queue (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id      bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
    stage            text NOT NULL,
    gate_number      int CHECK (gate_number BETWEEN 1 AND 4),
    requested_by     text NOT NULL,                -- agent identity
    evidence_summary text,                         -- agent's summary of work done
    estimated_cost_usd numeric(10,6),
    impact_score     int CHECK (impact_score BETWEEN 0 AND 100),
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','evaluating','decided','expired')),
    outcome          text CHECK (outcome IN ('mature','revise','depend','discard')),
    decided_by       text,                         -- agent identity or 'user'
    decision_notes   text,
    process_after    timestamptz DEFAULT now() NOT NULL,
    created_at       timestamptz DEFAULT now() NOT NULL,
    decided_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_decision_queue_pending
    ON decision_queue(process_after ASC) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_decision_queue_proposal
    ON decision_queue(proposal_id);

-- ─── Table 4: transition_queue ───────────────────────────────────────────────
-- Approved stage transitions waiting to execute.
-- Uses FOR UPDATE SKIP LOCKED for concurrent-safe worker polling.

CREATE TABLE IF NOT EXISTS transition_queue (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
    from_stage      text NOT NULL,
    to_stage        text NOT NULL,
    triggered_by    text NOT NULL,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','done','failed')),
    attempt_count   int NOT NULL DEFAULT 0,
    max_attempts    int NOT NULL DEFAULT 3,
    process_after   timestamptz DEFAULT now() NOT NULL,
    processing_at   timestamptz,
    completed_at    timestamptz,
    last_error      text,
    metadata        jsonb,
    created_at      timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transition_queue_pending
    ON transition_queue(process_after ASC) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_transition_queue_proposal
    ON transition_queue(proposal_id);

-- ─── Table 5: agent_budget_ledger ────────────────────────────────────────────
-- Real-time per-proposal spend tracking. One row per agent run.
-- The pre-spawn budget check queries the latest row by proposal_id.

CREATE TABLE IF NOT EXISTS agent_budget_ledger (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id          bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
    agent_run_id         bigint REFERENCES agent_runs(id) ON DELETE SET NULL,
    agent_identity       text NOT NULL,
    model_used           text NOT NULL,
    tokens_in            int DEFAULT 0,
    tokens_out           int DEFAULT 0,
    cost_usd             numeric(10,6) NOT NULL,
    budget_allocated_usd numeric(10,4) DEFAULT 10.00,
    budget_remaining_usd numeric(10,6) NOT NULL,
    cumulative_cost_usd  numeric(10,6) NOT NULL,
    recorded_at          timestamptz DEFAULT now() NOT NULL
);

-- Primary access pattern: latest ledger row for a proposal (pre-spawn check)
CREATE INDEX IF NOT EXISTS idx_budget_ledger_proposal_latest
    ON agent_budget_ledger(proposal_id, recorded_at DESC);

-- ─── Table 6: agent_conflicts ────────────────────────────────────────────────
-- Disagreement escalation log. When two agents disagree, both positions
-- are recorded here and the conflict is escalated to PM or USER.

CREATE TABLE IF NOT EXISTS agent_conflicts (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint NOT NULL REFERENCES proposal(id) ON DELETE CASCADE,
    agent_a         text NOT NULL,
    agent_b         text NOT NULL,
    topic           text NOT NULL,
    position_a      text NOT NULL,
    position_b      text NOT NULL,
    status          text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','escalated','resolved','dismissed')),
    resolved_by     text,
    resolution      text,
    created_at      timestamptz DEFAULT now() NOT NULL,
    resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_conflicts_proposal
    ON agent_conflicts(proposal_id);

CREATE INDEX IF NOT EXISTS idx_agent_conflicts_open
    ON agent_conflicts(created_at DESC) WHERE status = 'open';

-- ─── Table 7: notification_queue ─────────────────────────────────────────────
-- USER/human alert delivery queue. Severity tiers: INFO→ALERT→URGENT→CRITICAL.
-- The notification dispatcher reads pending rows and delivers via configured channels.

CREATE TABLE IF NOT EXISTS notification_queue (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     bigint REFERENCES proposal(id) ON DELETE SET NULL,
    severity        text NOT NULL DEFAULT 'INFO'
                    CHECK (severity IN ('INFO','ALERT','URGENT','CRITICAL')),
    channel         text NOT NULL DEFAULT 'discord'
                    CHECK (channel IN ('discord','email','sms','push','digest')),
    title           text NOT NULL,
    body            text NOT NULL,
    metadata        jsonb,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','failed','suppressed')),
    created_at      timestamptz DEFAULT now() NOT NULL,
    delivered_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_notification_queue_pending
    ON notification_queue(severity, created_at ASC) WHERE status = 'pending';

-- ─── NOTIFY Trigger: proposal maturity change ─────────────────────────────────
-- Fires on proposal.maturity_level changes to wake the auto-transition engine.
-- Also used by dependent proposals subscribed to readiness signals.

CREATE OR REPLACE FUNCTION fn_notify_maturity_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_payload jsonb;
BEGIN
    -- Only fire when maturity_level actually changes
    IF NEW.maturity_level IS NOT DISTINCT FROM OLD.maturity_level THEN
        RETURN NEW;
    END IF;

    v_payload := jsonb_build_object(
        'proposal_id',   NEW.id,
        'display_id',    NEW.display_id,
        'from_maturity', OLD.maturity_level,
        'to_maturity',   NEW.maturity_level,
        'stage',         NEW.status,
        'ts',            to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );

    -- Real-time signal for the auto-transition engine (ephemeral)
    PERFORM pg_notify('proposal_maturity_changed', v_payload::text);

    RETURN NEW;
END;
$$;

-- Drop and recreate to ensure latest version
DROP TRIGGER IF EXISTS trg_notify_maturity_change ON proposal;
CREATE TRIGGER trg_notify_maturity_change
    BEFORE UPDATE ON proposal
    FOR EACH ROW EXECUTE FUNCTION fn_notify_maturity_change();

-- ─── NOTIFY Trigger: budget threshold ────────────────────────────────────────
-- Fires after INSERT on agent_budget_ledger when spend crosses 20% or 5% remaining.
-- Edge-triggered: only fires once per threshold crossing, not on every insert.

CREATE OR REPLACE FUNCTION fn_budget_threshold_notify()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_pct numeric;
BEGIN
    IF NEW.budget_allocated_usd = 0 THEN RETURN NEW; END IF;

    v_pct := NEW.budget_remaining_usd / NEW.budget_allocated_usd;

    -- Cross 5% threshold (downward)
    IF v_pct <= 0.05
       AND (NEW.budget_remaining_usd + NEW.cost_usd) / NEW.budget_allocated_usd > 0.05
    THEN
        PERFORM pg_notify('budget_threshold_breached', jsonb_build_object(
            'proposal_id',    NEW.proposal_id,
            'threshold_pct',  5,
            'remaining_usd',  NEW.budget_remaining_usd,
            'cumulative_usd', NEW.cumulative_cost_usd,
            'ts',             to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);

    -- Cross 20% threshold (downward)
    ELSIF v_pct <= 0.20
          AND (NEW.budget_remaining_usd + NEW.cost_usd) / NEW.budget_allocated_usd > 0.20
    THEN
        PERFORM pg_notify('budget_threshold_breached', jsonb_build_object(
            'proposal_id',    NEW.proposal_id,
            'threshold_pct',  20,
            'remaining_usd',  NEW.budget_remaining_usd,
            'cumulative_usd', NEW.cumulative_cost_usd,
            'ts',             to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
        )::text);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_budget_threshold_notify ON agent_budget_ledger;
CREATE TRIGGER trg_budget_threshold_notify
    AFTER INSERT ON agent_budget_ledger
    FOR EACH ROW EXECUTE FUNCTION fn_budget_threshold_notify();

-- ─── NOTIFY channel catalogue (no DDL — documentation only) ──────────────────
-- Channel: proposal_maturity_changed  → auto-transition engine
--   Payload: {proposal_id, display_id, from_maturity, to_maturity, stage, ts}
--
-- Channel: transition_queued          → transition worker pool
--   Payload: {proposal_id, from_stage, to_stage, ts}  (fired by application)
--
-- Channel: budget_threshold_breached  → notification dispatcher
--   Payload: {proposal_id, threshold_pct, remaining_usd, cumulative_usd, ts}
--
-- Channel: agent_conflict_opened      → PM notification dispatcher
--   Payload: {proposal_id, conflict_id, topic, ts}    (fired by application)
--
-- Channel: decision_requested         → gate evaluator pool
--   Payload: {proposal_id, stage, gate_number, ts}    (fired by application)

-- ─── pg_cron jobs (commented out — enable if pg_cron is available) ────────────
-- SELECT cron.schedule('auto-transition-poll', '30 seconds',
--   $$ SELECT pg_notify('transition_queued', jsonb_build_object('source','pg_cron','ts',to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS"Z"'))::text)
--      WHERE EXISTS (SELECT 1 FROM transition_queue WHERE status = 'pending' AND process_after <= now()); $$);
--
-- SELECT cron.schedule('research-cache-expire', '0 * * * *',
--   $$ UPDATE research_cache SET is_superseded = true WHERE expires_at < now() AND is_superseded = false; $$);
--
-- SELECT cron.schedule('transition-queue-retry', '*/5 * * * *',
--   $$ UPDATE transition_queue SET status = 'pending', process_after = now() + (attempt_count * interval '2 minutes')
--      WHERE status = 'failed' AND attempt_count < max_attempts AND completed_at IS NULL; $$);
--
-- SELECT cron.schedule('decision-queue-expire', '*/10 * * * *',
--   $$ UPDATE decision_queue SET status = 'expired' WHERE status = 'pending'
--      AND process_after < now() - interval '2 hours'; $$);

COMMIT;

-- ─── Verification queries ─────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
--   AND table_name IN ('agent_runs','research_cache','decision_queue','transition_queue',
--                      'agent_budget_ledger','agent_conflicts','notification_queue')
--   ORDER BY table_name;
--
-- SELECT trigger_name, event_object_table FROM information_schema.triggers
--   WHERE trigger_name IN ('trg_notify_maturity_change','trg_budget_threshold_notify');
