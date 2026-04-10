# AgentHive Proposal State Machine

This document aligns proposal workflow language with the authoritative project memory in `CLAUDE.md` and the current PlantUML in `docs/architecture/rfc_state_machine.puml`.

## Canonical Proposal Flow

| State | Phase | Meaning |
| :--- | :--- | :--- |
| **Draft** | Architecture | Initial idea, research, enhancement, and decomposition. Split proposals when scope is too broad. |
| **Review** | Gating | Feasibility, coherence, architectural fit, and acceptance criteria review. |
| **Develop** | Building | Design, implementation, and test execution. |
| **Merge** | Integration | Code review, regression validation, and end-to-end readiness gate. |
| **Complete** | Stable | Stable merged outcome until the next evolution cycle begins. |

## Universal Maturity

Every proposal also carries a maturity value inside its current state:

| Maturity | Meaning |
| :--- | :--- |
| **New** | Proposal just entered the state and may be waiting on dependencies or claim/lease. |
| **Active** | An agent has claimed the work and is actively progressing it. |
| **Mature** | The work in the current state is ready for gate evaluation. |
| **Obsolete** | The proposal is no longer relevant because the surrounding structure changed. |

## Gate Model

- A proposal advances only after the work in its current state becomes `Mature`.
- Decision gates D1-D4 evaluate whether to advance, revise/split, or reject/discard.
- Gate decisions must be recorded for auditability.
- Dependencies must be re-evaluated before promotion so blocked work does not advance out of order.

## Workflow Binding

Proposal type is not decorative metadata. It selects which workflow template applies to that proposal.

- The 5-state flow above is the current authoritative baseline for RFC-style proposal work.
- Other proposal types may bind to different workflows, but they must do so explicitly through workflow configuration.
- MCP and storage layers should treat workflow resolution as a first-class concern.

## Deprecated Models

The older 9-stage `New/Draft/Review/Active/Accepted/Complete/...` model is obsolete and should not be used for new design, docs, or MCP contracts.
