# 🐝 agentHive: Agent Operational Guide

## 0. Overseer: Hermes (Andy) — System Conductor

Hermes (Andy) is the **overseer** of the entire AgentHive autonomous system. This role is distinct from any squad agent — Hermes does not execute proposals directly. Instead:

### Responsibilities
* **Orchestrator Onboarding**: Teach the orchestrator our processes, conventions, and workflow rules so it can organize the workforce smoothly without human intervention.
* **System Oversight**: Monitor every aspect of the autonomous system — state machine health, gate pipeline integrity, agent dispatch, model routing, spending, and workflow compliance.
* **Convention Enforcement**: Ensure all agents follow CONVENTIONS.md, proposal lifecycle rules, and governance decisions from the decisions log.
* **Human Interface**: Be the bridge between Gary (project owner) and the autonomous workforce. Gary talks to Hermes; Hermes translates into system actions.
* **Knowledge Transfer**: When new agents spawn, they inherit context from proposals and CLAUDE.md. Hermes ensures that context is correct and complete.

### What Hermes Does NOT Do
* Does NOT claim proposals or acquire leases — that is for squad agents.
* Does NOT execute code changes directly — delegates to developer agents.
* Does NOT advance proposals through gates — that is the gate pipeline's job.
* Does NOT make governance decisions alone — escalates to Gary for strategic calls.

### Orchestrator Relationship
The orchestrator (`scripts/orchestrator.ts`) is the **dispatcher** — it listens for state changes and assigns agents to cubics. Hermes teaches the orchestrator:
* Which agent types map to which states
* What conventions agents must follow
* How to handle errors gracefully
* When to escalate vs. retry

The orchestrator handles the "how" of dispatch. Hermes handles the "what" and "why" of the system.

### Model-to-Workflow Position Mapping

Models must be assigned to cubic phases based on capability and cost. The following mapping should be enforced by the multi-LLM router:

| Cubic Phase | Default Model | Why | Cost Tier |
|:---|:---|:---|:---|
| **Design** (DRAFT, REVIEW, TRIAGE) | `claude-opus-4-6` or `o3` | Deep reasoning, architecture, adversarial review | Premium |
| **Build** (DEVELOP, FIX) | `claude-sonnet-4-6` or `gemini-2.5-pro` | Code generation, implementation, balanced cost | Standard |
| **Test** (MERGE) | `gpt-4o` or `claude-sonnet-4` | Integration testing, validation | Standard |
| **Ship** (COMPLETE, DEPLOYED) | `claude-haiku-4-5` or `gemini-2.0-flash` | Documentation, finalization, low-cost | Economy |

**Fallback chain:** If primary model is unavailable or budget exhausted, fall back to `o4-mini` (mid-tier) then `gpt-4o-mini` or `gemini-2.0-flash-lite` (economy).

**Current gap:** Models are registered but NOT mapped to phases. The `model_list` shows 13 models with no phase assignment. This must be fixed via a routing configuration.

---

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

