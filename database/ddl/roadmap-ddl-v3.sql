-- =============================================================================
-- ROADMAP SCHEMA — v3 (consolidated)
-- Generated: 2026-04-07
-- Source: roadmap-ddl-v2.sql + roadmap-ddl-v2-additions.sql + roadmap-ddl-v2.1.sql
-- Schema: roadmap
-- Pillars: Product Development · Workforce Management · Efficiency · Utility
--
-- This is the single authoritative DDL. Run on a fresh database.
-- ALTER TABLE changes from the additions file are incorporated inline.
-- Functions use their final (additions) versions where they were updated.
-- =============================================================================

BEGIN;

-- ─── Prerequisites ────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;      -- pgvector: semantic search
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram: keyword fallback search

CREATE SCHEMA IF NOT EXISTS roadmap;
SET search_path TO roadmap, public;


-- =============================================================================
-- SECTION 1 — CORE LOOKUP TABLES (no FK deps)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1a. model_metadata — LLM catalogue with cost and capability metadata
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.model_metadata (
    id                  int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    model_name          text          NOT NULL,
    provider            text          NOT NULL,
    cost_per_1k_input   numeric(14,6) NULL,
    cost_per_1k_output  numeric(14,6) NULL,
    max_tokens          int4          NULL,
    context_window      int4          NULL,
    capabilities        jsonb         NULL,   -- {"vision":true,"tool_use":true,"cache":true}
    rating              int4          NULL,
    is_active           bool          DEFAULT true NOT NULL,
    created_at          timestamptz   DEFAULT now() NOT NULL,
    updated_at          timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT model_metadata_pkey           PRIMARY KEY (id),
    CONSTRAINT model_metadata_model_name_key UNIQUE (model_name),
    CONSTRAINT model_metadata_rating_check   CHECK (rating BETWEEN 1 AND 5)
);
COMMENT ON TABLE  roadmap.model_metadata IS 'Catalogue of LLM models with cost and capability metadata';
COMMENT ON COLUMN roadmap.model_metadata.cost_per_1k_input IS 'USD per 1k input tokens — 6dp to capture sub-cent pricing';
COMMENT ON COLUMN roadmap.model_metadata.context_window    IS 'Maximum context window in tokens';
COMMENT ON COLUMN roadmap.model_metadata.capabilities      IS 'Feature flags: vision, tool_use, cache, json_mode, etc.';


-- ---------------------------------------------------------------------------
-- 1b. maturity — lookup for integer maturity levels (0–3)
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.maturity (
    level        int4  NOT NULL,
    name         text  NOT NULL,
    description  text  NULL,
    CONSTRAINT maturity_pkey        PRIMARY KEY (level),
    CONSTRAINT maturity_name_key    UNIQUE (name),
    CONSTRAINT maturity_level_check CHECK (level >= 0)
);
COMMENT ON TABLE roadmap.maturity IS 'Lookup defining what each integer maturity level means; referenced by workflow_stages.maturity_gate. Scale 0-3 plus Obsolete state.';

INSERT INTO roadmap.maturity (level, name, description) VALUES
    (0, 'New',      'Proposal just created; transit to a new state'),
    (1, 'Active',   'Author is actively researching, enhancing, developing, merging or fully integrated with other features or components'),
    (2, 'Mature',   'Decision gating decides this is ready for next state'),
    (3, 'Obsolete', 'Regardless of state, this proposal is no longer relevant or valid; could be replaced or superseded, decided at discretion of governing body.');


-- =============================================================================
-- SECTION 2 — WORKFORCE TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 2a. agent_registry — registry of all agents (human or AI)
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.agent_registry (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity  text        NOT NULL,
    agent_type      text        NOT NULL,   -- 'human' | 'llm' | 'tool' | 'hybrid'
    role            text        NULL,
    skills          jsonb       NULL,
    preferred_model text        NULL,
    status          text        DEFAULT 'active' NOT NULL,
    github_handle   text        NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT agent_registry_pkey               PRIMARY KEY (id),
    CONSTRAINT agent_registry_agent_identity_key UNIQUE (agent_identity),
    CONSTRAINT agent_registry_type_check         CHECK (agent_type IN ('human','llm','tool','hybrid')),
    CONSTRAINT agent_registry_status_check       CHECK (status IN ('active','inactive','suspended')),
    CONSTRAINT agent_registry_model_fkey         FOREIGN KEY (preferred_model)
        REFERENCES roadmap.model_metadata (model_name) ON DELETE SET NULL
);
COMMENT ON TABLE  roadmap.agent_registry IS 'Registry of all agents (human or AI) participating in the roadmap system';
COMMENT ON COLUMN roadmap.agent_registry.agent_identity IS 'Stable unique handle used across all tables as a text reference';
COMMENT ON COLUMN roadmap.agent_registry.preferred_model IS 'Default model for LLM agents; null for human agents';


-- ---------------------------------------------------------------------------
-- 2b. spending_caps — per-agent daily/monthly spend limits
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.spending_caps (
    agent_identity    text          NOT NULL,
    daily_limit_usd   numeric(12,2) NULL,
    monthly_limit_usd numeric(14,2) NULL,
    is_frozen         bool          DEFAULT false NOT NULL,
    frozen_reason     text          NULL,
    updated_at        timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT spending_caps_pkey       PRIMARY KEY (agent_identity),
    CONSTRAINT spending_caps_agent_fkey FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE CASCADE
);
COMMENT ON TABLE  roadmap.spending_caps IS 'Per-agent spend limits; daily totals derived from spending_log, never stored here';
COMMENT ON COLUMN roadmap.spending_caps.is_frozen IS 'When true, agent cannot incur further costs until manually unfrozen';


-- ---------------------------------------------------------------------------
-- 2c. team + team_member
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.team (
    id          int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    team_name   text        NOT NULL,
    team_type   text        NULL,   -- 'feature' | 'ops' | 'research' | 'admin'
    status      text        DEFAULT 'active' NOT NULL,
    created_at  timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT team_pkey         PRIMARY KEY (id),
    CONSTRAINT team_name_key     UNIQUE (team_name),
    CONSTRAINT team_status_check CHECK (status IN ('active','archived'))
);

