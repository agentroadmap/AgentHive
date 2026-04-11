As we overhaul **agentRoadmap** into this domain-driven architecture, the **RFC (Request for Comments)** is the most critical artifact. It’s where your "Human Vision" meets the "Agent’s Execution Plan."

Below is the **Agent-Native RFC Template** for your `product/` directory. It is designed to be easily parsed by LLMs, stored in SpacetimeDB as a `Decision` record, and synced to Git as a `.md` file.

---

# `product/RFC-Template.md`

## 🆔 RFC-Metadata
* **RFC ID:** `RFC-YYYYMMDD-NAME`
* **Status:** `New | Draft | Approve | Active | Accept | Completei | Rejected | Replaced`
* **Visionary (Human):** Gary
* **Lead Proposer (Agent):** `[Agent_ID]`
* **Domain:** `[Product | Business | Infrastructure | etc.]`
* **SpacetimeDB Sync ID:** `[Primary_Key]`

---

## 🎯 1. Objective & Visionary Alignment
* **Vision Statement:** *Summarize the human's "ideal product" goal this RFC addresses.*
* **Problem Statement:** *What specific gap in the current product state are we closing?*
* **Success Metrics:** *How will the Workforce (Agents) know the task is complete? (e.g., passing pipeline tests).*

---

## 🏗️ 2. Proposed Architecture & Design
* **Logic (DAG):** *Describe the new nodes being added to the Product DAG.*
* **SpacetimeDB Schema Changes:** *List any new tables or reducers required.*
* **MCP Requirements:** *Does this proposal require new tools in the `mcp/` domain?*
* **Export Strategy:** *How will this state be reflected in the filesystem?*

---

## ⚖️ 3. Adversarial Analysis (The "Skeptic" Agent)
> **Note:** This section must be filled by a different Agent than the Proposer.
* **Identified Risks:** *Technical debt, security holes, or complex dependencies.*
* **Token Efficiency Check:** *Estimated cost vs. project value.*
* **Counter-Proposal:** *A leaner or more stable alternative.*

---

## 💰 4. Resource & Budget Allocation
* **Estimated Token Cost:** `$[Amount]`
* **Assigned Workforce:** `[Squad_ID / Agent_IDs]`
* **Model Allocation:** `[e.g., Claude-3.5-Sonnet for logic, GPT-4o-mini for summaries]`
* **Time-to-Artifact:** *Expected duration until Git commit.*

---

## 📝 5. Decision Log (The ADR)
* **Human Feedback:** `[Inputs from TUI/WebSash]`
* **Final Consensus:** `[Approved/Rejected reasoning]`
* **Snapshot Hash:** `[Git commit SHA or SDB log ID]`

---

### **Implementation Guide for your Overhaul:**

1.  **Automation:** When you type a vision in the **TUI**, have a "Product Architect Agent" automatically clone this template and fill out Sections 1 & 2.
2.  **The Debate:** Once Section 2 is filled, SpacetimeDB should trigger a "Skeptic Agent" (using a different model for diversity) to fill Section 3.
3.  **The Gate:** You (the human) only look at the file once Sections 1–4 are complete. You then sign off in Section 5 via **WebSash** or **Mobile App**.
4.  **The Sync:** Upon approval, SpacetimeDB marks the `spending/` budget as "Authorized" and the agents begin work in the **`pipeline/`**.

