-- ═══════════════════════════════════════════════════════════════
-- agentRoadmap v2.0: FULL CONSOLIDATED MASTER SCHEMA
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
    domain_id TEXT,
    description TEXT,
    maturity_level INT           -- 1 to 5
);

CREATE TABLE business_process (
    id BIGINT PRIMARY KEY,
    process_name TEXT,           -- e.g., 'Standard_RFC_Flow'
    steps_json TEXT              -- State machine transition rules
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: DIRECTIVE (Human Intent Control Plane)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE directive (
    id BIGINT PRIMARY KEY,
    visionary_identity TEXT,      -- The Human leader's SDB Identity
    title TEXT,
    content TEXT,                -- The meaningful strategic communication
    status TEXT,                 -- Pending, Active, Fulfilled
    created_at BIGINT
);

CREATE TABLE directive_mapping (
    id BIGINT PRIMARY KEY,
    directive_id BIGINT,
    target_id BIGINT,            -- Can link to Proposal or Ops_Issue
    target_type TEXT,            -- 'PROPOSAL' or 'ISSUE'
    contribution_weight INT      -- 1-100% toward fulfillment
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
    title TEXT,
    status TEXT,                 -- New, Draft, Review, Active, Accepted, Complete, Rejected
    category TEXT,               -- Feature, Refactor, Security
    body_markdown TEXT,
    tags TEXT NULLABLE,          -- Searchable metadata
    budget_limit_usd DOUBLE,
    created_at BIGINT
);

CREATE TABLE proposal_decision (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    title TEXT,
    decision_summary TEXT,
    rationale TEXT,              -- ADR format
    status TEXT,                 -- Accepted, Superseded
    created_at BIGINT
);

CREATE TABLE proposal_criteria (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    description TEXT,
    is_verified BOOLEAN
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: INFRASTRUCTURE & EXECUTION (The "How")
-- ─────────────────────────────────────────────────────────────

CREATE TABLE component_registry (
    id TEXT PRIMARY KEY,
    domain_id TEXT,
    name TEXT,
    repository_path TEXT         -- Path to the Git artifact
);

-- Unified Execution: Handles Tasks, Bugs, and Administrative Requests
CREATE TABLE ops_issue (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE,
    assigned_identity TEXT NULLABLE,
    requester_identity TEXT NULLABLE,
    title TEXT,
    category TEXT,               -- TASK, BUG, REQUEST, INFRA
    request_type TEXT NULLABLE,  -- BUDGET_INC, ACCESS_GRANT
    request_payload_json TEXT NULLABLE,
    status TEXT,                 -- BACKLOG, ACTIVE, PENDING_APPROVAL, RESOLVED
    tags TEXT NULLABLE,
    created_at BIGINT
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
    is_active BOOLEAN
);

CREATE TABLE workforce_pulse (
    identity TEXT PRIMARY KEY,
    active_issue_id BIGINT NULLABLE,
    last_seen_at BIGINT,
    status_message TEXT          -- "Working on Issue #105"
);

CREATE TABLE spending_caps (
    agent_identity TEXT PRIMARY KEY,
    daily_limit_usd DOUBLE,
    total_spent_today_usd DOUBLE,
    is_frozen BOOLEAN
);

CREATE TABLE spending_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE,
    issue_id BIGINT NULLABLE,
    agent_identity TEXT,
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

CREATE TABLE test_results (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
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
    timestamp BIGINT
);
