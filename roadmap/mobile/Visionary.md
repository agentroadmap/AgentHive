To tie the **TUI**, **WebSash**, and **Mobile App** together, we need a standardized **Visionary Command Schema**. This is the high-level JSON structure that translates your "human intent" into a set of "agentic tasks" across your 100-member workforce.

In your overhaul, this schema lives in the `messaging/` domain and is the primary way the **Architect** agent receives its marching orders.

---

## 🏗️ The Visionary Command Schema (v2.0)

When you hit "Submit" on a new product idea in **WebSash**, it sends this transaction to **SpacetimeDB**:

```json
{
  "command_id": "CMD-20260331-GARY-01",
  "visionary_id": "GARY_TORONTO",
  "priority": "HIGH | NORMAL | BACKGROUND",
  "intent": {
    "statement": "Build a secure, local-first file-sharing MCP server for agentRoadmap.",
    "constraints": [
      "Must use Rust for the backend",
      "Must include end-to-end encryption",
      "Must sync with Git every 10 minutes"
    ]
  },
  "resources": {
    "max_budget_usd": 25.00,
    "allowed_squads": ["INFRA_SQUAD", "SECURITY_RED_TEAM"],
    "deadline": "2026-04-05T12:00:00Z"
  },
  "governance": {
    "approval_mode": "HUMAN_GATE | AUTO_IF_UNDER_5USD",
    "require_adversarial_review": true
  }
}
```

---

## 1. How the Domains React
Once this command hits **SpacetimeDB**, a "Chain Reaction" occurs across your folders:

1.  **`workforce/`**: The **Architect** (`ARCH-01`) claims the command and breaks it into 5 **RFCs**.
2.  **`spending/`**: The **Auditor** locks $25.00 in the project's "Escrow" table to prevent overspending.
3.  **`model/`**: The system selects **Claude 3.5 Sonnet** for the logic and **Llama 3 (Local)** for the repetitive unit-test generation to save money.
4.  **`pipeline/`**: A new "Staging" branch is created in the Git repo to house the emerging code.

---

## 2. Interface Behavior (TUI vs. WebSash)

### **The TUI (Real-time Stream)**
* Your terminal will start scrolling **"Pulse"** updates: `[RES-01] Researching Encryption Protocols...`
* The **Ledger** tab will tick up: `-$0.12 (Input) | -$0.04 (Output)`.
* You see the raw logic as it happens.

### **The WebSash (Visual DAG)**
* A new **Root Node** appears in the Product Graph.
* Five **Sub-Nodes** (the RFCs) sprout from the root, glowing **Yellow** (In Progress).
* As agents finish tasks, the nodes turn **Green** (Promoted to Main).



---

## 3. The Mobile "Approval" Notification
If the **Skeptic** agent finds a security flaw in the encryption proposal, your phone vibrates:
> **⚠️ Security Alert: RFC-20260331-ENC**
> *Skeptic RED-01 suggests the chosen library has an unpatched CVE.*
> **[Approve Fix] [Pause Project] [Talk to Architect]**

---

### **Architect's Summary of the Overhaul**
We have successfully designed the "Nervous System" of **agentRoadmap**:
* **State:** SpacetimeDB (Fast, Transactional, Multi-machine).
* **Artifacts:** Git/Filesystem (Auditable, Permanent, Human-readable).
* **Workforce:** 100 specialized agents with defined roles and pulses.
* **Economy:** OpenRouter-linked budget caps and cache-optimized prompts.
* **Control:** TUI for the engineer, WebSash for the visionary.

