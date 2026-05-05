-- P843: Create roadmap.principal_identity table (gap-fill from P472)
--
-- This table stores the canonical principal identity records for operators,
-- agencies, and ephemeral agents. It is referenced by PrincipalVerifier for
-- authentication and authorization gates.

CREATE TABLE IF NOT EXISTS roadmap.principal_identity (
  principal_id        TEXT PRIMARY KEY,
  principal_kind      TEXT NOT NULL CHECK (principal_kind IN ('operator','agency','agent')),
  parent_principal_id TEXT,
  credential_kind     TEXT NOT NULL CHECK (credential_kind IN ('oauth','ed25519','hmac_session')),
  public_credential   TEXT,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revocation_reason   TEXT,
  last_used_at        TIMESTAMPTZ,
  metadata            JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_principal_identity_kind ON roadmap.principal_identity(principal_kind);
CREATE INDEX IF NOT EXISTS idx_principal_identity_parent ON roadmap.principal_identity(parent_principal_id)
  WHERE parent_principal_id IS NOT NULL;

-- pg_notify trigger for revocation cascades
CREATE OR REPLACE FUNCTION roadmap.fn_principal_revoke_notify()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    PERFORM pg_notify(
      'principal_revoked',
      json_build_object('principal_id', NEW.principal_id, 'kind', NEW.principal_kind)::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_principal_revoke_notify ON roadmap.principal_identity;
CREATE TRIGGER trg_principal_revoke_notify
  AFTER UPDATE ON roadmap.principal_identity
  FOR EACH ROW EXECUTE FUNCTION roadmap.fn_principal_revoke_notify();
