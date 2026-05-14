-- P933: v_agent_display_label — DB-driven host-strip view
-- Encapsulates the host-strip CASE so consumers avoid inline repetition.
-- Host list is read from roadmap.agency.host_id (never hardcoded).
-- NOTE: COALESCE returns agent_identity when display_alias IS NULL so
--       callers with NULL-alias agents get a safe fallback automatically.

CREATE OR REPLACE VIEW roadmap_workforce.v_agent_display_label AS
SELECT
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
                THEN split_part(ar.display_alias, '-', 1)
                  || '-'
                  || split_part(ar.display_alias, '-', 3)
            ELSE ar.display_alias
        END,
        ar.agent_identity
    ) AS display_label
FROM roadmap_workforce.agent_registry ar;

COMMENT ON VIEW roadmap_workforce.v_agent_display_label IS
    'Compact display label for each registered agent. '
    'Strips the middle host segment from 3-part aliases (e.g. Claude-Bot-Documenter → Claude-Documenter) '
    'using the live host list in roadmap.agency.host_id. '
    'Falls back to agent_identity when display_alias is NULL.';
