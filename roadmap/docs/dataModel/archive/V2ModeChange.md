Your current schema is a solid "V1" foundation—it’s functional and compact. However, as we scale to a 100-agent enterprise, the 3-letter table names (`ac`, `art`, `sbx`) will become a maintenance bottleneck, and the reliance on the word `step` keeps the system feeling like a simple "To-Do list" rather than a **Strategic Proposal Engine**.

Here is the analysis of the gap and the suggested migration to the **Domain-Driven Model**.

---

## 1. The Core Shift: From `step` to `proposal`
In your current schema, `step` is the "god object." By renaming it to **`proposal`**, you align the database with the **9-stage RFC lifecycle** we designed.

### **The Migration Map**
| Current Table | New Domain Name | Why? |
| :--- | :--- | :--- |
| `step` | `proposal` | Shifts focus from "doing a task" to "proposing a change." |
| `ac` | `proposal_criteria` | Explicitly links acceptance criteria to the proposal. |
| `rev` | `proposal_review` | Clears up what is being reviewed (not just a step). |
| `flow` | `proposal_state_history` | Better for auditing transitions between the 9 stages. |
| `prop` | *Merge into `proposal`* | Currently, `prop` and `step` overlap too much. |

---

## 2. Domain-Based Schema Analysis (The Gaps)

### **A. Workforce Domain**
* **Current:** `agent`, `agent_skill`, `skill`, `member`, `team`, `privilege`.
* **Gap:** Missing **Pulse** and **Identity**.
* **Migration:** * Rename `agent` to `workforce_registry`.
    * Add `pulse_events` table (to track agent heartbeats and latency).
    * Rename `privilege` to `access_control` (to support Row-Level Security).

### **B. Spending & Model Domain**
* **Current:** `agent_budget`, `token_ledger`.
* **Gap:** No link between **Model Attributes** and **Spending Caps**.
* **Migration:**
    * Rename `token_ledger` to `spending_log`.
    * Add `model_registry` table (storing ratings, cost per 1k tokens, and expertise tags).
    * Update `agent_budget` to include `daily_limit` and `monthly_limit`.

### **C. Context & Memory Domain**
* **Current:** `mem`, `cache`, `comp`.
* **Gap:** Confusing naming. `comp` usually stands for "Component" or "Compensation," but here it's "ContextCache."
* **Migration:**
    * Rename `comp` to `context_partition`.
    * Rename `mem` to `agent_long_term_memory`.
    * Rename `cache` to `agent_session_cache`.

### **D. Pipeline & Infrastructure Domain**
* **Current:** `test`, `res`, `sbx`.
* **Gap:** Missing "Promotion" logic and "Pre-flight" verification.
* **Migration:**
    * Rename `res` to `test_results`.
    * Add `promotion_log` (tracks when an artifact moves from SDB to Git).
    * Rename `sbx` to `execution_sandbox`.

---

## 3. The New Model (Proposed Rust Structs)

To align with the 13 domains in your manifest, here is the suggested naming structure for your next SpacetimeDB deployment.

### **Product/Project Tables**
```rust
pub struct Proposal { // Replaces 'step'
    pub id: u32,
    pub display_id: String, // e.g., "RFC-2026-001"
    pub status: String,      // New, Draft, Review, etc.
    pub visionary_id: String, // Link to Gary/Derek/Nolan
    pub squad_id: u32,
    pub body_markdown: String,
    pub budget_limit: f64,
}

pub struct ProposalReview { // Replaces 'rev'
    pub id: u32,
    pub proposal_id: u32,
    pub reviewer_agent_id: String,
    pub verdict: String, // Skeptical, Supportive, Blocked
    pub rationale: String,
}
```

### **Spending Tables**
```rust
pub struct SpendingLog { // Replaces 'token_ledger'
    pub id: u32,
    pub agent_id: String,
    pub proposal_id: u32,
    pub model_name: String,
    pub cost_usd: f64,
    pub timestamp: u64,
}
```

---

## 4. Reducer Cleanup
Your current reducers use the "Step" nomenclature. To migrate, you'll want to update the entry points:

* **Old:** `claim_step`, `create_step`, `transition_step`.
* **New:** `claim_proposal`, `submit_proposal`, `transition_proposal_status`.

---

## 5. Summary of the Gap
1.  **Semantic Clarity:** Your current tables use 3-letter shortcuts that agents (and you) will struggle to map to the **Business Architecture**. Moving to full-domain names (`workforce_registry` instead of `agent`) makes the system "Agent-Readable."
2.  **Workflow vs. Task:** The current `step` model is too granular. The `proposal` model treats a body of work as a unified entity with an audit trail.
3.  **Missing Interconnects:** The new model needs to explicitly link **Spending** to **Proposals**, allowing you to see exactly which RFC burned your budget.

