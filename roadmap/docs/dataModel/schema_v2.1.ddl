-- ═══════════════════════════════════════════════════════════════
-- agentRoadmap v2.5: THE FRESH START MASTER SCHEMA
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: THE UNIVERSAL ENTITY (The "Everything" Table)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE proposal (
    id BIGINT PRIMARY KEY,
    display_id TEXT,             -- Human-readable ID (e.g., 'DIR-001', 'RFC-105')
    parent_id BIGINT NULLABLE,   -- Hierarchy glue (Parent Directive -> Child RFC)
    
    -- Discriminators
    proposal_type TEXT,          -- DIRECTIVE, CAPABILITY, TECHNICAL, COMPONENT, OPS_ISSUE
    category TEXT,               -- FEATURE, BUG, RESEARCH, SECURITY, INFRA
    
    -- Strategic Context
    domain_id TEXT,              -- Business silo (e.g., 'FINOPS', 'ENGINE')
    title TEXT,
    status TEXT,                 -- New, Draft, Review, Active, Accepted, Complete, Rejected
    priority TEXT,               -- Strategic, High, Medium, Low
    
    -- Content & Logic
    body_markdown TEXT NULLABLE, -- The primary text (Idea, RFC Spec, or Issue details)
    process_logic TEXT NULLABLE, -- Descriptive business process for Directives
    maturity_level INT NULLABLE, -- 1-5 (For CAPABILITY and COMPONENT types)
    repository_path TEXT NULLABLE, -- Physical Git path (For COMPONENT/SRC types)
    
    -- Economics & Search
    budget_limit_usd DOUBLE,
    tags TEXT NULLABLE,          -- JSON/Comma-separated metadata
    
    created_at BIGINT,
    updated_at BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: PROVENANCE & LIFECYCLE (The Logic)
-- ─────────────────────────────────────────────────────────────

-- Git-style versioning for body_markdown and metadata.
CREATE TABLE proposal_version (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    author_identity TEXT,        -- SDB Identity of the agent/human
    version_number INT,
    change_summary TEXT,         -- "Commit Message"
    body_delta TEXT NULLABLE,     -- Unified Diff of the markdown
    metadata_delta_json TEXT,    -- Changes to status, priority, etc.
    git_commit_sha TEXT NULLABLE, -- Pointer to the read-only MD mirror commit
    timestamp BIGINT
);

CREATE TABLE proposal_criteria (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    description TEXT,
    is_verified BOOLEAN          -- Must be true for 'Complete' status
);

CREATE TABLE proposal_decision (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    title TEXT,
    decision_summary TEXT,
    rationale TEXT,              -- Formal ADR format
    status TEXT,                 -- Accepted, Superseded
    created_at BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: ASSETS (Multimedia & Binary Store)
-- ─────────────────────────────────────────────────────────────

-- Links photos and diagrams to proposals.
CREATE TABLE attachment_registry (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    display_id TEXT,             -- Used for folder pathing
    file_name TEXT,
    relative_path TEXT,          -- Path: 'product/attachments/[display_id]/file'
    file_type TEXT,              -- PHOTO, DIAGRAM, MOCKUP
    content_hash TEXT,           -- SHA-256 for integrity
    vision_summary TEXT NULLABLE, -- AI-generated description for text agents
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: WORKFORCE & ECONOMY (The Guardrails)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE workforce_registry (
    identity TEXT PRIMARY KEY,   -- Cryptographic SDB Identity
    agent_id TEXT,               -- Readable ID (e.g., 'CODE-01')
    role TEXT,
    is_active BOOLEAN
);

CREATE TABLE workforce_pulse (
    identity TEXT PRIMARY KEY,
    active_proposal_id BIGINT NULLABLE, -- Current tactical focus
    last_seen_at BIGINT,
    status_message TEXT,         -- "Drafting RFC-105..."
    is_zombie BOOLEAN
);

CREATE TABLE spending_caps (
    agent_identity TEXT PRIMARY KEY,
    daily_limit_usd DOUBLE,
    total_spent_today_usd DOUBLE,
    is_frozen BOOLEAN            -- System-wide kill switch for the agent
);

CREATE TABLE spending_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,          -- All costs linked to a specific entity
    agent_identity TEXT,
    cost_usd DOUBLE,
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: SECURITY & KNOWLEDGE (The Vault)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE security_acl (
    id BIGINT PRIMARY KEY,
    agent_identity TEXT,
    target_proposal_id BIGINT,   -- Access to specific Directives or Components
    permission_id TEXT           -- READ, WRITE, EXECUTE
);

CREATE TABLE security_audit_log (
    id BIGINT PRIMARY KEY,
    actor_identity TEXT,
    action TEXT,                 -- e.g., 'SDB_REDUCER_CALL'
    severity TEXT,
    timestamp BIGINT
);

CREATE TABLE agent_memory (
    id BIGINT PRIMARY KEY,
    agent_identity TEXT,
    scope_proposal_id BIGINT,    -- Memory limited to specific proposal context
    key TEXT,
    val TEXT,
    updated_at BIGINT
);

CREATE TABLE message_ledger (
    id BIGINT PRIMARY KEY,
    channel_name TEXT,
    sender_identity TEXT,
    content TEXT,
    timestamp BIGINT
);
