-- P932: best-effort backfill of display_alias for slot-'a' worker rows
-- that registered before the claimDisplayAlias wiring landed in
-- workerRegisterHandler.
--
-- Derivation:
--   provider  → agency.preferred_provider (human-friendly), or first '/' segment
--               of agency.agent_identity as fallback, then INITCAP
--   host      → second '-' segment of the worker identity (e.g. "bot"), INITCAP
--   expertise → third '-' segment of the worker identity (the encoded form,
--               e.g. "arch", "ts", "docum"), INITCAP
--
-- Result: "Claude-Bot-Arch", "Codex-Bot-Ts", etc.
-- These are best-effort labels. Re-running worker_register with skills via
-- the MCP will replace them with properly-titled aliases ("Architecture",
-- "Typescript") once the live wiring is active.
--
-- Safety: WHERE guard ensures only NULL-alias, active, slot-'a' workers
-- with a valid 4-segment identity are touched.

BEGIN;

UPDATE roadmap_workforce.agent_registry ar
SET
    display_alias = concat_ws(
        '-',
        initcap(
            COALESCE(
                NULLIF(trim(agency.preferred_provider), ''),
                split_part(agency.agent_identity, '/', 1)
            )
        ),
        initcap(split_part(ar.agent_identity, '-', 2)),
        initcap(split_part(ar.agent_identity, '-', 3))
    ),
    alias_audit = COALESCE(alias_audit, '[]'::jsonb) || jsonb_build_array(
        jsonb_build_object(
            'action', 'claimed',
            'tier',   2,
            'alias',  concat_ws(
                '-',
                initcap(COALESCE(NULLIF(trim(agency.preferred_provider), ''), split_part(agency.agent_identity, '/', 1))),
                initcap(split_part(ar.agent_identity, '-', 2)),
                initcap(split_part(ar.agent_identity, '-', 3))
            ),
            'at',     to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'note',   'p932-backfill'
        )
    )
FROM roadmap_workforce.agent_registry agency
WHERE agency.id = ar.agency_id
  AND ar.display_alias IS NULL
  AND ar.status = 'active'
  AND ar.agent_identity ~ '^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-a$';

COMMIT;
