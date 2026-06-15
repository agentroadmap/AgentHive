> **Type:** reference
> **MCP-tracked:** P2995
> **Source-of-truth:** Postgres `roadmap_proposal.proposal`, `roadmap.workflow_templates`, `roadmap.workflow_stages`, and `roadmap_proposal.proposal_valid_transitions`

# AgentHive Proposal Lifecycle State Machine

This document is the publication-facing schema description for AgentHive's
proposal lifecycle. It describes the state machine that is live in the
`agenthive` database as of 2026-06-11, not older design intent.

## Core Model

A proposal has two independent lifecycle axes:

| Axis | Column | Live values | Meaning |
| --- | --- | --- | --- |
| Workflow state | `roadmap_proposal.proposal.status` | Workflow-specific uppercase states such as `DRAFT`, `REVIEW`, `DEVELOP`, `MERGE`, `COMPLETE` | Where the proposal is in its configured workflow. |
| Maturity | `roadmap_proposal.proposal.maturity` | `new`, `active`, `mature`, `obsolete` | Whether work inside the current state is idle, claimed, ready for a gate, or retired. |

`status` is advanced by gate/state-machine actions. `maturity` is advanced by
work inside a state. `mature` is the gate-ready signal; it does not itself move
the workflow state.

## Workflow Templates

Workflow topology is data-driven:

| Table | Purpose |
| --- | --- |
| `roadmap.workflow_templates` | Names a workflow template and records version, stage count, SMDL metadata, and project scope. |
| `roadmap.workflow_stages` | Orders active stages inside each workflow template and records whether a stage requires ACs. |
| `roadmap_proposal.proposal_valid_transitions` | Lists allowed edges by workflow name, including allowed transition reasons and AC requirement policy. |

### Standard RFC

Live template id `14`, description `5-stage RFC pipeline for product development`.

| Order | State | Requires AC | Forward gate |
| --- | --- | --- | --- |
| 1 | `DRAFT` | no | D1: `DRAFT -> REVIEW` |
| 2 | `REVIEW` | yes | D2: `REVIEW -> DEVELOP` |
| 3 | `DEVELOP` | yes | D3: `DEVELOP -> MERGE` |
| 4 | `MERGE` | yes | D4: `MERGE -> COMPLETE` |
| 5 | `COMPLETE` | no | terminal |

Reverse iteration edges exist for `REVIEW -> DRAFT`, `DEVELOP -> REVIEW`, and
`MERGE -> DEVELOP` with reasons such as `iterate` or `revision`.

### Hotfix

Live template id `37`, description `Localized operational fix workflow`.

| Order | State | Requires AC | Forward edge |
| --- | --- | --- | --- |
| 1 | `DRAFT` | no | `DRAFT -> DEVELOP` |
| 2 | `DEVELOP` | yes | `DEVELOP -> COMPLETE` |
| 3 | `COMPLETE` | no | terminal |

`DEVELOP -> DRAFT` is the live revision edge.

### Governance Amendment

Live template id `56`. This workflow is for constitutional and governance rule
changes and has extra gate configuration.

| Order | State | Requires AC | Gate configuration |
| --- | --- | --- | --- |
| 1 | `DRAFT` | yes | requires section reference |
| 2 | `DELIBERATION` | no | minimum 48 hour wait, blocking concerns check |
| 3 | `REVIEW` | yes | two distinct reviewers, required skeptic role |
| 4 | `DEVELOP` | no | developer dispatch profile |
| 5 | `MERGE` | yes | human approver required |
| 6 | `COMPLETE` | no | update constitutional document |

Forward edges are `DRAFT -> DELIBERATION`, `DELIBERATION -> REVIEW`,
`REVIEW -> DEVELOP`, `DEVELOP -> MERGE`, and `MERGE -> COMPLETE`.

## Acceptance Criteria

Acceptance criteria live in
`roadmap_proposal.proposal_acceptance_criteria`.

| Column | Contract |
| --- | --- |
| `proposal_id`, `item_number` | Unique per proposal. |
| `criterion_text` | The requirement text. |
| `status` | One of `pending`, `pass`, `fail`, `blocked`, `waived`. |
| `verified_by`, `verified_at`, `verification_notes` | Evidence and attribution for non-pending statuses. |
| `details`, `details_schema_version` | Structured evidence when a verifier provides it. |

