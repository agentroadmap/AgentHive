-- Migration 131: P182 — Charter backfill + default norms in auto-charter trigger
-- Fixes two gaps discovered on 2026-05-20:
--   1. Pre-trigger squads (17 proposals with 2+ active dispatches) have no team row or charter.
--   2. fn_auto_charter_team only seeds team:charter; default norms (handoff, communication,
--      challenge, memory, worktree) are not seeded automatically — only when the MCP tool is
--      called explicitly.
-- Proposal: P182

BEGIN;

-- ── 1. Seed default norms into fn_auto_charter_team ──────────────────────────
-- Drop and recreate the function so it also inserts the five default governance
-- norms at trigger time, matching what teamCharterCreate (MCP) does.
CREATE OR REPLACE FUNCTION fn_auto_charter_team()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_team_id     BIGINT;
    v_team_name   TEXT;
    v_prop_count  INT;
BEGIN
    -- Only act on non-terminal dispatches
    IF NEW.dispatch_status IN ('cancelled', 'failed', 'completed') THEN
        RETURN NEW;
    END IF;

    SELECT COUNT(*) INTO v_prop_count
    FROM roadmap_workforce.squad_dispatch
    WHERE proposal_id = NEW.proposal_id
      AND dispatch_status NOT IN ('cancelled', 'failed', 'completed');

    IF v_prop_count < 2 THEN
        RETURN NEW;
    END IF;

    v_team_name := 'team:P' || NEW.proposal_id::text;

    INSERT INTO roadmap_workforce.team (team_name, team_type, status)
    VALUES (v_team_name, 'proposal', 'active')
    ON CONFLICT (team_name) DO NOTHING;

    SELECT id INTO v_team_id
    FROM roadmap_workforce.team
    WHERE team_name = v_team_name;

    -- Charter (minimal auto record)
    INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
    VALUES (
        v_team_id,
        'team:charter',
        jsonb_build_object(
            'team_name',        v_team_name,
            'proposal_id',      NEW.proposal_id,
            'created_by',       'auto:squad_dispatch',
            'created_at',       now()::text,
            'governance_layer', 'team',
            'auto_generated',   true
        ),
        'system'
    )
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

-- ── 2. Backfill: create teams + charters for pre-trigger squads ───────────────
-- Targets proposals that have 2+ non-terminal dispatches but no team row yet.
DO $$
DECLARE
    r             RECORD;
    v_team_id     BIGINT;
    v_team_name   TEXT;
BEGIN
    FOR r IN
        SELECT proposal_id
        FROM roadmap_workforce.squad_dispatch
        WHERE dispatch_status NOT IN ('cancelled', 'failed', 'completed')
        GROUP BY proposal_id
        HAVING COUNT(*) >= 2
    LOOP
        v_team_name := 'team:P' || r.proposal_id::text;

        INSERT INTO roadmap_workforce.team (team_name, team_type, status)
        VALUES (v_team_name, 'proposal', 'active')
        ON CONFLICT (team_name) DO NOTHING;

        SELECT id INTO v_team_id
        FROM roadmap_workforce.team
        WHERE team_name = v_team_name;

        -- Charter
        INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
        VALUES (
            v_team_id,
            'team:charter',
            jsonb_build_object(
                'team_name',        v_team_name,
                'proposal_id',      r.proposal_id,
                'created_by',       'backfill:migration-131',
                'created_at',       now()::text,
                'governance_layer', 'team',
                'auto_generated',   true,
                'backfilled',       true
            ),
            'system'
        )
        ON CONFLICT (team_id, norm_key) DO NOTHING;

        -- Default norms
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

    END LOOP;
END;
$$;

-- ── 3. Also backfill default norms for existing teams that only have team:charter ─
-- (teams auto-created by the old trigger version without default norms)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT DISTINCT t.id AS team_id
        FROM roadmap_workforce.team t
        JOIN roadmap_workforce.team_norms tn ON tn.team_id = t.id AND tn.norm_key = 'team:charter'
        WHERE NOT EXISTS (
            SELECT 1 FROM roadmap_workforce.team_norms tn2
            WHERE tn2.team_id = t.id AND tn2.norm_key = 'team:norm:handoff'
        )
    LOOP
        INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
        VALUES
            (r.team_id, 'team:norm:handoff',
             '{"rule":"Leave context summary in team memory before releasing lease","key":"team:handoff"}'::jsonb,
             'system'),
            (r.team_id, 'team:norm:communication',
             '{"rule":"Use team: prefix in proposal_discussions for intra-team matters","key":"team:communication"}'::jsonb,
             'system'),
            (r.team_id, 'team:norm:challenge',
             '{"rule":"Skeptic challenges go through team discussion before gate","key":"team:challenge"}'::jsonb,
             'system'),
            (r.team_id, 'team:norm:memory',
             '{"rule":"Design decisions in team memory; implementation notes in individual","key":"team:memory"}'::jsonb,
             'system'),
            (r.team_id, 'team:norm:worktree',
             '{"rule":"Coordinate via proposal_discussions before merging branches","key":"team:worktree"}'::jsonb,
             'system')
        ON CONFLICT (team_id, norm_key) DO NOTHING;
    END LOOP;
END;
$$;

COMMIT;
