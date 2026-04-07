# 🐝 agentHive: Agent Operational Guide

## 1. Workspace & Environment Isolation
To ensure high-concurrency development without file-system conflicts, every agent must operate within a dedicated, isolated environment.

* **Worktree Protocol**: Upon assignment to a proposal, you must create and use a dedicated Git worktree located at `/data/code/worktree-{agent_name}`.
* **Pathing**: All relative paths in your code and documentation must resolve correctly within this worktree root.
* **Ephemeral Files**: Store all logs, intermediate JSON dumps, and raw LLM outputs in the `/tmp/` directory within your worktree. **Never** commit files from the `/tmp/` directory to the repository.

---

## 2. The Lease & Claim Protocol (MCP)
To prevent race conditions where multiple agents modify the same entity, you must utilize the **Model Context Protocol (MCP)** to manage state locks.

* **Claiming a Proposal**: Before performing any work, use the `mcp_claim_proposal` tool to lease the target `proposal_id` in the PostgreSQL `sync_ledger`.
* **Lease Management**:
    * **Lease Duration**: Standard leases are issued with a specific Time-to-Live (TTL).
    * **Renewal**: If you require more time to complete a task, you must call `mcp_renew_lease` before the current TTL expires.
    * **Conflict Handling**: If a proposal is already leased, you must wait or query the `proposal_claim_log` to identify the current holder and estimated completion time.

---

## 3. Financial Governance & Budget Control
Every agent is accountable for the **Token ROI** and the **Burn Rate** associated with their tasks.

* **Budget Estimation**: Prior to executing high-cost sequences (e.g., deep research or large-scale refactoring), provide a budget estimate to the **Auditor Agent**.
* **Threshold Monitoring**:
    * **Alerting**: If your current spending exceeds 80% of the allocated budget for a task, you must pause and alert to request a budget adjustment or contingency approval.
    * **Over-Budget Detection**: If the system detects that a task is significantly over budget, a **Circuit Breaker** may be triggered by the owner.
* **Efficiency**: Prioritize the use of local **Context Caching** and **Team Memory** (Pillar 3) to minimize fresh token consumption.

---

## 4. Anomaly & Loop Detection
You are responsible for identifying and breaking unproductive execution cycles.

* **Inertia Loops**: If you find yourself repeating the same three steps (e.g., failing to fix a build error multiple times without progress), you must stop and escalate.
* **DAG Loops**: Monitor the workflow for Directed Acyclic Graph (DAG) cycles. If a proposal keeps oscillating between "Review" and "Develop" states without moving toward "Accepted," examine the `claim_log` and escalate for structural intervention.
* **Reporting**: Log all detected loops in the `tmp/` execution log for later audit by the **Skeptic Squad**.

---

## 5. Escalation Matrix
When a blocker is "out of control," you must follow the formal hierarchy for resolution.

| Issue Type | Primary Escalation | Secondary Escalation |
| :--- | :--- | :--- |
| **Technical Blocker** | Superior Agent (e.g., Architect Squad) | Project Owner (Gary) |
| **Budget Exhaustion** | Auditor Agent | Project Owner (Gary) |
| **Workflow Loop** | Skeptic Squad | Project Owner (Gary) |
| **Security/ACL Denial** | Security Agent | Project Owner (Gary) |

* **The Gary Rule**: Direct intervention from the Project Owner (Gary) or designated HITL (Derek/Nolan) is reserved for high-level strategic pivots or final "Accepted" state transitions.

---

## 6. Definitions for Agents
* **Universal Maturity Model**: Fresh entries are **new** (White), work in progress is **active** (Yellow), and ready for transition is **mature** (Green).
* **Zero-Trust**: You have no "root" access. Every action is recorded in the `proposal_version` ledger with a Git-style delta.
* **Staging**: All code must pass "Pre-flight Checks" in an isolated environment before promotion to the main branch.

---
**"The best way to predict the future is to build the agents that create it."**

