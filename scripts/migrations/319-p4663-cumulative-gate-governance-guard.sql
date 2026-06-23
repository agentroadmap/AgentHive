-- 319-p4663-cumulative-gate-governance-guard.sql
-- (Renumbered from 316 → 319: 316 collided with 316-p4509 / 316-p3566.SUPERSEDED on main;
--  highest active prefix in scripts/migrations is 318-p4996; 319 free in both roots — AC-11.)
-- P4663: Cumulative gate/governance/AC/independence guard consolidation.
--
-- Constitution authority: doc-9 / P179
--   Article III §9  — checks and balances / independent review
--   Article VI §15  — coherent, evidenced, non-vacuous completion
--   Article VII §19 — governance-amendment deliberation, quorum, and human final approval
--
-- Function boundaries preserved (no merge):
--   fn_guard_gate_advance   — terminal and governance-amendment status-transition invariants
--   fn_apply_gate_advance   — non-terminal independence + blocker checks (unchanged)
--   fn_actor_is_independent — shared identity-inequality helper (unchanged)
--
-- Pillars installed by this migration (cumulative union of prior writers):
--   P_noBypass   : app.gate_bypass removed from ALL code paths (P906/mig264 fully restored)
--   P_govEdges   : DELIBERATION status added; DRAFT→DELIBERATION + DELIBERATION→REVIEW guarded
--   P_gov48h     : governance-amendment DELIBERATION→REVIEW refused before 48h elapsed
--   P_govHuman   : governance-amendment MERGE→COMPLETE requires human-role decider
--   P_termIndep  : terminal decider != proposal author (author from audit JSON; fail-closed)
--   P_termAC     : MERGE→COMPLETE refuses zero ACs or any unwaived pending/fail/blocked AC
--   P_log        : non-terminal requires gate_decision_log; terminal requires log OR review approve
--
-- Prior writer migrations and their RAISE conditions re-implemented here:
--   mig 189 (P181):  governance deliberation period (48h), human approver, independence
--   mig 254 (P3566): gate_decision_log required for non-terminal (D1, D2)
--   mig 270 (P3566): non-terminal independence via fn_apply_gate_advance (unchanged)
--   mig 289 (P3566): terminal bypass for gate_decision_log (kept; bypass removed)
--   mig 291 (P3563): terminal AC non-vacuous completion invariant
--   mig 299 (P3929): non-terminal bypass removal (app.gate_bypass scoped to terminal only)
-- This migration makes the P3929 partial removal COMPLETE by also removing bypass from terminal.
--
-- Author-resolution for P_termIndep (AC-13):
--   Primary:  audit JSONB array element with Activity='Created', Agent field
--   Fallback: earliest proposal_discussions.author_identity not LIKE 'system%'
--   Fail-closed: RAISE if neither resolves a concrete non-system identity
--
-- Human-role set for P_govHuman (AC-14; verified against live agent_registry 2026-06-22):
--   agent_type = 'human' (live distinct values: developer/human, reviewer/human)
--
-- Blast radius: HIGH — fn_guard_gate_advance fires on every proposal status advance.
-- Applied in operator-supervised window. See rollback section at end of file.
-- Idempotent: CREATE OR REPLACE + DROP/ADD CONSTRAINT with IF EXISTS / IF NOT EXISTS.
-- Prerequisite: mig 299 applied (fn_guard_gate_advance + fn_apply_gate_advance present).

BEGIN;

-- ─── PREFLIGHT ────────────────────────────────────────────────────────────────

DO $$
DECLARE
    v_guard_present BOOLEAN;
    v_apply_present BOOLEAN;
    v_ledger_file   TEXT;
