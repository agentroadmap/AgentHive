-- 022-schema-grants-agent-users.sql
-- Description: Fix zero-access gap — grant USAGE + table permissions on all
--              post-refactor schemas to agent roles.
-- Date: 2026-04-13
-- Requires: 007-agent-security-roles.sql, 008-create-agent-users.sql
--
-- After the schema refactor (migrations 009–021) all tables moved from
-- public → roadmap, roadmap_proposal, roadmap_workforce, roadmap_efficiency,
-- metrics, token_cache.  The existing agent_read/agent_write grants in 007
-- target only `public`, leaving every agent user with zero access to the
-- actual tables.
--
-- Role hierarchy (confirmed live):
--   roadmap_agent (group)
--     ├── agent_read  (SELECT)
--     └── agent_write (INSERT/UPDATE + inherits agent_read)
--         └── admin_write (DELETE/TRUNCATE + inherits agent_write)
--
-- Login users:
--   claude, gary, agent_claude_one, agent_xiaomi_one → roadmap_agent member
--   xiaomi, agent_andy, agent_bob, … → agent_write member
--
-- Strategy: grant to roles (inherited by all members), not individual users.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SCHEMA USAGE
--    Grant USAGE on every application schema to the two root roles.
--    roadmap_agent covers claude / gary / agent_*_one
--    agent_write   covers xiaomi and any future user not in roadmap_agent
-- ═══════════════════════════════════════════════════════════════════════════

GRANT USAGE ON SCHEMA
    roadmap,
    roadmap_proposal,
    roadmap_workforce,
    roadmap_efficiency,
    metrics,
    token_cache
TO roadmap_agent, agent_write;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. READ ACCESS (agent_read)
--    SELECT on all tables + sequences in every schema.
-- ═══════════════════════════════════════════════════════════════════════════

-- roadmap
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap TO agent_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA roadmap TO agent_read;

-- roadmap_proposal
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_proposal TO agent_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA roadmap_proposal TO agent_read;

-- roadmap_workforce
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_workforce TO agent_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA roadmap_workforce TO agent_read;

-- roadmap_efficiency
GRANT SELECT ON ALL TABLES IN SCHEMA roadmap_efficiency TO agent_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA roadmap_efficiency TO agent_read;

-- metrics
GRANT SELECT ON ALL TABLES IN SCHEMA metrics TO agent_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA metrics TO agent_read;

-- token_cache
GRANT SELECT ON ALL TABLES IN SCHEMA token_cache TO agent_read;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA token_cache TO agent_read;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. WRITE ACCESS (agent_write)
--    INSERT/UPDATE on safe write surfaces.  DELETE is NOT granted here —
--    destructive ops require admin_write or explicit USER approval.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── roadmap schema ───────────────────────────────────────────────────────

-- Sequence access (needed for IDENTITY columns on INSERT)
GRANT USAGE ON ALL SEQUENCES IN SCHEMA roadmap TO agent_write;

GRANT INSERT, UPDATE ON TABLE
    roadmap.notification_queue,
    roadmap.transition_queue,
    roadmap.run_log,
    roadmap.message_ledger,
    roadmap.research_cache,
    roadmap.decision_queue,
    roadmap.escalation_log,
    roadmap.knowledge_entries,
    roadmap.extracted_patterns,
    roadmap.audit_log,
    roadmap.mentions,
    roadmap.protocol_threads,
    roadmap.protocol_replies,
    roadmap.channel_subscription,
    roadmap.documents,
    roadmap.document_versions,
    roadmap.worktree_merge_log,
    roadmap.scheduled_job,
    roadmap.resource_allocation,
    roadmap.workflow_roles
TO agent_write;

-- Agents may read and update their own app_config / model_assignment rows
GRANT SELECT, UPDATE ON TABLE
    roadmap.app_config,
    roadmap.model_assignment,
    roadmap.model_metadata
TO agent_write;
GRANT INSERT ON TABLE
    roadmap.model_assignment
