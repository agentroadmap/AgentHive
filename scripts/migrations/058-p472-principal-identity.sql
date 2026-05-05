-- Migration 058: Unified Principal Identity Model (P472)
--
-- Creates roadmap.principal_identity and roadmap.authority_grant as the
-- canonical identity graph for operators, agencies, and ephemeral agents.
-- Migrates existing agent_registry.public_key rows with collision detection.
-- Adds pg_notify trigger so the orchestrator can flush caches on revocation.

BEGIN;

-- ── 1. principal_identity — the single source of truth ──────────────────────

CREATE TABLE IF NOT EXISTS roadmap.principal_identity (
    principal_id        text        PRIMARY KEY,
    principal_kind      text        NOT NULL,
    parent_principal_id text        REFERENCES roadmap.principal_identity (principal_id) ON DELETE RESTRICT,
    credential_kind     text        NOT NULL,
    public_credential   text,
    issued_at           timestamptz NOT NULL DEFAULT now(),
    expires_at          timestamptz,
    revoked_at          timestamptz,
    revocation_reason   text,
    last_used_at        timestamptz,
    metadata            jsonb       NOT NULL DEFAULT '{}',
    CONSTRAINT pi_kind_check       CHECK (principal_kind    IN ('operator', 'agency', 'agent')),
    CONSTRAINT pi_cred_kind_check  CHECK (credential_kind   IN ('oauth', 'ed25519', 'hmac_session')),
    CONSTRAINT pi_revoke_requires_reason CHECK (
        revoked_at IS NULL OR revocation_reason IS NOT NULL
    )
);

COMMENT ON TABLE roadmap.principal_identity IS
    'P472: Canonical identity graph — one row per active operator / agency / agent principal.';
COMMENT ON COLUMN roadmap.principal_identity.principal_id IS
    'Stable composite key: operator:<oauth_sub> | agency:<agency_id> | agent:<spawn_id>';
COMMENT ON COLUMN roadmap.principal_identity.parent_principal_id IS
    'For agent principals: parent agency. Null for operators.';
COMMENT ON COLUMN roadmap.principal_identity.public_credential IS
    'Ed25519 public key (PEM) for agency/agent; OAuth subject string for operator.';

CREATE INDEX IF NOT EXISTS idx_pi_kind         ON roadmap.principal_identity (principal_kind);
CREATE INDEX IF NOT EXISTS idx_pi_parent       ON roadmap.principal_identity (parent_principal_id) WHERE parent_principal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pi_revoked      ON roadmap.principal_identity (revoked_at)          WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pi_expires      ON roadmap.principal_identity (expires_at)          WHERE expires_at IS NOT NULL;

-- ── 2. authority_grant — replaces authority_chain; same semantics ────────────

CREATE TABLE IF NOT EXISTS roadmap.authority_grant (
    id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    grantor_id      text        NOT NULL REFERENCES roadmap.principal_identity (principal_id) ON DELETE CASCADE,
    grantee_id      text        NOT NULL REFERENCES roadmap.principal_identity (principal_id) ON DELETE CASCADE,
    scope_category  text        NOT NULL,
    scope_ref       text,
    authority_level text        NOT NULL DEFAULT 'trusted',
    can_override    boolean     NOT NULL DEFAULT false,
    reason          text,
    expires_at      timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ag_level_check   CHECK (authority_level IN ('authority', 'trusted', 'known')),
    CONSTRAINT ag_unique        UNIQUE (grantor_id, grantee_id, scope_category, scope_ref)
);

COMMENT ON TABLE roadmap.authority_grant IS
    'P472: Principal-to-principal authority delegation. Replaces roadmap_workforce.authority_chain.';

CREATE INDEX IF NOT EXISTS idx_ag_grantee   ON roadmap.authority_grant (grantee_id);
CREATE INDEX IF NOT EXISTS idx_ag_scope     ON roadmap.authority_grant (scope_category, scope_ref);

CREATE TRIGGER trg_ag_updated_at
    BEFORE UPDATE ON roadmap.authority_grant
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

-- ── 3. Revocation cascade + pg_notify trigger ────────────────────────────────
--
-- When revoked_at is set on an agency principal, all dependent agent principals
-- are immediately revoked too. pg_notify fires so in-process caches can flush
-- within the 30-second TTL window required by AC#101.

