-- P1291: Per-(proposal_id, role) pause fuse for repeated no-eligible-agency failures.
--
-- After consecutive dispatch failures for the same (proposal, role) tuple,
-- a row is inserted into this table with an expires_at timestamp. The
-- postWorkOffer function checks for non-expired pauses and throws
-- PausedRoleError before posting.
--
-- Backoff is exponential: BASE_BACKOFF * 2^(pause_cycle - 1), capped at MAX_BACKOFF.
-- The row is auto-cleared on capability_vocabulary_changed NOTIFY or by
-- operator resume_role action.

CREATE TABLE IF NOT EXISTS roadmap_workforce.proposal_role_pause (
    proposal_id              BIGINT       NOT NULL,
    role                     TEXT         NOT NULL,
    pause_reason             TEXT         NOT NULL
        CHECK (pause_reason IN ('no_eligible_agency', 'capability_mismatch', 'operator_hold')),
    failure_count            INT          NOT NULL DEFAULT 0,
    paused_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at               TIMESTAMPTZ  NOT NULL,
    pause_cycle              INT          NOT NULL DEFAULT 1,
    last_failure_dispatch_id BIGINT       REFERENCES roadmap_workforce.squad_dispatch(id) ON DELETE SET NULL,
    PRIMARY KEY (proposal_id, role)
);

CREATE INDEX IF NOT EXISTS idx_proposal_role_pause_expires_active
    ON roadmap_workforce.proposal_role_pause (expires_at);

COMMENT ON TABLE roadmap_workforce.proposal_role_pause IS
    'P1291: Per-(proposal_id, role) pause fuse for pre-spawn dispatch failures. '
    'Prevents repeated no_eligible_agency loops while preserving work on other roles/proposals.';

COMMENT ON COLUMN roadmap_workforce.proposal_role_pause.pause_reason IS
    'Why the tuple is paused: no_eligible_agency (dispatch), capability_mismatch (agency), or operator_hold (manual).';

COMMENT ON COLUMN roadmap_workforce.proposal_role_pause.failure_count IS
    'Consecutive failures since last pause. Reset to 0 when pause_cycle increments.';

COMMENT ON COLUMN roadmap_workforce.proposal_role_pause.pause_cycle IS
    'Exponential backoff cycle: expires_at = now() + BASE * 2^(cycle-1), capped at MAX.';
