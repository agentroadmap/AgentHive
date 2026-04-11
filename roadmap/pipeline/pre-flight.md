To finalize the **`pipeline/`** domain, here is the **Pre-flight Check** protocol. This is an MCP-driven script that a **Coder Agent** must run locally on its host machine (Mac, Windows, or Linux) before it is allowed to submit an RFC or a code promotion request to SpacetimeDB.

By catching errors "at the edge," you save significant API costs by not sending broken code to your expensive high-reasoning **Reviewer Agents**.

---

## 🚀 The `pipeline/preflight_check.sh` (Conceptual Logic)

This script acts as the agent's "Self-Correction" loop.

```bash
#!/bin/bash
# agentRoadmap Pre-flight Verification v1.0

echo "🔍 Starting Pre-flight Check for Agent: $AGENT_ID"

# 1. Syntax & Linting (The "Dumb Error" Filter)
# Runs local linters (e.g., cargo check, eslint, or python -m py_compile)
run_linter()
if [ $? -ne 0 ]; then
  echo "❌ Syntax Error Detected. Fix before submitting."
  exit 1
fi

# 2. Secret Scanning (The "Security" Filter)
# Scans for strings matching API Key patterns from the 'model/' domain
scan_for_secrets()
if [ $secrets_found -gt 0 ]; then
  echo "⚠️ CRITICAL: Hardcoded API Keys detected. Scrubbing required."
  exit 1
fi

# 3. Logic Validation (The "Unit Test" Filter)
# Runs the specific test suite defined in 'pipeline/configs/'
run_unit_tests()

# 4. SpacetimeDB Schema Alignment
# Checks if the proposed code matches the current SDB Reducer signatures
check_sdb_compatibility()

echo "✅ Pre-flight Complete. Ready for RFC Submission."
```

---

## 1. Integration with the `workforce/` Domain
When a **Coder Agent** fails a pre-flight check more than three times for the same error, the **Auditor** should:
* **Log a "Training Event":** Update the agent's profile in `workforce/profiles/` with a "Logic Deficiency" note.
* **Throttling:** Temporarily lower the agent's `clearance_level` until it successfully passes a sandbox tutorial.

## 2. The "Promotion" Transaction in SpacetimeDB
Once the pre-flight passes, the agent calls a **Promotion Reducer**.



```rust
#[reducer]
pub fn request_promotion(ctx: &ReducerContext, artifact_id: String, checksum: String) {
    // 1. Verify the agent has 'Coder' permissions
    // 2. Check if 'Pre-flight' was logged as 'Passed' in the last 5 minutes
    // 3. Move the status in the 'project/' table from DRAFT to STAGING
    log::info!("Artifact {} promoted to Staging for Reviewer analysis.", artifact_id);
}
```

---

## 3. Human Visibility (TUI & WebSash)
On your **WebSash** dashboard, the pipeline should look like a "Traffic Light" system:
* **Green:** Pre-flight passed; awaiting Reviewer Agent.
* **Yellow:** Reviewer Agent found minor issues; Coder Agent is self-correcting.
* **Red:** Pre-flight or Security scan failed; Task halted to save budget.

---

### **Strategic Summary of the Overhaul**
We have now established a professional, enterprise-grade foundation for **agentRoadmap**:
1.  **Product:** RFC/ADR workflow for visionary alignment.
2.  **Workforce:** Role-based agents with performance tracking.
3.  **Spending:** Real-time OpenRouter/SDB budget firewalls.
4.  **Pipeline:** Multi-stage verification to ensure code quality and security.

