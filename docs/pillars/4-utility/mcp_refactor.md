To simplify the **agentHive** nervous system, the MCP layer should hide relational joins from agents while keeping the database normalized. This aligns with the goal of reducing "ops noise" while avoiding duplicate storage that can drift out of sync.

The MCP and CLI should act as a lightweight projection engine: read canonical child tables, assemble one YAML+Markdown projection, and return that to agents as the prompt-ready context block.

### 1. The Redundancy Elimination (Database Cleanup)

The following fields and tables are identified as tactical clutter and should be removed or derived dynamically to reduce token waste and database locking.

* **Removed Table:** `proposal_criteria`. This table is redundant with `proposal_acceptance_criteria` and should not be replaced by a copied `criteria JSONB` column.
* **Canonical Child Table:** `proposal_acceptance_criteria` remains the source of truth for acceptance criteria. MCP can project it as a compact list without exposing the table structure to agents.
* **Removed Columns:**
    * `rfc_state`: Use `status` column proposal.
    * `maturity_queue_position`: Derived dynamically via a SQL View using `created_at` and `priority`.
    * `blocked_by_dependencies`: Calculated via a `roadmap_proposal.dependency_link` table query rather than a hard-coded field.
    * `accepted_criteria_count` / `required_criteria_count`: Derived dynamically from `proposal_acceptance_criteria`.

* Try to remove redundant calculated values, they maybe inconsistent and are high maintenance and not reliable

---

### 2. The Projection Interface

To simplify agent interactions, we will implement a "Select-by-Projection" syntax. This allows an agent to request exactly the slice of data it needs for its current context.

**Command Syntax:**
`roadmap proposal detail {id:190, title, maturity, design, acceptance_criteria}`

**Internal MCP Logic:**
The MCP server will parse this JSON-like string and map it to the relational read model, such as `roadmap.v_proposal_full` and its child-table aggregates. This ensures that the agent receives one flat projection without creating a second canonical copy of proposal data.

---

### 3. Agent-Native Output: The YAML+MD Hybrid

Agents perform best when metadata is structured (YAML) and narratives are descriptive (Markdown). The simplified MCP tool will return a single block formatted as follows:

```yaml
# --- METADATA (YAML) ---
id: 190
title: "Agent Society Governance Framework"
priority: High
maturity: New
type: Theory
lease: { agent: "Architect-01", expires: "2026-04-13T10:00Z" }
# -----------------------

# --- NARRATIVE (Markdown) ---
## Motivation
To borrow from Ostrom and Axelrod to define the 5-layer governance model.

## Design
The system uses a Tit-for-Tat reputation engine in the `roadmap_workforce` schema.

## Acceptance Criteria
1. All agents must have a verifiable Identity.
2. Lease hijackers face immediate audit.
```



---

### 4. Implementation Guidelines for the Refactor

| Change | Technical Action | Pillar Mapping |
| :--- | :--- | :--- |
| **Criteria Cleanup** | Drop `proposal_criteria`; keep `proposal_acceptance_criteria` as the canonical source and project it through MCP. | Pillar 1 (Proposal) |
| **Reference Authority** | Move all "Maturity" and "State" labels to `roadmap.reference_terms`. | Pillar 4 (Utility) |
| **MCP Projection** | Implement `mcp_get_proposal_projection` in the MCP server. | Pillar 4 (Utility) |
| **Context Optimization** | Use `roadmap_efficiency` to cache these projections. | Pillar 3 (Efficiency) |

### Rationale
By moving to a **YAML+MD** output, you drastically reduce the pre-processing logic an agent needs before calling an LLM. The agent no longer has to "clean" the data; it can simply inject the Markdown block directly into its prompt as **"Context."** This saves tokens and reduces the chance of "Agent Hallucination" during the **REVIEW** and **DEVELOP** phases.

Do not create a `criteria JSONB` replacement for `proposal_criteria`; use child-table aggregates in the MCP projection.
