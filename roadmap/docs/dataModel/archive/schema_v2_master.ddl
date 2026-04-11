-- ═══════════════════════════════════════════════════════════════
-- agentRoadmap v2.0: Unified Agentic Enterprise Schema
-- ═══════════════════════════════════════════════════════════════
-- Target Engine: SpacetimeDB 2.0 (Relational / Rust-Backed)
-- Focus: Domain-Driven Design, Financial Guardrails, Auditability
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: BUSINESS (Strategy & Governance)
-- ─────────────────────────────────────────────────────────────

-- Defines the high-level "Value Streams" the enterprise provides.
CREATE TABLE business_capability (
    id TEXT PRIMARY KEY,         -- e.g., 'CAP_DATA_SYNTHESIS'
    description TEXT,            -- What value this capability provides
    owning_squad_id TEXT,        -- The squad responsible for this value
    maturity_level INT           -- 1 (Initial) to 5 (Optimized)
);

-- The "Railway Tracks" for agent workflows (BPMN-style).
CREATE TABLE business_process (
    id BIGINT PRIMARY KEY,
    process_name TEXT,           -- e.g., 'Standard_RFC_Flow'
    version TEXT,
    steps_json TEXT,             -- State machine logic for status transitions
    is_active BOOLEAN
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: INFRASTRUCTURE (The Physical Map)
-- ─────────────────────────────────────────────────────────────

-- Maps the logical software architecture to physical artifacts.
CREATE TABLE component_registry (
    id TEXT PRIMARY KEY,         -- e.g., 'SDB_SCHEMA_CORE'
    domain_id TEXT,              -- Link to high-level domain (Core, UI, FinOps)
    name TEXT,
    description TEXT,
    repository_path TEXT,        -- The subfolder in Git (e.g., 'infrastructure/db/')
    owner_identity TEXT          -- The Lead Architect agent responsible
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: PRODUCT (The Strategic Roadmap)
-- ─────────────────────────────────────────────────────────────

-- The core object. Replaces 'step'. Represents a proposed change.
CREATE TABLE proposal (
    id BIGINT PRIMARY KEY,
    display_id TEXT,             -- e.g., 'RFC-2026-001'
    parent_id BIGINT NULLABLE,   -- For nested or dependent proposals
    domain_id TEXT,              -- Grouping: Core, UI, Infrastructure, etc.
    component_id TEXT,           -- Specific component from component_registry
    category TEXT,               -- Feature, Bug, Refactor, Security, Research
    business_capability_id TEXT, -- The 'Why' (Link to business value)
    business_process_id BIGINT,   -- The 'How' (Link to workflow rules)
    title TEXT,
    status TEXT,                 -- New, Draft, Review, Active, Accepted, Complete, Rejected, Abandoned, Replaced
    body_markdown TEXT,          -- The full technical proposal
    priority TEXT,               -- Low, Medium, High, Critical
    visionary_id TEXT,           -- Human Stakeholder (Gary/Derek/Nolan)
    budget_limit_usd DOUBLE,     -- Authorized spending cap for this RFC
    created_at BIGINT,
    updated_at BIGINT
);

-- Mandatory Acceptance Criteria for a Proposal.
CREATE TABLE proposal_criteria (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    description TEXT,
    is_verified BOOLEAN,         -- Must be true to move to 'Accepted'
    verified_by_agent_id TEXT NULLABLE,
    verified_at BIGINT NULLABLE
);

-- Formal Architecture Decision Records (ADR).
CREATE TABLE proposal_decision (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    title TEXT,
    decision_summary TEXT,       -- The "What"
    rationale TEXT,              -- The "Why"
    status TEXT,                 -- Proposed, Accepted, Superseded, Deprecated
    created_at BIGINT
);

-- Threaded discussions regarding a specific proposal.
CREATE TABLE proposal_discussion (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    agent_identity TEXT,
    content TEXT,
    note_type TEXT,              -- Technical, Strategic, Blocker, Cost
    created_at BIGINT
);

-- Administrative requests (Budget increases, Tool access).
CREATE TABLE ops_request (
    id BIGINT PRIMARY KEY,
    requester_identity TEXT,
    request_type TEXT,           -- Budget_Increase, Access_Grant
    payload_json TEXT,           -- Details of the request
    status TEXT,                 -- Pending_Human, Approved, Denied
    approver_identity TEXT NULLABLE
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: WORKFORCE (Identity & Performance)
-- ─────────────────────────────────────────────────────────────

-- Source of truth for all 100 agents.
CREATE TABLE workforce_registry (
    identity TEXT PRIMARY KEY,   -- Cryptographic SDB Identity
    agent_id TEXT,               -- Readable ID e.g., 'ARCH-01'
    role TEXT,                   -- Architect, Skeptic, Coder, etc.
    squad_id TEXT,
    clearance_level INT,         -- 1 to 5
    is_active BOOLEAN
);

-- Real-time health and heartbeat of the agents.
CREATE TABLE workforce_pulse (
    identity TEXT PRIMARY KEY,
    last_seen_at BIGINT,
    status_message TEXT,         -- Current activity description
    is_zombie BOOLEAN            -- True if heartbeat is lost
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: SPENDING & MODEL (The Economy)
-- ─────────────────────────────────────────────────────────────

-- The "Brain Registry" for LLM selection.
CREATE TABLE model_registry (
    model_id TEXT PRIMARY KEY,   -- e.g., 'claude-3-5-sonnet'
    provider TEXT,               -- OpenRouter, Local, etc.
    cost_per_1m_input DOUBLE,
    cost_per_1m_output DOUBLE,
    reasoning_rating INT         -- 1 to 10
);

-- Detailed spending ledger.
CREATE TABLE spending_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE, -- Link to Product Cost
    issue_id BIGINT NULLABLE,    -- Link to Ops Cost
    agent_identity TEXT,
    model_id TEXT,
    cost_usd DOUBLE,
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: PIPELINE (The Gatekeeper)
-- ─────────────────────────────────────────────────────────────

-- Records when a SpacetimeDB change is committed to Git.
CREATE TABLE promotion_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    artifact_path TEXT,          -- Path in the 'product/' or 'infrastructure/' folders
    git_commit_sha TEXT,
    timestamp BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: CONTEXT & MESSAGING (Memory & Comms)
-- ─────────────────────────────────────────────────────────────

-- High-density long-term agent memory.
CREATE TABLE agent_memory (
    id BIGINT PRIMARY KEY,
    agent_identity TEXT,
    scope_id TEXT,               -- Links to Proposal or Component
    key TEXT,
    val TEXT,
    updated_at BIGINT
);

-- Immutable record of all agent-to-agent and agent-to-human talk.
CREATE TABLE message_ledger (
    id BIGINT PRIMARY KEY,
    channel_name TEXT,
    sender_identity TEXT,
    content TEXT,
    msg_type TEXT,               -- Log, Chat, Tool_Call
    timestamp BIGINT
);


-- ─────────────────────────────────────────────────────────────
-- DOMAIN: DIRECTIVE (The Visionary Control Plane)
-- ─────────────────────────────────────────────────────────────

-- The "North Star" commands issued by Human Stakeholders.
CREATE TABLE directive (
    id BIGINT PRIMARY KEY,
    visionary_id TEXT,           -- Gary, Derek, or Nolan
    title TEXT,                  -- Short summary of the command
    content TEXT,                -- The full "Meaningful Communication"
    domain_id TEXT NULLABLE,     -- e.g., 'FINOPS', 'ENGINE', 'RESEARCH'
    priority TEXT,               -- P0 (Emergency) to P3 (Strategic)
    status TEXT,                 -- Pending, In_Progress, Fulfilled, Canceled
    created_at BIGINT,
    expires_at BIGINT NULLABLE   -- When the directive is no longer relevant
);

-- Links Directives to the Proposals they spawned.
-- This allows you to track "Intent Fulfillment."
CREATE TABLE directive_mapping (
    id BIGINT PRIMARY KEY,
    directive_id BIGINT,
    proposal_id BIGINT NULLABLE,
    ops_issue_id BIGINT NULLABLE,
    status TEXT                  -- How this specific link contributes to fulfillment
);

-- A specific table for "Human-to-Squad" strategic memos.
-- Use this for context that isn't a "Command" but a "Knowledge Shift."
CREATE TABLE strategic_memo (
    id BIGINT PRIMARY KEY,
    author_id TEXT,
    target_squad_id TEXT,        -- e.g., 'INFRA_SQUAD'
    content TEXT,
    importance_weight INT,       -- 1 to 10 (Directs agent attention)
    created_at BIGINT
);

-- ─────────────────────────────────────────────────────────────
-- DOMAIN: OPERATIONS (The Unified Ticket)
-- ─────────────────────────────────────────────────────────────

-- Handles Bugs, Tasks, AND Administrative Requests.
CREATE TABLE ops_issue (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE, -- Links to Product Roadmap
    directive_id BIGINT NULLABLE, -- Links to Strategic Intent
    assigned_identity TEXT NULLABLE,
    requester_identity TEXT NULLABLE, -- Who is asking (if it's a Request)
    
    title TEXT,
    description TEXT,
    
    category TEXT,               -- BUG, TASK, REQUEST, INFRA, SECURITY
    request_type TEXT NULLABLE,  -- BUDGET_INC, ACCESS_GRANT, MODEL_SWAP
    request_payload_json TEXT NULLABLE, -- The specific data for the request
    
    severity TEXT,               -- P0 to P3
    status TEXT,                 -- BACKLOG, ACTIVE, PENDING_APPROVAL, RESOLVED, DENIED
    
    estimated_tokens INT,
    created_at BIGINT,
    resolved_at BIGINT NULLABLE
);

-- Essential for the "Approval Audit Trail".
CREATE TABLE ops_issue_history (
    id BIGINT PRIMARY KEY,
    issue_id BIGINT,
    from_status TEXT,
    to_status TEXT,
    actor_identity TEXT,         -- The Human or Agent who approved/denied
    comment TEXT NULLABLE,       -- Rationale for the status change
    timestamp BIGINT
);
