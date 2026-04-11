This DDL represents the **agentRoadmap v2.0** architecture. It migrates your "V1" schema into a domain-driven model, replacing the `step` nomenclature with the **Proposal Lifecycle** and expanding into the 13 domains identified in your manifest.

While SpacetimeDB uses Rust structs, this SQL-compatible DDL serves as the authoritative specification for your next migration.

---

## 1. Product & Project Domains (The Proposal Engine)

```sql
-- Replaces 'step' and 'prop'. The central "God Object" of the system.
CREATE TABLE proposal (
    id BIGINT PRIMARY KEY,
    display_id TEXT,             -- e.g., "RFC-2026-001"
    parent_proposal_id BIGINT NULLABLE,
    squad_id TEXT,
    title TEXT,
    status TEXT,                 -- New, Draft, Review, Active, Accepted, Complete, Rejected, Abandoned, Replaced
    body_markdown TEXT,
    priority TEXT,               -- Low, Medium, High, Critical
    visionary_id TEXT,           -- Link to Human (Gary/Derek/Nolan)
    owner_agent_id TEXT,         -- The Lead Architect agent
    budget_limit_usd DOUBLE,
    created_at BIGINT,
    updated_at BIGINT
);
CREATE INDEX proposal_status_idx ON proposal (status);

-- Replaces 'ac'. Links specific criteria to the proposal lifecycle.
CREATE TABLE proposal_criteria (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    description TEXT,
    is_verified BOOLEAN,
    verified_by_agent_id TEXT NULLABLE,
    verified_at BIGINT NULLABLE
);

-- Replaces 'rev'. Formalized adversarial and peer review.
CREATE TABLE proposal_review (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    reviewer_agent_id TEXT,
    verdict TEXT,                -- Approved, Skeptical, Rejected
    rationale TEXT,
    timestamp BIGINT
);

-- Replaces 'flow'. High-fidelity audit trail for the 9-stage lifecycle.
CREATE TABLE proposal_state_history (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    from_status TEXT,
    to_status TEXT,
    reason TEXT,
    actor_id TEXT,               -- Agent or Human ID
    timestamp BIGINT
);
```

---

## 2. Workforce Domain (Registry & Pulse)

```sql
-- Replaces 'agent'. The source of truth for all 100 agents.
CREATE TABLE workforce_registry (
    identity TEXT PRIMARY KEY,   -- Cryptographic SDB Identity
    agent_id TEXT,               -- Readable ID e.g., "ARCH-01"
    name TEXT,
    role TEXT,                   -- Architect, Skeptic, Coder, etc.
    squad_id TEXT,
    clearance_level INT,         -- 1 to 5
    is_active BOOLEAN,
    created_at BIGINT
);

-- New Table: Tracking the real-time health of the 100-agent fleet.
CREATE TABLE workforce_pulse (
    identity TEXT PRIMARY KEY,
    last_seen_at BIGINT,
    current_latency_ms INT,
    status_message TEXT,         -- e.g., "Synthesizing RFC-001"
    is_zombie BOOLEAN            -- True if pulse is missed twice
);

-- Replaces 'agent_skill' and 'skill'.
CREATE TABLE skill_registry (
    id BIGINT PRIMARY KEY,
    name TEXT,                   -- e.g., "Rust-SDB-Optimization"
    description TEXT,
    spec_version TEXT
);

CREATE TABLE workforce_skills (
    identity TEXT,
    skill_id BIGINT,
    proficiency_level INT,       -- 1 to 10
    PRIMARY KEY (identity, skill_id)
);
```

---

## 3. Spending & Model Domains (The Economy)

