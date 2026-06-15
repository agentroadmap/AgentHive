-- 279 — P828: core.config_mutation_log audit table + fn_config_mutation_audit
--
-- PROBLEM: ConfigResolver.set() (src/shared/runtime/config.ts) already writes an
-- audit row to core.config_mutation_log on every authorized config mutation, and
-- reads control_identity.principal for the principal_id FK. The table is defined
-- in the bootstrap DDL (database/ddl/hivecentral/001-core.sql) but that DDL only
-- runs on a fresh install — it was never applied to the live hiveCentral DB, so
-- `\d core.config_mutation_log` returns "did not find any relation". Every set()
-- mutation therefore fails at the INSERT. This migration creates the table on the
-- live control plane (idempotent), matching the 001-core.sql definition exactly,
-- and adds fn_config_mutation_audit (P828 AC-39) for filtered audit reads.
--
-- TARGET DB: hiveCentral (control plane). core.config_mutation_log lives in the
--            `core` schema; principal_id FK references control_identity.principal.
--
-- IDEMPOTENT: CREATE TABLE / INDEX / FUNCTION IF NOT EXISTS / OR REPLACE. No inner
-- BEGIN/COMMIT (the migration runner wraps each file in its own transaction).
-- Safe to re-run; matches database/ddl/hivecentral/001-core.sql lines 376-433.

-- ─────────────────────────────────────────────────────────────────────────────
-- core.config_mutation_log — append-only audit trail for config writes.
-- Every ConfigResolver.set() that passes the authority gate writes one row.
-- Append-only is enforced two ways (REVOKE + trigger).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.config_mutation_log (
  mutation_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_name           TEXT NOT NULL,
  key_class          TEXT NOT NULL CHECK (key_class IN ('flag','registry','structural','secret')),
  scope              TEXT,
  old_value          JSONB,
  new_value          JSONB,
  caller_did         TEXT NOT NULL,
  principal_id       BIGINT NOT NULL REFERENCES control_identity.principal(id),
  mutation_authority TEXT NOT NULL CHECK (mutation_authority IN ('operator','system')),
  validation_result  TEXT NOT NULL CHECK (validation_result IN ('success','failed')),
  validation_error   TEXT,
  mutated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS config_mutation_log_key_time
  ON core.config_mutation_log (key_name, mutated_at DESC);
CREATE INDEX IF NOT EXISTS config_mutation_log_principal
  ON core.config_mutation_log (principal_id, mutated_at DESC);

COMMENT ON TABLE core.config_mutation_log IS
  'P828: append-only audit of ConfigResolver.set() mutations (who/what/when/old->new).';

-- Append-only enforcement (a): role grants.
REVOKE UPDATE, DELETE ON core.config_mutation_log FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT INSERT, SELECT ON core.config_mutation_log TO agenthive_orchestrator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT SELECT ON core.config_mutation_log TO agenthive_observability;
  END IF;
END $$;

-- Append-only enforcement (b): trigger rejecting UPDATE/DELETE.
CREATE OR REPLACE FUNCTION core.deny_config_mutation_log_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'core.config_mutation_log is append-only';
END;
$$;

DROP TRIGGER IF EXISTS config_mutation_log_no_update ON core.config_mutation_log;
CREATE TRIGGER config_mutation_log_no_update
  BEFORE UPDATE ON core.config_mutation_log
  FOR EACH ROW EXECUTE FUNCTION core.deny_config_mutation_log_mutation();

DROP TRIGGER IF EXISTS config_mutation_log_no_delete ON core.config_mutation_log;
CREATE TRIGGER config_mutation_log_no_delete
  BEFORE DELETE ON core.config_mutation_log
  FOR EACH ROW EXECUTE FUNCTION core.deny_config_mutation_log_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- P828 AC-39: fn_config_mutation_audit — filtered read of config_mutation_log.
-- Returns rows for a given key_name (required) with optional scope filter and a
-- row cap. Ordered newest-first. SECURITY INVOKER (default) so the caller's
-- SELECT grant on core.config_mutation_log is what authorizes the read.
--   p_key_name : exact key_name to filter on (required; pass '' / NULL for all).
--   p_scope    : optional exact scope filter (NULL = any scope).
--   p_limit    : max rows (default 100, clamped to [1, 1000]).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION core.fn_config_mutation_audit(
  p_key_name TEXT DEFAULT NULL,
  p_scope    TEXT DEFAULT NULL,
  p_limit    INT  DEFAULT 100
)
RETURNS TABLE (
  mutation_id        UUID,
  key_name           TEXT,
  key_class          TEXT,
  scope              TEXT,
  old_value          JSONB,
  new_value          JSONB,
  caller_did         TEXT,
  principal_id       BIGINT,
  mutation_authority TEXT,
  validation_result  TEXT,
  validation_error   TEXT,
  mutated_at         TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT
    l.mutation_id, l.key_name, l.key_class, l.scope, l.old_value, l.new_value,
    l.caller_did, l.principal_id, l.mutation_authority, l.validation_result,
    l.validation_error, l.mutated_at
  FROM core.config_mutation_log l
  WHERE (p_key_name IS NULL OR p_key_name = '' OR l.key_name = p_key_name)
    AND (p_scope    IS NULL OR l.scope    = p_scope)
  ORDER BY l.mutated_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);
$$;

COMMENT ON FUNCTION core.fn_config_mutation_audit(TEXT, TEXT, INT) IS
  'P828 AC-39: filtered, newest-first read of core.config_mutation_log by key_name + optional scope.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT EXECUTE ON FUNCTION core.fn_config_mutation_audit(TEXT, TEXT, INT) TO agenthive_orchestrator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT EXECUTE ON FUNCTION core.fn_config_mutation_audit(TEXT, TEXT, INT) TO agenthive_observability;
  END IF;
END $$;
