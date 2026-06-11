/**
 * P2323: Test Fixture Reaper
 *
 * AC-3: fn_reap_stale_test_fixtures_demote — demotes agent_registry/agency rows
 *       with NULL or stale heartbeat from 'active' to 'inactive'/'offline'.
 *
 * AC-4: fn_delete_test_fixture_rows — deletes pattern-matched test fixtures
 *       (test/%, a2a-xproc%, %-tx-%, %-test-ac3-%, %-econ-test-%, %mutex-test%,
 *        epoch-suffixed agency ids) older than a retention window.
 *
 * Both functions log their actions for forensic auditing.
 */

-- ────────────────────────────────────────────────────────────────────────────
-- AC-3: Demote agent_registry/agency rows with stale/NULL heartbeat
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_reap_stale_test_fixtures_demote(
  heartbeat_ttl INTERVAL DEFAULT '5 minutes'
)
RETURNS TABLE(
  demoted_count INTEGER,
  demoted_agent_identities TEXT[]
) LANGUAGE SQL SECURITY DEFINER AS $$
  WITH demote_candidates AS (
    -- agent_registry rows with NULL or stale last_seen_at
    SELECT ar.id, ar.agent_identity, 'agent_registry' AS table_name
    FROM roadmap_workforce.agent_registry ar
    WHERE ar.status = 'active'
      AND (ar.last_seen_at IS NULL OR (now() - ar.last_seen_at) > heartbeat_ttl)
      -- Only demote test fixtures (these must have heartbeat for real agents)
      AND (ar.agent_identity LIKE 'test/%'
        OR ar.agent_identity LIKE 'a2a-xproc%'
        OR ar.agent_identity LIKE '%-tx-%'
        OR ar.agent_identity LIKE '%-test-ac3-%'
        OR ar.agent_identity LIKE '%-econ-test-%'
        OR ar.agent_identity LIKE '%mutex-test%')

    UNION ALL

    -- agency rows with NULL or stale last_heartbeat_at
    SELECT ar.id, ar.agent_identity, 'agency' AS table_name
    FROM roadmap_workforce.agent_registry ar
    INNER JOIN roadmap.agency a ON a.agency_id = ar.agent_identity
    WHERE ar.status = 'active'
      AND (a.last_heartbeat_at IS NULL OR (now() - a.last_heartbeat_at) > heartbeat_ttl)
      -- Only demote test fixtures
      AND (ar.agent_identity LIKE 'test/%'
        OR ar.agent_identity LIKE 'a2a-xproc%'
        OR ar.agent_identity LIKE '%-tx-%'
        OR ar.agent_identity LIKE '%-test-ac3-%'
        OR ar.agent_identity LIKE '%-econ-test-%'
        OR ar.agent_identity LIKE '%mutex-test%')
  ),
  updated AS (
    UPDATE roadmap_workforce.agent_registry
    SET status = 'inactive', updated_at = now()
    WHERE id IN (SELECT id FROM demote_candidates)
    RETURNING agent_identity
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM updated) AS demoted_count,
    ARRAY_AGG(agent_identity) AS demoted_agent_identities
  FROM updated;
$$;

COMMENT ON FUNCTION roadmap_workforce.fn_reap_stale_test_fixtures_demote IS
  'P2323/AC-3: Demote stale test-fixture agent_registry rows from active→inactive';

-- ────────────────────────────────────────────────────────────────────────────
-- AC-4: Delete test fixture rows matching patterns
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION roadmap_workforce.fn_delete_test_fixture_rows(
  fixture_retention_age INTERVAL DEFAULT '1 hour'
)
RETURNS TABLE(
  deleted_count INTEGER,
  deleted_agent_identities TEXT[]
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_deleted_count INTEGER := 0;
  v_deleted_identities TEXT[] := '{}';
BEGIN
  -- Use advisory lock to prevent concurrent execution of this reaper
  PERFORM pg_advisory_lock(hashtext('fn_delete_test_fixture_rows'));

  BEGIN
    -- Collect fixture identities that match patterns and are older than retention age
    WITH fixture_candidates AS (
      SELECT ar.id, ar.agent_identity
      FROM roadmap_workforce.agent_registry ar
      WHERE (now() - ar.created_at) > fixture_retention_age
        AND (ar.agent_identity LIKE 'test/%'
          OR ar.agent_identity LIKE 'a2a-xproc%'
          OR ar.agent_identity LIKE '%-tx-%'
          OR ar.agent_identity LIKE '%-test-ac3-%'
          OR ar.agent_identity LIKE '%-econ-test-%'
          OR ar.agent_identity LIKE '%mutex-test%')
        -- Exclude if it has real usage/references
        AND ar.id NOT IN (
          SELECT DISTINCT id FROM (
            -- Rows referenced by proposal_lease (active contracts)
            SELECT DISTINCT ar2.id
            FROM roadmap_workforce.agent_registry ar2
            INNER JOIN roadmap_proposal.proposal_lease pl
              ON pl.agent_identity = ar2.agent_identity
            WHERE pl.released_at IS NULL

            UNION

            -- Rows referenced by message_ledger (active messages)
            SELECT DISTINCT ar2.id
            FROM roadmap_workforce.agent_registry ar2
            WHERE ar2.agent_identity IN (
              SELECT DISTINCT from_agent FROM roadmap.message_ledger
              WHERE created_at > (now() - interval '1 hour')
            )
            OR ar2.agent_identity IN (
              SELECT DISTINCT to_agent FROM roadmap.message_ledger
              WHERE created_at > (now() - interval '1 hour')
            )

            UNION

            -- Rows referenced by provider_registry (active providers)
            SELECT DISTINCT ar2.id
            FROM roadmap_workforce.agent_registry ar2
            INNER JOIN roadmap_workforce.provider_registry pr
              ON pr.agency_id = ar2.id
          ) referenced_rows
        )
    )
    DELETE FROM roadmap_workforce.agent_registry ar
    WHERE ar.id IN (SELECT id FROM fixture_candidates)
    RETURNING agent_identity INTO v_deleted_identities;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- Log the deletion for forensic auditing
    INSERT INTO roadmap_efficiency.reaper_audit_log (
      reaper_name,
      action,
      count,
      details,
      executed_at
    ) VALUES (
      'fn_delete_test_fixture_rows',
      'delete_test_fixtures',
      v_deleted_count,
      jsonb_build_object(
        'deleted_identities', v_deleted_identities,
        'retention_age_interval', fixture_retention_age::TEXT
      ),
      now()
    );

  EXCEPTION WHEN others THEN
    PERFORM pg_advisory_unlock(hashtext('fn_delete_test_fixture_rows'));
    RAISE;
  END;

  PERFORM pg_advisory_unlock(hashtext('fn_delete_test_fixture_rows'));

  RETURN QUERY SELECT v_deleted_count, v_deleted_identities;
END;
$$;

COMMENT ON FUNCTION roadmap_workforce.fn_delete_test_fixture_rows IS
  'P2323/AC-4: Delete test-fixture agent_registry rows older than retention window';

-- Create audit log table if it doesn't exist
CREATE TABLE IF NOT EXISTS roadmap_efficiency.reaper_audit_log (
  id BIGSERIAL PRIMARY KEY,
  reaper_name TEXT NOT NULL,
  action TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  details JSONB,
  executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reaper_audit_log_executed_at
  ON roadmap_efficiency.reaper_audit_log(executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_reaper_audit_log_reaper_name
  ON roadmap_efficiency.reaper_audit_log(reaper_name);
