-- ============================================================
-- agentHive2 — 003-identity.sql
-- Principal registry, W3C DIDs, cryptographic keys, audit log.
-- Renamed from hiveCentral's `control_identity` → `identity`.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql
-- ============================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS identity;
COMMENT ON SCHEMA identity IS
  'Principal registry, W3C DID documents, per-principal cryptographic keys, '
  'and the append-only identity audit log.';

-- Shared updated_at trigger
CREATE OR REPLACE FUNCTION identity.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

-- Append-only enforcement: block UPDATE and DELETE on audit tables
CREATE OR REPLACE FUNCTION identity.deny_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity.auditAction is append-only — % not permitted', TG_OP;
END;
$$;

-- ============================================================
-- identity.principal — canonical identity for every agent/human/service
-- ============================================================
CREATE TABLE IF NOT EXISTS identity.principal (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  did              TEXT         NOT NULL UNIQUE,          -- 'did:agenthive:<name>'
  kind             TEXT         NOT NULL
                               CHECK (kind IN ('agent','human','service','system')),
  display_name     TEXT         NOT NULL,
  project_id       BIGINT       REFERENCES core.project (id) ON DELETE SET NULL,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS principal_kind_active ON identity.principal (kind)
  WHERE lifecycle_status = 'active';
CREATE INDEX IF NOT EXISTS principal_project ON identity.principal (project_id);

CREATE OR REPLACE TRIGGER set_updated_at_principal
  BEFORE UPDATE ON identity.principal
  FOR EACH ROW EXECUTE FUNCTION identity.set_updated_at();

COMMENT ON TABLE identity.principal IS
  'Canonical identity row for every actor: agents, humans, services, system. '
  'DID is the stable cross-system identifier.';

-- ============================================================
-- identity.didDocument — W3C DID document per principal
-- ============================================================
CREATE TABLE IF NOT EXISTS identity.didDocument (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal_id     BIGINT       NOT NULL REFERENCES identity.principal (id) ON DELETE CASCADE,
  did              TEXT         NOT NULL UNIQUE,
  document_jsonb   JSONB        NOT NULL,
  version          INT          NOT NULL DEFAULT 1,
  published_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS did_document_principal ON identity.didDocument (principal_id);

CREATE OR REPLACE TRIGGER set_updated_at_did_document
  BEFORE UPDATE ON identity.didDocument
  FOR EACH ROW EXECUTE FUNCTION identity.set_updated_at();

COMMENT ON TABLE identity.didDocument IS
  'W3C DID document per principal. One active document per DID at any time.';

-- ============================================================
-- identity.principalKey — cryptographic credentials per principal
-- ============================================================
CREATE TABLE IF NOT EXISTS identity.principalKey (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  principal_id     BIGINT       NOT NULL REFERENCES identity.principal (id) ON DELETE CASCADE,
  key_id           TEXT         NOT NULL,                 -- key fragment in DID URL
  key_type         TEXT         NOT NULL
                               CHECK (key_type IN ('Ed25519','P-256','RSA-2048','symmetric')),
  public_key_b64   TEXT,                                  -- base64url encoded public key
  key_usage        TEXT         NOT NULL
                               CHECK (key_usage IN ('authentication','assertion','key-agreement','service')),
  expires_at       TIMESTAMPTZ,
  revoked_at       TIMESTAMPTZ,
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'active'
                               CHECK (lifecycle_status IN ('active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (principal_id, key_id)
);

CREATE INDEX IF NOT EXISTS principal_key_active ON identity.principalKey (principal_id)
  WHERE lifecycle_status = 'active';

CREATE OR REPLACE TRIGGER set_updated_at_principal_key
  BEFORE UPDATE ON identity.principalKey
  FOR EACH ROW EXECUTE FUNCTION identity.set_updated_at();

COMMENT ON TABLE identity.principalKey IS
  'Cryptographic credentials per principal. key_id matches the fragment in the DID URL (e.g., #key-1).';

-- ============================================================
-- identity.auditAction — append-only identity audit log (time-series)
-- ============================================================
CREATE TABLE IF NOT EXISTS identity.auditAction (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY,
  principal_id     BIGINT       REFERENCES identity.principal (id) ON DELETE SET NULL,
  actor_did        TEXT         NOT NULL,
  action           TEXT         NOT NULL,                 -- 'create_principal', 'revoke_key', etc.
  target_did       TEXT,
  payload_jsonb    JSONB        NOT NULL DEFAULT '{}',
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS identity.auditAction_default
  PARTITION OF identity.auditAction DEFAULT;

-- Append-only: block UPDATE and DELETE
REVOKE UPDATE, DELETE ON identity.auditAction FROM PUBLIC;

CREATE OR REPLACE TRIGGER deny_audit_mutation
  BEFORE UPDATE OR DELETE ON identity.auditAction
  FOR EACH ROW EXECUTE FUNCTION identity.deny_mutation();

COMMENT ON TABLE identity.auditAction IS
  'Append-only identity audit log. Every principal creation, key rotation, '
  'and revocation must produce a row here. Partitioned by occurred_at.';

-- ============================================================
-- Views
-- ============================================================
CREATE OR REPLACE VIEW identity.v_active_principals AS
SELECT id, did, kind, display_name, project_id, created_at
  FROM identity.principal
 WHERE lifecycle_status = 'active';

CREATE OR REPLACE VIEW identity.v_principal_keys AS
SELECT
  pk.id,
  p.did AS principal_did,
  pk.key_id,
  pk.key_type,
  pk.key_usage,
  pk.expires_at,
  pk.revoked_at
FROM identity.principalKey pk
JOIN identity.principal p ON p.id = pk.principal_id
WHERE pk.lifecycle_status = 'active'
  AND pk.revoked_at IS NULL;

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA identity TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON identity.principal, identity.didDocument, identity.principalKey TO agenthive_orchestrator;
    GRANT SELECT, INSERT ON identity.auditAction TO agenthive_orchestrator;
    GRANT SELECT ON identity.v_active_principals, identity.v_principal_keys TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA identity TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA identity TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA identity TO agenthive_agency;
    GRANT SELECT ON identity.principal, identity.v_active_principals TO agenthive_agency;
    GRANT INSERT ON identity.auditAction TO agenthive_agency;
  END IF;
END $$;

-- ============================================================
-- Seed: bootstrap system principal
-- ============================================================
INSERT INTO identity.principal (did, kind, display_name, owner_did)
VALUES ('did:agenthive:system', 'system', 'AgentHive System', 'did:agenthive:system')
ON CONFLICT (did) DO NOTHING;
