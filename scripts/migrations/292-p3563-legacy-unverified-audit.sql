-- 292-p3563-legacy-unverified-audit.sql
-- P3563 Step 4: Legacy verification-provenance audit.
--
-- FLAGS already-COMPLETE proposals that lack verified evidence as
-- 'legacy-unverified' for audit, WITHOUT reopening or altering their COMPLETE
-- status. This is read-only provenance: a view + a non-destructive flag column
-- on a dedicated audit table. It never touches proposal.status / maturity.
--
-- Motivation (MEMORY 2026-06-15): 80 COMPLETE proposals with ZERO ACs (vacuous
-- gate pass) and 192 COMPLETE with unverified ACs. P3563 enforcement (mig 291)
-- prevents NEW vacuous advances; this migration makes the EXISTING legacy debt
-- visible and queryable for a supervised remediation pass — without rewriting
-- history.
--
-- "legacy-unverified" classification (a COMPLETE proposal is flagged if ANY):
--   class_no_ac        : zero acceptance criteria.
--   class_unverified_ac: has ACs but at least one non-(pass|waived) AC, OR a
--                        'pass' AC with no evidence (details IS NULL AND
--                        verification_notes IS NULL/empty).
-- A COMPLETE proposal whose every AC is pass/waived WITH evidence is 'verified'.
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE VIEW, upsert refresh.
-- NON-DESTRUCTIVE: no UPDATE/DELETE on proposal or proposal_acceptance_criteria.

BEGIN;

-- ---------------------------------------------------------------------------
-- Provenance view: classify every COMPLETE proposal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap_proposal.v_legacy_verification_provenance AS
WITH ac_rollup AS (
    SELECT
        ac.proposal_id,
        count(*)                                                          AS ac_total,
        count(*) FILTER (WHERE ac.status NOT IN ('pass','waived'))        AS ac_not_done,
        count(*) FILTER (
            WHERE ac.status = 'pass'
              AND ac.details IS NULL
              AND (ac.verification_notes IS NULL OR trim(ac.verification_notes) = '')
        )                                                                 AS ac_pass_no_evidence
    FROM roadmap_proposal.proposal_acceptance_criteria ac
    GROUP BY ac.proposal_id
)
SELECT
    p.id                                            AS proposal_id,
    p.display_id,
    p.status,
    COALESCE(r.ac_total, 0)                         AS ac_total,
    COALESCE(r.ac_not_done, 0)                      AS ac_not_done,
    COALESCE(r.ac_pass_no_evidence, 0)              AS ac_pass_no_evidence,
    (COALESCE(r.ac_total,0) = 0)                    AS class_no_ac,
    (COALESCE(r.ac_total,0) > 0
        AND (COALESCE(r.ac_not_done,0) > 0
             OR COALESCE(r.ac_pass_no_evidence,0) > 0)) AS class_unverified_ac,
    CASE
        WHEN COALESCE(r.ac_total,0) = 0 THEN 'legacy-unverified'
        WHEN COALESCE(r.ac_not_done,0) > 0
          OR COALESCE(r.ac_pass_no_evidence,0) > 0 THEN 'legacy-unverified'
        ELSE 'verified'
    END                                             AS provenance_class
FROM roadmap_proposal.proposal p
LEFT JOIN ac_rollup r ON r.proposal_id = p.id
WHERE UPPER(p.status) = 'COMPLETE';

COMMENT ON VIEW roadmap_proposal.v_legacy_verification_provenance IS
  'P3563 Step 4: read-only verification provenance for COMPLETE proposals. '
  'provenance_class = legacy-unverified (zero ACs OR any non-pass/waived AC OR '
  'any evidence-less pass) | verified. Never alters proposal state.';

-- ---------------------------------------------------------------------------
-- Audit ledger table: a durable, idempotent snapshot of the flag so operators
-- can track remediation over time. The proposal's COMPLETE status is untouched.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roadmap_proposal.legacy_verification_audit (
    proposal_id        bigint PRIMARY KEY
                       REFERENCES roadmap_proposal.proposal(id) ON DELETE CASCADE,
    provenance_class   text NOT NULL,
    ac_total           int  NOT NULL DEFAULT 0,
    ac_not_done        int  NOT NULL DEFAULT 0,
    ac_pass_no_evidence int NOT NULL DEFAULT 0,
    flagged_at         timestamptz NOT NULL DEFAULT now(),
    refreshed_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_proposal.legacy_verification_audit IS
  'P3563 Step 4: durable snapshot of legacy-unverified COMPLETE proposals. '
  'Audit-only; the referenced proposals remain COMPLETE. Refresh via '
  'fn_refresh_legacy_verification_audit().';

-- ---------------------------------------------------------------------------
-- Idempotent refresh function: upsert the view into the audit table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_refresh_legacy_verification_audit()
RETURNS TABLE(total_complete bigint, legacy_unverified bigint, verified bigint)
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO roadmap_proposal.legacy_verification_audit
        (proposal_id, provenance_class, ac_total, ac_not_done, ac_pass_no_evidence, refreshed_at)
    SELECT v.proposal_id, v.provenance_class, v.ac_total, v.ac_not_done,
           v.ac_pass_no_evidence, now()
      FROM roadmap_proposal.v_legacy_verification_provenance v
    ON CONFLICT (proposal_id) DO UPDATE
       SET provenance_class    = EXCLUDED.provenance_class,
           ac_total            = EXCLUDED.ac_total,
           ac_not_done         = EXCLUDED.ac_not_done,
           ac_pass_no_evidence = EXCLUDED.ac_pass_no_evidence,
           refreshed_at        = now();

    RETURN QUERY
    SELECT count(*),
           count(*) FILTER (WHERE provenance_class = 'legacy-unverified'),
           count(*) FILTER (WHERE provenance_class = 'verified')
      FROM roadmap_proposal.legacy_verification_audit;
END;
$$;

COMMENT ON FUNCTION roadmap_proposal.fn_refresh_legacy_verification_audit() IS
  'P3563 Step 4: idempotent upsert of v_legacy_verification_provenance into '
  'legacy_verification_audit. Returns before/after-style rollup counts. '
  'Non-destructive — never alters proposal status.';

-- ---------------------------------------------------------------------------
-- POST-MIGRATION VERIFICATION
-- ---------------------------------------------------------------------------
DO $verify$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_views WHERE schemaname='roadmap_proposal'
                   AND viewname='v_legacy_verification_provenance') THEN
        RAISE EXCEPTION '[P3563-Step4] provenance view missing.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='roadmap_proposal'
                   AND table_name='legacy_verification_audit') THEN
        RAISE EXCEPTION '[P3563-Step4] audit table missing.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                   WHERE n.nspname='roadmap_proposal'
                   AND p.proname='fn_refresh_legacy_verification_audit') THEN
        RAISE EXCEPTION '[P3563-Step4] refresh function missing.';
    END IF;
    RAISE NOTICE '[P3563-Step4] All post-migration checks passed.';
END $verify$;

INSERT INTO roadmap.schema_migration (filename, checksum, applied_at)
VALUES ('292-p3563-legacy-unverified-audit.sql', 'p3563-legacy-audit-v1', now())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
