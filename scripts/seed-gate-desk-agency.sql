-- seed-gate-desk-agency.sql  (P3840 Part 2)
--
-- Registers the dedicated `gate-desk` gating agency so postWorkOffer's pre-flight
-- capability check finds an active agency advertising the `gate_review` job and
-- POSTS the deliberate gate offer OPEN (instead of throwing CapabilityMismatchError
-- and inserting nothing).
--
-- WHY a dedicated identity (not the worker liaison):
--   * The worker liaison `claude-bot-gary.a` advertises only
--     ["develop","review","design","research","proposal_management","code_generation"]
--     — it does NOT advertise `gate_review`, so it will never match/claim a
--     gate-review offer (required_capabilities=['gate_review']).
--   * `gate-desk` advertises ONLY `gate_review`. It is deliberately NOT added to
--     AGENTHIVE_SELF_CLAIM_AGENCIES (see src/infra/agency/liaison-agent.ts), so no
--     AgencyClaimLoop self-claims on its behalf. The offer therefore sits OPEN in
--     the pool until a qualified gater (operator via board, or an authority-granted
--     gating identity) claims it and calls gate_decision deliberately.
--
-- agent_registry.status MUST be 'active' for the capability pre-flight to pass
-- (the SELECT in post-work-offer.ts requires ar.status='active'). That is purely a
-- capability ADVERTISEMENT — it does not make gate-desk dispatchable: dispatch /
-- spawning is governed by the self-claim allowlist + heartbeat-derived
-- dispatchability, neither of which gate-desk participates in. We pin
-- max_concurrent_claims=0 as belt-and-suspenders so even a stray claim path can't
-- assign work to it.
--
-- Idempotent: safe to run repeatedly. Run AFTER migration 295 and BEFORE flipping
-- AGENTHIVE_DELIBERATE_GATE_OFFERS_ENABLED on.

BEGIN;

-- ─── (1) agent_registry: the gate-desk agency ────────────────────────────────
-- agent_type='agency' (NOT 'coordinator', so it survives the capability filter).
-- role='gate-desk' (NOT 'interactive-session'). status='active'.
INSERT INTO roadmap_workforce.agent_registry
    (agent_identity, agent_type, role, preferred_provider, host_affinity, status,
     max_concurrent_claims)
VALUES
    ('gate-desk', 'agency', 'gate-desk', 'anthropic', 'bot', 'active', 0)
ON CONFLICT (agent_identity) DO UPDATE SET
    agent_type            = EXCLUDED.agent_type,
    role                  = EXCLUDED.role,
    status                = 'active',
    max_concurrent_claims = 0;

-- ─── (2) provider_registry: advertise the gate_review job ────────────────────
-- capabilities->'jobs' MUST be a JSON array (the pre-flight uses the ?| operator:
-- `(pr.capabilities->'jobs') ?| ARRAY['gate_review']`). project_id / squad_name
-- NULL = all projects / all squads. status='active' (CHECK allows active|paused).
INSERT INTO roadmap_workforce.provider_registry
    (agency_id, agency_identity, project_id, squad_name, capabilities, is_active, status)
SELECT
    ar.id,
    'gate-desk',
    NULL,
    NULL,
    '{"jobs": ["gate_review"]}'::jsonb,
    true,
    'active'
FROM roadmap_workforce.agent_registry ar
WHERE ar.agent_identity = 'gate-desk'
ON CONFLICT (agency_id, project_id, squad_name) DO UPDATE SET
    agency_identity = EXCLUDED.agency_identity,
    capabilities    = EXCLUDED.capabilities,
    is_active       = true,
    status          = 'active',
    updated_at      = now();

COMMIT;

-- Verification (run manually after applying):
--   SELECT ar.agent_identity, ar.status, ar.agent_type, pr.capabilities->'jobs'
--     FROM roadmap_workforce.provider_registry pr
--     JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
--    WHERE ar.agent_identity = 'gate-desk';
--   -- Expect: gate-desk | active | agency | ["gate_review"]
--
--   -- Confirm the pre-flight capability query now returns count=1 for gate_review:
--   SELECT count(*)::int
--     FROM roadmap_workforce.provider_registry pr
--     JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
--    WHERE pr.status NOT IN ('offline','retired')
--      AND ar.status = 'active'
--      AND ar.agent_type <> 'coordinator'
--      AND ar.role <> 'interactive-session'
--      AND ar.agent_identity NOT LIKE 'test/%'
--      AND (pr.capabilities->'jobs') ?| ARRAY['gate_review'];
