-- Task #40 prereq: align core.runtime_flag schema with the universal-config
-- resolver (src/shared/runtime/config.ts getScopedFlagValue).
--
-- The resolver queries:
--   SELECT value_jsonb FROM core.runtime_flag
--   WHERE flag_name = $1 AND scope = $2 AND lifecycle_status = 'active'
--
-- But migration 170 created the table with only `name` + `value_jsonb` — no
-- scope, no lifecycle_status, and the lookup column is `name` not `flag_name`.
-- Result: every FlagKeys.* lookup through config.get() silently returns
-- undefined (try/catch swallows the column-does-not-exist error), forcing
-- callers (start-a2a-host.ts) to bypass the resolver and query directly.
--
-- This migration is backward-compatible: existing rows get scope='global'
-- and lifecycle_status='active' defaults, and the renamed column keeps the
-- same primary key. The trigger fn_runtime_flag_notify continues to work
-- (it doesn't reference the renamed column).
--
-- After this migration:
--   - Resolver works: config.get(FlagKeys.A2A_HOST_PRESENCE_REFRESH_MS) returns the right value.
--   - Scoped overrides become possible: INSERT a row with scope='agency:george' to
--     override globally for one agency. (Not used today; future-ready.)
--   - start-a2a-host.ts direct queries continue working after the column rename
--     (separate code commit updates the column references).

BEGIN;

ALTER TABLE core.runtime_flag
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active';

-- Rename name → flag_name to match the resolver. ALTER COLUMN RENAME is
-- atomic and preserves the PRIMARY KEY constraint.
ALTER TABLE core.runtime_flag RENAME COLUMN name TO flag_name;

-- Add a partial index for the resolver's hot path
CREATE INDEX IF NOT EXISTS idx_runtime_flag_active
  ON core.runtime_flag (flag_name, scope)
  WHERE lifecycle_status = 'active';

-- The trigger fn_runtime_flag_notify uses OLD/NEW.flag_name implicitly
-- via record-level references; no change needed. But the existing trigger
-- function may have inlined the old column name — replace if so.
CREATE OR REPLACE FUNCTION core.fn_runtime_flag_notify() RETURNS trigger AS $func$
BEGIN
  PERFORM pg_notify(
    'runtime_flag_changed',
    json_build_object(
      'flag_name', COALESCE(NEW.flag_name, OLD.flag_name),
      'scope',     COALESCE(NEW.scope,     OLD.scope),
      'op',        TG_OP,
      'at',        now()::text
    )::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$func$ LANGUAGE plpgsql;

COMMENT ON TABLE core.runtime_flag IS
  'Runtime-tunable feature flags. Resolver in src/shared/runtime/config.ts queries by (flag_name, scope, lifecycle_status). Scope examples: global | host:<id> | project:<slug> | agency:<id>.';

COMMIT;