BEGIN
    -- 1. Canonical prerequisite: mig 299 must be applied (fn_guard_gate_advance present).
    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'roadmap_proposal'
           AND p.proname = 'fn_guard_gate_advance'
    ) INTO v_guard_present;

    IF NOT v_guard_present THEN
        RAISE EXCEPTION
            'PREFLIGHT FAIL: roadmap_proposal.fn_guard_gate_advance() missing. '
            'Apply mig 299 (p3929-drop-nonterminal-gate-bypass.sql) first.';
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'roadmap_proposal'
           AND p.proname = 'fn_apply_gate_advance'
    ) INTO v_apply_present;

    IF NOT v_apply_present THEN
        RAISE EXCEPTION
            'PREFLIGHT FAIL: roadmap_proposal.fn_apply_gate_advance() missing. '
            'Apply mig 299 first.';
    END IF;

    -- 2. Canonical ledger authority: check roadmap.schema_migration (P4664 canonical).
    --    migration_history / schema_migrations are NOT authoritative.
    --    Mig 299 (p3929) was applied ad-hoc and not ledgered; the last ledgered
    --    prerequisite is mig 298 (p3566-gate-advance-integrity-audit).
    SELECT filename INTO v_ledger_file
      FROM roadmap.schema_migration
     WHERE filename LIKE '298%'
     LIMIT 1;

    IF v_ledger_file IS NULL THEN
        RAISE EXCEPTION
            'PREFLIGHT FAIL: mig 298 not found in roadmap.schema_migration. '
            'The canonical ledger (roadmap.schema_migration) must record the prerequisite. '
            'Do not use migration_history or schema_migrations as authority (P4664/AC-6).';
    END IF;

    -- 3. Collision check: this file must not already be in the ledger.
    IF EXISTS (SELECT 1 FROM roadmap.schema_migration WHERE filename LIKE '319-p4663%') THEN
        RAISE NOTICE 'Mig 319-p4663 already in roadmap.schema_migration — idempotent no-op.';
        -- Don't abort; CREATE OR REPLACE is idempotent.
    END IF;
END;
$$;

-- ─── 1. Add DELIBERATION to proposal_status_canonical (AC-16) ─────────────────
-- DELIBERATION is the holding state for governance-amendment proposals during the
-- 48h mandatory deliberation window (P181/Art.VII§19).
-- Rollback: remove DELIBERATION iff no rows remain in that status.

DO $$
DECLARE
    v_current_def TEXT;
BEGIN
    SELECT pg_get_constraintdef(oid) INTO v_current_def
      FROM pg_constraint
     WHERE conrelid = 'roadmap_proposal.proposal'::regclass
       AND conname  = 'proposal_status_canonical';

    IF v_current_def IS NULL THEN
        RAISE WARNING 'proposal_status_canonical constraint not found; skipping DELIBERATION addition.';
        RETURN;
    END IF;

    IF v_current_def LIKE '%DELIBERATION%' THEN
        RAISE NOTICE 'DELIBERATION already in proposal_status_canonical — no-op.';
        RETURN;
    END IF;
END;
$$;

ALTER TABLE roadmap_proposal.proposal
    DROP CONSTRAINT IF EXISTS proposal_status_canonical;

