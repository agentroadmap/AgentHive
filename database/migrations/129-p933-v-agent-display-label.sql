-- P933: DB-driven host-strip view for live feed alias rendering
-- Centralises the CASE expression so live-feed.ts, state-feed.sh, and any
-- future consumers all get the same label without duplicating the SQL.
--
-- The 3-part alias pattern is "{Provider}-{Host}-{Role}".
-- When the middle segment matches a known host in roadmap.agency, it is
-- stripped, yielding "{Provider}-{Role}" as the display_label.

CREATE OR REPLACE VIEW roadmap_workforce.v_agent_display_label AS
SELECT
    ar.agent_identity,
    ar.display_alias,
    COALESCE(
        CASE
            WHEN ar.display_alias IS NULL THEN NULL
            WHEN array_length(string_to_array(ar.display_alias, '-'), 1) = 3
             AND lower(split_part(ar.display_alias, '-', 2))
                 IN (SELECT lower(host_id) FROM roadmap.agency WHERE host_id IS NOT NULL)
              THEN split_part(ar.display_alias, '-', 1) || '-' || split_part(ar.display_alias, '-', 3)
            ELSE ar.display_alias
        END,
        ar.agent_identity
    ) AS display_label
FROM roadmap_workforce.agent_registry ar;
