-- P427: Normalize cubic worktree paths.
--
-- The old cubic default used /data/code/worktree-<agent>. The canonical
-- AgentHive worktree layout is /data/code/worktree/<name>. Existing active
-- rows are repaired separately by scripts/repair-cubic-worktrees.ts so this
-- migration only fixes future acquisition defaults.

BEGIN;

CREATE OR REPLACE FUNCTION roadmap.fn_acquire_cubic(
    p_agent_identity TEXT,
    p_proposal_id    INT8,
    p_phase          TEXT DEFAULT 'design',
    p_budget_usd     NUMERIC DEFAULT NULL,
    p_worktree_path  TEXT DEFAULT NULL
) RETURNS TABLE (
    cubic_id        TEXT,
    was_recycled    BOOLEAN,
    was_created     BOOLEAN,
    status          TEXT,
    worktree_path   TEXT
) LANGUAGE plpgsql AS $$
DECLARE
    v_cubic_id         TEXT;
    v_existing_status  TEXT;
    v_lock_holder      TEXT;
    v_new_id           TEXT;
    v_effective_path   TEXT;
    v_was_recycled     BOOLEAN := FALSE;
BEGIN
    v_effective_path := COALESCE(
        p_worktree_path,
        '/data/code/worktree/' || regexp_replace(p_agent_identity, '[^A-Za-z0-9._-]+', '-', 'g')
    );

    SELECT c.cubic_id, c.status, c.lock_holder
    INTO v_cubic_id, v_existing_status, v_lock_holder
    FROM roadmap.cubics c
    WHERE c.agent_identity = p_agent_identity
      AND c.status NOT IN ('expired', 'complete')
    ORDER BY
        CASE c.status WHEN 'idle' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        c.created_at DESC
    LIMIT 1;

    IF FOUND THEN
        IF v_lock_holder IS NOT NULL
           AND v_lock_holder != 'P' || p_proposal_id::TEXT THEN
            v_was_recycled := TRUE;
        END IF;

        UPDATE roadmap.cubics c
        SET status         = 'active',
            phase          = p_phase,
            lock_holder    = 'P' || p_proposal_id::TEXT,
            lock_phase     = p_phase,
            locked_at      = NOW(),
            activated_at   = COALESCE(c.activated_at, NOW()),
            completed_at   = NULL,
            budget_usd     = COALESCE(p_budget_usd, c.budget_usd),
            worktree_path  = COALESCE(p_worktree_path, c.worktree_path, v_effective_path),
            metadata       = COALESCE(c.metadata, '{}'::jsonb)
                             || jsonb_build_object(
                                    'current_proposal', p_proposal_id,
                                    'phase', p_phase,
                                    'acquired_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                                )
        WHERE c.cubic_id = v_cubic_id
        RETURNING c.worktree_path INTO v_effective_path;

        RETURN QUERY SELECT
            v_cubic_id,
            v_was_recycled,
            FALSE,
            'active'::TEXT,
            v_effective_path;
    ELSE
        INSERT INTO roadmap.cubics (
            status, phase, agent_identity, worktree_path, budget_usd,
            lock_holder, lock_phase, locked_at, activated_at, metadata
        ) VALUES (
            'active',
            p_phase,
            p_agent_identity,
            v_effective_path,
            p_budget_usd,
            'P' || p_proposal_id::TEXT,
            p_phase,
            NOW(),
            NOW(),
            jsonb_build_object(
                'current_proposal', p_proposal_id,
                'phase', p_phase,
                'created_by', 'fn_acquire_cubic',
                'acquired_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
        )
        RETURNING cubics.cubic_id INTO v_new_id;

        RETURN QUERY SELECT
            v_new_id,
            FALSE,
            TRUE,
            'active'::TEXT,
            v_effective_path;
    END IF;
END;
$$;

COMMENT ON FUNCTION roadmap.fn_acquire_cubic IS
    'Atomic cubic acquisition using canonical /data/code/worktree/<agent> paths unless an explicit worktree_path is supplied.';

COMMIT;
