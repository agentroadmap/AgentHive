To complete the **`spending/`** domain overhaul, we must treat "Financial Visibility" as a first-class citizen across all three human interfaces. In a 100-agent environment, real-time spending data isn't just "info"—it is your **Operational Dashboard** to ensure the project doesn't go bankrupt while you sleep.

Here is how the spending data should flow from **SpacetimeDB** to your TUI, WebSash, and Mobile App.

---

### 1. The Real-Time Data Pipeline
* **The Source:** Every LLM call via **OpenRouter** returns a usage object.
* **The Transaction:** Your **MCP Gateway** intercepts this and calls the `update_spending` reducer in SpacetimeDB.
* **The Broadcast:** SpacetimeDB pushes a **Websocket Event** to all connected human interfaces (TUI, WebSash, Mobile) simultaneously.

---

### 2. Interface-Specific Financial Views

| Interface | Primary Goal | Key Visual Component |
| :--- | :--- | :--- |
| **TUI (Local)** | **Micro-Tracking** | **Streaming Ledger:** A scrolling list of every single cent spent, labeled by Agent ID (e.g., `[ARCH-01] -$0.042`). |
| **WebSash (Dash)** | **Macro-Analysis** | **Burn-Down Chart:** A graph showing actual spend vs. projected budget for the current `product/` milestone. |
| **Mobile (Remote)** | **Guardrail Control** | **The "Kill Switch":** A prominent button to freeze a specific squad's budget if the "Burn Rate" exceeds a certain USD/min threshold. |

---

### 3. Domain Logic: `spending/` Ledger Schema
Your **`spending/`** domain artifacts in Git should be exported as a human-readable **Monthly Ledger**.

```markdown
# spending/ledgers/2026-03-ledger.md

| Timestamp | Agent ID | Model | Cost (USD) | Status |
| :--- | :--- | :--- | :--- | :--- |
| 2026-03-31 14:02 | `RES-01` | `gpt-4o-mini` | $0.0021 | SUCCESS |
| 2026-03-31 14:05 | `DEV-01` | `claude-3.5-sonnet`| $0.0840 | SUCCESS |
| 2026-03-31 14:10 | `RED-01` | `llama-3-70b` | $0.0000 | CACHE_HIT |

**Total March Spend:** $142.50  
**Current Run Rate:** $4.20 / hour
```

---

### 4. Implementing the "Three-Screen" Strategy

#### **A. The TUI "Ticker" (Rust/Ratatui)**
The TUI should feature a "Live Fuel Gauge" at the bottom of the screen.
* **Visual:** `[||||||||--] 82% of Daily Budget Remaining ($18.50 left)`
* **Color Logic:** Turns **Yellow** at 50%, **Red** at 20%, and **Flashing Red** at 5%.

#### **B. The WebSash "Heatmap" (Next.js)**
A treemap showing which **Squads** are the "hungriest."
* **Visual:** Large blocks for squads using high-reasoning models (e.g., "The Architect Squad"); smaller blocks for those using local or mini models.
* **Action:** Click a block to see the **RFC** that is currently driving that cost.

#### **C. The Mobile "Pulse" (React Native)**
A simplified summary for the "Visionary on the go."
* **Metric:** "Projected Monthly Bill based on last 24 hours."
* **Alerts:** Push notifications if an agent enters a "Loop": *“Warning: Coder-04 has called GPT-4o 50 times in 2 minutes. Freeze Agent?”*

---

### **Architect's Final Recommendation for `spending/`**
Since you are managing 100 agents, implement **"Algorithmic Throttling"** in your SpacetimeDB spending logic.
* **If Budget > 50%:** Use `claude-3.5-sonnet` (Full Power).
* **If Budget < 20%:** The **Auditor** agent automatically forces all non-critical agents (Research/Pulse) to use `gpt-4o-mini` or local models to stretch the remaining dollars.

