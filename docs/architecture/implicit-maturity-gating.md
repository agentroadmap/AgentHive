# Implicit Maturity Gating

This document describes the simplified proposal gating design introduced by P240. The goal is to remove confusion caused by treating `transition_queue` as a second state machine. The proposal itself is the source of truth.

## Core Model

Every proposal has two independent lifecycle dimensions:

| Dimension | Source | Purpose |
| --- | --- | --- |
| Workflow state | `proposal.status` | Where the proposal is in its configured workflow. |
| Maturity | `proposal.maturity` | Whether work inside the current state is ready, active, complete for gate review, or obsolete. |

The canonical RFC workflow is:

```text
Draft -> Review -> Develop -> Merge -> Complete
```

The universal maturity model inside each state is:

```text
new -> active -> mature -> obsolete
```

`mature` is the only gate-ready signal. A proposal does not need a separate queue row to become gate eligible.

## Gate Readiness

A proposal is gate-ready when:

1. `proposal.maturity = 'mature'`
2. `proposal.status` is a workflow state with a configured next transition
3. no active gate lease already exists for the same proposal and gate

The inferred gate comes from the current workflow state:

| Current state | Gate | Successful transition |
| --- | --- | --- |
| `Draft` | D1 | `Review` |
| `Review` | D2 | `Develop` |
| `Develop` | D3 | `Merge` |
| `Merge` | D4 | `Complete` |

`Complete + mature` is not part of the D1-D4 gate queue. It is a re-evaluation opportunity for future optimization or transformation work, described separately by P242.

## Stateless Baseline Handoff

The baseline handoff is intentionally simple:

1. A builder, researcher, or architect claims the proposal and works inside the current state.
2. When that agent believes the work is ready, it sets maturity to `mature`.
3. The agent releases its work lease.
4. The proposal/cubic waits for a gating agent to claim the inferred gate.
5. The gating agent records a decision through MCP.
6. The gate lease is released as part of the decision.

No agent waits idle for the gate by default. The cubic keeps the proposal context so a later agent can continue without relying on a queue row for memory.

Optional standby collaboration, where the prior leaser remains available during gating, is a separate mode described by P241. It must not complicate the baseline state machine.

## Gate Decisions

Gate decisions mutate `proposal.status` and `proposal.maturity`; they do not create a new lifecycle object.

| Decision | Effect |
| --- | --- |
| `advance` | Move to the next workflow state and set maturity to `new`. |
| `send_back` or `hold` | Keep the current workflow state and set maturity to `new`. |
| `obsolete` | Keep or close the workflow state according to policy and set maturity to `obsolete`. |

Every decision must write durable context through MCP discussion, message, or event records. The decision record should explain why the gate advanced, sent back, held, or obsoleted the proposal.

## Dependency Rule

Dependencies are not part of the gate decision for the current state.

A gate evaluates whether the work for the current state is coherent and ready to move forward. It should not reject or hold a proposal only because a dependency is still unresolved.

**Gating Decision:** If a proposal is mature and passes gate review, it advances regardless of unresolved dependencies. The gate agent should NOT block advancement due to transitive dependencies.

**Dependency Handoff:** Unresolved dependencies carry forward with the proposal after an advance. They can block later work, later claims, or later advancement when the next state requires the dependency to be resolved. This enforcement happens at dispatch time, not at gate time.

Example:

```text
P501 is Draft/mature and depends on P250.
D1 evaluates P501's draft quality and ACs; P250 is unresolved but not a gate blocker.
D1 advances P501 to Review/new. The dependency on P250 remains attached.
P501 may be blocked from dispatch or later D2 advancement until P250 is resolved.
```

This keeps gate review focused on current-state quality while preserving dependency enforcement for the stages where the dependency actually matters (dispatch, capability availability, etc.).

## Role of transition_queue

`transition_queue` must not be treated as workflow truth.

If it remains during migration, it may only be used for:

- scheduler wakeups
- retry or attempt history
- compatibility with older workers
- operational diagnostics

It must not introduce statuses that compete with `proposal.status` or `proposal.maturity`. Agents and dashboards should prefer a derived gate-ready projection based on proposals, leases, and events.

## MCP Projection

Agents should not reason directly over table structure. MCP should expose a projection for gate work that includes:

- proposal id, title, type, state, and maturity
- inferred gate
- current lease and gate lease information
- current cubic or proposal context pointer
- unresolved dependencies as carried context
- latest decision or discussion summary
- acceptance criteria and relevant review notes

The projection should be suitable for YAML plus Markdown output so agents receive one coherent briefing instead of stitching together raw tables.

## Invariants

- `mature` means gate-ready.
- one active gate lease is allowed per proposal and inferred gate.
- gate decisions release the gate lease.
- send-back returns maturity to `new`.
- advance moves state and resets maturity to `new`.
- dependencies carry forward and block future work or advancement when relevant.
- `transition_queue` is not a second state machine.

