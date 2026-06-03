-- P933: live feed alias rendering — SQL VIEW for DB-driven host strip
--
-- Creates v_agent_display_label: encapsulates host-strip CASE expression.
-- Middle segment is stripped ONLY when it matches a host_id in roadmap.agency
-- (case-insensitive). No hardcoded host list — adding a host to agency.host_id
-- automatically affects all consumers of this view.
--
-- AC-1: no LEFT JOIN...ON true pattern; host lookup is an IN-subquery in CASE.

BEGIN;

CREATE OR REPLACE VIEW roadmap_workforce.v_agent_display_label AS
SELECT
    ar.id,
    ar.agent_identity,
    ar.display_alias,
    COALESCE(
        CASE
            WHEN ar.display_alias IS NULL THEN NULL
            WHEN array_length(string_to_array(ar.display_alias, '-'), 1) = 3
             AND lower(split_part(ar.display_alias, '-', 2)) IN (
                 SELECT lower(host_id)
                 FROM roadmap.agency
                 WHERE host_id IS NOT NULL
             )
                THEN split_part(ar.display_alias, '-', 1) || '-' || split_part(ar.display_alias, '-', 3)
            ELSE ar.display_alias
        END,
        ar.agent_identity
    ) AS display_label
FROM roadmap_workforce.agent_registry ar;

-- Grant read access to agenthive application role
GRANT SELECT ON roadmap_workforce.v_agent_display_label TO agenthive;

COMMIT;
