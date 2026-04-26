-- P477 AC-7: Control-plane operator security model
-- Adds per-operator bearer-token authorization for privileged web actions
-- (stop runaway agents/cubics/state machines, send DMs, etc.) with an
-- audit trail. Does NOT change existing read endpoints — those stay
-- unauthenticated to keep parity with the current portal.
--
-- Default posture is fail-closed: with no rows in operator_token, every
-- privileged action returns 503 "operator auth not configured". Operators
-- are added explicitly via INSERT.

BEGIN;

-- One row per operator credential. Tokens are stored as SHA-256 hashes
-- (the literal token never lives in the DB). allowed_actions lists the
-- action names the holder may invoke; '*' is the all-actions wildcard.
CREATE TABLE IF NOT EXISTS roadmap.operator_token (
    id              bigserial PRIMARY KEY,
    operator_name   text NOT NULL,
    token_sha256    text NOT NULL UNIQUE,
    allowed_actions text[] NOT NULL DEFAULT ARRAY['*']::text[],
    expires_at      timestamptz,
    revoked_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz,
    notes           text
);

CREATE INDEX IF NOT EXISTS idx_operator_token_active
    ON roadmap.operator_token (token_sha256)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE  roadmap.operator_token            IS 'P477 AC-7: bearer-token credentials for privileged web control-plane actions. Tokens stored as sha256 hex.';
COMMENT ON COLUMN roadmap.operator_token.token_sha256    IS 'sha256(token) lowercase hex. The plaintext token is shown once at issue time and never stored.';
COMMENT ON COLUMN roadmap.operator_token.allowed_actions IS 'Action names this token may invoke. Use ARRAY[''*''] for full operator powers.';
COMMENT ON COLUMN roadmap.operator_token.expires_at      IS 'Optional expiry. Null = no expiry. Past expires_at is treated like revoked.';

-- Audit row per privileged call. Decision is the authz outcome:
--   allow  — token valid + action permitted
--   deny   — token present but lacks the action OR is revoked/expired
--   anonymous — no Authorization header AND fail-open path was used
--   unconfigured — privileged endpoint hit while operator_token is empty
CREATE TABLE IF NOT EXISTS roadmap.operator_audit_log (
    id                  bigserial PRIMARY KEY,
    occurred_at         timestamptz NOT NULL DEFAULT now(),
    operator_name       text,
    token_id            bigint REFERENCES roadmap.operator_token(id) ON DELETE SET NULL,
    action              text NOT NULL,
    decision            text NOT NULL,
    target_kind         text,
    target_identity     text,
    request_summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
    remote_addr         text,
    response_status     integer,
    failure_reason      text,
    CONSTRAINT operator_audit_decision_check
        CHECK (decision IN ('allow','deny','anonymous','unconfigured'))
);

CREATE INDEX IF NOT EXISTS idx_operator_audit_recent
    ON roadmap.operator_audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_audit_action
    ON roadmap.operator_audit_log (action, occurred_at DESC);

COMMENT ON TABLE roadmap.operator_audit_log IS 'P477 AC-7: append-only log of every privileged web action (operator name + decision + target). Surfaces the kill-switch usage trail.';

COMMIT;
