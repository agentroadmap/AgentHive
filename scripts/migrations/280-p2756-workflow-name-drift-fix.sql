-- P2756: Fix workflow_name write-side drift — single-source the creation path
--
-- Root cause: roadmap_proposal.proposal.workflow_name has DEFAULT 'Standard RFC'::text,
-- so new proposals of any type (architecture, hotfix, etc.) are permanently stored with
-- workflow_name='Standard RFC' unless the caller explicitly sets it. The AFTER INSERT
-- trigger trg_spawn_workflow correctly seeds roadmap.workflows.template_id from
-- proposal_type_config[type].workflow_name — but proposal.workflow_name stays wrong.
--
-- Fix (AC-1/AC-5): BEFORE INSERT trigger fn_set_proposal_workflow_name sets
-- NEW.workflow_name from proposal_type_config[NEW.type].workflow_name before the row
-- is committed, eliminating the dual-source. The DEFAULT is dropped (AC-2) so there
-- is no fallback path that can silently reintroduce the old value.
--
-- Reconcile (AC-8): UPDATE non-terminal drifted proposals to fix proposal.workflow_name
-- to match the type-derived value. workflows.template_id is already correct (the trigger
-- always ran right); only proposal.workflow_name needed fixing.

-- ── 1. BEFORE INSERT trigger function ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION roadmap_proposal.fn_set_proposal_workflow_name()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_workflow_name text;
BEGIN
    SELECT ptc.workflow_name
    INTO v_workflow_name
    FROM roadmap_proposal.proposal_type_config ptc
    WHERE ptc.type = NEW.type;

    IF v_workflow_name IS NOT NULL THEN
        NEW.workflow_name := v_workflow_name;
    END IF;

    RETURN NEW;
END;
$$;

-- ── 2. BEFORE INSERT trigger (fires before the row is stored) ──────────────────
-- Name does not conflict with existing trg_spawn_workflow (AFTER INSERT).
DROP TRIGGER IF EXISTS trg_set_proposal_workflow_name ON roadmap_proposal.proposal;
CREATE TRIGGER trg_set_proposal_workflow_name
BEFORE INSERT ON roadmap_proposal.proposal
FOR EACH ROW EXECUTE FUNCTION roadmap_proposal.fn_set_proposal_workflow_name();

-- ── 3. Drop the hardcoded DEFAULT that caused drift ────────────────────────────
ALTER TABLE roadmap_proposal.proposal
    ALTER COLUMN workflow_name DROP DEFAULT;

-- ── 4. Reconcile all drifted rows (AC-4 hygiene + AC-8 non-terminal) ──────────
-- Two-pass reconcile: fix proposal.workflow_name first, then workflows.template_id.
-- Excludes P3326-arch-*/P3326-test-* test fixtures (per AC-7 guard requirement).
--
-- Pass A: proposal.workflow_name → type-derived value from proposal_type_config.
DO $$
DECLARE
    v_count int;
BEGIN
    UPDATE roadmap_proposal.proposal p
    SET    workflow_name = ptc.workflow_name
    FROM   roadmap_proposal.proposal_type_config ptc
    WHERE  ptc.type = p.type
      AND  p.workflow_name IS DISTINCT FROM ptc.workflow_name
      AND  p.display_id NOT LIKE 'P3326-%';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'P2756 reconcile pass-A: fixed proposal.workflow_name on % rows', v_count;
END;
$$;

-- Pass B: workflows.template_id → id matching ptc.workflow_name for each type.
-- Required for proposals created before proposal_type_config mapping was updated
-- (e.g. architecture proposals created when 'architecture' still mapped to Standard RFC).
DO $$
DECLARE
    v_count int;
BEGIN
    UPDATE roadmap.workflows w
    SET    template_id = wt_correct.id
    FROM   roadmap_proposal.proposal p
    JOIN   roadmap_proposal.proposal_type_config ptc ON ptc.type = p.type
    JOIN   roadmap.workflow_templates wt_correct ON wt_correct.name = ptc.workflow_name
    WHERE  w.proposal_id = p.id
      AND  w.template_id IS DISTINCT FROM wt_correct.id
      AND  p.display_id NOT LIKE 'P3326-%';

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'P2756 reconcile pass-B: fixed workflows.template_id on % rows', v_count;
END;
$$;
