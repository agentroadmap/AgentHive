-- P068: Federation & Cross-Instance Sync — database schema
--
-- Creates the peer registry, sync audit log, and conflict log required for
-- bidirectional proposal federation across multiple AgentHive instances.
-- Also extends roadmap_proposal.proposal_dependencies with cross-instance
-- peer reference columns (AC-14).
--
-- All DDL uses IF NOT EXISTS / IF EXISTS guards for idempotency.

BEGIN;

-- ─── Peer registry ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.federation_peers (
    peer_uuid               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    peer_name               TEXT        UNIQUE NOT NULL,
    hostname                TEXT        NOT NULL,
    address                 TEXT        NOT NULL,
    port                    INTEGER     NOT NULL,
    certificate_pem         TEXT,
    certificate_fingerprint TEXT,
    status                  TEXT        NOT NULL DEFAULT 'pending'
        CONSTRAINT federation_peers_status_check
        CHECK (status IN ('pending','approved','active','quarantined','revoked')),
    is_active               BOOLEAN     GENERATED ALWAYS AS (status = 'active') STORED,
    sync_filter             JSONB,
    last_sync_at            TIMESTAMPTZ,
    health_fail_count       INTEGER     NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.federation_peers IS
'Registry of known peer AgentHive instances participating in proposal federation.
Peer status state machine: pending → approved → active → quarantined → revoked.
is_active is a generated column — do not write it directly.';

COMMENT ON COLUMN roadmap.federation_peers.sync_filter IS
'Optional JSONB filter controlling which proposals are imported from this peer.
Example: {"type": "feature"} imports only feature proposals.
NULL means import all proposals.';

COMMENT ON COLUMN roadmap.federation_peers.health_fail_count IS
'Consecutive health-check failures. Peer is quarantined after 3 failures (AC-9).';

COMMENT ON COLUMN roadmap.federation_peers.last_sync_at IS
'Timestamp of last successful sync cycle with this peer (AC-10).
Peers silent for >1 hour are flagged as stale.';

-- ─── Sync log ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.sync_log (
    id                BIGSERIAL   PRIMARY KEY,
    peer_uuid         UUID        NOT NULL REFERENCES roadmap.federation_peers(peer_uuid),
    proposal_id       BIGINT,
    direction         TEXT        NOT NULL
        CONSTRAINT sync_log_direction_check
        CHECK (direction IN ('push','pull')),
    action            TEXT        NOT NULL
        CONSTRAINT sync_log_action_check
        CHECK (action IN ('create','update','skip','conflict')),
    conflict_detected BOOLEAN     NOT NULL DEFAULT false,
    payload           JSONB,
    synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.sync_log IS
'Audit trail of every proposal sync operation performed with each peer.
Rows are append-only; do not update or delete.';

-- ─── Conflict log ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roadmap.sync_conflict_log (
    id                  BIGSERIAL   PRIMARY KEY,
    peer_uuid           UUID        NOT NULL REFERENCES roadmap.federation_peers(peer_uuid),
    proposal_id         BIGINT,
    local_version       JSONB,
    remote_version      JSONB,
    local_modified_at   TIMESTAMPTZ,
    remote_modified_at  TIMESTAMPTZ,
    diff                JSONB,
    resolution          TEXT        NOT NULL DEFAULT 'pending'
        CONSTRAINT sync_conflict_log_resolution_check
        CHECK (resolution IN ('pending','local_wins','remote_wins','manual')),
    resolved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap.sync_conflict_log IS
'Conflict log for proposals modified concurrently on two instances (AC-15).
Both versions are stored; last-write-wins resolution is applied automatically
but both versions are preserved for audit.';

-- ─── Extend proposal_dependencies with peer reference columns (AC-14) ────────

-- Cross-instance deps set peer_id + peer_display_id and leave to_proposal_id NULL
-- (the existing FK + NOT NULL constraint would reject NULL, so we relax it here).
-- Guard: exactly one of (to_proposal_id, peer_id) must be non-null.
ALTER TABLE roadmap_proposal.proposal_dependencies
    ADD COLUMN IF NOT EXISTS peer_id         UUID
        REFERENCES roadmap.federation_peers(peer_uuid),
    ADD COLUMN IF NOT EXISTS peer_display_id TEXT;

-- Drop NOT NULL on to_proposal_id so cross-instance rows can omit it
ALTER TABLE roadmap_proposal.proposal_dependencies
    ALTER COLUMN to_proposal_id DROP NOT NULL;

-- Enforce: at least one target must be present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'proposal_deps_target_check'
          AND conrelid = 'roadmap_proposal.proposal_dependencies'::regclass
    ) THEN
        ALTER TABLE roadmap_proposal.proposal_dependencies
            ADD CONSTRAINT proposal_deps_target_check
            CHECK (to_proposal_id IS NOT NULL OR peer_id IS NOT NULL);
    END IF;
END$$;

COMMENT ON COLUMN roadmap_proposal.proposal_dependencies.peer_id IS
'Remote peer UUID when the dependency target lives on a different instance.
NULL for local dependencies.';

COMMENT ON COLUMN roadmap_proposal.proposal_dependencies.peer_display_id IS
'Namespaced display ID of the remote dependency (e.g. PEER-A/P001).
NULL for local dependencies.';

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_federation_peers_status
    ON roadmap.federation_peers(status);

CREATE INDEX IF NOT EXISTS idx_federation_peers_is_active
    ON roadmap.federation_peers(is_active)
    WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_sync_log_peer_time
    ON roadmap.sync_log(peer_uuid, synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_log_proposal
    ON roadmap.sync_log(proposal_id)
    WHERE proposal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sync_conflict_log_peer
    ON roadmap.sync_conflict_log(peer_uuid);

CREATE INDEX IF NOT EXISTS idx_sync_conflict_log_pending
    ON roadmap.sync_conflict_log(resolution)
    WHERE resolution = 'pending';

CREATE INDEX IF NOT EXISTS idx_proposal_dep_peer
    ON roadmap_proposal.proposal_dependencies(peer_id)
    WHERE peer_id IS NOT NULL;

COMMIT;
