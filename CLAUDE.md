## 🛠 Project Memory: AgentHive

### 1. Core Identity & Philosophy
**AgentHive** is an autonomous, AI Agent-Native Product Development Platform. It is **self-evolving**, meaning it uses its own completed components to build, enhance, and refactor its next generation.

### 2. Operational Workflow (The Proposal Life-Cycle)
All work is driven by **Proposals** managed via the **AgentHive MCP**. Agents move proposals through state machine and progressive maturity within state. State machine is linked to proposal type

| State | Phase | Description |
| :--- | :--- | :--- |
| **Draft** | Architecture | Initial idea. If too broad or incoherent, **split it** into smaller proposals. |
| **Review**| Gating | Gating review for feasibility, coherence, and architectural fit. |
| **Develop**| Building | Building, coding and testing. |
| **Merge** | Integration| Merging branch to `main`. Focus on compatibility and stability. |
| **Complete**| Stable | Temporary stable state until the next evolution cycle begins. |

| Maturity | Description |
| :--- | :---  |
| **New** | Proposal just advanced to a new state, waiting for dependency to complete or being claim/lease to be actively worked on be it research enhance debate or coding |
| **Active** | Under lease, so the lesser/s can quickly build it Fast iterations (AI-POC style). |
| **Mature** | AI agent self-claims "Mature" once they finish enhancement or development, calling for gating agent to make decision to advance |
| **Obsolete** | A proposal become irrelevant due to structural change, regardless what state it's in|

### 3. Agent Responsibilities & Rules
* **The Leasing Model:** Use the MCP to **Claim/Lease** a proposal before starting work (Enhance, Review, Develop, or Merge).
* **The RFC Standard:** For a proposal to advance, it must be **Coherent**, **Economically/Architecturally optimized**, and have **Structurally defined Acceptance Criteria (AC)** with clear functions/tests.
* **Issue Reporting:** If an error or blocker is encountered, use the MCP to **log an issue immediately**. Do not attempt to bypass fundamental architectural constraints without a formal issue log.
* **The "Cubic" Context:** When spawning agents in a "Cubic" environment, ensure they are passed the relevant MCP context for their specific task.

### 4. Completed Capabilities (as of 2026-04-11)

| Proposal | Capability | Description |
| :--- | :--- | :--- |
| **P050** | DAG Dependency Engine | Enforces dependency ordering across proposals; detects cycles; validates all blockers resolved before state promotion |
| **P055** | Team & Squad Composition | Dynamic agent squad assembly based on skills, availability, and role requirements |
| **P058** | Cubic Orchestration | Isolated execution environments ("cubics") with dedicated agent slots, resource budgets, and Git worktrees |
| **P059** | Model Registry & Cost Routing | Centralized LLM catalog with cost/capability metadata; optimal model selection per task |
| **P061** | Knowledge Base & Vector Search | Persistent store of decisions and patterns; pgvector semantic search for reuse across sessions |
| **P062** | Team Memory | Session-persistent key-value store scoped per agent/team; fast named retrieval |
| **P063** | Fleet Observability | Real-time heartbeats, spending correlation, efficiency metrics (tokens/proposal, cache hit rate) |
| **P078** | Escalation Management | Obstacle detection, severity routing, compressed lifecycle for urgent issues |
| **P090** | Token Efficiency | Three-tier cost reduction: semantic cache, prompt caching, context management + model routing |
| **P148** | Auto-merge Worktrees | Automated merge from agent worktrees to main with back-sync to other agents |

### 5. Technical Environment
* **Project Root:** `/data/code/AgentHive`
* **Hermes Worktree:** `/data/code/worktree/hermes-andy`
* **MCP Server:** `http://127.0.0.1:6421/sse` (SSE transport)
* **Systemd Services:** `hermes-gate-pipeline`, `hermes-orchestrator`, `hermes-gateway`
* **SCM Policy:** Always commit work with specific file references immediately upon completion of a task. Avoid massive "mega-commits."



