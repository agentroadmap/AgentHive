-- P1456 AC-13: Add 'delegated' to principal_identity.credential_kind CHECK constraint
--
-- Live schema (verified 2026-06-06): CHECK only allows ['oauth', 'ed25519', 'hmac_session'].
-- Session identities authenticate via the standing lane (not their own key), so
-- 'delegated' must be a valid credential_kind before any session principal_identity
-- row is inserted.
--
-- Renumbered 233→283 (2026-06-15): number 233 collided with 233-p3000-agent-cost-quota
-- (applied live) and 233-p1018; 283 is the next free slot. Idempotent.

ALTER TABLE roadmap.principal_identity
  DROP CONSTRAINT IF EXISTS pi_cred_kind_check;

ALTER TABLE roadmap.principal_identity
  ADD CONSTRAINT pi_cred_kind_check
    CHECK (credential_kind IN ('oauth', 'ed25519', 'hmac_session', 'delegated'));

COMMENT ON COLUMN roadmap.principal_identity.credential_kind IS
  'How the principal authenticates. ''delegated'' is used for session-instance principals
   that inherit credentials from their parent (e.g. user/gary delegates to a CLI session).';
