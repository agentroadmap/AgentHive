-- ============================================================================
-- ROLLBACK: Migration 312 — P4668 break-glass function
-- ============================================================================
-- NOTE: This does NOT delete the break_glass_operator role if it has members.
-- Check pg_auth_members before dropping.
-- ============================================================================

BEGIN;

REVOKE EXECUTE ON FUNCTION roadmap.fn_canonical_transition_break_glass(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT)
    FROM break_glass_operator;

DROP FUNCTION IF EXISTS roadmap.fn_canonical_transition_break_glass(BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT);

REVOKE SELECT ON roadmap_proposal.proposal_transition_ledger FROM break_glass_operator;
REVOKE SELECT ON roadmap_proposal.v_proposal_transition_ledger FROM break_glass_operator;

-- Only drop if no members; leave role if it exists for audit trail
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members WHERE roleid = 'break_glass_operator'::regrole
    ) THEN
        DROP ROLE IF EXISTS break_glass_operator;
    ELSE
        RAISE NOTICE 'break_glass_operator role has active members — not dropped. Remove manually.';
    END IF;
END;
$$;

COMMIT;
