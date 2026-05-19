-- ============================================================
-- agentHive2 — 004-governance.sql
-- Governance layer: versioned policies, hash-chained decision log,
-- compliance checks, and append-only event stream.
-- Target DB:  agentHive2
-- Owner:      agenthive_admin
-- Depends on: 001-core.sql, 003-identity.sql
-- Requires:   pgcrypto (for sha256 hash chain)
-- ============================================================

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS governance;
COMMENT ON SCHEMA governance IS
  'Governance layer: versioned policies, hash-chained immutable decision log, '
  'compliance checks, and append-only event stream.';

-- Append-only enforcement
CREATE OR REPLACE FUNCTION governance.deny_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance.% is append-only — % not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

-- ============================================================
-- governance.policy — versioned governance policies
-- ============================================================
CREATE TABLE IF NOT EXISTS governance.policy (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             TEXT         NOT NULL,                 -- stable identifier across versions
  version          INT          NOT NULL DEFAULT 1,
  title            TEXT         NOT NULL,
  body_text        TEXT,
  effective_at     TIMESTAMPTZ,
  superseded_at    TIMESTAMPTZ,
  author_did       TEXT         NOT NULL,
  metadata         JSONB        NOT NULL DEFAULT '{}',
  owner_did        TEXT         NOT NULL,
  lifecycle_status TEXT         NOT NULL DEFAULT 'draft'
                               CHECK (lifecycle_status IN ('draft','active','deprecated','retired','blocked')),
  deprecated_at    TIMESTAMPTZ,
  retire_after     TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (slug, version)
);

CREATE OR REPLACE FUNCTION governance.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER set_updated_at_policy
  BEFORE UPDATE ON governance.policy
  FOR EACH ROW EXECUTE FUNCTION governance.set_updated_at();

-- Published policies become immutable
CREATE OR REPLACE FUNCTION governance.lock_published_policy()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.effective_at IS NOT NULL AND OLD.effective_at <= now() THEN
    RAISE EXCEPTION 'Cannot mutate published policy (id=%, slug=%, version=%)',
      OLD.id, OLD.slug, OLD.version;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER lock_published_policy
  BEFORE UPDATE ON governance.policy
  FOR EACH ROW EXECUTE FUNCTION governance.lock_published_policy();

COMMENT ON TABLE governance.policy IS
  'Versioned governance policies. Once effective_at is set and in the past the row is immutable.';

-- ============================================================
-- governance.decision — immutable hash-chained gate decisions (time-series)
-- ============================================================
CREATE TABLE IF NOT EXISTS governance.decision (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY,
  project_id       BIGINT       REFERENCES core.project (id) ON DELETE SET NULL,
  proposal_ref     TEXT         NOT NULL,                 -- display_id e.g. 'P190'
  stage            TEXT         NOT NULL,                 -- workflow stage at decision time
  outcome          TEXT         NOT NULL
                               CHECK (outcome IN ('advance','reject','defer','split','archive')),
  actor_did        TEXT         NOT NULL,
  rationale        TEXT,
  policy_id        BIGINT       REFERENCES governance.policy (id) ON DELETE SET NULL,
  metadata_jsonb   JSONB        NOT NULL DEFAULT '{}',
  prev_hash        TEXT,                                  -- sha256 of previous row for chain integrity
  row_hash         TEXT         GENERATED ALWAYS AS (
    encode(
      digest(
        COALESCE(proposal_ref,'') || COALESCE(stage,'') || COALESCE(outcome,'') ||
        COALESCE(actor_did,'') || COALESCE(rationale,'') || COALESCE(prev_hash,''),
        'sha256'
      ),
      'hex'
    )
  ) STORED,
  decided_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, decided_at)
) PARTITION BY RANGE (decided_at);

CREATE TABLE IF NOT EXISTS governance.decision_default
  PARTITION OF governance.decision DEFAULT;

REVOKE UPDATE, DELETE ON governance.decision FROM PUBLIC;

