-- P1456 AC-13: Add 'delegated' to principal_identity.credential_kind CHECK constraint.
--
-- Live schema (migration 107-p843-principal-identity.sql) only permits:
--   CHECK (credential_kind IN ('oauth', 'ed25519', 'hmac_session'))
-- Session-instance principals authenticate via their standing agency lane, not
-- their own key, so they require credential_kind = 'delegated'. Without this
-- migration, Step 1 of the delegation bootstrap (INSERT/UPSERT principal_identity
-- for the session) fails with a CHECK violation.
--
-- The constraint must be dropped and recreated because PostgreSQL does not
-- support ALTER CONSTRAINT ... ADD value for CHECK constraints.
--
-- Post-migration test: see AC-13 verification in P1456.

BEGIN;

ALTER TABLE roadmap.principal_identity
  DROP CONSTRAINT IF EXISTS principal_identity_credential_kind_check;

ALTER TABLE roadmap.principal_identity
  ADD CONSTRAINT principal_identity_credential_kind_check
  CHECK (credential_kind IN ('oauth', 'ed25519', 'hmac_session', 'delegated'));

COMMIT;
