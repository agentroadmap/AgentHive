-- ═══════════════════════════════════════════════════════════════
-- agentRoadmap v2.0: Unified Master Schema (Final Polish)
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: BUSINESS & DIRECTIVE (The Intent)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE business_capability (
    id TEXT PRIMARY KEY,
    description TEXT,
    owning_squad_id TEXT,
    maturity_level INT
);

CREATE TABLE business_process (
    id BIGINT PRIMARY KEY,
    process_name TEXT,
    steps_json TEXT,
    is_active BOOLEAN
);

CREATE TABLE directive (
    id BIGINT PRIMARY KEY,
    visionary_identity TEXT,      -- The Human Stakeholder
    title TEXT,
    content TEXT,
    domain_id TEXT NULLABLE,
    priority TEXT,
    status TEXT,                 -- Pending, Active, Fulfilled
    created_at BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: PRODUCT (The Roadmap)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE proposal (
    id BIGINT PRIMARY KEY,
    display_id TEXT,             -- RFC-XXXX
    directive_id BIGINT NULLABLE,
    domain_id TEXT,
    component_id TEXT,
    capability_id TEXT,          -- Link to business_capability
    process_id BIGINT,           -- Link to business_process
    title TEXT,
    status TEXT,                 -- New, Draft, Review, Active, Accepted, Complete, Rejected, Abandoned, Replaced
    body_markdown TEXT,
    budget_limit_usd DOUBLE,
    created_at BIGINT
);

CREATE TABLE proposal_decision (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    title TEXT,
    decision_summary TEXT,
    rationale TEXT,
    status TEXT,
    created_at BIGINT
);

CREATE TABLE proposal_criteria (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    description TEXT,
    is_verified BOOLEAN
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: OPERATIONS (The Unified Execution)
-- ─────────────────────────────────────────────────────────────

-- Handles Bugs, Tasks, and Administrative Requests (Merged logic)
CREATE TABLE ops_issue (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE,
    directive_id BIGINT NULLABLE,
    assigned_identity TEXT NULLABLE,
    requester_identity TEXT NULLABLE,
    title TEXT,
    description TEXT,
    category TEXT,               -- BUG, TASK, REQUEST, INFRA
    request_type TEXT NULLABLE,  -- BUDGET_INC, ACCESS_GRANT
    request_payload_json TEXT NULLABLE,
    status TEXT,                 -- BACKLOG, ACTIVE, PENDING_APPROVAL, RESOLVED
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
-- DOMAIN: WORKFORCE & SPENDING (The Economy)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE workforce_registry (
    identity TEXT PRIMARY KEY,
    agent_id TEXT,               -- e.g., 'ARCH-01'
    role TEXT,
    squad_id TEXT,
    is_active BOOLEAN
);

CREATE TABLE workforce_pulse (
    identity TEXT PRIMARY KEY,
    active_issue_id BIGINT NULLABLE, -- Current tactical work
    last_seen_at BIGINT,
    status_message TEXT,
    is_zombie BOOLEAN
);

CREATE TABLE spending_caps (
    agent_identity TEXT PRIMARY KEY,
    daily_limit_usd DOUBLE,
    total_spent_today_usd DOUBLE,
    is_frozen BOOLEAN
);

CREATE TABLE spending_log (
    id BIGINT PRIMARY KEY,
    issue_id BIGINT NULLABLE,
    agent_identity TEXT,
    cost_usd DOUBLE,
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: PIPELINE & QA (The Gatekeeper)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE test_definition (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    test_name TEXT,
    category TEXT                -- Security, Regression, Unit
);

CREATE TABLE test_results (
    id BIGINT PRIMARY KEY,
    test_id BIGINT,
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
-- DOMAIN: CONTEXT & MEMORY
-- ─────────────────────────────────────────────────────────────

CREATE TABLE agent_memory (
    id BIGINT PRIMARY KEY,
    agent_identity TEXT,
    scope_id TEXT,               -- Links to Proposal or Component
    key TEXT,
    val TEXT,
    updated_at BIGINT
);

CREATE TABLE message_ledger (
    id BIGINT PRIMARY KEY,
    channel_name TEXT,
    sender_identity TEXT,
    content TEXT,
    msg_type TEXT,
    timestamp BIGINT
);