```sql
-- Replaces 'token_ledger'. Granular tracking of every cent.
CREATE TABLE spending_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT NULLABLE, -- Links cost directly to an RFC
    agent_identity TEXT,
    model_name TEXT,
    input_tokens BIGINT,
    output_tokens BIGINT,
    cached_tokens BIGINT,
    cost_usd DOUBLE,
    timestamp BIGINT
);

-- Replaces 'agent_budget'.
CREATE TABLE spending_caps (
    agent_identity TEXT PRIMARY KEY,
    daily_limit_usd DOUBLE,
    monthly_limit_usd DOUBLE,
    total_spent_usd DOUBLE,
    is_frozen BOOLEAN
);

-- New Table: Storing model intelligence and cost attributes.
CREATE TABLE model_registry (
    model_name TEXT PRIMARY KEY, -- e.g., "claude-3-5-sonnet"
    provider TEXT,               -- OpenRouter, Local, etc.
    cost_per_1k_input DOUBLE,
    cost_per_1k_output DOUBLE,
    reasoning_rating INT,        -- 1 to 10
    is_active BOOLEAN
);
```

---

## 4. Context & Messaging Domains (Memory & Comms)

```sql
-- Replaces 'comp' and 'cache'.
CREATE TABLE context_partition (
    id BIGINT PRIMARY KEY,
    name TEXT,                   -- e.g., "Material_Science_Knowledge"
    scope TEXT,                  -- Global, Squad, or Proposal
    owner_identity TEXT NULLABLE
);

-- Replaces 'mem'. High-density long-term storage.
CREATE TABLE agent_long_term_memory (
    id BIGINT PRIMARY KEY,
    agent_identity TEXT,
    partition_id BIGINT,
    key TEXT,
    val TEXT,
    updated_at BIGINT
);

-- Replaces 'chan' and 'msg'.
CREATE TABLE messaging_channel (
    name TEXT PRIMARY KEY,
    description TEXT,
    is_private BOOLEAN
);

CREATE TABLE message_ledger (
    id BIGINT PRIMARY KEY,
    channel_name TEXT,
    sender_identity TEXT,
    content TEXT,
    msg_type TEXT,               -- Log, Chat, Tool_Call
    timestamp BIGINT
);
```

---

## 5. Pipeline & Infrastructure Domains (The Gatekeeper)

```sql
-- New Table: Monitoring the transition from SDB to Git.
CREATE TABLE promotion_log (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    artifact_path TEXT,          -- e.g., "product/RFC-2026-001.md"
    git_commit_sha TEXT,
    promoted_by_identity TEXT,
    timestamp BIGINT
);

-- Replaces 'test' and 'res'.
CREATE TABLE test_definition (
    id BIGINT PRIMARY KEY,
    proposal_id BIGINT,
    test_name TEXT,
    category TEXT,               -- Security, Regression, Unit
    file_path TEXT
);

CREATE TABLE test_results (
    id BIGINT PRIMARY KEY,
    test_id BIGINT,
    passed BOOLEAN,
    duration_ms INT,
    error_log TEXT,
    timestamp BIGINT
);

-- Replaces 'sbx'.
CREATE TABLE execution_sandbox (
    container_id TEXT PRIMARY KEY,
    agent_identity TEXT,
    status TEXT,                 -- Spinning_Up, Active, Terminated
    created_at BIGINT,
    expires_at BIGINT
);
```

---

### Key Migration Notes:
1.  **Uniform Naming:** Every table now uses its full domain name as a prefix (e.g., `workforce_`, `proposal_`, `spending_`). This allows agents to use wildcard tools like `read_table("proposal_*")` more effectively.
2.  **Identity-First:** All agent references now use `identity` (the SpacetimeDB public key) as the primary key/foreign key, ensuring Row-Level Security (RLS) is native to the architecture.
3.  **RFC Centricity:** The `proposal_id` is now a foreign key in `spending_log`, `test_definition`, and `promotion_log`. This creates a unified "Cost-to-Value" audit trail that was missing in V1.
4.  **Pulse Integration:** The `workforce_pulse` table is critical for your TUI and WebSash to display the real-time "heartbeat" of your 100-agent workforce.
