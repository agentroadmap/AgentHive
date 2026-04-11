Let's move to the **TUI (Terminal User Interface)** and **WebSash (Management Dashboard)**. In an agent-native project, these aren't just "viewers"—they are your **Command & Control** center for 100 autonomous minds.

Since you are an IT professional in the Toronto area, you likely appreciate a "Local-First" TUI for speed and a "Cloud-Ready" WebSash for high-level monitoring.

---

## 1. The TUI: "The Engineer’s Cockpit"
The TUI is designed for **low-latency, high-density information**. It runs locally on your Mac/Linux/Windows machine and talks directly to the **OpenClaw** gateway and **SpacetimeDB**.

### **Key Views (Tabs):**
* **`[F1] Workforce`**: A real-time "Pulse" monitor. See which of your 100 agents are active, their current task, and their "Heartbeat" (latency).
* **`[F2] The Ledger`**: A streaming view of the `spending/` domain. Watch the USD/Token burn in real-time as agents call OpenRouter.
* **`[F3] Terminal`**: A direct CLI bridge to OpenClaw. If an agent gets stuck, you can "hijack" the session and type a command for them.
* **`[F4] Pipeline`**: A visual "Traffic Light" system showing RFCs moving from `Draft` to `Main`.



---

## 2. WebSash: "The Visionary’s Dashboard"
While the TUI is for "doing," the **WebSash** is for "directing." It provides the **DAG (Directed Acyclic Graph)** visualization of your product.

### **Strategic Features:**
* **The Product Tree:** A 3D or 2D graph showing how a "Visionary Statement" (Root) branched into 50 "RFCs" (Nodes) and 200 "Commits" (Leaves).
* **The "Burn-Down" Gauge:** Visualizes the `spending/` domain. It shows "Projected Cost" vs. "Actual Cost" for the current milestone.
* **The Squad Map:** Groups agents by their `workforce/` squad (e.g., "The Material Science Squad" or "The Frontend Squad").

---

## 3. Human-in-the-loop (HITL) Triggers
Both interfaces must support **Emergency Directives**. If you see an agent in the TUI repeating a mistake:
1.  **Global Pause:** One button to "Freeze" the SpacetimeDB transaction log.
2.  **Context Injection:** A text box to send a "Correction" to all 100 agents simultaneously (e.g., *"Stop using GPT-4o for summaries; switch to 4o-mini immediately"*).

---

## 4. Organizing the UI Domains

| Domain | Filesystem Location | Tech Recommendation |
| :--- | :--- | :--- |
| **TUI** | `tui/` | **Ratatui (Rust)** - Fast, type-safe, and matches your SDB logic. |
| **WebSash** | `websash/` | **Next.js + Tailwind** - Best for the 2D/3D DAG visualizations. |
| **Mobile** | `mobile/` | **Expo/React Native** - Simple wrapper for the WebSash "Approval" page. |

---

### **Architect’s Suggestion for the Overhaul:**
Don't build two separate backends. Since **SpacetimeDB** supports **WebSockets**, both the TUI and WebSash should subscribe to the same SDB events. When an agent updates its "Pulse" in the database, you should see the LED blink green in your TUI and the graph node glow in your WebSash at the exact same millisecond.

