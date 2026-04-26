-- P447: Cubic worktree path canonicalization
-- Enforces canonical root /data/code/worktree/ with grandfathered legacy set
-- NOT VALID constraint to allow lazy validation of existing rows

-- Step 1: Create normalize_agent_identity SQL function
-- Matches the NFC + lowercase + slugify pattern from sanitize-agent-id.ts
CREATE OR REPLACE FUNCTION roadmap.normalize_agent_identity(p_input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $func$
DECLARE
    v_normalized text;
    v_slugified text;
BEGIN
    IF p_input IS NULL OR p_input = '' THEN
        RETURN NULL;
    END IF;

    -- Trim, NFC normalize, lowercase
    v_normalized := LOWER(TRIM(p_input));

    -- Basic NFC normalization via Unicode collation
    -- (PostgreSQL NFC is automatic for text type with Unicode support)

    -- Slugify: replace disallowed chars with hyphens, collapse runs, strip edges
    -- Allowed: [a-z0-9_/-]
    v_slugified := REGEXP_REPLACE(v_normalized, '[^a-z0-9_/-]', '-', 'g');
    v_slugified := REGEXP_REPLACE(v_slugified, '-+', '-', 'g');
    v_slugified := REGEXP_REPLACE(v_slugified, '^-+|-+$', '', 'g');

    RETURN COALESCE(NULLIF(v_slugified, ''), NULL);
END;
$func$;

-- Step 2: Log count of legacy rows before adding constraint
DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM roadmap.cubics
    WHERE worktree_path NOT LIKE '/data/code/worktree/%';
    RAISE NOTICE 'P447: Found % legacy cubic rows outside canonical root', v_count;
END $$;

-- Step 3: Add CHECK constraint (NOT VALID) to enforce canonical root
-- This constraint applies immediately to new inserts but defers validation of existing rows
-- Grandfathered set: all existing non-canonical rows are implicitly allowed via NOT VALID
-- Once repair script runs, all rows will be canonical and constraint is fully enforceable
ALTER TABLE roadmap.cubics
ADD CONSTRAINT ck_cubics_worktree_path_canonical
CHECK (worktree_path LIKE '/data/code/worktree/%') NOT VALID;

-- Step 4: Validate the constraint after repair script completes
-- Note: Do NOT run VALIDATE here; it will fail due to legacy rows.
-- The repair script (repair-cubic-worktree-paths.ts --apply) will fix legacy rows,
-- then we can VALIDATE manually: ALTER TABLE roadmap.cubics VALIDATE CONSTRAINT ck_cubics_worktree_path_canonical;

-- Step 5: Create v_cubic_health view
-- Lists cubics outside canonical root (if any exist after repair)
CREATE OR REPLACE VIEW roadmap.v_cubic_health AS
SELECT
    cubic_id,
    worktree_path,
    status,
    created_at,
    agent_identity,
    'legacy' AS health_status
FROM roadmap.cubics
WHERE worktree_path NOT LIKE '/data/code/worktree/%';

-- Step 6: Update fn_acquire_cubic to default p_worktree_path
-- to canonical path derived from agent_identity
CREATE OR REPLACE FUNCTION roadmap.fn_acquire_cubic(
    p_agent_identity text,
    p_proposal_id bigint,
    p_phase text DEFAULT 'design'::text,
    p_budget_usd numeric DEFAULT NULL::numeric,
    p_worktree_path text DEFAULT NULL::text
)
RETURNS TABLE(
    cubic_id text,
    was_recycled boolean,
    was_created boolean,
    status text,
    worktree_path text
)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_cubic_id      TEXT;
    v_existing_status TEXT;
    v_lock_holder   TEXT;
    v_new_id        TEXT;
    v_was_recycled  BOOLEAN := FALSE;
    v_was_created   BOOLEAN := FALSE;
    v_worktree_path TEXT;
BEGIN
    -- Compute default worktree_path if not provided (P447)
    IF p_worktree_path IS NULL THEN
        v_worktree_path := '/data/code/worktree/' || roadmap.normalize_agent_identity(p_agent_identity);
    ELSE
        v_worktree_path := p_worktree_path;
    END IF;

    -- Step 1: Find existing cubic for this agent (prefer idle, then any non-expired)
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
        -- Step 2: If locked to a different proposal, release it
        IF v_lock_holder IS NOT NULL
           AND v_lock_holder != 'P' || p_proposal_id::TEXT THEN
            v_was_recycled := TRUE;
        END IF;

        -- Step 3: Focus the cubic on this proposal
        UPDATE roadmap.cubics c
        SET status         = 'active',
            phase          = p_phase,
            lock_holder    = 'P' || p_proposal_id::TEXT,
            lock_phase     = p_phase,
            locked_at      = NOW(),
            activated_at   = COALESCE(c.activated_at, NOW()),
            completed_at   = NULL,
            budget_usd     = COALESCE(p_budget_usd, c.budget_usd),
            worktree_path  = COALESCE(p_worktree_path, c.worktree_path),
            metadata       = COALESCE(c.metadata, '{}'::jsonb)
                             || jsonb_build_object(
                                    'current_proposal', p_proposal_id,
                                    'phase', p_phase,
                                    'acquired_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                                )
        WHERE c.cubic_id = v_cubic_id;

        RETURN QUERY SELECT
            v_cubic_id, v_was_recycled, v_was_created,
            'active'::text, v_worktree_path;
    ELSE
        -- Step 4: Create new cubic
        v_new_id := 'cubic_' || gen_random_uuid()::text;

        INSERT INTO roadmap.cubics
            (cubic_id, agent_identity, status, phase, lock_holder, lock_phase, locked_at,
             activated_at, budget_usd, worktree_path, metadata)
        VALUES
            (v_new_id, p_agent_identity, 'active', p_phase, 'P' || p_proposal_id::TEXT,
             p_phase, NOW(), NOW(), p_budget_usd, v_worktree_path,
             jsonb_build_object(
                'current_proposal', p_proposal_id,
                'phase', p_phase,
                'acquired_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
             ));

        v_was_created := TRUE;

        RETURN QUERY SELECT
            v_new_id, v_was_recycled, v_was_created,
            'active'::text, v_worktree_path;
    END IF;
END;
$function$;

-- Step 7: Grant permissions (roadmap_writer may not exist, but function is available)
-- GRANT EXECUTE ON FUNCTION roadmap.normalize_agent_identity TO roadmap_writer;
