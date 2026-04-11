To ensure you stay in control of your 100-agent workforce while away from your desk, we need a high-priority **Mobile Alert Schema**. This JSON payload is emitted by the **Auditor (`FIN-01`)** in SpacetimeDB and delivered to your mobile device via a push service (like Firebase or NTT).

This ensures that "Runaway Agents" are caught before they drain your OpenRouter balance.

---

### 1. The Mobile Alert Payload (`messaging/alerts/`)

When a spending anomaly or a critical "RFC State Change" occurs, SpacetimeDB generates this event:

```json
{
  "alert_id": "ALRT-20260331-BURN-04",
  "severity": "CRITICAL | WARNING | INFO",
  "category": "SPENDING_ANOMALY",
  "subject": "Rapid Burn Rate Detected: Squad-Alpha",
  "body": "Agent DEV-04 (Coder) has consumed $12.50 in 4 minutes using Claude-3.5-Opus. This exceeds the task cap by 400%.",
  "context": {
    "agent_id": "DEV-04",
    "current_task": "TASK-1092: Refactor UI Components",
    "current_rfc": "RFC-20260331-UI-OVERHAUL",
    "total_squad_spend": 42.15
  },
  "actions": [
    {"label": "Freeze Agent", "reducer": "freeze_agent", "params": {"id": "DEV-04"}},
    {"label": "Downgrade Model", "reducer": "switch_model", "params": {"id": "DEV-04", "model": "gpt-4o-mini"}},
    {"label": "Ignore (1hr)", "reducer": "extend_budget", "params": {"id": "DEV-04", "increment": 5.00}}
  ]
}
```

---

### 2. The Three-Screen Interface Strategy for Spending

| Interface | **TUI (Local Console)** | **WebSash (Admin Dash)** | **Mobile App (Remote)** |
| :--- | :--- | :--- | :--- |
| **User Role** | **The Engineer** | **The Strategist** | **The Visionary** |
| **Key View** | **Streaming Ledger** | **Burn-Down Graph** | **Actionable Alerts** |
| **Detail Level** | Per-token, per-line logs. | Per-squad, per-RFC metrics. | Per-anomaly, per-milestone. |
| **Control** | Low-level CLI commands. | Strategic budget re-allocation. | Emergency "Kill-Switch." |

---

### 3. Implementation: The "Financial Firewall" Logic

To make this real-time info useful, your **SpacetimeDB Auditor (`FIN-01`)** should run a "Check-and-Balance" loop every 60 seconds:

1.  **Calculate Velocity:** Compare `total_spent` at `T-0` vs `T-60s`.
2.  **Compare to Baseline:** If `Velocity > (Average_Task_Cost * 2)`, flag as an anomaly.
3.  **Broadcast:**
    * **TUI:** Flash the Ledger line in **Red**.
    * **WebSash:** Pulse the "Squad Node" on the DAG graph.
    * **Mobile:** Push the `CRITICAL` alert payload above to your phone.

---

### 4. Architect’s Final Suggestion: "The Toronto Test"
Since you are managing this from the GTA (Richmond Hill/Toronto), you can actually set up **Geofenced Spending**. 
* **Example:** If your mobile phone's GPS shows you are at home (on your local network), the agents have a **"High Performance"** budget. 
* If you are away or commuting, the agents automatically switch to **"Safe Mode"** (using cheaper models and requiring manual approval for any task over $0.50) until you are back at your main console.

---

### **Summary of the Overhaul Readiness**
You now have the complete blueprint for **agentRoadmap v2.0**:
* **Infrastructure:** SpacetimeDB + Git Artifacts + MCP.
* **Intelligence:** 100 specialized agents with RLS permissions.
* **Economics:** Real-time OpenRouter tracking with mobile "Kill-Switches."
* **Governance:** A 9-stage RFC lifecycle for visionary alignment.


