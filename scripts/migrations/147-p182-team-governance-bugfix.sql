-- Migration 147: P182 Team Governance — Bug Fixes
-- Fixes two issues found in post-delivery audit:
--   1. team.status constraint missing 'dissolved' (handler sets 'dissolved' after archive)
--   2. Auto-charter trigger: creates team + charter when 2+ agents dispatched to same proposal

BEGIN;

-- ── 1. Expand team status constraint to include dissolved/forming/dissolving ──
ALTER TABLE roadmap_workforce.team
    DROP CONSTRAINT team_status_check;

ALTER TABLE roadmap_workforce.team
    ADD CONSTRAINT team_status_check
    CHECK (status = ANY (ARRAY[
        'forming'::text,
        'active'::text,
        'dissolving'::text,
        'dissolved'::text,
        'archived'::text
    ]));

-- ── 2. Auto-charter function: fires after squad_dispatch INSERT/UPDATE ─────────
-- Creates a team row + team:charter norm when ≥2 agents are dispatched to
-- the same proposal, satisfying AC-1 and AC-6 (auto-charter within one lease cycle).
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_auto_charter_team()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_team_id     BIGINT;
    v_team_name   TEXT;
    v_prop_count  INT;
BEGIN
    -- Only act on active/assigned dispatches
    IF NEW.dispatch_status IN ('cancelled', 'failed', 'completed') THEN
        RETURN NEW;
    END IF;

    -- Count non-terminal dispatches for this proposal
    SELECT COUNT(*) INTO v_prop_count
    FROM roadmap_workforce.squad_dispatch
    WHERE proposal_id = NEW.proposal_id
      AND dispatch_status NOT IN ('cancelled', 'failed', 'completed');

    IF v_prop_count < 2 THEN
        RETURN NEW;
    END IF;

    v_team_name := 'team:P' || NEW.proposal_id::text;

    -- Upsert team row (idempotent)
    INSERT INTO roadmap_workforce.team (team_name, team_type, status)
    VALUES (v_team_name, 'proposal', 'active')
    ON CONFLICT (team_name) DO NOTHING;

    SELECT id INTO v_team_id
    FROM roadmap_workforce.team
    WHERE team_name = v_team_name;

    -- Insert charter if not already present
    INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
    VALUES (
        v_team_id,
        'team:charter',
        jsonb_build_object(
            'team_name',    v_team_name,
            'proposal_id',  NEW.proposal_id,
            'created_by',   'auto:squad_dispatch',
            'created_at',   now()::text,
            'governance_layer', 'team',
            'auto_generated',   true
        ),
        'system'
    )
    ON CONFLICT (team_id, norm_key) DO NOTHING;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_charter_on_dispatch
AFTER INSERT OR UPDATE OF dispatch_status
ON roadmap_workforce.squad_dispatch
FOR EACH ROW
EXECUTE FUNCTION roadmap_workforce.fn_auto_charter_team();

COMMIT;
