-- P477 AC-4: control-plane stop actions
-- Adds the minimal columns needed to record operator-initiated stops
-- without ambiguity. The actual "kill the running process" is left to
-- the worker's heartbeat/notify loop — these columns are the contract
-- the worker observes ("status went to cancelled, give up gracefully").
--
-- Three stop targets:
--   * agent_runs        — soft-cancel a single run row
--   * cubics            — flip an active cubic to expired + drop lock
--   * proposal          — halt the gate scanner for one proposal
--
-- Each adds a who/why pair for audit reconstruction.

BEGIN;

-- agent_runs cancellations
ALTER TABLE roadmap_workforce.agent_runs
    ADD COLUMN IF NOT EXISTS cancelled_by     text,
    ADD COLUMN IF NOT EXISTS cancelled_at     timestamptz,
    ADD COLUMN IF NOT EXISTS cancelled_reason text;

COMMENT ON COLUMN roadmap_workforce.agent_runs.cancelled_by     IS 'P477 AC-4: operator name from operator_token who triggered the stop. Null = not cancelled by operator.';
COMMENT ON COLUMN roadmap_workforce.agent_runs.cancelled_reason IS 'P477 AC-4: free-text reason the operator gave at stop time.';

-- cubic stop trail
ALTER TABLE roadmap.cubics
    ADD COLUMN IF NOT EXISTS stopped_by     text,
    ADD COLUMN IF NOT EXISTS stopped_at     timestamptz,
    ADD COLUMN IF NOT EXISTS stopped_reason text;

COMMENT ON COLUMN roadmap.cubics.stopped_by     IS 'P477 AC-4: operator name from operator_token who flipped this cubic to expired. Null = expired by normal lifecycle.';
COMMENT ON COLUMN roadmap.cubics.stopped_reason IS 'P477 AC-4: free-text reason the operator gave at stop time.';

-- Proposal-level state-machine halt: when true, gate-scanner / orchestrator
-- skips this proposal until an operator resumes. NULLable to keep the column
-- cheap for the 99% of proposals that are never halted.
ALTER TABLE roadmap_proposal.proposal
    ADD COLUMN IF NOT EXISTS gate_scanner_paused      boolean       NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS gate_paused_by           text,
    ADD COLUMN IF NOT EXISTS gate_paused_at           timestamptz,
    ADD COLUMN IF NOT EXISTS gate_paused_reason       text;

COMMENT ON COLUMN roadmap_proposal.proposal.gate_scanner_paused IS 'P477 AC-4: operator-set kill switch for the gate scanner. When true, the scanner / orchestrator must skip this proposal until an operator resumes it.';
COMMENT ON COLUMN roadmap_proposal.proposal.gate_paused_by      IS 'P477 AC-4: operator name (from operator_token) who paused the gate scanner.';

-- Index for the scanner so it can cheaply skip paused proposals.
CREATE INDEX IF NOT EXISTS idx_proposal_gate_paused
    ON roadmap_proposal.proposal (gate_scanner_paused)
    WHERE gate_scanner_paused = true;

COMMIT;