CREATE TABLE roadmap.team_member (
    id        int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    team_id   int8        NOT NULL,
    agent_id  int8        NOT NULL,
    role      text        NULL,
    joined_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT team_member_pkey        PRIMARY KEY (id),
    CONSTRAINT team_member_unique      UNIQUE (team_id, agent_id),
    CONSTRAINT team_member_team_fkey   FOREIGN KEY (team_id)  REFERENCES roadmap.team (id) ON DELETE CASCADE,
    CONSTRAINT team_member_agent_fkey  FOREIGN KEY (agent_id) REFERENCES roadmap.agent_registry (id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- 2d. resource_allocation — agent resource/tool mapping
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.resource_allocation (
    id            int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_id      int8        NOT NULL,
    resource_type text        NOT NULL,   -- 'api_key' | 'worktree' | 'workspace' | 'mcp_tool' | 'budget'
    resource_key  text        NOT NULL,   -- encrypted ref or path; never store raw secrets
    label         text        NULL,
    is_active     bool        DEFAULT true NOT NULL,
    expires_at    timestamptz NULL,
    created_at    timestamptz DEFAULT now() NOT NULL,
    updated_at    timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT resource_allocation_pkey       PRIMARY KEY (id),
    CONSTRAINT resource_allocation_type_check CHECK (resource_type IN ('api_key','worktree','workspace','mcp_tool','budget')),
    CONSTRAINT resource_allocation_agent_fkey FOREIGN KEY (agent_id)
        REFERENCES roadmap.agent_registry (id) ON DELETE CASCADE
);
COMMENT ON TABLE  roadmap.resource_allocation IS 'Maps agents to allocated resources: API keys, worktrees, workspaces, MCP tools';
COMMENT ON COLUMN roadmap.resource_allocation.resource_key IS 'Encrypted identifier or path; never store raw secrets here';


-- ---------------------------------------------------------------------------
-- 2e. acl — access control list
--     Additions: added expires_at, scope_ref columns
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.acl (
    id         int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    subject    text        NOT NULL,   -- agent_identity or 'team:<team_name>'
    resource   text        NOT NULL,   -- workflow name, table name, or '*'
    action     text        NOT NULL,   -- 'read' | 'write' | 'approve' | 'transition' | 'admin'
    granted    bool        DEFAULT true NOT NULL,
    granted_by text        NOT NULL,
    granted_at timestamptz DEFAULT now() NOT NULL,
    expires_at timestamptz NULL,       -- NULL = permanent grant
    scope_ref  text        NULL,       -- proposal display_id, team name, or workflow name — narrows the grant
    CONSTRAINT acl_pkey                        PRIMARY KEY (id),
    CONSTRAINT acl_subject_resource_action_key UNIQUE (subject, resource, action),
    CONSTRAINT acl_action_check                CHECK (action IN ('read','write','approve','transition','admin'))
);
CREATE INDEX idx_acl_expires ON roadmap.acl (expires_at) WHERE expires_at IS NOT NULL;
COMMENT ON TABLE  roadmap.acl IS 'Access control list binding subjects (agents/teams) to permitted actions on resources';
COMMENT ON COLUMN roadmap.acl.expires_at IS 'NULL = permanent grant; non-null = time-bounded permission, cleaned up by scheduled_job';
COMMENT ON COLUMN roadmap.acl.scope_ref  IS 'Optional scoping: proposal display_id, team name, or workflow name — narrows the grant';


-- ---------------------------------------------------------------------------
-- 2f. agency_profile — agent profile loaded from GitHub
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.agency_profile (
    id            int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_id      int8        NOT NULL,
    github_repo   text        NOT NULL,   -- 'org/repo'
    branch        text        DEFAULT 'main' NOT NULL,
    commit_sha    text        NULL,
    profile_path  text        DEFAULT 'agent.json' NOT NULL,
    last_synced_at timestamptz NULL,
    sync_status   text        DEFAULT 'pending' NOT NULL,
    sync_error    text        NULL,
    profile_data  jsonb       NULL,   -- cached parsed profile
    created_at    timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT agency_profile_pkey         PRIMARY KEY (id),
    CONSTRAINT agency_profile_agent_key    UNIQUE (agent_id),
    CONSTRAINT agency_profile_status_check CHECK (sync_status IN ('pending','syncing','ok','error')),
    CONSTRAINT agency_profile_agent_fkey   FOREIGN KEY (agent_id)
        REFERENCES roadmap.agent_registry (id) ON DELETE CASCADE
);
COMMENT ON TABLE  roadmap.agency_profile IS 'Agent profile loaded from a GitHub repo; synced on demand or on schedule';
COMMENT ON COLUMN roadmap.agency_profile.profile_data IS 'Cached copy of parsed agent.json; refreshed on each successful sync';


-- ---------------------------------------------------------------------------
-- 2g. budget_allowance — named budget envelopes
--     Additions: added team_id FK
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.budget_allowance (
    id             int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    label          text          NOT NULL,
    owner_identity text          NOT NULL,   -- agent_identity or team_name
    scope          text          NOT NULL,   -- 'global' | 'proposal' | 'team'
    scope_ref      text          NULL,       -- proposal display_id or team_name
    allocated_usd  numeric(14,2) NOT NULL,
    consumed_usd   numeric(14,6) DEFAULT 0 NOT NULL,   -- maintained by trigger
    is_active      bool          DEFAULT true NOT NULL,
    valid_from     timestamptz   DEFAULT now() NOT NULL,
    valid_until    timestamptz   NULL,
    created_at     timestamptz   DEFAULT now() NOT NULL,
    team_id        int8          NULL,
    CONSTRAINT budget_allowance_pkey        PRIMARY KEY (id),
    CONSTRAINT budget_allowance_scope_check CHECK (scope IN ('global','proposal','team')),
    CONSTRAINT budget_allowance_positive    CHECK (allocated_usd > 0),
    CONSTRAINT budget_allowance_team_fkey   FOREIGN KEY (team_id)
        REFERENCES roadmap.team (id) ON DELETE SET NULL
);
CREATE INDEX idx_budget_team ON roadmap.budget_allowance (team_id) WHERE team_id IS NOT NULL;
COMMENT ON TABLE  roadmap.budget_allowance IS 'Named budget envelopes; consumed_usd maintained by spending_log insert trigger';
COMMENT ON COLUMN roadmap.budget_allowance.team_id IS 'FK to team when scope=team; replaces opaque scope_ref text for team envelopes';


-- ---------------------------------------------------------------------------
-- 2h. agent_capability — structured capability rows (queryable routing)
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.agent_capability (
    id           int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_id     int8        NOT NULL,
    capability   text        NOT NULL,
    proficiency  int4        DEFAULT 3 NOT NULL,
    verified_by  text        NULL,
    verified_at  timestamptz NULL,
    notes        text        NULL,
    created_at   timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT agent_capability_pkey            PRIMARY KEY (id),
    CONSTRAINT agent_capability_agent_cap_key   UNIQUE (agent_id, capability),
    CONSTRAINT agent_capability_proficiency_chk CHECK (proficiency BETWEEN 1 AND 5),
    CONSTRAINT agent_capability_agent_fkey      FOREIGN KEY (agent_id)
        REFERENCES roadmap.agent_registry (id) ON DELETE CASCADE,
    CONSTRAINT agent_capability_verifier_fkey   FOREIGN KEY (verified_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE SET NULL
);
CREATE INDEX idx_capability_agent       ON roadmap.agent_capability (agent_id);
CREATE INDEX idx_capability_term        ON roadmap.agent_capability (capability);
CREATE INDEX idx_capability_proficiency ON roadmap.agent_capability (capability, proficiency);
COMMENT ON TABLE  roadmap.agent_capability IS 'Structured capability rows; replaces opaque skills jsonb for queryable routing';
COMMENT ON COLUMN roadmap.agent_capability.capability  IS 'Controlled term, e.g. python, architecture-review, security-audit, llm-prompting';
COMMENT ON COLUMN roadmap.agent_capability.proficiency IS '1=novice, 3=competent, 5=expert';


-- ---------------------------------------------------------------------------
-- 2i. agent_workload — live capacity snapshot per agent
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.agent_workload (
    agent_id           int8          NOT NULL,
    active_lease_count int4          DEFAULT 0 NOT NULL,
    context_load_score numeric(6,2)  DEFAULT 0 NOT NULL,
    updated_at         timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT agent_workload_pkey        PRIMARY KEY (agent_id),
    CONSTRAINT agent_workload_agent_fkey  FOREIGN KEY (agent_id)
        REFERENCES roadmap.agent_registry (id) ON DELETE CASCADE,
    CONSTRAINT agent_workload_count_check CHECK (active_lease_count >= 0)
);
COMMENT ON TABLE  roadmap.agent_workload IS 'Live capacity snapshot per agent; maintained by proposal_lease triggers';
COMMENT ON COLUMN roadmap.agent_workload.context_load_score IS 'Rolling estimate of context pressure; updated by application';
-- =============================================================================
-- SECTION 3 — WORKFLOW ENGINE
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 3a. workflow_templates
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.workflow_templates (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    name            text        NOT NULL,
    description     text        NULL,
    version         text        DEFAULT '1.0.0' NOT NULL,
    is_default      bool        DEFAULT false NOT NULL,
    is_system       bool        DEFAULT false NOT NULL,
    stage_count     int4        NULL,
    smdl_id         text        NULL,
    smdl_definition jsonb       NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    modified_at     timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT workflow_templates_pkey     PRIMARY KEY (id),
    CONSTRAINT workflow_templates_name_key UNIQUE (name)
);
COMMENT ON TABLE roadmap.workflow_templates IS 'Named workflow blueprints; bound to proposal types via proposal_type_config';


-- ---------------------------------------------------------------------------
-- 3b. workflow_roles
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.workflow_roles (
    id          int8  GENERATED ALWAYS AS IDENTITY NOT NULL,
    template_id int8  NOT NULL,
    role_name   text  NOT NULL,
    description text  NULL,
    clearance   int4  DEFAULT 1 NOT NULL,
    is_default  bool  DEFAULT false NOT NULL,
    CONSTRAINT workflow_roles_pkey          PRIMARY KEY (id),
    CONSTRAINT workflow_roles_tmpl_role_key UNIQUE (template_id, role_name),
    CONSTRAINT workflow_roles_template_fkey FOREIGN KEY (template_id)
        REFERENCES roadmap.workflow_templates (id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- 3c. workflow_stages
--     Additions: added maturity_gate FK to roadmap.maturity
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.workflow_stages (
    id            int8  GENERATED ALWAYS AS IDENTITY NOT NULL,
    template_id   int8  NOT NULL,
    stage_name    text  NOT NULL,
    stage_order   int4  NOT NULL,
    maturity_gate int4  DEFAULT 2 NULL,
    requires_ac   bool  DEFAULT false NOT NULL,
    gating_config jsonb NULL,
    CONSTRAINT workflow_stages_pkey               PRIMARY KEY (id),
    CONSTRAINT workflow_stages_tmpl_name_key      UNIQUE (template_id, stage_name),
    CONSTRAINT workflow_stages_tmpl_order_key     UNIQUE (template_id, stage_order),
    CONSTRAINT workflow_stages_template_fkey      FOREIGN KEY (template_id)
        REFERENCES roadmap.workflow_templates (id) ON DELETE CASCADE,
    CONSTRAINT workflow_stages_maturity_gate_fkey FOREIGN KEY (maturity_gate)
        REFERENCES roadmap.maturity (level) ON DELETE SET NULL
);


-- ---------------------------------------------------------------------------
-- 3d. workflow_transitions
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.workflow_transitions (
    id            int8   GENERATED ALWAYS AS IDENTITY NOT NULL,
    template_id   int8   NOT NULL,
    from_stage    text   NOT NULL,
    to_stage      text   NOT NULL,
    labels        text[] NULL,
    allowed_roles text[] NULL,
    requires_ac   bool   DEFAULT false NOT NULL,
    gating_rules  jsonb  NULL,
    CONSTRAINT workflow_transitions_pkey          PRIMARY KEY (id),
    CONSTRAINT workflow_transitions_tmpl_from_to  UNIQUE (template_id, from_stage, to_stage),
    CONSTRAINT workflow_transitions_template_fkey FOREIGN KEY (template_id)
        REFERENCES roadmap.workflow_templates (id) ON DELETE CASCADE
);


-- ---------------------------------------------------------------------------
-- 3e. proposal_type_config — binds a proposal type to a workflow template
--     Additions: added required_fields, optional_fields
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_type_config (
    type            text    NOT NULL,
    workflow_name   text    NOT NULL,
    description     text    NULL,
    is_active       bool    DEFAULT true NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    modified_at     timestamptz DEFAULT now() NOT NULL,
    required_fields text[]  DEFAULT ARRAY[]::text[] NOT NULL,
    optional_fields text[]  DEFAULT ARRAY[]::text[] NOT NULL,
    CONSTRAINT proposal_type_config_pkey    PRIMARY KEY (type),
    CONSTRAINT proposal_type_config_wf_fkey FOREIGN KEY (workflow_name)
        REFERENCES roadmap.workflow_templates (name) ON DELETE RESTRICT
);
COMMENT ON TABLE  roadmap.proposal_type_config IS 'Binds each proposal type to its workflow template; type → workflow is the authoritative mapping';
COMMENT ON COLUMN roadmap.proposal_type_config.workflow_name    IS 'Changing this affects new proposals of this type; in-flight proposals keep their existing workflow instance';
COMMENT ON COLUMN roadmap.proposal_type_config.required_fields  IS 'Proposal fields that must be non-null for this type, e.g. {motivation,design} for RFC';
COMMENT ON COLUMN roadmap.proposal_type_config.optional_fields  IS 'Fields shown in the editor for this type but not mandatory';


-- ---------------------------------------------------------------------------
-- 3f. proposal_valid_transitions — per-workflow allowed state machine edges
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_valid_transitions (
    id              int8   GENERATED ALWAYS AS IDENTITY NOT NULL,
    workflow_name   text   NOT NULL,
    from_state      text   NOT NULL,
    to_state        text   NOT NULL,
    allowed_reasons text[] NULL,
    allowed_roles   text[] NULL,
    requires_ac     text   DEFAULT 'none' NOT NULL,
    CONSTRAINT proposal_valid_transitions_pkey       PRIMARY KEY (id),
    CONSTRAINT proposal_valid_transitions_wf_from_to UNIQUE (workflow_name, from_state, to_state),
    CONSTRAINT proposal_valid_transitions_ac_check   CHECK (requires_ac IN ('none','all','critical')),
    CONSTRAINT proposal_valid_transitions_wf_fkey    FOREIGN KEY (workflow_name)
        REFERENCES roadmap.workflow_templates (name) ON DELETE RESTRICT
);
CREATE INDEX idx_pvt_from ON roadmap.proposal_valid_transitions (from_state);
CREATE INDEX idx_pvt_to   ON roadmap.proposal_valid_transitions (to_state);
COMMENT ON TABLE roadmap.proposal_valid_transitions IS 'Valid state machine edges per workflow; status values are open — validated here, not by a CHECK constraint on proposal';
-- =============================================================================
-- SECTION 4 — PROPOSAL CORE + SATELLITE TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 4a. proposal — central entity
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal (
    id                      int8    GENERATED ALWAYS AS IDENTITY NOT NULL,
    display_id              text    NOT NULL,
    parent_id               int8    NULL REFERENCES roadmap.proposal (id) ON DELETE SET NULL,
    type                    text    NOT NULL,
    status                  text    DEFAULT 'Draft'::text NOT NULL,
    maturity                jsonb   DEFAULT '{"Draft":"New"}'::jsonb NOT NULL,
    title                   text    NOT NULL,
    summary                 text    NULL,
    motivation              text    NULL,
    design                  text    NULL,
    drawbacks               text    NULL,
    alternatives            text    NULL,
    dependency              text    NULL,
    priority                text    NULL,
    body_vector             public.vector(1536) NULL,
    tags                    jsonb   NULL,
    audit                   jsonb   NOT NULL,
    blocked_by_dependencies bool    DEFAULT false NOT NULL,
    CONSTRAINT proposal_display_id_key UNIQUE (display_id),
    CONSTRAINT proposal_pkey           PRIMARY KEY (id)
);
CREATE INDEX idx_proposal_status ON roadmap.proposal (status);
CREATE INDEX idx_proposal_type   ON roadmap.proposal (type);
CREATE INDEX idx_proposal_parent ON roadmap.proposal (parent_id) WHERE parent_id IS NOT NULL;

COMMENT ON COLUMN roadmap.proposal.display_id              IS 'P+number id used in lists/display — P001, P042, P1001 — auto-filled by trigger';
COMMENT ON COLUMN roadmap.proposal.parent_id               IS 'Parent proposal id; constructs a hierarchical relation';
COMMENT ON COLUMN roadmap.proposal.type                    IS 'Controlled term for proposal type; dictates workflow via proposal_type_config';
COMMENT ON COLUMN roadmap.proposal.status                  IS 'Current state within the workflow state machine; values are open, validated against proposal_valid_transitions';
COMMENT ON COLUMN roadmap.proposal.maturity                IS '{"Draft":"Mature","Review":"Mature","Develop":"Active"}';
COMMENT ON COLUMN roadmap.proposal.priority                IS 'Loosely described priority in markdown; queue ordering is DAG-derived via v_proposal_queue, not this field';
COMMENT ON COLUMN roadmap.proposal.dependency              IS 'Prose description of dependencies; structured dependencies live in proposal_dependencies';
COMMENT ON COLUMN roadmap.proposal.body_vector             IS 'pgvector embedding for semantic search';
COMMENT ON COLUMN roadmap.proposal.tags                    IS 'Search tags; may include category, domain, and intelligently identified keywords';
COMMENT ON COLUMN roadmap.proposal.audit                   IS 'Array of audit events: [{"TS":"<iso8601>","Agent":"<name>","Activity":"<verb>","Reason":"<text>"}]';

-- FK: proposal.type → proposal_type_config (deferred so seed data can be inserted first)
ALTER TABLE roadmap.proposal
    ADD CONSTRAINT proposal_type_fkey
    FOREIGN KEY (type) REFERENCES roadmap.proposal_type_config (type) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;


-- ---------------------------------------------------------------------------
-- 4b. proposal_template — versioned content scaffolds per type
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_template (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    type            text        NOT NULL,
    version         int4        DEFAULT 1 NOT NULL,
    label           text        NOT NULL,
    is_default      bool        DEFAULT false NOT NULL,
    summary_md      text        NULL,
    motivation_md   text        NULL,
    design_md       text        NULL,
    drawbacks_md    text        NULL,
    alternatives_md text        NULL,
    created_by      text        NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_template_pkey         PRIMARY KEY (id),
    CONSTRAINT proposal_template_type_ver_key UNIQUE (type, version),
    CONSTRAINT proposal_template_type_fkey    FOREIGN KEY (type)
        REFERENCES roadmap.proposal_type_config (type) ON DELETE CASCADE,
    CONSTRAINT proposal_template_author_fkey  FOREIGN KEY (created_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_proposal_template_default ON roadmap.proposal_template (type) WHERE is_default = true;
CREATE INDEX idx_proposal_template_type ON roadmap.proposal_template (type);
COMMENT ON TABLE  roadmap.proposal_template IS 'Versioned content scaffolds per proposal type; default template is pre-filled by fn_spawn_workflow on insert';
COMMENT ON COLUMN roadmap.proposal_template.is_default IS 'Only one default per type; enforced by partial unique index';


-- ---------------------------------------------------------------------------
-- 4c. workflows — live workflow instance per proposal
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.workflows (
    id            int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    template_id   int8        NOT NULL,
    proposal_id   int8        NOT NULL,
    current_stage text        NOT NULL,
    started_at    timestamptz DEFAULT now() NOT NULL,
    completed_at  timestamptz NULL,
    CONSTRAINT workflows_pkey           PRIMARY KEY (id),
    CONSTRAINT workflows_proposal_key   UNIQUE (proposal_id),
    CONSTRAINT workflows_template_fkey  FOREIGN KEY (template_id)
        REFERENCES roadmap.workflow_templates (id) ON DELETE RESTRICT,
    CONSTRAINT workflows_proposal_fkey  FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE
);
CREATE INDEX idx_workflows_stage    ON roadmap.workflows (current_stage);
CREATE INDEX idx_workflows_template ON roadmap.workflows (template_id);
COMMENT ON TABLE roadmap.workflows IS 'Live workflow instance per proposal; template_id is the snapshot of the type config at creation time';


-- ---------------------------------------------------------------------------
-- 4d. proposal_acceptance_criteria
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_acceptance_criteria (
    id                 int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id        int8        NOT NULL,
    item_number        int4        NOT NULL,
    criterion_text     text        NOT NULL,
    status             text        DEFAULT 'pending' NOT NULL,
    verified_by        text        NULL,
    verification_notes text        NULL,
    verified_at        timestamptz NULL,
    created_at         timestamptz DEFAULT now() NOT NULL,
    updated_at         timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_ac_pkey          PRIMARY KEY (id),
    CONSTRAINT proposal_ac_proposal_item UNIQUE (proposal_id, item_number),
    CONSTRAINT proposal_ac_item_positive CHECK (item_number > 0),
    CONSTRAINT proposal_ac_status_check  CHECK (status IN ('pending','pass','fail','blocked','waived')),
    CONSTRAINT proposal_ac_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_ac_verifier_fkey FOREIGN KEY (verified_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE SET NULL
);
CREATE INDEX idx_ac_proposal ON roadmap.proposal_acceptance_criteria (proposal_id);
CREATE INDEX idx_ac_status   ON roadmap.proposal_acceptance_criteria (status);


-- ---------------------------------------------------------------------------
-- 4e. proposal_dependencies — DAG of dependencies
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_dependencies (
    id               int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    from_proposal_id int8        NOT NULL,
    to_proposal_id   int8        NOT NULL,
    dependency_type  text        DEFAULT 'blocks' NOT NULL,
    resolved         bool        DEFAULT false NOT NULL,
    resolved_at      timestamptz NULL,
    created_at       timestamptz DEFAULT now() NOT NULL,
    updated_at       timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_deps_pkey        PRIMARY KEY (id),
    CONSTRAINT proposal_deps_from_to_key UNIQUE (from_proposal_id, to_proposal_id),
    CONSTRAINT proposal_deps_no_self     CHECK (from_proposal_id <> to_proposal_id),
    CONSTRAINT proposal_deps_type_check  CHECK (dependency_type IN ('blocks','depended_by','supersedes','relates')),
    CONSTRAINT proposal_deps_from_fkey   FOREIGN KEY (from_proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_deps_to_fkey     FOREIGN KEY (to_proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE
);
CREATE INDEX idx_deps_from       ON roadmap.proposal_dependencies (from_proposal_id);
CREATE INDEX idx_deps_to         ON roadmap.proposal_dependencies (to_proposal_id);
CREATE INDEX idx_deps_unresolved ON roadmap.proposal_dependencies (from_proposal_id) WHERE resolved = false;
COMMENT ON TABLE roadmap.proposal_dependencies IS 'Structured DAG of proposal dependencies; drives queue priority in v_proposal_queue';


-- ---------------------------------------------------------------------------
-- 4f. proposal_decision — formal approve/reject/defer/escalate decisions
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_decision (
    id            int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id   int8        NOT NULL,
    decision      text        NOT NULL,   -- 'approved','rejected','deferred','escalated'
    authority     text        NOT NULL,
    rationale     text        NULL,
    binding       bool        DEFAULT true NOT NULL,
    decided_at    timestamptz DEFAULT now() NOT NULL,
    superseded_by int8        NULL,
    CONSTRAINT proposal_decision_pkey           PRIMARY KEY (id),
    CONSTRAINT proposal_decision_decision_check CHECK (decision = ANY (
        ARRAY['approved','rejected','deferred','escalated'])),
    CONSTRAINT fk_pd_proposal   FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT fk_pd_superseded FOREIGN KEY (superseded_by)
        REFERENCES roadmap.proposal_decision (id) ON DELETE SET NULL
);
CREATE INDEX idx_decision_proposal ON roadmap.proposal_decision (proposal_id);
CREATE INDEX idx_decision_at       ON roadmap.proposal_decision (decided_at DESC);
COMMENT ON TABLE  roadmap.proposal_decision IS 'Formal approve/reject/defer/escalate decisions with authority and rationale';
COMMENT ON COLUMN roadmap.proposal_decision.binding       IS 'True = decision is final and pipeline-enforced; false = advisory only';
COMMENT ON COLUMN roadmap.proposal_decision.superseded_by IS 'Points to the newer decision if this one was overturned';


-- ---------------------------------------------------------------------------
-- 4g. proposal_lease — claim/lease model (replaces assignment)
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_lease (
    id             int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id    int8        NOT NULL,
    agent_identity text        NOT NULL,
    claimed_at     timestamptz DEFAULT now() NOT NULL,
    expires_at     timestamptz NULL,
    released_at    timestamptz NULL,
    release_reason text        NULL,
    is_active      bool        GENERATED ALWAYS AS (released_at IS NULL) STORED,
    CONSTRAINT proposal_lease_pkey          PRIMARY KEY (id),
    CONSTRAINT proposal_lease_one_active    UNIQUE NULLS NOT DISTINCT (proposal_id, released_at),
    CONSTRAINT proposal_lease_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_lease_agent_fkey    FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_lease_proposal ON roadmap.proposal_lease (proposal_id) WHERE released_at IS NULL;
CREATE INDEX idx_lease_agent    ON roadmap.proposal_lease (agent_identity) WHERE released_at IS NULL;
CREATE INDEX idx_lease_expires  ON roadmap.proposal_lease (expires_at) WHERE expires_at IS NOT NULL AND released_at IS NULL;
COMMENT ON TABLE  roadmap.proposal_lease IS 'Claim/lease model: an agent claims a proposal to work on it; one active lease per proposal at a time';
COMMENT ON COLUMN roadmap.proposal_lease.is_active     IS 'Generated column: true while released_at IS NULL';
COMMENT ON COLUMN roadmap.proposal_lease.expires_at    IS 'Optional TTL; expired leases should be reaped by the lease_reaper scheduled job';
COMMENT ON COLUMN roadmap.proposal_lease.release_reason IS 'Why the lease was released: completed, expired, reassigned, etc.';


-- ---------------------------------------------------------------------------
-- 4h. proposal_milestone
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_milestone (
    id          int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id int8        NOT NULL,
    label       text        NOT NULL,
    due_at      timestamptz NULL,
    achieved_at timestamptz NULL,
    status      text        DEFAULT 'pending' NOT NULL,
    notes       text        NULL,
    created_at  timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_milestone_pkey         PRIMARY KEY (id),
    CONSTRAINT proposal_milestone_status_check CHECK (status IN ('pending','achieved','missed','waived')),
    CONSTRAINT proposal_milestone_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE
);
CREATE INDEX idx_milestone_proposal ON roadmap.proposal_milestone (proposal_id);
CREATE INDEX idx_milestone_due      ON roadmap.proposal_milestone (due_at) WHERE achieved_at IS NULL;


-- ---------------------------------------------------------------------------
-- 4i. proposal_reviews
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_reviews (
    id                int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id       int8        NOT NULL,
    reviewer_identity text        NOT NULL,
    verdict           text        NOT NULL,
    findings          jsonb       NULL,
    notes             text        NULL,
    comment           text        NULL,
    is_blocking       bool        DEFAULT false NOT NULL,
    reviewed_at       timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_reviews_pkey          PRIMARY KEY (id),
    CONSTRAINT proposal_reviews_unique        UNIQUE NULLS NOT DISTINCT (proposal_id, reviewer_identity),
    CONSTRAINT proposal_reviews_verdict_check CHECK (verdict IN ('approve','request_changes','reject')),
    CONSTRAINT proposal_reviews_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_reviews_reviewer_fkey FOREIGN KEY (reviewer_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_reviews_proposal ON roadmap.proposal_reviews (proposal_id);
CREATE INDEX idx_reviews_reviewer ON roadmap.proposal_reviews (reviewer_identity);
CREATE INDEX idx_reviews_verdict  ON roadmap.proposal_reviews (verdict);
CREATE INDEX idx_reviews_blocking ON roadmap.proposal_reviews (proposal_id) WHERE is_blocking = true;


-- ---------------------------------------------------------------------------
-- 4j. proposal_state_transitions — state change ledger
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_state_transitions (
    id                int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id       int8        NOT NULL,
    from_state        text        NOT NULL,
    to_state          text        NOT NULL,
    transition_reason text        NOT NULL,
    transitioned_by   text        NULL,
    depends_on_id     int8        NULL,
    notes             text        NULL,
    emoji             char(4)     NULL,
    transitioned_at   timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_state_transitions_pkey           PRIMARY KEY (id),
    CONSTRAINT proposal_state_transitions_proposal_fkey  FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_state_transitions_by_fkey        FOREIGN KEY (transitioned_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE SET NULL,
    CONSTRAINT proposal_state_transitions_dep_fkey       FOREIGN KEY (depends_on_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL
);
CREATE INDEX idx_transitions_proposal ON roadmap.proposal_state_transitions (proposal_id);
CREATE INDEX idx_transitions_from     ON roadmap.proposal_state_transitions (from_state);
CREATE INDEX idx_transitions_to       ON roadmap.proposal_state_transitions (to_state);
CREATE INDEX idx_transitions_reason   ON roadmap.proposal_state_transitions (transition_reason);
CREATE INDEX idx_transitions_at       ON roadmap.proposal_state_transitions (transitioned_at DESC);
COMMENT ON COLUMN roadmap.proposal_state_transitions.transition_reason IS 'Open text — validated against proposal_valid_transitions at application layer, not by CHECK';
COMMENT ON COLUMN roadmap.proposal_state_transitions.depends_on_id     IS 'FK to proposal.id — dependency that unblocked or triggered this transition';


-- ---------------------------------------------------------------------------
-- 4k. proposal_version
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_version (
    id                  int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id         int8        NOT NULL,
    author_identity     text        NOT NULL,
    version_number      int4        NOT NULL,
    change_summary      text        NULL,
    body_delta          text        NULL,
    metadata_delta_json jsonb       NULL,
    git_commit_sha      text        NULL,
    created_at          timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_version_pkey          PRIMARY KEY (id),
    CONSTRAINT proposal_version_proposal_ver  UNIQUE (proposal_id, version_number),
    CONSTRAINT proposal_version_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_version_author_fkey   FOREIGN KEY (author_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_version_proposal ON roadmap.proposal_version (proposal_id);


-- ---------------------------------------------------------------------------
-- 4l. proposal_discussions — threaded discussion with vector search
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_discussions (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id     int8        NOT NULL,
    parent_id       int8        NULL,
    author_identity text        NOT NULL,
    context_prefix  text        NULL,
    body            text        NOT NULL,
    body_markdown   text        NULL,
    body_vector     public.vector(1536) NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_discussions_pkey          PRIMARY KEY (id),
    CONSTRAINT proposal_discussions_context_check CHECK (context_prefix IN (
        'arch:','team:','critical:','security:','general:','feedback:','concern:','poc:')),
    CONSTRAINT proposal_discussions_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_discussions_parent_fkey   FOREIGN KEY (parent_id)
        REFERENCES roadmap.proposal_discussions (id) ON DELETE SET NULL,
    CONSTRAINT proposal_discussions_author_fkey   FOREIGN KEY (author_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_discussion_proposal ON roadmap.proposal_discussions (proposal_id);
CREATE INDEX idx_discussion_parent   ON roadmap.proposal_discussions (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_discussion_author   ON roadmap.proposal_discussions (author_identity);
CREATE INDEX idx_discussion_created  ON roadmap.proposal_discussions (created_at DESC);
CREATE INDEX idx_discussion_context  ON roadmap.proposal_discussions (context_prefix) WHERE context_prefix IS NOT NULL;
CREATE INDEX idx_discussion_vector   ON roadmap.proposal_discussions
    USING hnsw (body_vector vector_cosine_ops) WITH (m = '16', ef_construction = '64');


-- ---------------------------------------------------------------------------
-- 4m. proposal_labels
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_labels (
    proposal_id int8        NOT NULL,
    label       text        NOT NULL,
    applied_by  text        NOT NULL,
    applied_at  timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT proposal_labels_pkey          PRIMARY KEY (proposal_id, label),
    CONSTRAINT proposal_labels_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT proposal_labels_agent_fkey    FOREIGN KEY (applied_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_labels_label ON roadmap.proposal_labels (label);


-- ---------------------------------------------------------------------------
-- 4n. proposal_event — transactional outbox (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.proposal_event (
    id            int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id   int8        NOT NULL,
    event_type    text        NOT NULL,
    payload       jsonb       NOT NULL DEFAULT '{}',
    created_at    timestamptz DEFAULT now() NOT NULL,
    dispatched_at timestamptz NULL,
    CONSTRAINT proposal_event_pkey         PRIMARY KEY (id),
    CONSTRAINT proposal_event_type_check   CHECK (event_type IN (
        'status_changed','decision_made','lease_claimed','lease_released',
        'dependency_added','dependency_resolved','ac_updated','review_submitted',
        'maturity_changed','milestone_achieved')),
    CONSTRAINT proposal_event_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE
);
CREATE INDEX idx_event_proposal     ON roadmap.proposal_event (proposal_id);
CREATE INDEX idx_event_undispatched ON roadmap.proposal_event (created_at) WHERE dispatched_at IS NULL;
CREATE INDEX idx_event_type         ON roadmap.proposal_event (event_type);
COMMENT ON TABLE  roadmap.proposal_event IS 'Transactional outbox: one row per domain event, written atomically with the mutation that caused it';
COMMENT ON COLUMN roadmap.proposal_event.dispatched_at IS 'Set by the dispatcher after successful delivery; NULL = pending';
-- =============================================================================
-- SECTION 5 — EFFICIENCY TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 5a. run_log — central run record; anchors all child log rows
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.run_log (
    run_id         text        NOT NULL,
    agent_identity text        NOT NULL,
    proposal_id    int8        NULL,
    model_name     text        NULL,
    pipeline_stage text        NULL,
    status         text        DEFAULT 'running' NOT NULL,
    input_summary  text        NULL,
    error_message  text        NULL,
    started_at     timestamptz DEFAULT now() NOT NULL,
    finished_at    timestamptz NULL,
    CONSTRAINT run_log_pkey         PRIMARY KEY (run_id),
    CONSTRAINT run_log_status_check CHECK (status IN ('running','success','error','cancelled')),
    CONSTRAINT run_log_agent_fkey   FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT run_log_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL,
    CONSTRAINT run_log_model_fkey   FOREIGN KEY (model_name)
        REFERENCES roadmap.model_metadata (model_name) ON DELETE SET NULL
);
CREATE INDEX idx_run_agent    ON roadmap.run_log (agent_identity);
CREATE INDEX idx_run_proposal ON roadmap.run_log (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX idx_run_started  ON roadmap.run_log (started_at DESC);
CREATE INDEX idx_run_status   ON roadmap.run_log (status) WHERE status = 'running';
COMMENT ON TABLE  roadmap.run_log IS 'Central run record; run_id anchors spending_log, context_window_log, and cache_write_log';
COMMENT ON COLUMN roadmap.run_log.run_id         IS 'Caller-assigned key (UUID recommended); set before writing any child log rows';
COMMENT ON COLUMN roadmap.run_log.input_summary  IS 'Short description of what the run was asked to do; not the full prompt';


-- ---------------------------------------------------------------------------
-- 5b. agent_memory — long-term memory store with TTL and vector search
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.agent_memory (
    id             int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity text        NOT NULL,
    layer          text        NOT NULL,   -- 'episodic' | 'semantic' | 'working' | 'procedural'
    key            text        NOT NULL,
    value          text        NULL,
    metadata       jsonb       NULL,
    ttl_seconds    int4        NULL,       -- NULL = permanent
    expires_at     timestamptz NULL,       -- set by trigger from created_at + ttl_seconds
    body_vector    public.vector(1536) NULL,
    created_at     timestamptz DEFAULT now() NOT NULL,
    updated_at     timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT agent_memory_pkey        PRIMARY KEY (id),
    CONSTRAINT agent_memory_layer_check CHECK (layer IN ('episodic','semantic','working','procedural')),
    CONSTRAINT agent_memory_agent_fkey  FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE CASCADE
);
CREATE INDEX idx_memory_agent   ON roadmap.agent_memory (agent_identity);
CREATE INDEX idx_memory_layer   ON roadmap.agent_memory (layer);
CREATE INDEX idx_memory_expires ON roadmap.agent_memory (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_memory_vector  ON roadmap.agent_memory USING hnsw (body_vector vector_cosine_ops);
COMMENT ON COLUMN roadmap.agent_memory.ttl_seconds IS 'Memory TTL in seconds; NULL = permanent. expires_at is set by insert trigger.';
COMMENT ON COLUMN roadmap.agent_memory.layer       IS 'episodic=events, semantic=facts, working=current task, procedural=skills';


-- ---------------------------------------------------------------------------
-- 5c. model_assignment — proposal type + pipeline stage → model routing
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.model_assignment (
    id             int8  GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_type  text  NULL,   -- NULL = default for all types
    pipeline_stage text  NULL,   -- NULL = applies to all stages
    model_name     text  NOT NULL,
    priority       int4  DEFAULT 5 NOT NULL,
    is_active      bool  DEFAULT true NOT NULL,
    created_at     timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT model_assignment_pkey       PRIMARY KEY (id),
    CONSTRAINT model_assignment_model_fkey FOREIGN KEY (model_name)
        REFERENCES roadmap.model_metadata (model_name) ON DELETE RESTRICT
);
COMMENT ON TABLE roadmap.model_assignment IS 'Maps proposal type + pipeline stage to preferred model; highest priority active row wins';


-- ---------------------------------------------------------------------------
-- 5d. context_window_log — per-run token usage tracking
--     Additions: added run_id FK to run_log
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.context_window_log (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity  text        NOT NULL,
    proposal_id     int8        NULL,
    model_name      text        NOT NULL,
    input_tokens    int4        NOT NULL,
    output_tokens   int4        NOT NULL,
    total_tokens    int4        GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
    context_limit   int4        NULL,
    was_truncated   bool        DEFAULT false NOT NULL,
    truncation_note text        NULL,
    run_id          text        NULL,
    logged_at       timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT context_window_log_pkey          PRIMARY KEY (id),
    CONSTRAINT context_window_log_agent_fkey    FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT context_window_log_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL,
    CONSTRAINT context_window_log_model_fkey    FOREIGN KEY (model_name)
        REFERENCES roadmap.model_metadata (model_name) ON DELETE RESTRICT,
    CONSTRAINT context_window_log_run_fkey      FOREIGN KEY (run_id)
        REFERENCES roadmap.run_log (run_id) ON DELETE SET NULL
);
CREATE INDEX idx_ctx_agent     ON roadmap.context_window_log (agent_identity);
CREATE INDEX idx_ctx_proposal  ON roadmap.context_window_log (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX idx_ctx_truncated ON roadmap.context_window_log (logged_at DESC) WHERE was_truncated = true;
COMMENT ON TABLE roadmap.context_window_log IS 'Per-run token usage; total_tokens is a generated column';


-- ---------------------------------------------------------------------------
-- 5e. cache_write_log — immutable record of a cache write event
--     Additions: removed hit_count, cost_saved_usd, tokens_read, last_hit_at;
--               added run_id (NOT NULL) with FK to run_log
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.cache_write_log (
    id             int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity text          NOT NULL,
    proposal_id    int8          NULL,
    model_name     text          NOT NULL,
    cache_key      text          NOT NULL,   -- hash of the cached prompt segment
    tokens_written int4          NOT NULL,
    run_id         text          NOT NULL,
    written_at     timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT cache_write_log_pkey          PRIMARY KEY (id),
    CONSTRAINT cache_write_log_agent_fkey    FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE CASCADE,
    CONSTRAINT cache_write_log_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL,
    CONSTRAINT cache_write_log_run_fkey      FOREIGN KEY (run_id)
        REFERENCES roadmap.run_log (run_id) ON DELETE SET NULL
);
CREATE INDEX idx_cache_agent ON roadmap.cache_write_log (agent_identity);
CREATE INDEX idx_cache_key   ON roadmap.cache_write_log (cache_key);
COMMENT ON TABLE roadmap.cache_write_log IS 'Immutable record of a cache write event; hits tracked in cache_hit_log';


-- ---------------------------------------------------------------------------
-- 5f. cache_hit_log — append-only hit log per cache entry
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.cache_hit_log (
    id             int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    cache_write_id int8          NOT NULL,
    run_id         text          NULL,
    agent_identity text          NOT NULL,
    tokens_read    int4          NOT NULL,
    cost_saved_usd numeric(14,6) NOT NULL,
    hit_at         timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT cache_hit_log_pkey         PRIMARY KEY (id),
    CONSTRAINT cache_hit_log_write_fkey   FOREIGN KEY (cache_write_id)
        REFERENCES roadmap.cache_write_log (id) ON DELETE CASCADE,
    CONSTRAINT cache_hit_log_run_fkey     FOREIGN KEY (run_id)
        REFERENCES roadmap.run_log (run_id) ON DELETE SET NULL,
    CONSTRAINT cache_hit_log_agent_fkey   FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_cache_hit_write ON roadmap.cache_hit_log (cache_write_id);
CREATE INDEX idx_cache_hit_agent ON roadmap.cache_hit_log (agent_identity);
CREATE INDEX idx_cache_hit_at    ON roadmap.cache_hit_log (hit_at DESC);
COMMENT ON TABLE  roadmap.cache_hit_log IS 'Append-only hit log per cache entry; replaces mutable hit_count/cost_saved_usd on cache_write_log';
COMMENT ON COLUMN roadmap.cache_hit_log.cost_saved_usd IS 'Saving for this specific hit = tokens_read * (normal_cost - cache_read_cost)';


-- ---------------------------------------------------------------------------
-- 5g. prompt_template — versioned system prompts and context preambles
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.prompt_template (
    id             int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    name           text        NOT NULL,
    version        int4        NOT NULL,
    proposal_type  text        NULL,   -- NULL = applies to all types
    pipeline_stage text        NULL,   -- NULL = applies to all stages
    content        text        NOT NULL,
    description    text        NULL,
    is_active      bool        DEFAULT true NOT NULL,
    created_by     text        NOT NULL,
    created_at     timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT prompt_template_pkey         PRIMARY KEY (id),
    CONSTRAINT prompt_template_name_ver_key UNIQUE (name, version),
    CONSTRAINT prompt_template_author_fkey  FOREIGN KEY (created_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_prompt_template_lookup ON roadmap.prompt_template
    (proposal_type, pipeline_stage, is_active, version DESC);
COMMENT ON TABLE  roadmap.prompt_template IS 'Versioned system prompts and context preambles; agents resolve by type+stage, highest active version wins';
COMMENT ON COLUMN roadmap.prompt_template.proposal_type  IS 'NULL = default for all types; specific type overrides the default';
COMMENT ON COLUMN roadmap.prompt_template.pipeline_stage IS 'NULL = applies to all stages; specific stage overrides';


-- ---------------------------------------------------------------------------
-- 5h. embedding_index_registry — tracks model + refresh timestamp per vector
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.embedding_index_registry (
    id            int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    table_name    text        NOT NULL,
    row_id        int8        NOT NULL,
    model_name    text        NOT NULL,
    embedding_dim int4        NOT NULL,
    refreshed_at  timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT embedding_index_registry_pkey          PRIMARY KEY (id),
    CONSTRAINT embedding_index_registry_table_row_key UNIQUE (table_name, row_id),
    CONSTRAINT embedding_index_registry_model_fkey    FOREIGN KEY (model_name)
        REFERENCES roadmap.model_metadata (model_name) ON DELETE RESTRICT
);
CREATE INDEX idx_embed_table   ON roadmap.embedding_index_registry (table_name);
CREATE INDEX idx_embed_model   ON roadmap.embedding_index_registry (model_name);
CREATE INDEX idx_embed_refresh ON roadmap.embedding_index_registry (refreshed_at);
COMMENT ON TABLE  roadmap.embedding_index_registry IS 'Tracks which model produced each body_vector and when; stale rows indicate a re-embed is needed after a model upgrade';
COMMENT ON COLUMN roadmap.embedding_index_registry.table_name IS 'e.g. proposal, proposal_discussions, agent_memory';


-- =============================================================================
-- SECTION 6 — UTILITY TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 6a. mcp_tool_registry + mcp_tool_assignment
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.mcp_tool_registry (
    id            int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    tool_name     text        NOT NULL,
    tool_version  text        DEFAULT '1.0.0' NOT NULL,
    endpoint_url  text        NULL,
    description   text        NULL,
    capabilities  jsonb       NULL,
    is_active     bool        DEFAULT true NOT NULL,
    requires_auth bool        DEFAULT false NOT NULL,
    created_at    timestamptz DEFAULT now() NOT NULL,
    updated_at    timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT mcp_tool_registry_pkey         PRIMARY KEY (id),
    CONSTRAINT mcp_tool_registry_name_ver_key UNIQUE (tool_name, tool_version)
);
CREATE INDEX idx_mcp_active ON roadmap.mcp_tool_registry (tool_name) WHERE is_active = true;
COMMENT ON TABLE roadmap.mcp_tool_registry IS 'Catalogue of available MCP tools with endpoint and capability metadata';

CREATE TABLE roadmap.mcp_tool_assignment (
    id         int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_id   int8        NOT NULL,
    tool_id    int8        NOT NULL,
    is_enabled bool        DEFAULT true NOT NULL,
    granted_by text        NULL,
    granted_at timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT mcp_tool_assignment_pkey       PRIMARY KEY (id),
    CONSTRAINT mcp_tool_assignment_agent_tool UNIQUE (agent_id, tool_id),
    CONSTRAINT mcp_tool_assignment_agent_fkey FOREIGN KEY (agent_id)
        REFERENCES roadmap.agent_registry (id) ON DELETE CASCADE,
    CONSTRAINT mcp_tool_assignment_tool_fkey  FOREIGN KEY (tool_id)
        REFERENCES roadmap.mcp_tool_registry (id) ON DELETE CASCADE
);
COMMENT ON TABLE roadmap.mcp_tool_assignment IS 'Per-agent MCP tool enablement; only listed+enabled tools are accessible';


-- ---------------------------------------------------------------------------
-- 6b. message_ledger — agent-to-agent messaging
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.message_ledger (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    from_agent      text        NOT NULL,
    to_agent        text        NULL,   -- NULL = broadcast
    channel         text        NULL,   -- 'direct' | 'team:<n>' | 'broadcast' | 'system'
    message_type    text        NULL,
    message_content text        NULL,
    proposal_id     int8        NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT message_ledger_pkey         PRIMARY KEY (id),
    CONSTRAINT message_ledger_channel_check CHECK (channel IS NULL OR channel ~ '^(direct|team:.+|broadcast|system)$'),
    CONSTRAINT message_ledger_type_check    CHECK (message_type IN ('task','notify','ack','error','event')),
    CONSTRAINT message_ledger_from_fkey     FOREIGN KEY (from_agent)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT message_ledger_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL
);
CREATE INDEX idx_message_from     ON roadmap.message_ledger (from_agent);
CREATE INDEX idx_message_to       ON roadmap.message_ledger (to_agent) WHERE to_agent IS NOT NULL;
CREATE INDEX idx_message_created  ON roadmap.message_ledger (created_at DESC);
CREATE INDEX idx_message_proposal ON roadmap.message_ledger (proposal_id) WHERE proposal_id IS NOT NULL;
COMMENT ON COLUMN roadmap.message_ledger.to_agent IS 'NULL = broadcast; from_agent has FK for referential integrity';
COMMENT ON COLUMN roadmap.message_ledger.channel  IS 'direct, team:<n>, broadcast, or system';


-- ---------------------------------------------------------------------------
-- 6c. notification — fan-out notification table
--     Additions: removed is_read, read_at; added source_event_id FK
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.notification (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    recipient       text        NOT NULL,   -- agent_identity or 'team:<n>'
    surface         text        NOT NULL,   -- 'tui' | 'web' | 'mobile' | 'all'
    event_type      text        NOT NULL,
    payload         jsonb       NULL,
    proposal_id     int8        NULL,
    source_event_id int8        NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT notification_pkey           PRIMARY KEY (id),
    CONSTRAINT notification_surface_check  CHECK (surface IN ('tui','web','mobile','all')),
    CONSTRAINT notification_proposal_fkey  FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT notification_event_fkey     FOREIGN KEY (source_event_id)
        REFERENCES roadmap.proposal_event (id) ON DELETE SET NULL
);
CREATE INDEX idx_notification_recipient ON roadmap.notification (recipient);
CREATE INDEX idx_notification_created   ON roadmap.notification (created_at DESC);
COMMENT ON TABLE  roadmap.notification IS 'Fan-out notification table for TUI, Web Dashboard, and Mobile consumers';
COMMENT ON COLUMN roadmap.notification.source_event_id IS 'Links notification back to the proposal_event that generated it';


-- ---------------------------------------------------------------------------
-- 6d. notification_delivery — per-surface delivery receipt
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.notification_delivery (
    id              int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    notification_id int8        NOT NULL,
    surface         text        NOT NULL,
    delivered_at    timestamptz NULL,
    acknowledged_at timestamptz NULL,
    failure_reason  text        NULL,
    CONSTRAINT notification_delivery_pkey           PRIMARY KEY (id),
    CONSTRAINT notification_delivery_notif_surf_key UNIQUE (notification_id, surface),
    CONSTRAINT notification_delivery_surface_check  CHECK (surface IN ('tui','web','mobile')),
    CONSTRAINT notification_delivery_notif_fkey     FOREIGN KEY (notification_id)
        REFERENCES roadmap.notification (id) ON DELETE CASCADE
);
CREATE INDEX idx_notif_delivery_notif        ON roadmap.notification_delivery (notification_id);
CREATE INDEX idx_notif_delivery_undelivered  ON roadmap.notification_delivery (notification_id)
    WHERE delivered_at IS NULL;
COMMENT ON TABLE  roadmap.notification_delivery IS 'Per-surface delivery receipt; a notification can be delivered to web but pending on mobile';
COMMENT ON COLUMN roadmap.notification_delivery.acknowledged_at IS 'Set when user explicitly dismisses the notification on that surface';


-- ---------------------------------------------------------------------------
-- 6e. user_session
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.user_session (
    id             int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity text        NOT NULL,
    surface        text        NOT NULL,   -- 'tui' | 'web' | 'mobile'
    session_token  text        NOT NULL,
    preferences    jsonb       NULL,
    ip_address     text        NULL,
    user_agent     text        NULL,
    created_at     timestamptz DEFAULT now() NOT NULL,
    last_active_at timestamptz DEFAULT now() NOT NULL,
    expires_at     timestamptz NULL,
    CONSTRAINT user_session_pkey           PRIMARY KEY (id),
    CONSTRAINT user_session_token_key      UNIQUE (session_token),
    CONSTRAINT user_session_surface_check  CHECK (surface IN ('tui','web','mobile')),
    CONSTRAINT user_session_agent_fkey     FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE CASCADE
);
CREATE INDEX idx_session_agent   ON roadmap.user_session (agent_identity);
CREATE INDEX idx_session_expires ON roadmap.user_session (expires_at) WHERE expires_at IS NOT NULL;
COMMENT ON TABLE roadmap.user_session IS 'Active sessions for human users across TUI, Web Dashboard, and Mobile surfaces';


-- ---------------------------------------------------------------------------
-- 6f. attachment_registry
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.attachment_registry (
    id             int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    proposal_id    int8        NULL,
    uploaded_by    text        NULL,
    file_name      text        NULL,
    relative_path  text        NULL,
    content_hash   text        NULL,
    vision_summary text        NULL,
    created_at     timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT attachment_registry_pkey          PRIMARY KEY (id),
    CONSTRAINT attachment_registry_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE CASCADE,
    CONSTRAINT attachment_registry_agent_fkey    FOREIGN KEY (uploaded_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE SET NULL
);
CREATE INDEX idx_attachment_proposal ON roadmap.attachment_registry (proposal_id);


-- ---------------------------------------------------------------------------
-- 6g. spending_log — immutable cost ledger
--     Additions: added run_id FK to run_log
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.spending_log (
    id             int8          GENERATED ALWAYS AS IDENTITY NOT NULL,
    agent_identity text          NOT NULL,
    proposal_id    int8          NULL,
    model_name     text          NULL,
    cost_usd       numeric(14,6) NOT NULL,
    token_count    int4          NULL,
    run_id         text          NULL,
    budget_id      int8          NULL,
    created_at     timestamptz   DEFAULT now() NOT NULL,
    CONSTRAINT spending_log_pkey          PRIMARY KEY (id),
    CONSTRAINT spending_log_cost_positive CHECK (cost_usd >= 0),
    CONSTRAINT spending_log_agent_fkey    FOREIGN KEY (agent_identity)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT,
    CONSTRAINT spending_log_proposal_fkey FOREIGN KEY (proposal_id)
        REFERENCES roadmap.proposal (id) ON DELETE SET NULL,
    CONSTRAINT spending_log_model_fkey    FOREIGN KEY (model_name)
        REFERENCES roadmap.model_metadata (model_name) ON DELETE SET NULL,
    CONSTRAINT spending_log_budget_fkey   FOREIGN KEY (budget_id)
        REFERENCES roadmap.budget_allowance (id) ON DELETE SET NULL,
    CONSTRAINT spending_log_run_fkey      FOREIGN KEY (run_id)
        REFERENCES roadmap.run_log (run_id) ON DELETE SET NULL
);
CREATE INDEX idx_spending_agent    ON roadmap.spending_log (agent_identity);
CREATE INDEX idx_spending_proposal ON roadmap.spending_log (proposal_id) WHERE proposal_id IS NOT NULL;
CREATE INDEX idx_spending_created  ON roadmap.spending_log (created_at DESC);
COMMENT ON TABLE  roadmap.spending_log IS 'Immutable cost ledger; daily/monthly totals are always derived, never stored';
COMMENT ON COLUMN roadmap.spending_log.cost_usd IS 'Per-event cost in USD to 6dp; matches model_metadata precision';


-- ---------------------------------------------------------------------------
-- 6h. scheduled_job — registry and execution log for maintenance jobs
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.scheduled_job (
    id               int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    job_name         text        NOT NULL,
    description      text        NULL,
    cron_expr        text        NOT NULL,
    is_enabled       bool        DEFAULT true NOT NULL,
    last_run_at      timestamptz NULL,
    last_status      text        NULL,
    last_error       text        NULL,
    last_duration_ms int4        NULL,
    next_run_at      timestamptz NULL,
    run_count        int4        DEFAULT 0 NOT NULL,
    CONSTRAINT scheduled_job_pkey         PRIMARY KEY (id),
    CONSTRAINT scheduled_job_name_key     UNIQUE (job_name),
    CONSTRAINT scheduled_job_status_check CHECK (
        last_status IS NULL OR last_status IN ('ok','error','running','skipped'))
);
COMMENT ON TABLE  roadmap.scheduled_job IS 'Registry and last-run state for all background maintenance jobs';
COMMENT ON COLUMN roadmap.scheduled_job.cron_expr IS 'Standard cron expression, e.g. 0 * * * * for hourly';

INSERT INTO roadmap.scheduled_job (job_name, description, cron_expr) VALUES
    ('lease_reaper',        'Release expired proposal leases',                    '*/15 * * * *'),
    ('memory_ttl_purge',    'Delete agent_memory rows past expires_at',           '0 * * * *'),
    ('agency_profile_sync', 'Re-sync agent profiles from GitHub',                 '0 6 * * *'),
    ('embedding_refresh',   'Re-embed rows whose model version is stale',         '0 2 * * *'),
    ('acl_expiry_cleanup',  'Remove ACL rows past expires_at',                    '0 1 * * *'),
    ('budget_rollover',     'Reset or roll over monthly budget_allowance caps',   '0 0 1 * *'),
    ('webhook_dispatcher',  'Deliver pending proposal_event rows to subscribers', '* * * * *');


-- ---------------------------------------------------------------------------
-- 6i. webhook_subscription — external subscribers to proposal_event
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.webhook_subscription (
    id               int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    label            text        NOT NULL,
    endpoint_url     text        NOT NULL,
    event_types      text[]      NOT NULL,
    secret_hash      text        NULL,   -- HMAC-SHA256 of shared secret; never store plaintext
    is_active        bool        DEFAULT true NOT NULL,
    last_delivery_at timestamptz NULL,
    last_status      text        NULL,
    failure_count    int4        DEFAULT 0 NOT NULL,
    created_by       text        NOT NULL,
    created_at       timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT webhook_subscription_pkey       PRIMARY KEY (id),
    CONSTRAINT webhook_subscription_url_key    UNIQUE (endpoint_url),
    CONSTRAINT webhook_subscription_agent_fkey FOREIGN KEY (created_by)
        REFERENCES roadmap.agent_registry (agent_identity) ON DELETE RESTRICT
);
CREATE INDEX idx_webhook_active ON roadmap.webhook_subscription (is_active) WHERE is_active = true;
COMMENT ON TABLE  roadmap.webhook_subscription IS 'External subscribers to proposal_event; delivered by webhook_dispatcher job';
COMMENT ON COLUMN roadmap.webhook_subscription.secret_hash  IS 'Store only the HMAC hash; plaintext secret lives only with the subscriber';
COMMENT ON COLUMN roadmap.webhook_subscription.failure_count IS 'Dispatcher increments on delivery failure; subscriber auto-disabled at threshold';
COMMENT ON COLUMN roadmap.webhook_subscription.event_types  IS 'Array of event_type values from proposal_event this subscriber wants';


-- ---------------------------------------------------------------------------
-- 6j. audit_log — cross-entity before/after audit trail
-- ---------------------------------------------------------------------------
CREATE TABLE roadmap.audit_log (
    id          int8        GENERATED ALWAYS AS IDENTITY NOT NULL,
    entity_type text        NOT NULL,
    entity_id   text        NOT NULL,
    action      text        NOT NULL,
    changed_by  text        NULL,
    changed_at  timestamptz DEFAULT now() NOT NULL,
    before_json jsonb       NULL,
    after_json  jsonb       NULL,
    CONSTRAINT audit_log_pkey         PRIMARY KEY (id),
    CONSTRAINT audit_log_action_check CHECK (action IN ('insert','update','delete'))
);
CREATE INDEX idx_audit_entity  ON roadmap.audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_changed ON roadmap.audit_log (changed_at DESC);
CREATE INDEX idx_audit_who     ON roadmap.audit_log (changed_by) WHERE changed_by IS NOT NULL;
COMMENT ON TABLE  roadmap.audit_log IS 'Cross-entity before/after audit trail; covers ACL, budget, agent, and resource changes';
COMMENT ON COLUMN roadmap.audit_log.entity_id IS 'PK of the affected row cast to text (int8 or text PK both fit)';
-- =============================================================================
-- SECTION 7 — FUNCTIONS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 7a. fn_set_updated_at — shared updated_at refresh
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7b. fn_proposal_display_id — auto-generate P001, P042, P1001
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_proposal_display_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.display_id := 'P' || LPAD(NEW.id::text, 3, '0');
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7c. fn_spawn_workflow — auto-spawn workflow instance on proposal insert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_spawn_workflow()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_template_id int8;
    v_first_stage text;
BEGIN
    SELECT wt.id, ws.stage_name
    INTO   v_template_id, v_first_stage
    FROM   roadmap.proposal_type_config ptc
    JOIN   roadmap.workflow_templates wt ON wt.name = ptc.workflow_name
    JOIN   roadmap.workflow_stages ws    ON ws.template_id = wt.id
    WHERE  ptc.type = NEW.type
    ORDER  BY ws.stage_order
    LIMIT  1;

    IF v_template_id IS NOT NULL THEN
        INSERT INTO roadmap.workflows (template_id, proposal_id, current_stage)
        VALUES (v_template_id, NEW.id, COALESCE(v_first_stage, NEW.status));
    END IF;

    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7d. fn_log_proposal_state_change — audit + transitions ledger + outbox
--     This is the ADDITIONS version (includes proposal_event write).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_log_proposal_state_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_agent text;
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        v_agent := COALESCE(current_setting('app.agent_identity', true), 'system');

        -- 1. Append to audit jsonb
        NEW.audit := NEW.audit || jsonb_build_object(
            'TS',       to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'Agent',    v_agent,
            'Activity', 'StatusChange',
            'From',     OLD.status,
            'To',       NEW.status
        );

        -- 2. State transitions ledger
        INSERT INTO roadmap.proposal_state_transitions
            (proposal_id, from_state, to_state, transition_reason, transitioned_by)
        VALUES (NEW.id, OLD.status, NEW.status, 'system', v_agent);

        -- 3. Transactional outbox event
        INSERT INTO roadmap.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.id,
            'status_changed',
            jsonb_build_object(
                'from',  OLD.status,
                'to',    NEW.status,
                'agent', v_agent,
                'ts',    to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
        );
    END IF;
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7e. fn_sync_blocked_flag — keep proposal.blocked_by_dependencies in sync
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_sync_blocked_flag()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_proposal_id int8;
BEGIN
    v_proposal_id := COALESCE(NEW.from_proposal_id, OLD.from_proposal_id);
    UPDATE roadmap.proposal
    SET blocked_by_dependencies = EXISTS (
        SELECT 1 FROM roadmap.proposal_dependencies
        WHERE from_proposal_id = v_proposal_id
          AND dependency_type  = 'blocks'
          AND resolved         = false
    )
    WHERE id = v_proposal_id;
    RETURN COALESCE(NEW, OLD);
END;
$$;


-- ---------------------------------------------------------------------------
-- 7f. fn_validate_proposal_fields — enforce required_fields per type
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_validate_proposal_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_required text[];
    v_field     text;
    v_value     text;
BEGIN
    SELECT required_fields INTO v_required
    FROM   roadmap.proposal_type_config
    WHERE  type = NEW.type;

    IF v_required IS NULL THEN
        RETURN NEW;
    END IF;

    FOREACH v_field IN ARRAY v_required LOOP
        EXECUTE format('SELECT ($1).%I::text', v_field) INTO v_value USING NEW;
        IF v_value IS NULL OR trim(v_value) = '' THEN
            RAISE EXCEPTION 'Proposal type "%" requires field "%" to be non-empty',
                NEW.type, v_field
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7g. fn_check_dag_cycle — prevent circular dependency edges
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_check_dag_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_cycle_found bool;
BEGIN
    IF NEW.dependency_type NOT IN ('blocks', 'depended_by') THEN
        RETURN NEW;
    END IF;

    WITH RECURSIVE ancestors AS (
        SELECT to_proposal_id AS node
        FROM   roadmap.proposal_dependencies
        WHERE  from_proposal_id = NEW.to_proposal_id
          AND  dependency_type IN ('blocks','depended_by')
          AND  resolved = false
        UNION
        SELECT d.to_proposal_id
        FROM   roadmap.proposal_dependencies d
        JOIN   ancestors a ON d.from_proposal_id = a.node
        WHERE  d.dependency_type IN ('blocks','depended_by')
          AND  d.resolved = false
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE node = NEW.from_proposal_id)
    INTO   v_cycle_found;

    IF v_cycle_found THEN
        RAISE EXCEPTION
            'Adding dependency from P% to P% would create a cycle in the proposal DAG',
            NEW.from_proposal_id, NEW.to_proposal_id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7h. fn_event_lease_change — write proposal_event on lease claim/release
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_event_lease_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO roadmap.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.proposal_id, 'lease_claimed',
            jsonb_build_object(
                'agent',      NEW.agent_identity,
                'expires_at', NEW.expires_at
            )
        );
    ELSIF TG_OP = 'UPDATE' AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
        INSERT INTO roadmap.proposal_event (proposal_id, event_type, payload)
        VALUES (
            NEW.proposal_id, 'lease_released',
            jsonb_build_object(
                'agent',          NEW.agent_identity,
                'release_reason', NEW.release_reason
            )
        );
    END IF;
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7i. fn_sync_workload — keep agent_workload.active_lease_count in sync
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_sync_workload()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_agent_id int8;
    v_delta    int4;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT id INTO v_agent_id FROM roadmap.agent_registry
        WHERE agent_identity = NEW.agent_identity;
        v_delta := 1;
    ELSIF TG_OP = 'UPDATE' AND OLD.released_at IS NULL AND NEW.released_at IS NOT NULL THEN
        SELECT id INTO v_agent_id FROM roadmap.agent_registry
        WHERE agent_identity = NEW.agent_identity;
        v_delta := -1;
    ELSE
        RETURN NEW;
    END IF;

    INSERT INTO roadmap.agent_workload (agent_id, active_lease_count, updated_at)
    VALUES (v_agent_id, GREATEST(0, v_delta), now())
    ON CONFLICT (agent_id) DO UPDATE
        SET active_lease_count = GREATEST(0, roadmap.agent_workload.active_lease_count + v_delta),
            updated_at         = now();

    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7j. fn_rollup_budget_consumed — update budget_allowance.consumed_usd on spend
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_rollup_budget_consumed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.budget_id IS NOT NULL THEN
        UPDATE roadmap.budget_allowance
        SET consumed_usd = consumed_usd + NEW.cost_usd
        WHERE id = NEW.budget_id;
    END IF;
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7k. fn_set_memory_expires — compute expires_at from ttl_seconds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_set_memory_expires()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.ttl_seconds IS NOT NULL THEN
        NEW.expires_at := NEW.created_at + (NEW.ttl_seconds || ' seconds')::interval;
    ELSE
        NEW.expires_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7l. fn_check_spending_cap — auto-freeze agent when daily limit exceeded
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_check_spending_cap()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_daily_total numeric(14,6);
    v_daily_limit numeric(12,2);
BEGIN
    SELECT COALESCE(SUM(cost_usd), 0) INTO v_daily_total
    FROM   roadmap.spending_log
    WHERE  agent_identity = NEW.agent_identity
      AND  created_at >= date_trunc('day', now());

    SELECT daily_limit_usd INTO v_daily_limit
    FROM   roadmap.spending_caps
    WHERE  agent_identity = NEW.agent_identity;

    IF v_daily_limit IS NOT NULL AND v_daily_total > v_daily_limit THEN
        UPDATE roadmap.spending_caps
        SET    is_frozen     = true,
               frozen_reason = 'Daily limit USD ' || v_daily_limit || ' exceeded',
               updated_at    = now()
        WHERE  agent_identity = NEW.agent_identity
          AND  is_frozen = false;
    END IF;

    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7m. fn_set_version_number — auto-increment version_number per proposal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_set_version_number()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.version_number IS NULL THEN
        SELECT COALESCE(MAX(version_number), 0) + 1
        INTO   NEW.version_number
        FROM   roadmap.proposal_version
        WHERE  proposal_id = NEW.proposal_id;
    END IF;
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7n. fn_check_lease_available — reject INSERT when active lease exists
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_check_lease_available()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM roadmap.proposal_lease
        WHERE  proposal_id  = NEW.proposal_id
          AND  released_at  IS NULL
          AND  (expires_at  IS NULL OR expires_at > now())
    ) THEN
        RAISE EXCEPTION 'Proposal % already has an active lease', NEW.proposal_id
            USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
END;
$$;


-- ---------------------------------------------------------------------------
-- 7o. fn_audit_sensitive_tables — before/after audit trail
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_audit_sensitive_tables()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
    v_entity_id text;
    v_before    jsonb;
    v_after     jsonb;
    v_action    text;
BEGIN
    v_action := lower(TG_OP);

    IF TG_OP = 'DELETE' THEN
        v_entity_id := OLD.id::text;
        v_before    := to_jsonb(OLD);
        v_after     := NULL;
    ELSIF TG_OP = 'INSERT' THEN
        v_entity_id := NEW.id::text;
        v_before    := NULL;
        v_after     := to_jsonb(NEW);
    ELSE
        v_entity_id := NEW.id::text;
        v_before    := to_jsonb(OLD);
        v_after     := to_jsonb(NEW);
    END IF;

    INSERT INTO roadmap.audit_log
        (entity_type, entity_id, action, changed_by, before_json, after_json)
    VALUES (
        TG_TABLE_NAME,
        v_entity_id,
        v_action,
        COALESCE(current_setting('app.agent_identity', true), session_user),
        v_before,
        v_after
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;


-- ---------------------------------------------------------------------------
-- 7p. fn_notify_proposal_event — LISTEN/NOTIFY on proposal_event inserts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roadmap.fn_notify_proposal_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'roadmap_events',
        jsonb_build_object(
            'event_id', NEW.id,
            'type',     NEW.event_type,
            'proposal', NEW.proposal_id
        )::text
    );
    RETURN NEW;
END;
$$;


-- =============================================================================
-- SECTION 8 — TRIGGERS
-- =============================================================================

-- ─── updated_at refresh triggers ─────────────────────────────────────────────
CREATE TRIGGER trg_agent_registry_updated_at
    BEFORE UPDATE ON roadmap.agent_registry
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_model_metadata_updated_at
    BEFORE UPDATE ON roadmap.model_metadata
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_agent_memory_updated_at
    BEFORE UPDATE ON roadmap.agent_memory
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_proposal_ac_updated_at
    BEFORE UPDATE ON roadmap.proposal_acceptance_criteria
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_proposal_deps_updated_at
    BEFORE UPDATE ON roadmap.proposal_dependencies
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_proposal_discussions_updated_at
    BEFORE UPDATE ON roadmap.proposal_discussions
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_resource_allocation_updated_at
    BEFORE UPDATE ON roadmap.resource_allocation
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_mcp_tool_registry_updated_at
    BEFORE UPDATE ON roadmap.mcp_tool_registry
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

CREATE TRIGGER trg_proposal_type_config_updated_at
    BEFORE UPDATE ON roadmap.proposal_type_config
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_set_updated_at();

-- ─── proposal lifecycle triggers ─────────────────────────────────────────────
CREATE TRIGGER trg_proposal_display_id
    BEFORE INSERT ON roadmap.proposal
    FOR EACH ROW
    WHEN (NEW.display_id IS NULL OR NEW.display_id = '')
    EXECUTE FUNCTION roadmap.fn_proposal_display_id();

CREATE TRIGGER trg_spawn_workflow
    AFTER INSERT ON roadmap.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_spawn_workflow();

CREATE TRIGGER trg_proposal_state_change
    BEFORE UPDATE OF status ON roadmap.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_log_proposal_state_change();

CREATE TRIGGER trg_validate_proposal_fields
    BEFORE INSERT OR UPDATE ON roadmap.proposal
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_validate_proposal_fields();

-- ─── proposal_dependencies triggers ─────────────────────────────────────────
CREATE TRIGGER trg_sync_blocked_flag
    AFTER INSERT OR UPDATE OR DELETE ON roadmap.proposal_dependencies
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_sync_blocked_flag();

CREATE TRIGGER trg_check_dag_cycle
    BEFORE INSERT OR UPDATE ON roadmap.proposal_dependencies
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_check_dag_cycle();

-- ─── proposal_lease triggers ─────────────────────────────────────────────────
CREATE TRIGGER trg_check_lease_available
    BEFORE INSERT ON roadmap.proposal_lease
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_check_lease_available();

CREATE TRIGGER trg_event_lease_change
    AFTER INSERT OR UPDATE ON roadmap.proposal_lease
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_event_lease_change();

CREATE TRIGGER trg_sync_workload
    AFTER INSERT OR UPDATE ON roadmap.proposal_lease
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_sync_workload();

-- ─── proposal_version trigger ─────────────────────────────────────────────────
CREATE TRIGGER trg_set_version_number
    BEFORE INSERT ON roadmap.proposal_version
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_set_version_number();

-- ─── spending + budget triggers ───────────────────────────────────────────────
CREATE TRIGGER trg_rollup_budget_consumed
    AFTER INSERT ON roadmap.spending_log
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_rollup_budget_consumed();

CREATE TRIGGER trg_check_spending_cap
    AFTER INSERT ON roadmap.spending_log
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_check_spending_cap();

-- ─── agent_memory TTL trigger ─────────────────────────────────────────────────
CREATE TRIGGER trg_set_memory_expires
    BEFORE INSERT ON roadmap.agent_memory
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_set_memory_expires();

-- ─── audit triggers ───────────────────────────────────────────────────────────
CREATE TRIGGER trg_audit_acl
    AFTER INSERT OR UPDATE OR DELETE ON roadmap.acl
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();

CREATE TRIGGER trg_audit_spending_caps
    AFTER INSERT OR UPDATE OR DELETE ON roadmap.spending_caps
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();

CREATE TRIGGER trg_audit_agent_registry
    AFTER INSERT OR UPDATE OR DELETE ON roadmap.agent_registry
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();

CREATE TRIGGER trg_audit_resource_allocation
    AFTER INSERT OR UPDATE OR DELETE ON roadmap.resource_allocation
    FOR EACH ROW EXECUTE FUNCTION roadmap.fn_audit_sensitive_tables();

-- ─── proposal_event NOTIFY trigger ───────────────────────────────────────────
CREATE TRIGGER trg_notify_event
    AFTER INSERT ON roadmap.proposal_event
    FOR EACH ROW
    EXECUTE FUNCTION roadmap.fn_notify_proposal_event();
-- =============================================================================
-- SECTION 9 — VIEWS
-- =============================================================================

-- ---------------------------------------------------------------------------
-- v_proposal_summary — proposal with live workflow stage and latest decision
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_proposal_summary AS
SELECT
    p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.priority,
    p.maturity,
    p.tags,
    ptc.workflow_name,
    w.current_stage,
    pl.agent_identity                       AS leased_by,
    pl.claimed_at                           AS leased_at,
    pl.expires_at                           AS lease_expires,
    pd.decision                             AS latest_decision,
    pd.decided_at                           AS decision_at,
    p.created_at,
    p.audit
FROM roadmap.proposal p
LEFT JOIN roadmap.proposal_type_config ptc ON ptc.type = p.type
LEFT JOIN roadmap.workflows w              ON w.proposal_id = p.id
LEFT JOIN LATERAL (
    SELECT agent_identity, claimed_at, expires_at
    FROM   roadmap.proposal_lease
    WHERE  proposal_id = p.id AND released_at IS NULL
    LIMIT  1
) pl ON true
LEFT JOIN LATERAL (
    SELECT decision, decided_at
    FROM   roadmap.proposal_decision
    WHERE  proposal_id = p.id
    ORDER  BY decided_at DESC
    LIMIT  1
) pd ON true;


-- ---------------------------------------------------------------------------
-- v_proposal_queue — DAG-based priority ranking
-- Ranks proposals by: unresolved inbound blocks (proposals blocked by this one),
-- then by dependency maturity depth. Higher blocker_count = higher urgency.
-- Priority text on proposal is descriptive only; this view is the queue.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_proposal_queue AS
WITH blocker_counts AS (
    -- How many other proposals does each proposal block?
    SELECT   to_proposal_id   AS proposal_id,
             COUNT(*)          AS blocker_count
    FROM     roadmap.proposal_dependencies
    WHERE    resolved         = false
      AND    dependency_type  = 'blocks'
    GROUP BY to_proposal_id
),
dependency_depth AS (
    -- Simple depth: how many unresolved inbound dependencies does this proposal have?
    SELECT   from_proposal_id AS proposal_id,
             COUNT(*)          AS dep_count
    FROM     roadmap.proposal_dependencies
    WHERE    resolved         = false
    GROUP BY from_proposal_id
)
SELECT
    p.id,
    p.display_id,
    p.type,
    p.title,
    p.status,
    p.maturity,
    COALESCE(bc.blocker_count, 0) AS blocks_count,   -- proposals blocked by this one
    COALESCE(dd.dep_count, 0)     AS depends_on_count, -- unresolved deps this one has
    p.tags,
    p.created_at,
    ROW_NUMBER() OVER (
        ORDER BY COALESCE(bc.blocker_count, 0) DESC,
                 COALESCE(dd.dep_count, 0) ASC,
                 p.created_at ASC
    ) AS queue_position
FROM roadmap.proposal p
LEFT JOIN blocker_counts  bc ON bc.proposal_id = p.id
LEFT JOIN dependency_depth dd ON dd.proposal_id = p.id
WHERE p.status NOT IN ('Done','Discarded','Rejected');

COMMENT ON VIEW roadmap.v_proposal_queue IS
    'DAG-derived queue: proposals ordered by how many others they block (blocker_count DESC), '
    'then by how many unresolved deps they have (dep_count ASC), then by age. '
    'This is the authoritative priority order; proposal.priority is descriptive only.';


-- ---------------------------------------------------------------------------
-- v_blocked_proposals — unresolved blocking edges for dependency graph display
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_blocked_proposals AS
SELECT
    p.display_id    AS blocked_proposal,
    pb.display_id   AS blocked_by_proposal,
    d.dependency_type,
    d.created_at    AS since
FROM roadmap.proposal_dependencies d
JOIN roadmap.proposal p  ON p.id  = d.from_proposal_id
JOIN roadmap.proposal pb ON pb.id = d.to_proposal_id
WHERE d.resolved = false
  AND d.dependency_type = 'blocks';


-- ---------------------------------------------------------------------------
-- v_daily_spend — per-agent daily cost derived from spending_log
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_daily_spend AS
SELECT
    agent_identity,
    date_trunc('day', created_at)::date AS spend_date,
    SUM(cost_usd)                       AS total_usd,
    COUNT(*)                            AS event_count
FROM roadmap.spending_log
GROUP BY agent_identity, date_trunc('day', created_at)::date;


-- ---------------------------------------------------------------------------
-- v_active_memory — agent memory entries not yet expired
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_active_memory AS
SELECT *
FROM roadmap.agent_memory
WHERE expires_at IS NULL OR expires_at > now();


-- ---------------------------------------------------------------------------
-- v_active_leases — currently held leases with expiry status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_active_leases AS
SELECT
    pl.id,
    p.display_id,
    p.type,
    p.status,
    pl.agent_identity,
    pl.claimed_at,
    pl.expires_at,
    CASE
        WHEN pl.expires_at IS NULL            THEN 'open'
        WHEN pl.expires_at > now()            THEN 'active'
        ELSE                                       'expired'
    END AS lease_status
FROM roadmap.proposal_lease pl
JOIN roadmap.proposal p ON p.id = pl.proposal_id
WHERE pl.released_at IS NULL;


-- ---------------------------------------------------------------------------
-- v_proposal_blocked_status — dynamic block status per proposal (replaces
-- the dropped fn_sync_blocked_flag trigger from v2.1)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_sync_blocked_flag ON roadmap.proposal_dependencies;
DROP FUNCTION IF EXISTS roadmap.fn_sync_blocked_flag();

CREATE OR REPLACE VIEW roadmap.v_proposal_blocked_status AS
SELECT
    p.id,
    p.display_id,
    p.status,
    EXISTS (
        SELECT 1
        FROM   roadmap.proposal_dependencies d
        WHERE  d.from_proposal_id = p.id
          AND  d.dependency_type  = 'blocks'
          AND  d.resolved         = false
    ) AS is_blocked,
    (
        SELECT COUNT(*)
        FROM   roadmap.proposal_dependencies d
        WHERE  d.from_proposal_id = p.id
          AND  d.resolved         = false
    ) AS unresolved_dep_count
FROM roadmap.proposal p;

COMMENT ON VIEW roadmap.v_proposal_blocked_status IS
    'Dynamically computed block status per proposal; no stored flag — always current';


-- ---------------------------------------------------------------------------
-- v_undelivered_notifications — notifications with no successful delivery
-- Used by the push dispatcher and dead-letter monitor.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_undelivered_notifications AS
SELECT
    n.id,
    n.recipient,
    n.surface         AS target_surface,
    n.event_type,
    n.payload,
    n.proposal_id,
    n.created_at,
    nd.surface        AS delivery_surface,
    nd.delivered_at,
    nd.failure_reason
FROM roadmap.notification n
LEFT JOIN roadmap.notification_delivery nd
       ON nd.notification_id = n.id
      AND nd.delivered_at IS NOT NULL
WHERE nd.notification_id IS NULL
   OR nd.failure_reason  IS NOT NULL;

COMMENT ON VIEW roadmap.v_undelivered_notifications IS 'Notifications with no successful delivery on any surface; polled by push dispatcher';


-- ---------------------------------------------------------------------------
-- v_capable_agents — available agents matching capability + minimum proficiency
-- Used by lease routing to pick the least-loaded qualified agent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_capable_agents AS
SELECT
    ar.id,
    ar.agent_identity,
    ar.agent_type,
    ar.status,
    ac.capability,
    ac.proficiency,
    COALESCE(aw.active_lease_count, 0) AS active_leases,
    COALESCE(aw.context_load_score, 0) AS context_load
FROM roadmap.agent_registry ar
JOIN roadmap.agent_capability ac   ON ac.agent_id = ar.id
LEFT JOIN roadmap.agent_workload aw ON aw.agent_id = ar.id
WHERE ar.status = 'active';

COMMENT ON VIEW roadmap.v_capable_agents IS
    'Active agents with their capabilities and current workload; '
    'filter on capability + proficiency, order by active_leases ASC to route leases';


-- ---------------------------------------------------------------------------
-- v_pending_events — undispatched outbox rows with subscriber counts
-- Used by webhook_dispatcher.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_pending_events AS
SELECT
    pe.id,
    pe.proposal_id,
    pe.event_type,
    pe.payload,
    pe.created_at,
    COUNT(ws.id) AS subscriber_count
FROM roadmap.proposal_event pe
JOIN roadmap.webhook_subscription ws
  ON ws.is_active = true
 AND pe.event_type = ANY(ws.event_types)
WHERE pe.dispatched_at IS NULL
GROUP BY pe.id, pe.proposal_id, pe.event_type, pe.payload, pe.created_at;

COMMENT ON VIEW roadmap.v_pending_events IS 'Undispatched outbox events with active subscriber count; polled by webhook_dispatcher job';


-- ---------------------------------------------------------------------------
-- v_stale_embeddings — embeddings produced by inactive models or not refreshed
-- in 30 days. Consumed by the embedding_refresh job.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_stale_embeddings AS
SELECT
    er.table_name,
    er.row_id,
    er.model_name,
    er.refreshed_at,
    mm.is_active       AS model_is_active,
    now() - er.refreshed_at AS age
FROM roadmap.embedding_index_registry er
JOIN roadmap.model_metadata mm ON mm.model_name = er.model_name
WHERE mm.is_active = false
   OR er.refreshed_at < now() - INTERVAL '30 days';

COMMENT ON VIEW roadmap.v_stale_embeddings IS 'Embeddings from inactive models or not refreshed in 30 days; consumed by embedding_refresh job';


-- ---------------------------------------------------------------------------
-- v_run_summary — cross-table run summary joining run_log with aggregated logs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW roadmap.v_run_summary AS
SELECT
    r.run_id,
    r.agent_identity,
    r.proposal_id,
    r.model_name,
    r.pipeline_stage,
    r.status,
    r.started_at,
    r.finished_at,
    r.finished_at - r.started_at                       AS duration,
    COALESCE(ctx.total_tokens, 0)                       AS total_tokens,
    COALESCE(ctx.was_truncated, false)                  AS was_truncated,
    COALESCE(sl.cost_usd, 0)                            AS cost_usd,
    COALESCE(ch.cache_hits, 0)                          AS cache_hits,
    COALESCE(ch.cache_saved_usd, 0)                     AS cache_saved_usd
FROM roadmap.run_log r
LEFT JOIN LATERAL (
    SELECT SUM(total_tokens) AS total_tokens,
           bool_or(was_truncated) AS was_truncated
    FROM   roadmap.context_window_log
    WHERE  run_id = r.run_id
) ctx ON true
LEFT JOIN LATERAL (
    SELECT SUM(cost_usd) AS cost_usd
    FROM   roadmap.spending_log
    WHERE  run_id = r.run_id
) sl ON true
LEFT JOIN LATERAL (
    SELECT COUNT(*)         AS cache_hits,
           SUM(cost_saved_usd) AS cache_saved_usd
    FROM   roadmap.cache_hit_log chl
    JOIN   roadmap.cache_write_log cwl ON cwl.id = chl.cache_write_id
    WHERE  cwl.run_id = r.run_id
) ch ON true;

COMMENT ON VIEW roadmap.v_run_summary IS 'Per-run rollup joining tokens, cost, and cache savings; replaces ad-hoc cross-table joins on run_id';


-- =============================================================================
-- END OF DDL — roadmap schema v3 (consolidated)
-- =============================================================================

COMMIT;
