-- ============================================================================
-- Migration 316 — P4509 AC-3: operator-token granular-control backfill
-- ----------------------------------------------------------------------------
-- P4509 splits the four destructive operator-control endpoints off the coarse
-- `control.stop` scope onto their own granular actions:
--     suspend-agency · drain-host · cancel-dispatch · terminate-worker
-- The generic POST /api/operator/control/stop keeps `control.stop`.
--
-- After this split, an EXACT-MATCH `control.stop` grant no longer reaches the
-- four granular endpoints. To preserve backward compatibility, this migration
-- expands every EXISTING non-wildcard token that currently carries
-- `control.stop` so it ALSO carries the four granular actions. Wildcard ('*')
-- tokens are untouched (they already authorize everything).
--
-- AC-7 ordering invariant: the granular handler authorization in
-- src/apps/server/operator-auth.ts / index.ts stays DISABLED (legacy
-- `control.stop` check) until this file is recorded in
-- roadmap.schema_migration. Applying this migration is therefore the explicit
-- cutover gate. Do NOT cut the handlers over before this row exists.
--
-- Properties:
--   * Idempotent — re-running is a no-op (only adds actions that are missing).
--   * Additive — only appends granular actions; never removes any action.
--   * Preserves expires_at, revoked_at, scoped_project_id, operator_name,
--     created_at, notes (only allowed_actions changes).
--   * Auditable — emits before/after NOTICE counts and stamps an audit row.
--
-- Apply ONLY inside an operator-approved deployment window (P4509 AC-12).
-- Lint / dry-run:
--   docker exec -i postgres-db psql -U admin -d agenthive -1 \
--     -f scripts/migrations/316-p4509-operator-granular-control-backfill.sql
--   (wrap in BEGIN; … ROLLBACK; to dry-run without committing)
-- ============================================================================

BEGIN;

DO $$
DECLARE
    v_granular text[] := ARRAY[
        'suspend-agency', 'drain-host', 'cancel-dispatch', 'terminate-worker'
    ];
    v_eligible_before int;
    v_needing_expansion int;
    v_expanded int;
BEGIN
    -- Count tokens that carry control.stop and are not wildcard.
    SELECT count(*) INTO v_eligible_before
      FROM roadmap.operator_token
     WHERE 'control.stop' = ANY(allowed_actions)
       AND NOT ('*' = ANY(allowed_actions));

    -- Of those, how many are still missing at least one granular action
    -- (i.e. would actually change). This is the idempotency measure.
    SELECT count(*) INTO v_needing_expansion
      FROM roadmap.operator_token
     WHERE 'control.stop' = ANY(allowed_actions)
       AND NOT ('*' = ANY(allowed_actions))
       AND NOT (allowed_actions @> v_granular);

    RAISE NOTICE 'P4509 backfill: % token(s) carry control.stop (non-wildcard); % need expansion',
        v_eligible_before, v_needing_expansion;

    -- Expand: union the existing actions with the four granular actions,
    -- de-duplicated and order-stable. Only touch rows that actually change so
    -- re-runs are no-ops and last_used_at / other fields stay put.
    WITH updated AS (
        UPDATE roadmap.operator_token t
           SET allowed_actions = (
                 SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(t.allowed_actions || v_granular) AS a
               )
         WHERE 'control.stop' = ANY(t.allowed_actions)
           AND NOT ('*' = ANY(t.allowed_actions))
           AND NOT (t.allowed_actions @> v_granular)
        RETURNING t.id
    )
    SELECT count(*) INTO v_expanded FROM updated;

    RAISE NOTICE 'P4509 backfill: expanded % token(s)', v_expanded;

    -- AC-3 auditability: stamp one audit row recording the backfill outcome.
    -- No token secret is logged. token_id is NULL (this is a migration-level
    -- event, not a single-token action).
    INSERT INTO roadmap.operator_audit_log
        (operator_name, token_id, action, decision,
         target_kind, target_identity, request_summary, response_status, failure_reason)
    VALUES
        ('migration:316-p4509', NULL, 'token.backfill', 'allow',
         'operator_token', 'control.stop->granular',
         jsonb_build_object(
            'migration', '316-p4509-operator-granular-control-backfill.sql',
            'eligible_control_stop_tokens', v_eligible_before,
            'expanded', v_expanded,
            'granular_actions', to_jsonb(v_granular)
         ),
         200, NULL);
END $$;

COMMIT;

-- ── Verification (run after apply) ───────────────────────────────────────────
-- Before/after audit of which tokens changed and that owner/expiry are intact:
--   SELECT id, operator_name, allowed_actions, expires_at, scoped_project_id, revoked_at
--     FROM roadmap.operator_token
--    WHERE 'control.stop' = ANY(allowed_actions)
--    ORDER BY id;
-- Every such non-wildcard row should now also contain the four granular actions
-- while expires_at / scoped_project_id / operator_name remain unchanged.