CREATE OR REPLACE FUNCTION roadmap.fn_principal_revocation_cascade()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_payload text;
BEGIN
    -- Only act when revoked_at transitions from NULL → non-NULL
    IF (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN

        -- Cascade to all direct child (agent) principals
        UPDATE roadmap.principal_identity
           SET revoked_at        = NEW.revoked_at,
               revocation_reason = 'parent_revoked:' || NEW.principal_id
         WHERE parent_principal_id = NEW.principal_id
           AND revoked_at IS NULL;

        -- Notify subscribers so in-process key caches flush
        v_payload := json_build_object(
            'event',        'principal_revoked',
            'principal_id', NEW.principal_id,
            'kind',         NEW.principal_kind,
            'revoked_at',   NEW.revoked_at
        )::text;
        PERFORM pg_notify('principal_revoked', v_payload);
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_principal_revocation_cascade
    AFTER UPDATE ON roadmap.principal_identity
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_principal_revocation_cascade();

-- ── 4. Collision-auditing migration from agent_registry.public_key ───────────
--
-- AC#106: duplicate agent_identity → different public_keys blocks migration.
-- This view surfaces any collisions; the application-level migration script
-- (scripts/migrate-principal-identity.ts) refuses to proceed when it detects rows.

CREATE OR REPLACE VIEW roadmap.v_principal_migration_collisions AS
SELECT
    agent_identity,
    count(DISTINCT public_key)  AS distinct_key_count,
    array_agg(DISTINCT public_key ORDER BY public_key) AS keys
FROM   roadmap_workforce.agent_registry
WHERE  public_key IS NOT NULL
GROUP  BY agent_identity
HAVING count(DISTINCT public_key) > 1;

COMMENT ON VIEW roadmap.v_principal_migration_collisions IS
    'P472 AC#106: Returns agent_identity rows where >1 distinct public_key exists. Must be empty before migration.';

-- ── 5. Backfill agent_registry rows (no-collision path) ─────────────────────
--
-- Only runs when the collision view is empty (enforced here via assertion).
-- agent_identity → principal_id 'agent:<agent_identity>'
-- Existing public_key (PEM or base64) becomes public_credential.

DO $$
DECLARE
    v_collision_count int;
BEGIN
    SELECT count(*) INTO v_collision_count FROM roadmap.v_principal_migration_collisions;
    IF v_collision_count > 0 THEN
        RAISE EXCEPTION
            'P472 migration blocked: % agent_identity rows have conflicting public_keys. '
            'Resolve via roadmap.v_principal_migration_collisions before re-running.',
            v_collision_count;
    END IF;

    INSERT INTO roadmap.principal_identity (
        principal_id,
        principal_kind,
        credential_kind,
        public_credential,
        issued_at,
        metadata
    )
    SELECT
        'agent:' || ar.agent_identity                       AS principal_id,
        'agent'                                             AS principal_kind,
        'ed25519'                                           AS credential_kind,
        ar.public_key                                       AS public_credential,
        COALESCE(ar.key_rotated_at, ar.created_at, now())   AS issued_at,
        jsonb_build_object(
            'migrated_from', 'agent_registry',
            'agent_identity', ar.agent_identity,
            'legacy_row_id', ar.id
        )                                                   AS metadata
    FROM   roadmap_workforce.agent_registry ar
    WHERE  ar.public_key IS NOT NULL
    ON CONFLICT (principal_id) DO NOTHING;
END;
$$;

-- ── 6. Backfill authority_chain → authority_grant ────────────────────────────
--
-- Maps each authority_chain row to a grant where the grantor is the
-- 'granted_by' agent principal and the grantee is the 'authority_agent'.
-- Rows whose agent principals weren't migrated above are skipped (no-op INSERT).

INSERT INTO roadmap.authority_grant (
    grantor_id,
    grantee_id,
    scope_category,
    scope_ref,
    authority_level,
    can_override,
    reason,
    expires_at,
    created_at,
    updated_at
)
SELECT
    'agent:' || ac.granted_by       AS grantor_id,
    'agent:' || ac.authority_agent  AS grantee_id,
    ac.scope_category,
    ac.scope_ref,
    ac.authority_level,
    ac.can_override,
    ac.reason,
    ac.expires_at,
    ac.created_at,
    ac.updated_at
FROM   roadmap_workforce.authority_chain ac
WHERE  EXISTS (
    SELECT 1 FROM roadmap.principal_identity
     WHERE principal_id = 'agent:' || ac.granted_by
)
AND    EXISTS (
    SELECT 1 FROM roadmap.principal_identity
     WHERE principal_id = 'agent:' || ac.authority_agent
)
ON CONFLICT (grantor_id, grantee_id, scope_category, scope_ref) DO NOTHING;

COMMIT;
