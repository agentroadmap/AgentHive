This refactoring plan moves **agentHive** from a single-table logic to a robust, enterprise-grade architecture. By using dedicated PostgreSQL schemas for these four domains, we physically isolate the "noise" of execution from the "signal" of design, enabling the 100-agent fleet to operate with significantly fewer locking conflicts.

---

### ## Database Refactoring Guidelines

To ensure this refactor unblocks the current gating deadlocks and supports the "Type A vs Type B" logic, agents must follow these three mandates:
1.  **Schema Isolation**: Every domain must reside in its own Postgres schema (`roadmap`, `roadmap_proposal`, etc.) to allow for granular `security_acl` and independent migrations.
2.  **Term Authority**: No agent is permitted to hardcode "Maturity" levels or "State" names. They must query the `roadmap.reference_terms` table to ensure systematic alignment.
3.  **Lease-First Access**: All write operations to `roadmap_proposal` or `roadmap_workforce` must be preceded by a lease check in the `claim_log`.



---

### ## Domain 1: `roadmap` (The Utility & Foundation)
This schema acts as the "Operating System" for the hive. It stores the stable configuration that defines how the TUI, Web Dashboard, and MCP services interact.

| Table | Purpose | Key Attributes |
| :--- | :--- | :--- |
| `reference_terms` | The Master Vocabulary | `term_category`, `term_value`, `is_immutable` |
| `app_config` | Global settings | `ui_mode`, `git_auto_commit_status`, `export_path` |
| `mcp_registry` | MCP Endpoint definitions | `transport_type` (SSE/Chatty/Chunky), `port`, `heartbeat` |
| `ui_preferences` | TUI/Web/Mobile settings | `max_column_width`, `theme`, `refresh_rate` |

---

### ## Domain 2: `roadmap_proposal` (The Nervous System)
This handles the **Universal Entity Lifecycle**. We are rebranding `maturity_state` to `maturity` to clarify that a proposal has both a **State** (Draft/Review) and a **Maturity** (New/Active/Mature).

* **Logic Mode**: Supports **Type A (Design)** and **Type B (Implementation)** gating rules.
* **Key Tables**:
    * `proposal`: The root entity. Includes `proposal_type` (Theory, Product, Feature, Hotfix).
    * `workflow_state`: Local dynamic enforcement of transitions.
    * `claim_log`: Tracks active agent leases and TTLs to prevent "Inertia Loops".
    * `proposal_version`: Git-style deltas for every change to the permanent record.

---

### ## Domain 3: `roadmap_workforce` (The Fleet Management)
This is where the governance theories (Ostrom, Axelrod, Ubuntu) are codified into agent behavior.

* **Agent Aging**: A combined metric of **Memory Decay** and **Moral Alignment**.
* **Key Tables**:
    * `agent_profile`: Identity, Role (Architect/Skeptic/Coder), and Skills.
    * `trust_ledger`: Reputation scores based on Tit-for-Tat cooperation (Axelrod).
    * `squad_dispatch`: Real-time mapping of agents to active Proposal positions.
    * `authority_chain`: Defines which agents (or Gary) can approve transitions for specific Pillars.

---

### ## Domain 4: `roadmap_efficiency` (The Performance Optimizer)
This domain treats **Context** and **Tokens** as expensive resources that must be governed via Ostrom’s principles.

* **The 5-Level Memory Hierarchy**:
    1.  **Universal**: Project-wide laws and constitutions.
    2.  **Project**: High-level product direction.
    3.  **Team**: Shared squad-level knowledge (Ubuntu philosophy).
    4.  **Agent**: Individual agent's local experience and "hand-off notes."
    5.  **Task**: Transient, proposal-specific ephemeral data.
* **Key Tables**:
    * `token_ledger`: Real-time burn rate and `spending_caps`.
    * `context_cache`: Local storage for frequently used "Neural Snapshots."
    * `api_buffer`: Manages delayed and pulled LLM calls to optimize cost.

---

### ## Implementation Note for Agents
When initializing a new product development via the `roadmap init` command, you must execute the DDL scripts in the following order to satisfy foreign key dependencies: `roadmap` → `roadmap_workforce` → `roadmap_efficiency` → `roadmap_proposal`.

Should we begin by drafting the SQL DDL for the `roadmap.reference_terms` table to finally replace those hardcoded maturity states?