CREATE OR REPLACE TRIGGER deny_decision_mutation
  BEFORE UPDATE OR DELETE ON governance.decision
  FOR EACH ROW EXECUTE FUNCTION governance.deny_mutation();

CREATE INDEX IF NOT EXISTS decision_proposal ON governance.decision (proposal_ref);
CREATE INDEX IF NOT EXISTS decision_project ON governance.decision (project_id);

COMMENT ON TABLE governance.decision IS
  'Append-only hash-chained gate decision log. row_hash is computed over key fields '
  'to detect tampering. Partitioned by decided_at. Permanent retention.';

-- ============================================================
-- governance.compliance_check — point-in-time compliance assessments (time-series)
-- ============================================================
CREATE TABLE IF NOT EXISTS governance.compliance_check (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY,
  project_id       BIGINT       REFERENCES core.project (id) ON DELETE SET NULL,
  check_type       TEXT         NOT NULL,                 -- 'proposal_ac', 'security_scan', etc.
  target_ref       TEXT         NOT NULL,                 -- proposal_id, commit sha, etc.
  outcome          TEXT         NOT NULL
                               CHECK (outcome IN ('pass','fail','warn','skip')),
  details_jsonb    JSONB        NOT NULL DEFAULT '{}',
  actor_did        TEXT         NOT NULL,
  checked_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, checked_at)
) PARTITION BY RANGE (checked_at);

CREATE TABLE IF NOT EXISTS governance.complianceCheck_default
  PARTITION OF governance.compliance_check DEFAULT;

REVOKE UPDATE, DELETE ON governance.compliance_check FROM PUBLIC;

CREATE OR REPLACE TRIGGER deny_compliance_mutation
  BEFORE UPDATE OR DELETE ON governance.compliance_check
  FOR EACH ROW EXECUTE FUNCTION governance.deny_mutation();

COMMENT ON TABLE governance.compliance_check IS
  'Append-only compliance assessment log. Partitioned by checked_at. Retained 1 year by default.';

-- ============================================================
-- governance.event — append-only system event stream (time-series)
-- ============================================================
CREATE TABLE IF NOT EXISTS governance.event (
  id               BIGINT       GENERATED ALWAYS AS IDENTITY,
  project_id       BIGINT       REFERENCES core.project (id) ON DELETE SET NULL,
  event_type       TEXT         NOT NULL,                 -- 'proposal_transitioned', 'agent_registered', etc.
  actor_did        TEXT         NOT NULL,
  subject_ref      TEXT,                                  -- proposal_id, agent slug, etc.
  payload_jsonb    JSONB        NOT NULL DEFAULT '{}',
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS governance.event_default
  PARTITION OF governance.event DEFAULT;

REVOKE UPDATE, DELETE ON governance.event FROM PUBLIC;

CREATE OR REPLACE TRIGGER deny_event_mutation
  BEFORE UPDATE OR DELETE ON governance.event
  FOR EACH ROW EXECUTE FUNCTION governance.deny_mutation();

CREATE INDEX IF NOT EXISTS event_type_project ON governance.event (event_type, project_id);

COMMENT ON TABLE governance.event IS
  'Append-only system event stream. Source of truth for audit, analytics, and replay. '
  'Partitioned by occurred_at. Permanent retention.';

-- ============================================================
-- Grants
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_orchestrator') THEN
    GRANT USAGE ON SCHEMA governance TO agenthive_orchestrator;
    GRANT SELECT, INSERT, UPDATE ON governance.policy TO agenthive_orchestrator;
    GRANT SELECT, INSERT ON governance.decision, governance.compliance_check, governance.event TO agenthive_orchestrator;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_observability') THEN
    GRANT USAGE ON SCHEMA governance TO agenthive_observability;
    GRANT SELECT ON ALL TABLES IN SCHEMA governance TO agenthive_observability;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agenthive_agency') THEN
    GRANT USAGE ON SCHEMA governance TO agenthive_agency;
    GRANT SELECT ON governance.policy TO agenthive_agency;
    GRANT INSERT ON governance.event TO agenthive_agency;
  END IF;
END $$;
