-- P932: Backfill display_alias for worker rows registered before the fix landed.
--
-- These 7 rows were created by fn_register_worker (pure SQL), which cannot call
-- TypeScript-side claimDisplayAlias. The backfill derives a best-effort alias
-- from the identity segments and the owning agency's preferred_provider.
--
-- Shape of a worker identity: {routeAbbr}-{host}-{expertise}-{slot}
--   e.g. "ccs46ant-bot-archi-a"  →  provider from agency row, host="bot", exp="archi"
--
-- The preferred approach after this one-time fix is to re-run worker_register
-- via MCP (which now calls claimDisplayAlias), but this migration ensures the
-- 7 pre-existing rows get a human-readable alias immediately.

UPDATE roadmap_workforce.agent_registry ar
SET
  display_alias = (
    SELECT
      concat_ws('-',
        initcap(
          COALESCE(
            ag.preferred_provider,
            split_part(ag.agent_identity, '/', 1)
          )
        ),
        initcap(split_part(ar.agent_identity, '-', 2)),
        initcap(split_part(ar.agent_identity, '-', 3))
      )
    FROM roadmap_workforce.agent_registry ag
    WHERE ag.id = ar.agency_id
  ),
  alias_audit = COALESCE(alias_audit, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'action', 'claimed',
      'tier', 2,
      'alias', (
        SELECT
          concat_ws('-',
            initcap(
              COALESCE(
                ag.preferred_provider,
                split_part(ag.agent_identity, '/', 1)
              )
            ),
            initcap(split_part(ar.agent_identity, '-', 2)),
            initcap(split_part(ar.agent_identity, '-', 3))
          )
        FROM roadmap_workforce.agent_registry ag
        WHERE ag.id = ar.agency_id
      ),
      'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'note', 'p932-backfill'
    )
  )
WHERE ar.display_alias IS NULL
  AND ar.agent_identity ~ '^[a-z0-9]+-[a-z0-9]+-[a-z]+-a$'
  AND ar.status = 'active'
  AND ar.agency_id IS NOT NULL;
