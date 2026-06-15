-- P1107 hotfix: resolve ERROR 42702 ambiguous column in fn_listener_reconcile_drift()
--
-- Migration 164 applied fn_listener_reconcile_drift() with bare column names
-- (agent_identity, channel) in the FOR loop SELECT. PL/pgSQL treats them as
-- ambiguous between the RETURNS TABLE output variables and the actual table
-- columns, causing ERROR 42702 at runtime.
--
-- Fix: add table alias `ls` to the FOR SELECT so the column references are
-- unambiguous. This is a CREATE OR REPLACE with no schema change — safe to
-- run on live DBs that already applied migration 164.

CREATE OR REPLACE FUNCTION roadmap.fn_listener_reconcile_drift()
RETURNS TABLE(
    agent_identity text,
    channel text,
    drift_reason text
) LANGUAGE plpgsql AS $$
DECLARE
    v_row RECORD;
    v_pid_exists boolean;
    v_backend_pids int[];
BEGIN
    -- Collect all live backend PIDs
    SELECT ARRAY_AGG(pid) INTO v_backend_pids
        FROM pg_stat_activity WHERE state != 'disabled';

    -- ls alias avoids ERROR 42702: ambiguity between RETURNS TABLE cols and table cols
    FOR v_row IN SELECT ls.agent_identity, ls.channel, ls.established_pid
                 FROM roadmap.listener_subscription ls
    LOOP
        v_pid_exists := v_row.established_pid = ANY(v_backend_pids);

        IF NOT v_pid_exists THEN
            RETURN QUERY SELECT
                v_row.agent_identity,
                v_row.channel,
                'pid=' || v_row.established_pid || ' not in pg_stat_activity (agency died?)'::text;
        END IF;
    END LOOP;

    -- Clean up stale rows (pids no longer in the system)
    DELETE FROM roadmap.listener_subscription
        WHERE established_pid NOT IN (
            SELECT pid FROM pg_stat_activity WHERE state != 'disabled'
        );
END;
$$;

GRANT EXECUTE ON FUNCTION roadmap.fn_listener_reconcile_drift() TO admin;
