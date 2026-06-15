-- P1105 Phase D — agent_token_key table for multi-key bearer-token rotation.
--
-- AC-10 / AC-14: per-user HMAC signing keys with a grace window.
--   PRIMARY KEY (agent_identity, key_id) so each identity may hold multiple
--   keys at once (old key + new key) during a rotation grace period.
--   key_id is YYYY-MM (rotated on month boundary by token_rotate).
--   secret_key_hash holds the Argon2/opaque hash of the signing secret —
--   the raw secret is never stored (stateless JWT verification re-derives
--   expectations; the hash is a rotation-bookkeeping anchor, not a verifier
--   input). expires_at gives the grace window after which a rotated-out key
--   is no longer considered active.
--
-- Idempotent: safe to re-run. No inner BEGIN/COMMIT (runner wraps in a txn).

CREATE TABLE IF NOT EXISTS roadmap.agent_token_key (
	agent_identity  TEXT        NOT NULL,
	key_id          TEXT        NOT NULL,
	secret_key_hash TEXT        NOT NULL,
	issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	expires_at      TIMESTAMPTZ NOT NULL,
	PRIMARY KEY (agent_identity, key_id)
);

-- Index supporting the verifier's "freshest active key first" lookup:
--   SELECT ... WHERE agent_identity=$1 AND expires_at > NOW() ORDER BY expires_at DESC
-- A partial predicate cannot use NOW() (not IMMUTABLE), so the active filter is
-- applied at query time; this composite index still serves the ordered scan.
CREATE INDEX IF NOT EXISTS idx_agent_token_key_active
	ON roadmap.agent_token_key (agent_identity, expires_at DESC);

COMMENT ON TABLE roadmap.agent_token_key IS
	'P1105 Phase D: per-(user identity, key_id) HMAC signing keys for bearer-token rotation. key_id=YYYY-MM. Old keys remain active until expires_at (30d grace).';
