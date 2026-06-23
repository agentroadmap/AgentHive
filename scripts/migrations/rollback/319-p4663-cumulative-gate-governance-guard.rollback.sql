-- 319-p4663-cumulative-gate-governance-guard.rollback.sql
-- Rollback for 319-p4663-cumulative-gate-governance-guard.sql
--
-- Restores fn_guard_gate_advance to its IMMEDIATE predecessor: the mig 299
-- (P3929) body — terminal app.gate_bypass present, non-terminal independence /
-- gate_decision_log enforcement preserved. This is the state that existed on the
-- live DB before mig 319 was applied.
--
-- Scope (mirror of what mig 319 changed — nothing more):
--   1. fn_guard_gate_advance  → restored to mig 299 body (P4663-AC-10).
--   2. DELIBERATION removed from proposal_status_canonical (only if no rows use it).
--   3. DELIBERATION removed from roadmap.reference_terms (only if no rows use it).
--   4. Ledger row for 319-p4663 removed from roadmap.schema_migration.
--
-- fn_apply_gate_advance is NOT touched (mig 319 never modified it).
--
-- WARNING: this rollback re-introduces the terminal app.gate_bypass escape hatch
-- (P4663-AC-12 protection removed) and the P3929 partial-bypass state. Apply only
-- under operator supervision and plan to re-apply mig 319 once the issue is resolved.
--
-- Idempotent: CREATE OR REPLACE + guarded DROP/ADD CONSTRAINT + DELETE ... WHERE.

BEGIN;

-- ─── 1. Restore fn_guard_gate_advance to mig 299 (P3929) body ─────────────────

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate_key        TEXT;
    v_has_decision    BOOLEAN;
    v_is_nonterminal  BOOLEAN;
BEGIN
    -- Only act on forward gated status changes.
    v_gate_key := UPPER(OLD.status) || E'→' || UPPER(NEW.status);

    IF v_gate_key NOT IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE'
    ) THEN
        RETURN NEW;
    END IF;

    -- Classify gate type first so the bypass can be scoped to terminal-only.
    v_is_nonterminal := v_gate_key IN (E'DRAFT→REVIEW', E'REVIEW→DEVELOP');

    -- P3929: bypass is honored ONLY for terminal gates (D3, D4) as an operator
    -- escape hatch.  Non-terminal gates (D1, D2) ALWAYS enforce gate_decision_log
    -- + AC-1/2/3 checks regardless of the app.gate_bypass flag.
    IF NOT v_is_nonterminal AND current_setting('app.gate_bypass', true) = 'true' THEN
        RETURN NEW;
    END IF;

    -- ── Non-terminal gates (D1, D2): ONLY gate_decision_log advance row accepted.
    IF v_is_nonterminal THEN
        SELECT EXISTS (
            SELECT 1
            FROM roadmap_proposal.gate_decision_log gdl
            WHERE gdl.proposal_id = NEW.id
              AND UPPER(gdl.from_state) = UPPER(OLD.status)
              AND UPPER(gdl.to_state)   = UPPER(NEW.status)
              AND gdl.decision = 'advance'
              AND gdl.created_at >= now() - INTERVAL '10 minutes'
        ) INTO v_has_decision;

        IF v_has_decision THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION
            'Non-terminal gate % → % on proposal % requires record_gate_decision. '
            'Direct status updates on gated edges are not permitted (P3566/AC-3). '
            'Submit an independent review (proposal_reviews verdict=approve, reviewer != advancer), '
            'then call record_gate_decision(decision=advance) — the trigger will advance the status.',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- ── Terminal gates (D3, D4): dual-branch unchanged from P3566/mig270 ─────────

    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.gate_decision_log gdl
        WHERE gdl.proposal_id = NEW.id
          AND UPPER(gdl.from_state) = UPPER(OLD.status)
          AND UPPER(gdl.to_state)   = UPPER(NEW.status)
          AND gdl.decision = 'advance'
          AND gdl.created_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN
        RETURN NEW;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.proposal_reviews pr
        WHERE pr.proposal_id = NEW.id
          AND pr.verdict = 'approve'
          AND pr.reviewed_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF v_has_decision THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'Gate transition % → % on proposal % requires a gate decision. '
        'Submit a gate review (proposal_reviews verdict=approve) or '
        'gate_decision_log (decision=advance) within the last 10 minutes before advancing.',
        OLD.status, NEW.status, NEW.id
        USING ERRCODE = 'check_violation';
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
    'P3929 (ROLLBACK of P4663/mig319): terminal app.gate_bypass restored, '
    'non-terminal gate_decision_log enforcement preserved. '
    'See 319-p4663-cumulative-gate-governance-guard.sql for the cumulative guard.';

-- ─── 2. Remove DELIBERATION from proposal_status_canonical (guarded) ──────────

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM roadmap_proposal.proposal WHERE status = 'DELIBERATION'
    ) THEN
        RAISE EXCEPTION
            'Cannot remove DELIBERATION from proposal_status_canonical: % row(s) currently '
            'have status=DELIBERATION. Migrate those proposals first.',
            (SELECT COUNT(*) FROM roadmap_proposal.proposal WHERE status = 'DELIBERATION');
    END IF;

    ALTER TABLE roadmap_proposal.proposal
        DROP CONSTRAINT IF EXISTS proposal_status_canonical;

    ALTER TABLE roadmap_proposal.proposal
        ADD CONSTRAINT proposal_status_canonical CHECK (
            status = ANY (ARRAY[
                'Abandoned'::text, 'APPROVED'::text, 'CLOSED'::text,
                'Complete'::text,  'COMPLETE'::text,
                'DEPLOYED'::text,
                'Develop'::text,   'DEVELOP'::text,
                'DISCARDED'::text, 'DONE'::text,
                'Draft'::text,     'DRAFT'::text,
                'ESCALATE'::text,  'FIX'::text, 'FIXING'::text,
                'Merge'::text,     'MERGE'::text, 'MERGED'::text,
                'NON_ISSUE'::text, 'OPEN'::text,
                'Rejected'::text,  'REJECTED'::text, 'Replaced'::text,
                'Review'::text,    'REVIEW'::text,   'REVIEWING'::text,
                'TRIAGE'::text,    'WONT_FIX'::text
            ])
        );
END;
$$;

-- ─── 3. Remove DELIBERATION reference term (guarded) ─────────────────────────

DELETE FROM roadmap.reference_terms
 WHERE term_category = 'proposal_state'
   AND term_value    = 'DELIBERATION'
   AND NOT EXISTS (
       SELECT 1 FROM roadmap_proposal.proposal WHERE status = 'DELIBERATION'
   );

-- ─── 4. Remove the canonical ledger entry for mig 319 ────────────────────────

DELETE FROM roadmap.schema_migration
 WHERE filename = '319-p4663-cumulative-gate-governance-guard.sql';

COMMIT;