TO agent_write;

-- Cubics: agents create and transition their own cubics
GRANT INSERT, UPDATE ON TABLE roadmap.cubics TO agent_write;

-- ─── roadmap_proposal schema ─────────────────────────────────────────────

GRANT USAGE ON ALL SEQUENCES IN SCHEMA roadmap_proposal TO agent_write;

-- Full proposal lifecycle
GRANT INSERT ON TABLE
    roadmap_proposal.proposal,
    roadmap_proposal.proposal_acceptance_criteria,
    roadmap_proposal.proposal_decision,
    roadmap_proposal.proposal_dependencies,
    roadmap_proposal.proposal_discussions,
    roadmap_proposal.proposal_event,
    roadmap_proposal.proposal_lease,
    roadmap_proposal.proposal_maturity_transitions,
    roadmap_proposal.proposal_state_transitions,
    roadmap_proposal.proposal_version,
    roadmap_proposal.proposal_versions,
    roadmap_proposal.proposal_reviews,
    roadmap_proposal.gate_decision_log,
    roadmap_proposal.proposal_projection_cache
TO agent_write;

-- Safe UPDATE columns on proposals (no structural fields or IDs)
GRANT UPDATE (
    status, maturity, title, summary, motivation, design, drawbacks,
    alternatives, dependency, priority, tags, audit, modified_at
) ON TABLE roadmap_proposal.proposal TO agent_write;

-- Leases: agents claim and release
GRANT UPDATE ON TABLE roadmap_proposal.proposal_lease TO agent_write;

-- ACs and dependencies: agents manage their own
GRANT UPDATE, DELETE ON TABLE
    roadmap_proposal.proposal_acceptance_criteria,
    roadmap_proposal.proposal_dependencies
TO agent_write;

-- Projection cache: full lifecycle
GRANT UPDATE, DELETE ON TABLE
    roadmap_proposal.proposal_projection_cache
TO agent_write;

-- ─── roadmap_workforce schema ─────────────────────────────────────────────

GRANT USAGE ON ALL SEQUENCES IN SCHEMA roadmap_workforce TO agent_write;

GRANT INSERT, UPDATE ON TABLE
    roadmap_workforce.agent_registry,
    roadmap_workforce.agent_runs,
    roadmap_workforce.agent_health,
    roadmap_workforce.agent_heartbeat_log,
    roadmap_workforce.agent_workload,
    roadmap_workforce.agent_capability,
    roadmap_workforce.agent_conflicts,
    roadmap_workforce.squad_dispatch,
    roadmap_workforce.team,
    roadmap_workforce.team_member,
    roadmap_workforce.agency_profile
TO agent_write;

-- Trust: agents may insert trust records (reviewed, not arbitrary update)
GRANT INSERT ON TABLE roadmap_workforce.agent_trust TO agent_write;

-- ─── roadmap_efficiency schema ────────────────────────────────────────────

GRANT USAGE ON ALL SEQUENCES IN SCHEMA roadmap_efficiency TO agent_write;

GRANT INSERT, UPDATE ON TABLE
    roadmap_efficiency.agent_budget_ledger,
    roadmap_efficiency.agent_memory,
    roadmap_efficiency.cache_hit_log,
    roadmap_efficiency.cache_write_log,
    roadmap_efficiency.context_window_log,
    roadmap_efficiency.spending_log,
    roadmap_efficiency.api_buffer
TO agent_write;

-- Budget: agents read caps and circuit-breaker state; admin sets them
GRANT SELECT ON TABLE
    roadmap_efficiency.spending_caps,
    roadmap_efficiency.budget_allowance,
    roadmap_efficiency.budget_circuit_breaker
TO agent_write;

-- ─── metrics schema ──────────────────────────────────────────────────────

GRANT USAGE ON ALL SEQUENCES IN SCHEMA metrics TO agent_write;

GRANT INSERT, UPDATE ON TABLE metrics.token_efficiency TO agent_write;

