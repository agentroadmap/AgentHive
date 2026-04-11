-- ═══════════════════════════════════════════════════════════════
-- agentRoadmap v2.2: ULTIMATE CONSOLIDATED MASTER SCHEMA
-- ═══════════════════════════════════════════════════════════════
-- Target Engine: SpacetimeDB 2.0
-- Focus: 100-Agent Governance, Security, & Financial Traceability
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: BUSINESS & STRATEGY (The "Why")
-- ─────────────────────────────────────────────────────────────

CREATE TABLE business_domain (
    id TEXT PRIMARY KEY,         -- e.g., 'FINOPS', 'INFRA', 'AI_ENGINE'
    name TEXT,
    description TEXT
);

CREATE TABLE business_capability (
    id TEXT PRIMARY KEY,         -- e.g., 'CAP_DATA_SYNTHESIS'
    domain_id TEXT,              -- Link to business_domain
    description TEXT,
    maturity_level INT           -- 1 to 5
);

CREATE TABLE business_process (
    id BIGINT PRIMARY KEY,
    process_name TEXT,           -- e.g., 'Standard_RFC_Flow'
    version TEXT NULLABLE,
    steps_json TEXT,             -- State machine transition rules
    is_active BOOLEAN
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: DIRECTIVE (Human Intent Control Plane)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE directive (
    id BIGINT PRIMARY KEY,
    visionary_identity TEXT,      -- The Human leader's SDB Identity
    title TEXT,
    content TEXT,                -- The meaningful strategic communication
    domain_id TEXT NULLABLE,
    priority TEXT,
    status TEXT,                 -- Pending, Active, Fulfilled
    created_at BIGINT,
    expires_at BIGINT NULLABLE
);

-- Polymorphic mapping with contribution weight
CREATE TABLE directive_mapping (
    id BIGINT PRIMARY KEY,
    directive_id BIGINT,
    target_id BIGINT,            -- Link to Proposal or Ops_Issue
    target_type TEXT,            -- 'PROPOSAL' or 'ISSUE'
    contribution_weight INT      -- 1-100% toward fulfillment
);

-- Knowledge shifts from Gary/Stakeholders
CREATE TABLE strategic_memo (
    id BIGINT PRIMARY KEY,
    author_id TEXT,
    target_squad_id TEXT,
    content TEXT,
    importance_weight INT,       -- 1 to 10
    created_at BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: PRODUCT (The Strategic Roadmap)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE proposal (
    id BIGINT PRIMARY KEY,
    display_id TEXT,             -- RFC-XXXX
    directive_id BIGINT NULLABLE,
    domain_id TEXT,              -- Silo alignment
    component_id TEXT,           -- Infrastructure alignment
    capability_id TEXT,          -- Link to business_capability
    process_id BIGINT,           -- Link to business_process
    title TEXT,
    status TEXT,                 -- New, Draft, Review, Active, Accepted, Complete, Rejected, Abandoned, Replaced
    category TEXT,               -- Feature, Refactor, Security, Research
    body_markdown TEXT,
    tags TEXT NULLABLE,          -- Searchable metadata
    budget_limit_usd DOUBLE,
    created_at BIGINT,
    updated_at BIGINT
);

CREATE TABLE proposal_decision (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    title TEXT,
    decision_summary TEXT,
    rationale TEXT,              -- ADR format
    status TEXT,                 -- Proposed, Accepted, Superseded, Deprecated
    created_at BIGINT
);

CREATE TABLE proposal_criteria (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    description TEXT,
    is_verified BOOLEAN,
    verified_by_agent_id TEXT NULLABLE,
    verified_at BIGINT NULLABLE
);

CREATE TABLE proposal_discussion (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    agent_identity TEXT,
    content TEXT,
    note_type TEXT,              -- Technical, Strategic, Blocker, Cost
    created_at BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: INFRASTRUCTURE & EXECUTION (The "How")
-- ─────────────────────────────────────────────────────────────

CREATE TABLE component_registry (
    id TEXT PRIMARY KEY,
    domain_id TEXT,
    name TEXT,
    description TEXT,
    repository_path TEXT,        -- Path to the Git artifact
    owner_identity TEXT          -- Lead Architect agent
);

-- Unified Execution: Handles Tasks, Bugs, and Administrative Requests
CREATE TABLE ops_issue (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE,
    assigned_identity TEXT NULLABLE,
    requester_identity TEXT NULLABLE,
    title TEXT,
    description TEXT,
    category TEXT,               -- TASK, BUG, REQUEST, INFRA, SECURITY
    request_type TEXT NULLABLE,  -- BUDGET_INC, ACCESS_GRANT, MODEL_SWAP
    request_payload_json TEXT NULLABLE,
    severity TEXT,               -- P0 to P3
    status TEXT,                 -- BACKLOG, ACTIVE, PENDING_APPROVAL, RESOLVED, DENIED
    tags TEXT NULLABLE,
    created_at BIGINT,
    resolved_at BIGINT NULLABLE
);

CREATE TABLE ops_issue_history (
    id BIGINT PRIMARY KEY,
    issue_id BIGINT,
    from_status TEXT,
    to_status TEXT,
    actor_identity TEXT,
    comment TEXT NULLABLE,
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: WORKFORCE & ECONOMY (The "Who" and "Cost")
-- ─────────────────────────────────────────────────────────────

CREATE TABLE workforce_registry (
    identity TEXT PRIMARY KEY,   -- Cryptographic SDB Identity
    agent_id TEXT,               -- Readable ID e.g., 'ARCH-01'
    role TEXT,
    squad_id TEXT,
    clearance_level INT,         -- 1 to 5
    is_active BOOLEAN
);

CREATE TABLE workforce_pulse (
    identity TEXT PRIMARY KEY,
    active_issue_id BIGINT NULLABLE,
    last_seen_at BIGINT,
    status_message TEXT,         -- "Working on Issue #105"
    is_zombie BOOLEAN
);

CREATE TABLE spending_caps (
    agent_identity TEXT PRIMARY KEY,
    daily_limit_usd DOUBLE,
    total_spent_today_usd DOUBLE,
    is_frozen BOOLEAN
);

CREATE TABLE model_registry (
    model_id TEXT PRIMARY KEY,   -- e.g., 'claude-3-5-sonnet'
    provider TEXT,
    cost_per_1m_input DOUBLE,
    cost_per_1m_output DOUBLE,
    reasoning_rating INT
);

CREATE TABLE spending_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE,
    issue_id BIGINT NULLABLE,
    agent_identity TEXT,
    model_id TEXT,
    cost_usd DOUBLE,
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: QUALITY & SECURITY (The Guardrails)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE security_acl (
    id BIGINT PRIMARY KEY,
    agent_identity TEXT,
    target_id TEXT,              -- Domain or Component ID
    permission_id TEXT           -- READ, WRITE, EXECUTE
);

CREATE TABLE security_audit_log (
    id BIGINT PRIMARY KEY,
    actor_identity TEXT,
    action TEXT,
    severity TEXT,
    timestamp BIGINT
);

CREATE TABLE test_definition (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    test_name TEXT,
    category TEXT                -- Security, Regression, Unit, Adversarial
);

CREATE TABLE test_results (
    id BIGINT PRIMARY KEY,
    test_id BIGINT,              -- Link to test_definition
    passed BOOLEAN,
    error_log TEXT,
    timestamp BIGINT
);

CREATE TABLE promotion_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    artifact_path TEXT,
    git_commit_sha TEXT,
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: COGNITION (Memory & Context)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE agent_memory (
    id BIGINT PRIMARY KEY,
    agent_identity TEXT,
    scope_id TEXT,               -- Proposal or Component ID
    key TEXT,
    val TEXT,
    updated_at BIGINT
);

CREATE TABLE message_ledger (
    id BIGINT PRIMARY KEY,
    channel_name TEXT,
    sender_identity TEXT,
    content TEXT,
    msg_type TEXT,               -- Log, Chat, Tool_Call, Alert
    timestamp BIGINT
);
