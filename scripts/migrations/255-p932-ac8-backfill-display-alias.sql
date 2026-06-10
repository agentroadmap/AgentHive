-- P932 AC-8: Backfill display_alias for slot-'a' workers
--
-- Populates display_alias on existing agent_registry rows that:
--   - Have display_alias IS NULL (not yet claimed)
--   - Match slot-'a' pattern (agent_identity ends in '-a')
--   - Have extractable provider name (preferred_provider, or simple name like 'claude'/'codex')
--   - Have expertise available (skills[0])
--
-- Conservative scope: Rows with route abbreviations (ccs46ant, cdgp5oai) are SKIPPED
-- because they require agency context to determine the provider name. These rows will
-- be populated when workers are registered via agencyRegisterHandler or workerRegisterHandler,
-- which have the proper provider context. Current run: ~1 row (antigravity-bot-gary-a).
--
-- The backfill is idempotent (safe to re-run):
--   - WHERE display_alias IS NULL guards against re-processing
--   - UPDATE...ON CONFLICT is not used; instead we safely compute and set the alias
--
-- Alias computation matches P932 AC-2/AC-3/AC-4/AC-5 logic:
--   - Provider: preferred_provider, OR extracted from simple identities (claude, codex, antigravity)
--   - Host: Hardcoded to 'Bot' (PascalCase, matches P932 AC-4 default)
--   - Expertise: skills[0] (human-readable capability name)
--   - Format: {Provider}-{Host}-{Expertise} (e.g., "Claude-Bot-Review", "Antigravity-Bot-Review")
--
-- Per AC-7: If claimDisplayAlias would return collision, the rows stay NULL
-- and a log entry is recorded. This migration sets the computed alias directly
-- without collision checking; the application layer (claimDisplayAlias) will
-- handle any unique-index violations during normal register operations.

BEGIN;

-- CTE: Extract provider and expertise for each slot-'a' row
-- Only process rows where we can reliably extract a provider name
WITH slot_a_candidates AS (
  SELECT
    id,
    agent_identity,
    preferred_provider,
    skills,
    -- Extract provider: prefer preferred_provider, fallback to simple name identities
    -- Route abbreviations (ccs46ant, cdgp5oai) are skipped; they require agency context
    COALESCE(
      NULLIF(preferred_provider, ''),
      -- Only extract from identities that look like simple names (no digits in first segment)
      CASE
        WHEN agent_identity ~ '/' THEN split_part(agent_identity, '/', 1)
        WHEN split_part(agent_identity, '-', 1) ~ '^[a-z]+$' THEN split_part(agent_identity, '-', 1)
        ELSE NULL
      END
    ) AS provider,
    -- Extract expertise from skills[0] if available
    CASE
      WHEN skills IS NOT NULL AND jsonb_array_length(skills) > 0
        THEN skills ->> 0
      ELSE NULL
    END AS expertise_from_skills,
    -- Extract expertise code from identity (middle segments between route and slot)
    -- E.g., "ccs46ant-bot-docum-a" → "docum" (but these rows won't have provider set, so skipped)
    CASE
      WHEN agent_identity ~ '^[a-z0-9]+-[a-z]+-[a-z]+-a$'
        THEN substring(agent_identity, '([a-z]+)-a$')
      ELSE NULL
    END AS expertise_from_identity
  FROM roadmap_workforce.agent_registry
  WHERE display_alias IS NULL
    AND agent_identity ~ '-a$'
),

-- CTE: Normalize providers and build display aliases
with_aliases AS (
  SELECT
    id,
    agent_identity,
    provider,
    -- Normalize provider to PascalCase (e.g., "claude" → "Claude", "codex" → "Codex")
    CONCAT(
      UPPER(SUBSTRING(provider, 1, 1)),
      LOWER(SUBSTRING(provider, 2))
    ) AS provider_pascal,
    -- Use expertise from skills first, then from identity
    COALESCE(expertise_from_skills, expertise_from_identity) AS expertise,
    -- Normalize host to PascalCase (default "Bot" per P932 AC-4)
    'Bot' AS host_pascal
  FROM slot_a_candidates
  WHERE provider IS NOT NULL
    AND COALESCE(expertise_from_skills, expertise_from_identity) IS NOT NULL
),

-- CTE: Build final aliases in format "{Provider}-{Host}-{Expertise}"
final_aliases AS (
  SELECT
    id,
    agent_identity,
    CONCAT(provider_pascal, '-', host_pascal, '-',
           -- Title-case the expertise (capitalize first letter, keep rest as-is for now)
           CONCAT(
             UPPER(SUBSTRING(expertise, 1, 1)),
             LOWER(SUBSTRING(expertise, 2))
           )
    ) AS computed_alias
  FROM with_aliases
)

UPDATE roadmap_workforce.agent_registry ar
SET
  display_alias = fa.computed_alias,
  alias_audit = COALESCE(alias_audit, '[]'::jsonb) ||
    jsonb_build_array(
      jsonb_build_object(
        'action', 'backfilled',
        'tier', 2,
        'alias', fa.computed_alias,
        'at', now()::text
      )
    ),
  updated_at = now()
FROM final_aliases fa
WHERE ar.id = fa.id;

COMMIT;
