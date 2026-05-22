-- P932: idempotent backfill display_alias for existing NULL-alias slot-'a' worker rows

UPDATE roadmap_workforce.agent_registry ar
SET display_alias = (
  SELECT concat_ws('-',
    initcap(split_part(agency.agent_identity, '/', 1)),
    initcap(split_part(ar.agent_identity, '-', 2)),
    upper(split_part(ar.agent_identity, '-', 3))
  )
  FROM roadmap_workforce.agent_registry agency
  WHERE agency.id = ar.agency_id
)
WHERE ar.display_alias IS NULL
  AND ar.agent_identity ~ '^[a-z0-9]+-[a-z0-9]+-[a-z]+-a$'
  AND ar.status IN ('active', 'online')
  AND ar.agency_id IS NOT NULL;