ALTER TABLE roadmap_proposal.proposal
    ADD CONSTRAINT proposal_status_canonical CHECK (
        status = ANY (ARRAY[
            'Abandoned'::text, 'APPROVED'::text, 'CLOSED'::text,
            'Complete'::text,  'COMPLETE'::text,
            'DELIBERATION'::text,
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

-- ─── 1b. Seed DELIBERATION into roadmap.reference_terms (AC-16) ──────────────
-- fn_validate_proposal_reference_terms (live trigger) validates proposal.status
-- against this table. Must include DELIBERATION alongside the CHECK constraint.

INSERT INTO roadmap.reference_terms (term_category, term_value, description)
VALUES (
    'proposal_state', 'DELIBERATION',
    'Governance-amendment mandatory 48h deliberation holding state (P4663/P181/Art.VII§19)'
)
ON CONFLICT (term_category, term_value) DO NOTHING;

-- ─── 2. Canonical fn_guard_gate_advance (P4663 cumulative guard) ──────────────

CREATE OR REPLACE FUNCTION roadmap_proposal.fn_guard_gate_advance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_gate_key        TEXT;
    v_is_nonterminal  BOOLEAN;
    v_is_governance   BOOLEAN;
    v_has_decision    BOOLEAN;
    v_decider         TEXT;
    v_author          TEXT;
    v_ac_count        BIGINT;
    v_has_human       BOOLEAN;
BEGIN
    -- Only act on forward gated status changes.
    v_gate_key := UPPER(OLD.status) || E'→' || UPPER(NEW.status);

    IF v_gate_key NOT IN (
        -- Standard lifecycle gates
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DEVELOP→MERGE',
        E'MERGE→COMPLETE',
        -- Governance-amendment deliberation gates (P181/Art.VII§19)
        E'DRAFT→DELIBERATION',
        E'DELIBERATION→REVIEW'
    ) THEN
        RETURN NEW;
    END IF;

    -- P_noBypass: app.gate_bypass is NEVER consulted on any path.
    -- P906/mig264 proved this is safe: fn_apply_gate_advance's same-txn
    -- gate_decision_log INSERT is visible to the gate_decision_log lookup below.
    -- P3929/mig299 removed bypass from non-terminal gates; this migration removes
    -- it from terminal gates too, completing the P906 restoration. (AC-12)

    v_is_nonterminal := v_gate_key IN (
        E'DRAFT→REVIEW',
        E'REVIEW→DEVELOP',
        E'DRAFT→DELIBERATION',
        E'DELIBERATION→REVIEW'
    );

    v_is_governance := (NEW.type = 'governance-amendment');

    -- ── P_gov48h (non-terminal path): governance DELIBERATION→REVIEW refuses < 48h ──
    -- The 48h window is measured from state_changed_at (when the proposal entered
    -- DELIBERATION), not from proposal creation. (P181/Art.VII§19, AC-1)
    IF v_is_nonterminal AND v_is_governance AND UPPER(OLD.status) = 'DELIBERATION' THEN
        IF OLD.state_changed_at IS NOT NULL
           AND now() - OLD.state_changed_at < INTERVAL '48 hours' THEN
            RAISE EXCEPTION
                'governance-amendment: DELIBERATION→REVIEW refused — 48-hour deliberation '
                'period has not elapsed (entered DELIBERATION at %, now %). '
                'Wait until % before advancing. (P181/Art.VII§19/P4663-AC-1)',
                OLD.state_changed_at,
                now(),
                OLD.state_changed_at + INTERVAL '48 hours'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- ── P_log (non-terminal): gate_decision_log advance row required ──────────
    -- AC-3/P3566: fn_apply_gate_advance is the sole path that inserts this row and
    -- then updates proposal.status; same-txn visibility makes the bypass unnecessary.
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

        IF NOT v_has_decision THEN
            RAISE EXCEPTION
                'Non-terminal gate %→% on proposal % requires a gate_decision_log advance row. '
                'Direct status updates on gated edges are not permitted (P3566/P4663). '
                'Submit an independent review (proposal_reviews verdict=approve, reviewer != advancer), '
                'then call record_gate_decision(decision=advance). (P3566/AC-3/P4663)',
                OLD.status, NEW.status, NEW.id
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    END IF;

    -- ── Terminal gate section (DEVELOP→MERGE and MERGE→COMPLETE) ─────────────

    -- P_log (terminal): gate_decision_log OR proposal_reviews approve (kept for
    -- backward compatibility; P_termIndep below tightens who may be the decider).
    SELECT EXISTS (
        SELECT 1
        FROM roadmap_proposal.gate_decision_log gdl
        WHERE gdl.proposal_id = NEW.id
          AND UPPER(gdl.from_state) = UPPER(OLD.status)
          AND UPPER(gdl.to_state)   = UPPER(NEW.status)
          AND gdl.decision = 'advance'
          AND gdl.created_at >= now() - INTERVAL '10 minutes'
    ) INTO v_has_decision;

    IF NOT v_has_decision THEN
        SELECT EXISTS (
            SELECT 1
            FROM roadmap_proposal.proposal_reviews pr
            WHERE pr.proposal_id = NEW.id
              AND pr.verdict = 'approve'
              AND pr.reviewed_at >= now() - INTERVAL '10 minutes'
        ) INTO v_has_decision;
    END IF;

    IF NOT v_has_decision THEN
        RAISE EXCEPTION
            'Terminal gate %→% on proposal % requires authorization. '
            'Submit a gate_decision_log (decision=advance) or proposal_reviews (verdict=approve) '
            'within the last 10 minutes before advancing. (P3566/P4663)',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- ── P_termIndep: terminal builder/verifier/decider independence ───────────
    -- Resolve the decider identity from the most recent gate_decision_log advance row
    -- (same txn; fn_apply_gate_advance path). If not present, fall back to the most
    -- recent proposal_reviews approve (direct-review path).
    SELECT gdl.decided_by INTO v_decider
      FROM roadmap_proposal.gate_decision_log gdl
     WHERE gdl.proposal_id = NEW.id
       AND UPPER(gdl.from_state) = UPPER(OLD.status)
       AND UPPER(gdl.to_state)   = UPPER(NEW.status)
       AND gdl.decision = 'advance'
     ORDER BY gdl.created_at DESC
     LIMIT 1;

    IF v_decider IS NULL THEN
        SELECT pr.reviewer_identity INTO v_decider
          FROM roadmap_proposal.proposal_reviews pr
         WHERE pr.proposal_id = NEW.id
           AND pr.verdict = 'approve'
         ORDER BY pr.reviewed_at DESC
         LIMIT 1;
    END IF;

    -- Resolve the proposal author from audit JSONB (Activity='Created', Agent field).
    -- The audit column may be an array or a single object; handle both.
    SELECT elem->>'Agent' INTO v_author
      FROM jsonb_array_elements(
          CASE jsonb_typeof(NEW.audit)
              WHEN 'array'  THEN NEW.audit
              WHEN 'object' THEN jsonb_build_array(NEW.audit)
              ELSE '[]'::jsonb
          END
      ) AS elem
     WHERE (elem->>'Activity') = 'Created'
     LIMIT 1;

    -- Fallback: earliest proposal_discussions.author_identity (non-system, non-null).
    IF v_author IS NULL OR v_author LIKE 'system%' OR v_author = '' THEN
        SELECT pd.author_identity INTO v_author
          FROM roadmap_proposal.proposal_discussions pd
         WHERE pd.proposal_id = NEW.id
           AND pd.author_identity IS NOT NULL
           AND pd.author_identity NOT LIKE 'system%'
           AND pd.author_identity != ''
         ORDER BY pd.created_at ASC
         LIMIT 1;
    END IF;

    -- Fail-closed: if no concrete non-system author can be resolved, refuse the advance.
    -- (P4663/AC-13: unresolvable author → RAISE rather than silently pass)
    IF v_author IS NULL OR v_author LIKE 'system%' OR v_author = '' THEN
        RAISE EXCEPTION
            'Terminal gate %→% on proposal %: cannot resolve proposal author '
            '(no Created audit entry with non-system Agent, no non-system discussion author). '
            'Gate fails closed per P4663/Art.III§9/AC-13.',
            OLD.status, NEW.status, NEW.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- Decider == author is not permitted at terminal gates. (P181/Art.III§9, AC-4/AC-13)
    -- Note: independence is at identity granularity (fn_actor_is_independent equivalence);
    -- agency-level collapse is a known boundary, documented as a follow-up.
    IF v_decider IS NOT NULL AND v_decider = v_author THEN
        RAISE EXCEPTION
            'Terminal independence violation on proposal %: decider (%) is the proposal author. '
            'The terminal gate requires an independent decider (P181/Art.III§9/P4663/AC-4).',
            NEW.id, v_decider
            USING ERRCODE = 'check_violation';
    END IF;

    -- ── P_termAC: MERGE→COMPLETE refuses zero ACs or unwaived pending/fail/blocked ──
    -- (P3563/Art.VI§15, AC-3)
    IF UPPER(NEW.status) = 'COMPLETE' THEN
        SELECT COUNT(*) INTO v_ac_count
          FROM roadmap_proposal.proposal_acceptance_criteria pac
         WHERE pac.proposal_id = NEW.id;

        IF v_ac_count = 0 THEN
            RAISE EXCEPTION
                'MERGE→COMPLETE on proposal % refused: proposal has zero acceptance criteria. '
                'Non-vacuous completion requires at least one AC (P3563/Art.VI§15/P4663/AC-3).',
                NEW.id
                USING ERRCODE = 'check_violation';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM roadmap_proposal.proposal_acceptance_criteria pac
            WHERE pac.proposal_id = NEW.id
              AND pac.status IN ('pending', 'fail', 'blocked')
        ) THEN
            RAISE EXCEPTION
                'MERGE→COMPLETE on proposal % refused: unwaived pending/fail/blocked ACs exist. '
                'All ACs must reach pass or waived before COMPLETE (P3563/Art.VI§15/P4663/AC-3). '
                'Use verify_ac(status=waived) with justification for legitimate waivers.',
                NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- ── P_govHuman + P_gov48h (terminal path): governance-amendment extra checks ──
    IF v_is_governance THEN
        -- 48h deliberation: measured from proposal creation for terminal gates
        -- (the DELIBERATION→REVIEW non-terminal check above used state_changed_at).
        IF NEW.created_at IS NOT NULL
           AND now() - NEW.created_at < INTERVAL '48 hours' THEN
            RAISE EXCEPTION
                'governance-amendment: terminal gate %→% on proposal % refused — '
                '48-hour deliberation period not elapsed since proposal creation '
                '(created %, now %). (P181/Art.VII§19/P4663/AC-1)',
                OLD.status, NEW.status, NEW.id,
                NEW.created_at, now()
                USING ERRCODE = 'check_violation';
        END IF;

        -- Human-role decider required for MERGE→COMPLETE on governance-amendment.
        -- Human-role set: agent_type = 'human' (developer/human, reviewer/human per
        -- SELECT DISTINCT role, agent_type FROM roadmap_workforce.agent_registry on 2026-06-22).
        IF UPPER(NEW.status) = 'COMPLETE' THEN
            SELECT EXISTS (
                SELECT 1
                FROM roadmap_workforce.agent_registry ar
                WHERE ar.agent_identity = v_decider
                  AND ar.agent_type = 'human'
            ) INTO v_has_human;

            IF NOT v_has_human THEN
                RAISE EXCEPTION
                    'governance-amendment MERGE→COMPLETE on proposal % requires a human-role '
                    'decider (agent_type=''human'' in agent_registry). '
                    'Decider ''%'' does not qualify. (P181/Art.VII§19/P4663/AC-1/AC-14)',
                    NEW.id, COALESCE(v_decider, '<null>')
                    USING ERRCODE = 'check_violation';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_guard_gate_advance() IS
    'P4663 (canonical): Cumulative gate/governance/AC/independence guard. '
    'Constitution: doc-9/P179 Art.III§9 + Art.VI§15 + Art.VII§19. '
    'P_noBypass: app.gate_bypass removed from ALL paths (P906 fully restored). '
    'P_govEdges: DELIBERATION status; DRAFT→DELIBERATION + DELIBERATION→REVIEW guarded. '
    'P_gov48h: governance-amendment DELIBERATION→REVIEW refused < 48h elapsed. '
    'P_govHuman: governance-amendment MERGE→COMPLETE requires human-role decider. '
    'P_termIndep: terminal decider != proposal author (audit JSON; fail-closed). '
    'P_termAC: MERGE→COMPLETE refuses zero ACs or unwaived pending/fail/blocked. '
    'P_log: non-terminal requires gate_decision_log; terminal requires log or review approve. '
    'Non-terminal independence enforced in fn_apply_gate_advance (unchanged). '
    'Prior writers reconciled: mig 189/254/270/289/291/299 union with no omission.';

-- ─── 3. Ledger this migration (canonical: roadmap.schema_migration) ───────────
-- Checksum is sha256 of the INSTALLED function definition (pg_get_functiondef),
-- not the migration file bytes — this gives a stable, DB-verifiable proof of what
-- was actually installed. migration_history / schema_migrations NOT written. (AC-15)

INSERT INTO roadmap.schema_migration (filename, checksum, applied_at, applied_by)
VALUES (
    '319-p4663-cumulative-gate-governance-guard.sql',
    encode(sha256(pg_get_functiondef(
        'roadmap_proposal.fn_guard_gate_advance'::regproc
    )::bytea), 'hex'),
    now(),
    current_user
)
ON CONFLICT (filename) DO UPDATE
    SET checksum    = EXCLUDED.checksum,
        applied_at  = EXCLUDED.applied_at,
        applied_by  = EXCLUDED.applied_by;

COMMIT;

-- ─── ROLLBACK ARTIFACT ────────────────────────────────────────────────────────
-- Canonical rollback lives at:
--   scripts/migrations/rollback/319-p4663-cumulative-gate-governance-guard.rollback.sql
-- which captures the live fn_guard_gate_advance body at apply-time and restores it.
-- Manual reference steps (mirrored by that file):
--
--   1. Restore the prior fn_guard_gate_advance (mig 299 body — terminal app.gate_bypass
--      present, non-terminal independence preserved). The rollback file inlines that body.
--
--   2. Remove DELIBERATION from proposal_status_canonical (only if no rows in DELIBERATION):
--      DO $$
--      BEGIN
--          IF EXISTS (SELECT 1 FROM roadmap_proposal.proposal WHERE status = 'DELIBERATION') THEN
--              RAISE EXCEPTION 'Cannot remove DELIBERATION: rows exist in that status.';
--          END IF;
--          ALTER TABLE roadmap_proposal.proposal DROP CONSTRAINT proposal_status_canonical;
--          ALTER TABLE roadmap_proposal.proposal ADD CONSTRAINT proposal_status_canonical CHECK (
--              status = ANY (ARRAY['Abandoned','APPROVED','CLOSED','Complete','COMPLETE',
--                                  'DEPLOYED','Develop','DEVELOP','DISCARDED','DONE',
--                                  'Draft','DRAFT','ESCALATE','FIX','FIXING',
--                                  'Merge','MERGE','MERGED','NON_ISSUE','OPEN',
--                                  'Rejected','REJECTED','Replaced',
--                                  'Review','REVIEW','REVIEWING',
--                                  'TRIAGE','WONT_FIX'])
--          );
--      END;
--      $$;
--
--   3. Remove ledger entry:
--      DELETE FROM roadmap.schema_migration WHERE filename = '319-p4663-cumulative-gate-governance-guard.sql';
