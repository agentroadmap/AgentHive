To formalize your **`workforce/`** domain in the overhaul, we need a "Least Agency" model. In 2026, the best practice is to separate **Reader** agents from **Actor** agents to prevent a single hallucination from wiping your database or overspending your budget.

Using **SpacetimeDB 2.0's Row-Level Security (RLS)**, we can cryptographically bind these roles to each agent's identity.

### 1. The Initial "Five-Agent" Core
These are the foundational roles for your 100-agent team. Each has a specific "clearance level" and "token-spend profile."

| Role | Alias | Primary Responsibility | SpacetimeDB Permissions |
| :--- | :--- | :--- | :--- |
| **The Architect** | `ARCH-01` | Vision-to-Task decomposition. Writes RFCs. | Read/Write to `product/`, `project/`. |
| **The Skeptic** | `RED-01` | Adversarial analysis. Red-teaming proposals. | Read-Only to all; Write to `product/adversarial`. |
| **The Researcher** | `RES-01` | Web/Doc scraping via OpenClaw. | Read-Only `product/`; Write to `context/`. |
| **The Coder** | `DEV-01` | Code generation and implementation. | Read `project/`; Write to `pipeline/`. |
| **The Auditor** | `FIN-01` | Spending monitor and "Kill-Switch" operator. | **Admin** access to `spending/` and `model/`. |

---

### 2. SpacetimeDB Workforce Implementation (Rust)
Define your workforce registry using a **Role-Based Access Control (RBAC)** pattern. By 2026, we use `ViewContext` to filter what agents can see.

```rust
#[table(name = workforce_registry, accessor = workforce)]
pub struct AgentIdentity {
    #[primarykey]
    pub agent_id: u32,
    pub identity: Identity, // The cryptographic SDB identity
    pub role: AgentRole,    // Enum: Architect, Skeptic, Coder, etc.
    pub squad_id: u32,      // For "Squad-based" isolation
    pub clearance_level: u8, // 1-5 (5 = Human-Level)
}

// RLS Rule: An agent can only see tasks assigned to their squad
#[client_visibility_filter]
const TASK_FILTER: Filter = Filter::Sql(
    "SELECT t.* FROM project_tasks t 
     JOIN workforce_registry w ON w.agent_id = t.assigned_agent_id 
     WHERE w.identity = :sender"
);
```

---

### 3. Permissions & Guardrails (The "Least Agency" Framework)
In your `workforce/` domain files, each agent's profile should include a **Permission Matrix**.

* **Architect:** Can move an RFC from `Draft` → `In_Review`. Cannot self-approve.
* **Skeptic:** Must provide a "Risk Score" (1–10) before any RFC can be seen by the Human.
* **Researcher:** Has no access to your `apikey` table. It must request a "Short-Lived Token" from the **Auditor** to make LLM calls.
* **Coder:** Can only write to the `pipeline/sandbox/` branch. It cannot commit to `main` without a successful regression test in the `pipeline/` domain.

---

### 4. The "Pulse" Protocol
Every 60 seconds, each agent in your workforce must call the `update_pulse` reducer. 
* **If Pulse misses twice:** The **Auditor** marks the agent as `zombie` and freezes its budget to prevent "Runaway Loop" costs.
* **If Pulse shows high latency:** The **Architect** can choose to switch that agent's model (in the `model/` domain) to a faster, cheaper one to clear the bottleneck.

---

### 5. Organizing the `workforce/` Directory
Your file-based artifacts for this domain should look like this:
* `workforce/registry.json`: The "Phonebook" of all active agents.
* `workforce/profiles/[agent_id].md`: The agent's "Resume," including its past success rate and specialized skills (e.g., "React Specialist").
* `workforce/pulse_log.csv`: A historical record of agent uptime and token efficiency.

