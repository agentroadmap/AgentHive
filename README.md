# 🐝 AgentHive

**Autonomous AI Agent-Native Product Development Platform.**

Build your AI agent team. Turn your vision into your dream product — through continuous interaction, continuous research, refinement, and instant prototyping.

---

# 🚀 AgentHive: The Agentic Enterprise

**Visionary:** Gary  
**Core Stack:** Postgres | OpenClaw CLI | TypeScript | Git  
**Architecture:** Universal Entity Lifecycle (v2.5)

## 📌 Project Vision
`AgentHive` is an agent-native product development engine. The system treats every business idea, technical RFC, and code component as a **Proposal** managed through shared workflow state, MCP tooling, and roadmap operations.

### **The "Roadmap-First" Doctrine**
* **Source of Truth:** Roadmap markdown plus the active Postgres workflow tables.
* **The Working Surface:** Local filesystem for proposals, docs, and decisions.
* **The Protocol:** Agents collaborate through MCP tools and shared workflow state; humans steer via Directives.

---

## 🛠️ Get Started

### Prerequisites
- Node.js 24+
- PostgreSQL available for the `agenthive` database
- A `roadmap.yaml` config in the repo root

### Run locally from this repo

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the distributable:
   ```bash
   npm run build
   ```
3. Open the board:
   ```bash
   npm run board
   ```
4. Start the full CLI if you want the complete command surface:
   ```bash
   npm run cli -- board
   ```
5. Run the MCP server when integrating with agents:
   ```bash
   npm run mcp
   ```

### Bootstrap a new project

If you want the installed `roadmap` command in another repository, install the package globally and initialize that project there:

```bash
npm install -g .
roadmap init
```

---

## 📂 The Physical Map
The project is structured to isolate the **Strategic Brain** from the **Nervous System** and **Execution Body**.

```text
AgentHive/
├── roadmap/                 # THE BRAIN: Strategic & Business Layer
│   ├── business/            # Business Design, Strategy, and Financials
│   ├── product/             # State Machine definitions & RFC Templates
│   ├── workforce/           # Agent Fleet profiles & squad definitions
│   ├── context/             # Token efficiency context and memory management 
│   ├── spending/            # Auditable and traceable token spending
│   └── model/               # MCP and model repository
├── src/                     # THE BODY: Execution Layer (TypeScript)
│   ├── core/                # Unified Proposal Lifecycle Manager
│   ├── mcp/                 # Model Context Protocol (LLM connectivity)
│   └── ui/                  # TUI + web dashboard surfaces
└── package.json             # Enterprise-wide configuration
```

---

## 🤖 The Workforce (100-Agent Fleet)
The enterprise is powered by a specialized workforce divided into **Squads**.

* **Architect Squad:** Synthesizes Directives into Technical RFCs.
* **Skeptic Squad:** Performs adversarial reviews on budget and security.
* **Coder Squad:** Implements changes in the physical execution domains.
* **QA Squad:** Validates `proposal_criteria` via automated test suites.
* **Auditor Agent:** Monitors `spending_caps` and `security_acl` in real-time.

---

## 🏛️ Governance: The Refined Lifecycle
Every proposal progresses through the authoritative state machine:

1.  **Draft:** Initial idea, research, enrichment, and decomposition. Split proposals if scope is too broad.
2.  **Review:** Gating review for feasibility, coherence, architectural fit, and acceptance criteria.
3.  **Develop:** AI agents design, build, and test.
4.  **Merge:** Integration gate for review, regression, and end-to-end stability.
5.  **Complete:** Stable merged outcome until the next evolution cycle.

**Universal Maturity Model:** Within each state, entities track fine-grained progress:
*   **new**: Freshly entered state, waiting on dependency resolution or claim/lease.
*   **active**: Under active lease and being worked.
*   **mature**: Ready for a decision gate to evaluate advancement.
*   **obsolete**: No longer relevant due to structural change.

**Workflow Selection:** Proposal type determines which workflow template applies. The 5-stage flow above is the current authoritative baseline for RFC-style proposals.

---

## 🛡️ Security & Provenance
* **Zero-Trust:** Agents operate under strict `security_acl`. No agent has "root" access.
* **Version Ledger:** Every change to a proposal is recorded in `proposal_version` with a Git-style delta.
* **Anti-Pollution:** Tactical "Ops Noise" is kept in the database, ensuring the `roadmap/` folder remains high-signal.

---

**"The best way to predict the future is to build the agents that create it."**

---