-- ─── token_cache schema ──────────────────────────────────────────────────

GRANT USAGE ON ALL SEQUENCES IN SCHEMA token_cache TO agent_write;

GRANT INSERT, UPDATE ON TABLE token_cache.semantic_responses TO agent_write;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ADMIN WRITE (admin_write)
--    DELETE + TRUNCATE on core tables.  admin_write already inherits
--    agent_write via pg_auth_members (granted in 007).
-- ═══════════════════════════════════════════════════════════════════════════

GRANT DELETE ON TABLE
    roadmap_proposal.proposal,
    roadmap_proposal.proposal_acceptance_criteria,
    roadmap_proposal.proposal_dependencies,
    roadmap_proposal.proposal_discussions,
    roadmap_proposal.proposal_lease,
    roadmap_proposal.proposal_event,
    roadmap_proposal.proposal_reviews,
    roadmap_proposal.gate_decision_log,
    roadmap.notification_queue,
    roadmap.transition_queue,
    roadmap.message_ledger,
    roadmap.escalation_log,
    roadmap.knowledge_entries,
    roadmap.audit_log,
    roadmap.worktree_merge_log,
    roadmap_workforce.agent_runs,
    roadmap_workforce.agent_registry,
    roadmap_workforce.squad_dispatch,
    roadmap_efficiency.agent_budget_ledger,
    roadmap_efficiency.spending_log,
    roadmap_efficiency.cache_hit_log,
    metrics.token_efficiency,
    token_cache.semantic_responses
TO admin_write;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. DEFAULT PRIVILEGES
--    Ensure any future tables/sequences created by andy (schema owner) in
--    these schemas automatically inherit the same access pattern.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap
    GRANT SELECT ON TABLES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap
    GRANT SELECT ON SEQUENCES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap
    GRANT USAGE ON SEQUENCES TO agent_write;

ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_proposal
    GRANT SELECT ON TABLES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_proposal
    GRANT SELECT ON SEQUENCES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_proposal
    GRANT USAGE ON SEQUENCES TO agent_write;

ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_workforce
    GRANT SELECT ON TABLES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_workforce
    GRANT SELECT ON SEQUENCES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_workforce
    GRANT USAGE ON SEQUENCES TO agent_write;

ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_efficiency
    GRANT SELECT ON TABLES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_efficiency
    GRANT SELECT ON SEQUENCES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA roadmap_efficiency
    GRANT USAGE ON SEQUENCES TO agent_write;

ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA metrics
    GRANT SELECT ON TABLES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA metrics
    GRANT SELECT ON SEQUENCES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA metrics
    GRANT USAGE ON SEQUENCES TO agent_write;

ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA token_cache
    GRANT SELECT ON TABLES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA token_cache
    GRANT SELECT ON SEQUENCES TO agent_read;
ALTER DEFAULT PRIVILEGES FOR ROLE andy IN SCHEMA token_cache
    GRANT USAGE ON SEQUENCES TO agent_write;

COMMIT;

-- ─── Verification queries ──────────────────────────────────────────────────
-- Run after migration to confirm access:
--
-- Check USAGE grants:
-- SELECT n.nspname, r.rolname,
--        has_schema_privilege(r.rolname, n.nspname, 'USAGE') AS usage
-- FROM pg_namespace n, pg_roles r
-- WHERE n.nspname IN ('roadmap','roadmap_proposal','roadmap_workforce',
--                     'roadmap_efficiency','metrics','token_cache')
--   AND r.rolname IN ('agent_read','agent_write','roadmap_agent','claude','xiaomi')
-- ORDER BY n.nspname, r.rolname;
--
-- Check table grants on agent_runs:
-- SELECT grantee, privilege_type
-- FROM information_schema.role_table_grants
-- WHERE table_schema = 'roadmap_workforce'
--   AND table_name = 'agent_runs'
--   AND grantee IN ('agent_read','agent_write','admin_write')
-- ORDER BY grantee, privilege_type;