AC status is not inferred from tests or from a maturity change. A verifier must
explicitly call the MCP `verify_ac` path for each item whose status changes.

## Reviews, Gate Decisions, and Transitions

The lifecycle has three distinct record types:

| Record | Table | Role |
| --- | --- | --- |
| Review | `roadmap_proposal.proposal_reviews` | Non-mutating reviewer verdicts. Blocking reviews can prevent responsible gate movement, but a review is not itself a state transition. |
| Gate decision | `roadmap_proposal.gate_decision_log` | Structured gate verdict: `advance`, `hold`, `reject`, `waive`, `escalate`, `wontfix`, `discard`, `replace`, or `nonissue`. |
| Transition audit | `roadmap_proposal.proposal_state_transitions` | Historical audit row for actual `status` changes. |

The preferred MCP path for a gate advance is `mcp_proposal action=gate_decision`
with `decision='advance'`. That path writes a `gate_decision_log` row and relies
on the `trg_apply_gate_advance` trigger to move `proposal.status` when the row is
valid for the current workflow state.

Direct `prop_transition` is still available, but gate transitions require an
active lease, attribution, decision notes, and a recent gate-decision record.
`prop_update` intentionally rejects status changes.

## Maturity Mechanics

Maturity uses the universal overlay:

```text
new -> active -> mature -> obsolete
```

Important live triggers:

| Trigger | Table | Effect |
| --- | --- | --- |
| `trg_lease_set_maturity_active` | `proposal_lease` insert | A claimed proposal becomes `active`. |
| `trg_lease_clear_maturity_on_release` | `proposal_lease` update | Release can clear or adjust maturity according to the lease path. |
| `trg_notify_maturity_change` | `proposal` update | Emits maturity-change notifications. |
| `trg_gate_ready` | `proposal` update | Emits gate-ready wakeups when a proposal becomes eligible. |
| `trg_release_leases_on_transition` | `proposal` update | Releases leases after state movement. |

The gate scanner treats `mature` as readiness, not completion. A successful gate
advance moves to the next `status` and resets maturity for the new state.

## Guard Rails

The live database and MCP handlers enforce these invariants:

- `proposal.status` is normalized to uppercase.
- `proposal.maturity` is constrained to `new`, `active`, `mature`, or `obsolete`.
- `proposal.type` must exist in `roadmap_proposal.proposal_type_config`.
- `proposal_valid_transitions` is the edge catalog for legal movement.
- `proposal_acceptance_criteria.status` is constrained to the five AC statuses.
- Gate transitions are blocked by `fn_guard_gate_advance` unless the gate path
  has the required decision evidence or explicit bypass context.
- `prop_update` cannot mutate `status`; transition paths must be used.

## Source-Of-Truth Split

| Concern | Canonical source |
| --- | --- |
| Proposal text and lifecycle position | `roadmap_proposal.proposal` |
| AC list and verification | `roadmap_proposal.proposal_acceptance_criteria` |
| Workflow topology | `roadmap.workflow_templates`, `roadmap.workflow_stages`, `roadmap_proposal.proposal_valid_transitions` |
| Review findings | `roadmap_proposal.proposal_reviews` |
| Gate verdict and rationale | `roadmap_proposal.gate_decision_log` |
| State transition audit | `roadmap_proposal.proposal_state_transitions` |
| Discussion and handoff context | `roadmap_proposal.proposal_discussions` |
| Dependency ordering | `roadmap_proposal.proposal_dependencies` |

Markdown projections are secondary. MCP/Postgres state is authoritative.

## Known Architecture Gaps

These gaps are intentionally explicit because they are part of P2995's research
agenda:

- The state machine is original platform architecture, not a known external
  academic pattern that can be copied wholesale.
- Binary AC `pass/fail` status loses process signal; P2995 AC-4 tracks
  step-wise attribution and reward signals.
- Matchmaker-only dispatch is not complete; the current dispatcher still
  resolves target agencies in code for offer dispatch.
- Trust is currently registry/heartbeat/claim based; P2995 AC-2 and AC-3 track
  Proof, Stake, and signed delegation-chain extensions.
- The self-hosting loop needs a formal failure-mode analysis before the next
  self-evolution cycle.
