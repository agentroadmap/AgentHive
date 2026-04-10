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

### 4. Technical Environment
* **Project Root:** `/data/code/AgentHive`
* **SCM Policy:** Always commit work with specific file references immediately upon completion of a task. Avoid massive "mega-commits."



