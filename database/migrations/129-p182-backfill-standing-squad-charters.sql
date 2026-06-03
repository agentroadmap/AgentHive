-- Migration 129: Backfill charters for standing squads (P182)
-- These 7 core standing squads were created before the P182 charter trigger existed.
-- Seeds team:charter + 5 default governance norms for each so AC-6 passes.
-- P182: Team Governance Layer (Ostrom Principle 8)
-- 2026-05-20

BEGIN;

-- ── 1. Ensure auto-charter trigger function seeds all 5 default norms ─────────
-- (Re-)create the trigger function so future squad dispatches get all defaults.
CREATE OR REPLACE FUNCTION roadmap_workforce.fn_auto_charter_team()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_team_id BIGINT;
    v_count   INT;
BEGIN
    -- Only fire when a second agent is dispatched to the same proposal
    SELECT count(*) INTO v_count
    FROM roadmap_workforce.squad_dispatch
    WHERE proposal_id = NEW.proposal_id;

    IF v_count < 2 THEN
        RETURN NEW;
    END IF;

    -- Find or create a team for this proposal cluster
    SELECT id INTO v_team_id
    FROM roadmap_workforce.team
    WHERE team_name = 'team:proposal-' || NEW.proposal_id::text
    LIMIT 1;

    IF v_team_id IS NULL THEN
        INSERT INTO roadmap_workforce.team (team_name, team_type, status)
        VALUES ('team:proposal-' || NEW.proposal_id::text, 'proposal', 'active')
        RETURNING id INTO v_team_id;
    END IF;

    -- Charter (idempotent upsert)
    INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
    VALUES (v_team_id, 'team:charter', jsonb_build_object(
        'team_name',     'team:proposal-' || NEW.proposal_id::text,
        'proposal_ids',  ARRAY[NEW.proposal_id::text],
        'created_by',    'orchestrator',
        'created_at',    now()::text,
        'governance_layer', 'team'
    ), 'orchestrator')
    ON CONFLICT (team_id, norm_key) DO NOTHING;

    -- Default governance norms
    INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
    VALUES
        (v_team_id, 'team:norm:handoff',       '{"rule":"Leave context summary in team memory before releasing lease"}'::jsonb, 'orchestrator'),
        (v_team_id, 'team:norm:communication', '{"rule":"Use team: prefix in proposal_discussions for intra-team matters"}'::jsonb, 'orchestrator'),
        (v_team_id, 'team:norm:challenge',     '{"rule":"Skeptic challenges go through team discussion before gate"}'::jsonb, 'orchestrator'),
        (v_team_id, 'team:norm:memory',        '{"rule":"Design decisions in team memory; implementation notes in individual"}'::jsonb, 'orchestrator'),
        (v_team_id, 'team:norm:worktree',      '{"rule":"Coordinate via proposal_discussions before merging branches"}'::jsonb, 'orchestrator')
    ON CONFLICT (team_id, norm_key) DO NOTHING;

    RETURN NEW;
END;
$$;

-- ── 2. Backfill charters for the 7 standing squads created before P182 ────────
-- These are the core permanent squads seeded at platform bootstrap.
DO $$
DECLARE
    r   RECORD;
    def_norms JSONB[] := ARRAY[
        jsonb_build_object('key','team:norm:handoff',       'val','{"rule":"Leave context summary in team memory before releasing lease"}'::jsonb),
        jsonb_build_object('key','team:norm:communication', 'val','{"rule":"Use team: prefix in proposal_discussions for intra-team matters"}'::jsonb),
        jsonb_build_object('key','team:norm:challenge',     'val','{"rule":"Skeptic challenges go through team discussion before gate"}'::jsonb),
        jsonb_build_object('key','team:norm:memory',        'val','{"rule":"Design decisions in team memory; implementation notes in individual"}'::jsonb),
        jsonb_build_object('key','team:norm:worktree',      'val','{"rule":"Coordinate via proposal_discussions before merging branches"}'::jsonb)
    ];
    n   JSONB;
BEGIN
    FOR r IN
        SELECT t.id, t.team_name
        FROM roadmap_workforce.team t
        WHERE t.status = 'active'
          AND NOT EXISTS (
              SELECT 1 FROM roadmap_workforce.team_norms tn
              WHERE tn.team_id = t.id AND tn.norm_key = 'team:charter'
          )
    LOOP
        -- Charter
        INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
        VALUES (r.id, 'team:charter', jsonb_build_object(
            'team_name',         r.team_name,
            'created_by',        'migration-129',
            'created_at',        now()::text,
            'governance_layer',  'team',
            'backfilled',        true
        ), 'migration-129')
        ON CONFLICT (team_id, norm_key) DO NOTHING;

        -- Default norms
        FOREACH n IN ARRAY def_norms LOOP
            INSERT INTO roadmap_workforce.team_norms (team_id, norm_key, norm_value, set_by)
            VALUES (r.id, n->>'key', (n->>'val')::jsonb, 'migration-129')
            ON CONFLICT (team_id, norm_key) DO NOTHING;
        END LOOP;

        RAISE NOTICE 'Backfilled charter for team % (id=%)', r.team_name, r.id;
    END LOOP;
END;
$$;

COMMIT;
