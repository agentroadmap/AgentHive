/**
 * P1099: Identity homograph defence — canonical identity normalization.
 *
 * AC-10: Database schema alignment.
 * Creates fn_canonicalize_identity() Postgres function and adds CHECK constraints
 * to agent_registry(agent_identity) to enforce canonical slash-shapes at the DB level.
 *
 * Acceptance Criteria:
 * - fn_canonicalize_identity() Postgres function created (idempotent, collision-aware)
 * - CHECK constraint on agent_registry(agent_identity) ensures only canonical forms stored
 * - Migration includes collision audit before applying constraints
 * - Stored values across message_ledger, room_membership, listener_subscription are canonical
 */

-- Create fn_canonicalize_identity Postgres function.
-- This function mirrors the TypeScript implementation and can be used in CHECK constraints
-- and triggers to enforce canonical identities at the database layer.
CREATE OR REPLACE FUNCTION roadmap.fn_canonicalize_identity(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  trimmed text;
  collapsed text;
  lowercased text;
BEGIN
  -- Rule 1: Trim leading/trailing whitespace
  trimmed := trim(raw);

  -- Rule 2 & 3: Collapse multiple consecutive slashes, remove trailing slashes
  collapsed := rtrim(regexp_replace(trimmed, '/+', '/', 'g'), '/');

  -- Rule 4: Convert to lowercase
  lowercased := lower(collapsed);

  -- Rule 5: Validation
  -- Empty string after collapse
  IF lowercased = '' THEN
    RAISE EXCEPTION 'identity_empty';
  END IF;

  -- Starts with slash
  IF lowercased LIKE '/%' THEN
    RAISE EXCEPTION 'identity_starts_with_slash';
  END IF;

  -- Contains spaces
  IF lowercased LIKE '% %' THEN
    RAISE EXCEPTION 'identity_contains_spaces';
  END IF;

  RETURN lowercased;
END;
$$;

-- AC-5: Collision audit before migration.
-- This query verifies that no two distinct raw identity values canonicalize to the same canonical form.
-- If a collision is detected, the migration will be halted (manual intervention required).
-- Audit covers: agent_registry, message_ledger (from_agent, to_agent), room_membership, listener_subscription.
DO $$
DECLARE
  collision_count int;
BEGIN
  -- Check for collisions in agent_registry
  SELECT COUNT(*) INTO collision_count FROM (
    SELECT
      roadmap.fn_canonicalize_identity(agent_identity) AS canonical,
      COUNT(DISTINCT agent_identity) AS variant_count
    FROM roadmap_workforce.agent_registry
    GROUP BY canonical
    HAVING COUNT(DISTINCT agent_identity) > 1
  ) AS collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Identity collision detected in agent_registry: % collision groups found. Manual review required before proceeding.', collision_count;
  END IF;

  -- Check for collisions in message_ledger (from_agent)
  SELECT COUNT(*) INTO collision_count FROM (
    SELECT
      roadmap.fn_canonicalize_identity(from_agent) AS canonical,
      COUNT(DISTINCT from_agent) AS variant_count
    FROM roadmap.message_ledger
    WHERE from_agent IS NOT NULL
    GROUP BY canonical
    HAVING COUNT(DISTINCT from_agent) > 1
  ) AS collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Identity collision detected in message_ledger.from_agent: % collision groups found. Manual review required before proceeding.', collision_count;
  END IF;

  -- Check for collisions in message_ledger (to_agent)
  SELECT COUNT(*) INTO collision_count FROM (
    SELECT
      roadmap.fn_canonicalize_identity(to_agent) AS canonical,
      COUNT(DISTINCT to_agent) AS variant_count
    FROM roadmap.message_ledger
    WHERE to_agent IS NOT NULL
    GROUP BY canonical
    HAVING COUNT(DISTINCT to_agent) > 1
  ) AS collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Identity collision detected in message_ledger.to_agent: % collision groups found. Manual review required before proceeding.', collision_count;
  END IF;

  -- Check for collisions in room_membership (agent_identity)
  SELECT COUNT(*) INTO collision_count FROM (
    SELECT
      roadmap.fn_canonicalize_identity(agent_identity) AS canonical,
      COUNT(DISTINCT agent_identity) AS variant_count
    FROM roadmap.room_membership
    WHERE agent_identity IS NOT NULL
    GROUP BY canonical
    HAVING COUNT(DISTINCT agent_identity) > 1
  ) AS collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Identity collision detected in room_membership.agent_identity: % collision groups found. Manual review required before proceeding.', collision_count;
  END IF;

  -- Check for collisions in listener_subscription (from_agent)
  SELECT COUNT(*) INTO collision_count FROM (
    SELECT
      roadmap.fn_canonicalize_identity(from_agent) AS canonical,
      COUNT(DISTINCT from_agent) AS variant_count
    FROM roadmap.listener_subscription
    WHERE from_agent IS NOT NULL
    GROUP BY canonical
    HAVING COUNT(DISTINCT from_agent) > 1
  ) AS collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Identity collision detected in listener_subscription.from_agent: % collision groups found. Manual review required before proceeding.', collision_count;
  END IF;

  RAISE NOTICE 'P1099 collision audit: no collisions detected. Safe to proceed with canonicalization.';
END $$;

-- AC-10: Add CHECK constraint to agent_registry(agent_identity).
-- Ensures only canonical identities can be inserted or updated.
-- This prevents homograph attacks at the database layer.
ALTER TABLE roadmap_workforce.agent_registry
ADD CONSTRAINT ck_agent_identity_canonical
CHECK (agent_identity = roadmap.fn_canonicalize_identity(agent_identity));

-- Record migration in history
INSERT INTO roadmap.migration_history (migration_file, status, error_detail)
VALUES ('154-p1099-identity-canonicalization.sql', 'applied', NULL)
ON CONFLICT (migration_file) DO NOTHING;
