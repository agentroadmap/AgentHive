-- 283-p2997-stake-layer.sql
-- P2997 (P2995-AC2): Stake / capability-bond layer for agent identity trust.
--
-- SCOPE (post-rescope, see P2997 AC-5..AC-8):
--   The cryptographic PROOF layer already exists — migration 018 added
--   roadmap_workforce.agent_registry.public_key + key_rotated_at, and the
--   src/core/identity module (agent-identity.ts, identity-verification.ts,
--   principal-verifier.ts, key-storage.ts) implements Ed25519 sign/verify/
--   rotate. P2997 adds NO new proof tables or columns and reuses that layer.
--
--   This migration builds ONLY the net-new STAKE layer:
--     1. agent_registry.stake_microcents  — current bonded stake (integer microcents)
--     2. agent_registry.stake_status      — active | slashed | returned
--     3. agent_registry.is_legacy         — explicit legacy/unsigned scope flag
--     4. roadmap_workforce.stake_ledger   — append-only stake event log keyed
--        to failure_class, layered OVER (not duplicating) the cost ledger in
--        roadmap_efficiency.agent_budget_ledger.
--
-- Stake is denominated in MICROCENTS (1 cent = 10000 microcents) to stay
-- integer-exact and to align with the existing cost ledger's USD-cents
-- accounting without float drift. Returned-on-success / slashed-on-failure
-- semantics are enforced in src/infra/agency/stake-admission.ts at three
-- chokepoints (claimOne pre-claim, completion handler post-work, quota-refund
-- post-completion).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint + CREATE TABLE IF
-- NOT EXISTS. No inner BEGIN/COMMIT so the file is safe to wrap in a single
-- transaction by the migration runner.

SET search_path TO roadmap_workforce, public;

-- 1. Stake columns on agent_registry -----------------------------------------

ALTER TABLE roadmap_workforce.agent_registry
    ADD COLUMN IF NOT EXISTS stake_microcents bigint  NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stake_status     text    NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS is_legacy        boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN roadmap_workforce.agent_registry.stake_microcents IS
    'P2997: current bonded stake in microcents (1 cent = 10000 microcents). '
    'Deducted on failure (slash) keyed to failure_class; returned to the pool on '
    'successful delivery. 0 = no stake bonded.';

COMMENT ON COLUMN roadmap_workforce.agent_registry.stake_status IS
    'P2997: stake lifecycle state. active=bond intact and admissible; '
    'slashed=bond fully consumed by failures, agent rejected at claim; '
    'returned=bond returned after clean completion/withdrawal.';

COMMENT ON COLUMN roadmap_workforce.agent_registry.is_legacy IS
    'P2997: explicit legacy/unsigned scope flag. true = agent has no usable '
    'crypto identity (no public_key) and/or no stake; admitted only to '
    'non-blocking proposals under the existing AGENTHIVE_AUTH_REQUIRED soft-fail '
    'proof policy. Set true automatically on key-validity downgrade.';

-- stake_status domain guard (guarded so re-run does not error)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_registry_stake_status_check'
          AND conrelid = 'roadmap_workforce.agent_registry'::regclass
    ) THEN
        ALTER TABLE roadmap_workforce.agent_registry
            ADD CONSTRAINT agent_registry_stake_status_check
            CHECK (stake_status IN ('active', 'slashed', 'returned'));
    END IF;
END $$;

-- stake can never go negative
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'agent_registry_stake_nonneg_check'
          AND conrelid = 'roadmap_workforce.agent_registry'::regclass
    ) THEN
        ALTER TABLE roadmap_workforce.agent_registry
            ADD CONSTRAINT agent_registry_stake_nonneg_check
            CHECK (stake_microcents >= 0);
    END IF;
END $$;

-- 2. Append-only stake event ledger ------------------------------------------

CREATE TABLE IF NOT EXISTS roadmap_workforce.stake_ledger (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_identity   text   NOT NULL
        REFERENCES roadmap_workforce.agent_registry (agent_identity)
        ON DELETE CASCADE,
    -- event_type: bond=initial stake posted; slash=deducted on failure;
    -- return=returned on success; downgrade=moved to legacy scope.
    event_type       text   NOT NULL,
    -- signed delta in microcents: negative for slash, positive for bond/return.
    delta_microcents bigint NOT NULL,
    -- resulting stake_microcents after applying this delta (running balance).
    balance_after    bigint NOT NULL,
    -- failure_class taxonomy reused from migration 184 (squad_dispatch); the
    -- ONLY class that slashes is 'unknown' (genuine non-transient failure).
    -- Transient classes (auth_rejected, rate_limited, quota_exhausted,
    -- no_eligible_agency, lease_expired) NEVER slash. NULL for non-slash events.
    failure_class    text   NULL,
    -- the dispatch this event is attributed to (NULL for manual bond/return).
    dispatch_id      bigint NULL,
    proposal_id      bigint NULL,
    reason           text   NULL,
    recorded_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE roadmap_workforce.stake_ledger IS
    'P2997: append-only stake event log. One row per bond/slash/return/downgrade. '
    'Layered over roadmap_efficiency.agent_budget_ledger (cost accounting) — this '
    'ledger records BOND accounting, not token cost. balance_after gives an '
    'auditable running stake balance per agent.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'stake_ledger_event_type_check'
          AND conrelid = 'roadmap_workforce.stake_ledger'::regclass
    ) THEN
        ALTER TABLE roadmap_workforce.stake_ledger
            ADD CONSTRAINT stake_ledger_event_type_check
            CHECK (event_type IN ('bond', 'slash', 'return', 'downgrade'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_stake_ledger_agent_recorded
    ON roadmap_workforce.stake_ledger (agent_identity, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_stake_ledger_dispatch
    ON roadmap_workforce.stake_ledger (dispatch_id)
    WHERE dispatch_id IS NOT NULL;

-- Verification (commented) ----------------------------------------------------
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_schema='roadmap_workforce' AND table_name='agent_registry'
--     AND column_name IN ('stake_microcents','stake_status','is_legacy');
-- SELECT conname FROM pg_constraint
--   WHERE conrelid='roadmap_workforce.stake_ledger'::regclass;
