-- P1107: Listener subscription reconciliation function
-- Compares expected listeners (roadmap.listener_subscription) against actual
-- live backends via pg_stat_activity. Reports drift.

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

    -- Check each subscription row
    FOR v_row IN SELECT agent_identity, channel, established_pid
                 FROM roadmap.listener_subscription
    LOOP
        v_pid_exists := v_row.established_pid = ANY(v_backend_pids);

        IF NOT v_pid_exists THEN
            -- Listener process has died; agency likely restarted or crashed
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
