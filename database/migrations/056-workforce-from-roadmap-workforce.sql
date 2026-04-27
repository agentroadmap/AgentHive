-- Migration 056: Populate workforce.* from roadmap_workforce.*
-- Proposal: P597
-- Prerequisites: database/ddl/hivecentral/007-workforce.sql applied first.
-- Idempotency: All inserts use ON CONFLICT DO NOTHING; safe to re-run.
-- Scope: Copies agent_registry + agent_capability rows into workforce.* tables.
--        roadmap_workforce.* tables are NOT dropped — they remain authoritative
--        for runtime claim/lease/workload tracking until P429 (multi-tenant DB) lands.
-- 2026-04-27

BEGIN;

-- ── Step 1: Import agents from roadmap_workforce.agent_registry ───────────────
-- Maps: agent_identity → agent_identity, name → display_name
-- agent_type defaults to 'ai' (registry has no type column)
-- status: active unless suspended/inactive flags exist in metadata

INSERT INTO workforce.agent (agent_identity, display_name, agent_type, status, metadata)
SELECT
    ar.agent_identity,
    ar.agent_identity                          AS display_name,
    'ai'::workforce.agent_type,
    COALESCE(ar.status, 'active')::workforce.agent_status AS status,
    jsonb_strip_nulls(jsonb_build_object(
        'preferred_model', ar.preferred_model,
        'legacy_skills',   ar.skills,
        'github_handle',   ar.github_handle
    ))                                         AS metadata
FROM roadmap_workforce.agent_registry ar
ON CONFLICT (agent_identity) DO NOTHING;

-- ── Step 2: Ensure skill catalog covers existing capability tokens ─────────────
-- roadmap_workforce.agent_capability stores free-text `capability` strings.
-- We normalise them into workforce.skill rows (slug = lower(capability)).

INSERT INTO workforce.skill (skill_name, display_name, category, lifecycle)
SELECT DISTINCT
    lower(regexp_replace(ac.capability, '[^a-zA-Z0-9]+', '-', 'g')) AS skill_name,
    ac.capability                                                     AS display_name,
    'engineering'                                                     AS category,
    'active'::workforce.skill_lifecycle
FROM roadmap_workforce.agent_capability ac
WHERE ac.capability IS NOT NULL
ON CONFLICT (skill_name) DO NOTHING;

-- ── Step 3: Populate capability matrix from roadmap_workforce.agent_capability ─
-- Proficiency mapping: roadmap_workforce uses integer 1–5; map to enum.
-- 1→basic, 2→basic, 3→intermediate, 4→advanced, 5→expert

INSERT INTO workforce.agent_skill (agent_id, skill_id, proficiency, granted_by, granted_at)
SELECT
    wa.id                                                        AS agent_id,
    ws.id                                                        AS skill_id,
    CASE
        WHEN ac.proficiency >= 5 THEN 'expert'
        WHEN ac.proficiency >= 4 THEN 'advanced'
        WHEN ac.proficiency >= 3 THEN 'intermediate'
        ELSE                          'basic'
    END::workforce.proficiency_level                             AS proficiency,
    'system'                                                     AS granted_by,
    COALESCE(ac.created_at, now())                               AS granted_at
FROM roadmap_workforce.agent_capability ac
JOIN roadmap_workforce.agent_registry   ar ON ar.id = ac.agent_id
JOIN workforce.agent                    wa ON wa.agent_identity = ar.agent_identity
JOIN workforce.skill                    ws
    ON ws.skill_name = lower(regexp_replace(ac.capability, '[^a-zA-Z0-9]+', '-', 'g'))
ON CONFLICT (agent_id, skill_id) DO NOTHING;

-- ── Step 4: Verification queries (run manually post-migration) ─────────────────
-- These are informational; they do not block the migration.
--
-- Count agents imported:
--   SELECT count(*) FROM workforce.agent;
--
-- Count skills imported:
--   SELECT count(*) FROM workforce.skill;
--
-- Count capability rows imported:
--   SELECT count(*) FROM workforce.agent_skill;
--
-- Verify no agent lost capabilities (delta check):
--   SELECT ar.agent_identity, count(ac.id) AS old_caps
--   FROM roadmap_workforce.agent_registry ar
--   LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
--   GROUP BY ar.agent_identity
--   EXCEPT
--   SELECT wa.agent_identity, count(ags.skill_id) AS new_caps
--   FROM workforce.agent wa
--   LEFT JOIN workforce.agent_skill ags ON ags.agent_id = wa.id
--   GROUP BY wa.agent_identity;

COMMIT;
