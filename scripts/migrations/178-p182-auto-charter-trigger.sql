-- P182 AC-9: Auto-charter trigger on squad_dispatch
-- Fires AFTER INSERT OR UPDATE OF dispatch_status to create a team:charter
-- in team_norms whenever a second active dispatch is posted to the same proposal.
-- This captures the DB-native implementation that was applied out-of-band.

SET search_path = roadmap_workforce, public;

-- Drop the stale version in roadmap_proposal schema (wrong schema, different naming)
DROP FUNCTION IF EXISTS roadmap_proposal.fn_auto_charter_team() CASCADE;

-- Create (or replace) the canonical trigger function in roadmap_workforce
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_auto_charter_team()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_team_id BIGINT;
    v_count   INT;
BEGIN
    -- Skip terminal dispatches
    IF NEW.dispatch_status IN ('cancelled', 'failed', 'completed') THEN
        RETURN NEW;
    END IF;

    -- Only fire when a second non-terminal agent is dispatched to the same proposal
    SELECT count(*) INTO v_count
    FROM roadmap_workforce.squad_dispatch
    WHERE proposal_id = NEW.proposal_id
      AND dispatch_status NOT IN ('cancelled', 'failed', 'completed');

    IF v_count < 2 THEN
        RETURN NEW;
    END IF;

    -- Find or create a team for this proposal
    SELECT id INTO v_team_id
    FROM roadmap_workforce.team
    WHERE team_name = 'team:proposal-' || NEW.proposal_id::text
    LIMIT 1;

    IF v_team_id IS NULL THEN
        INSERT INTO roadmap_workforce.team (team_name, team_type, status)
        VALUES ('team:proposal-' || NEW.proposal_id::text, 'proposal', 'active')
        RETURNING id INTO v_team_id;
    END IF;

    -- Charter (idempotent — ON CONFLICT DO NOTHING so repeated fires are safe)
    INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
    VALUES (v_team_id, 'team:charter', jsonb_build_object(
        'team_name',        'team:proposal-' || NEW.proposal_id::text,
        'proposal_ids',     ARRAY[NEW.proposal_id::text],
        'created_by',       'auto:squad_dispatch',
        'created_at',       now()::text,
        'governance_layer', 'team',
        'auto_generated',   true
    ), 'system')
    ON CONFLICT (team_id, norm_key) DO NOTHING;

    -- Default governance norms (all idempotent)
    INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
    VALUES
        (v_team_id, 'team:norm:handoff',
         '{"rule":"Leave context summary in team memory before releasing lease","key":"team:handoff"}'::jsonb,
         'system'),
        (v_team_id, 'team:norm:communication',
         '{"rule":"Use team: prefix in proposal_discussions for intra-team matters","key":"team:communication"}'::jsonb,
         'system'),
        (v_team_id, 'team:norm:challenge',
         '{"rule":"Skeptic challenges go through team discussion before gate","key":"team:challenge"}'::jsonb,
         'system'),
        (v_team_id, 'team:norm:memory',
         '{"rule":"Design decisions in team memory; implementation notes in individual","key":"team:memory"}'::jsonb,
         'system'),
        (v_team_id, 'team:norm:worktree',
         '{"rule":"Coordinate via proposal_discussions before merging branches","key":"team:worktree"}'::jsonb,
         'system')
    ON CONFLICT (team_id, norm_key) DO NOTHING;

    RETURN NEW;
END;
$$;

-- Re-create the trigger (idempotent)
DROP TRIGGER IF EXISTS trg_auto_charter_on_dispatch ON roadmap_workforce.squad_dispatch;

CREATE TRIGGER trg_auto_charter_on_dispatch
    AFTER INSERT OR UPDATE OF dispatch_status
    ON roadmap_workforce.squad_dispatch
    FOR EACH ROW
    EXECUTE FUNCTION roadmap_workforce.fn_auto_charter_team();

-- Grant execute to the service role
GRANT EXECUTE ON FUNCTION roadmap_workforce.fn_auto_charter_team() TO andy;
