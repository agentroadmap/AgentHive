That is a robust lifecycle. By 2026 standards, moving from a basic "Pass/Fail" to a 9-stage state machine turns your **`product/`** domain into a high-fidelity **Audit Trail**. 

In a 100-agent environment, these specific states solve the "Agent Drift" problem—where agents might keep working on an idea you've already moved past.

---

### **The agentRoadmap RFC State Machine**

| Status | Meaning in the 100-Agent Workforce | Artifact Action |
| :--- | :--- | :--- |
| **New** | A `VisionaryCommand` has been parsed. No logic yet. | Entry in SpacetimeDB. |
| **Draft** | **Architect** is decomposing the vision into technical tasks. | `product/RFC-XXX.md` created in Git. |
| **Review** | **Skeptic** and **Auditor** are running adversarial/cost checks. | Comments appended to Markdown. |
| **Active** | **Gary (You)** has given the green light. Agents are coding. | Budget locked in `spending/`. |
| **Accepted** | The **Pipeline** tests passed. Code is ready for `main`. | Pull Request generated. |
| **Complete** | Merged to `main`. Artifacts are live. | RFC moved to `archives/`. |
| **Rejected** | Human or Skeptic found a fatal flaw. | Reasons logged; Task killed. |
| **Abandoned** | Project was stopped due to budget or pivot. | `[ABANDONED]` tag added to file. |
| **Replaced** | A newer RFC (e.g., v2.0) has superseded this logic. | Pointer link added to new RFC. |

---

### **Implementation Suggestion: The "Status Trigger"**
Inside **SpacetimeDB**, you can now write **State Transition Hooks**. This prevents "illegal" moves (e.g., an agent trying to move a "Rejected" RFC back to "Active" without your permission).

```rust
#[reducer]
pub fn update_rfc_status(ctx: &ReducerContext, rfc_id: u32, new_status: String) {
    let rfc = RFC::filter_by_id(rfc_id).unwrap();
    
    // Safety Logic: Only Gary can move to "Active"
    if new_status == "Active" && ctx.sender != GARY_IDENTITY {
        panic!("Unauthorized: Only the Visionary can activate an RFC.");
    }
    
    // Auto-Action: If "Complete", trigger the Git-Sync Worker
    if new_status == "Complete" {
        trigger_git_promotion(rfc_id);
    }
}
```



### **Why "Replaced" is your Secret Weapon**
With 100 agents, you will inevitably have overlapping ideas. The **"Replaced"** state is brilliant because it maintains the **DAG (Directed Acyclic Graph)**. Instead of deleting old ideas, you keep them as "Ancestors." This allows a new agent joining in 6 months to see: *"We used to do X, but RFC-42 replaced it with Y because of Z."*

