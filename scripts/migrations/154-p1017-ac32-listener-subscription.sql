-- P1017 AC-32: Listener subscription table for agent LISTEN channel tracking
--
-- Background: Agents register LISTEN subscriptions on channels
-- (e.g., a2a_msg_<agent_id>, liaison:task:<task_id>). This table tracks
-- active subscriptions to enable watchdog reconciliation and debug commands.
--
-- The reconciliation function is a stub; the watchdog that calls
-- pg_listening_channels() and compares against this table will be wired
-- in a follow-up task.

BEGIN;

-- ─── 1. Main subscription table ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.listener_subscription (
    agent_identity   TEXT        NOT NULL,
    channel          TEXT        NOT NULL,
    established_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    established_pid  INT,
    PRIMARY KEY (agent_identity, channel)
);

CREATE INDEX IF NOT EXISTS idx_listener_subscription_channel
    ON roadmap.listener_subscription (channel);

-- ─── 2. Reconciliation stub ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap.fn_listener_subscription_reconcile_stub() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- P1017 AC-32: real reconciliation calls pg_listening_channels() from probe
  -- sessions and compares against roadmap.listener_subscription. Stub does
  -- nothing until wired by watchdog (Senior Developer / Backend Architect
  -- follow-up).
  RETURN;
END;
$$;

COMMIT;
