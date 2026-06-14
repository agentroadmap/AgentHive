-- 266-p2335-cubic-acquisition-dispatch.sql
-- P2335: Reintroduce Cubic Workspace Acquisition Into Offer Dispatch (project-scoped)
--
-- Two idempotent changes, both safe to re-run (CREATE OR REPLACE):
--
--   1. fn_acquire_cubic(... , p_project_id bigint DEFAULT 1)
--      The 6-param, project-scoped overload was applied out-of-band to the live
--      DB (from the P2335 salvage WIP, commit 9bd15ef2) but was never captured
--      in a numbered migration, so a fresh DB rebuild would lack it. This block
--      re-asserts the exact live definition so the function is reproducible.
--      Satisfies AC-2 (project_id as 6th param, default=1, filters cubics by
--      project_id). The 5-param overload is intentionally left in place for
--      backward compatibility (legacy callers).
--
--   2. fn_complete_work_offer(...) — cubic lock release on completion.
--      Per the "wrapper-enforced concerns" invariant (CONVENTIONS §4), the
--      cubic lifecycle release is enforced at the mechanical SQL chokepoint
--      that every offer completion already passes through, NOT remembered by an
--      LLM/liaison. When a dispatch completes (delivered OR failed), any cubic
--      whose lock_holder matches this dispatch's proposal ('P<proposal_id>') is
--      released: lock_holder=NULL, status='idle'. Satisfies AC-3 / AC-10.
--      Idempotent: releasing an already-released cubic is a no-op.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Project-scoped cubic acquisition (capture live out-of-band definition)
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap.fn_acquire_cubic(
    p_agent_identity text,
    p_proposal_id    bigint,
    p_phase          text    DEFAULT 'design'::text,
    p_budget_usd     numeric DEFAULT NULL::numeric,
    p_worktree_path  text    DEFAULT NULL::text,
    p_project_id     bigint  DEFAULT 1
)
RETURNS TABLE(cubic_id text, was_recycled boolean, was_created boolean, status text, worktree_path text)
LANGUAGE plpgsql
AS $function$
DECLARE
    v_cubic_id        TEXT;
    v_existing_status TEXT;
    v_lock_holder     TEXT;
    v_new_id          TEXT;
    v_was_recycled    BOOLEAN := FALSE;
    v_was_created     BOOLEAN := FALSE;
    v_worktree_path   TEXT;
BEGIN
    -- Compute default worktree_path if not provided (P447 + P2335)
    IF p_worktree_path IS NULL THEN
        -- Project-scoped worktree path
        v_worktree_path := '/data/code/worktree/p' || p_project_id::text || '-P' || p_proposal_id::text || '-' || roadmap.normalize_agent_identity(p_agent_identity);
    ELSE
        v_worktree_path := p_worktree_path;
    END IF;

    -- Step 1: Find existing cubic for this agent AND project (prefer idle, then any non-expired)
    SELECT c.cubic_id, c.status, c.lock_holder
    INTO v_cubic_id, v_existing_status, v_lock_holder
    FROM roadmap.cubics c
    WHERE c.agent_identity = p_agent_identity
      AND c.project_id = p_project_id
      AND c.status NOT IN ('expired', 'complete')
    ORDER BY
        CASE c.status WHEN 'idle' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
        c.created_at DESC
    LIMIT 1;

    IF FOUND THEN
        -- Step 2: If locked to a different proposal, release it (recycle)
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
            worktree_path  = COALESCE(p_worktree_path, v_worktree_path),
            metadata       = COALESCE(c.metadata, '{}'::jsonb)
                             || jsonb_build_object(
                                    'current_proposal', p_proposal_id,
                                    'phase', p_phase,
                                    'acquired_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                                )
        WHERE c.cubic_id = v_cubic_id;

        RETURN QUERY SELECT
            v_cubic_id, v_was_recycled, v_was_created,
            'active'::text, COALESCE(p_worktree_path, v_worktree_path);
    ELSE
        -- Step 4: Create new cubic
        v_new_id := 'cubic_' || gen_random_uuid()::text;

        INSERT INTO roadmap.cubics
            (cubic_id, agent_identity, project_id, status, phase, lock_holder, lock_phase, locked_at,
             activated_at, budget_usd, worktree_path, metadata)
        VALUES
            (v_new_id, p_agent_identity, p_project_id, 'active', p_phase, 'P' || p_proposal_id::TEXT,
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

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Release the cubic lock when an offer completes (wrapper-enforced).
--    Re-assert fn_complete_work_offer with an added cubic-release step. The
--    rest of the body is preserved verbatim from the live definition.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_complete_work_offer(
    p_dispatch_id    bigint,
    p_agent_identity text,
    p_claim_token    uuid,
    p_status         text DEFAULT 'delivered'::text
)
RETURNS boolean
LANGUAGE plpgsql
AS $function$
DECLARE
  v_updated         INT;
  v_dispatch_status TEXT;
  v_proposal_id     BIGINT;
BEGIN
  IF p_status NOT IN ('delivered','failed') THEN
    RAISE EXCEPTION 'invalid completion status %', p_status
      USING ERRCODE = 'check_violation';
  END IF;

  v_dispatch_status := CASE p_status
    WHEN 'delivered' THEN 'completed'
    WHEN 'failed'    THEN 'failed'
  END;

  UPDATE roadmap_workforce.squad_dispatch
  SET offer_status    = p_status,
      dispatch_status = v_dispatch_status,
      completed_at    = now(),
      agency_identity = COALESCE(agency_identity, p_agent_identity),
      -- V3-C2: classify the failure. Default 'unknown' (countable) but preserve
      -- a transient class the caller pre-stamped before completing.
      failure_class   = CASE WHEN p_status = 'failed'
                             THEN COALESCE(failure_class, 'unknown')
                             ELSE failure_class END
  WHERE id           = p_dispatch_id
    AND claim_token  = p_claim_token
    AND offer_status IN ('claimed', 'active')
  RETURNING proposal_id INTO v_proposal_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 1 THEN
    UPDATE roadmap_proposal.proposal_lease pl
    SET released_at    = now(),
        release_reason = CASE p_status
          WHEN 'delivered' THEN 'work_delivered'
          ELSE 'work_failed'
        END
    FROM roadmap_workforce.squad_dispatch sd
    WHERE sd.id = p_dispatch_id
      AND sd.lease_id = pl.id
      AND pl.released_at IS NULL;

    -- P2335 AC-3 / AC-10: release the cubic lock held for this proposal so the
    -- worktree becomes idle/reclaimable. Mechanical, wrapper-enforced — no LLM
    -- in the loop. No-op when no matching locked cubic exists (legacy dispatch
    -- with no cubic, or already-released).
    IF v_proposal_id IS NOT NULL THEN
      UPDATE roadmap.cubics
      SET lock_holder  = NULL,
          lock_phase   = NULL,
          status       = 'idle',
          completed_at = now()
      WHERE lock_holder = 'P' || v_proposal_id::TEXT;
    END IF;
  END IF;

  RETURN v_updated = 1;
END;
$function$;

COMMIT;
