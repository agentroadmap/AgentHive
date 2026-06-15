> **Type:** reference
> **MCP-tracked:** P2995
> **Source-of-truth:** Postgres proposal workflow state, runtime service health, and the code paths named below

# Self-Hosting Failure-Mode Analysis

This document identifies the highest-risk failure modes in AgentHive's
self-hosting loop: agents modifying the platform that schedules, gates, merges,
and runs those same agents. It is the P2995 AC-7 preflight artifact for the next
self-evolution cycle.

## Operating Boundary

Self-hosting is acceptable only if mechanical invariants are enforced outside
LLM judgment. The relevant chokepoints are:

| Layer | Current source |
| --- | --- |
| Proposal state and maturity | `roadmap_proposal.proposal` |
| Gate verdicts | `roadmap_proposal.gate_decision_log` |
| AC verification | `roadmap_proposal.proposal_acceptance_criteria` |
| Work offers and claims | `roadmap_workforce.squad_dispatch` and claim functions |
| Worker execution | `roadmap_workforce.agent_runs` |
| Merge audit | `roadmap.worktree_merge_log` |
| Runtime health | systemd units, MCP health, Postgres watchdog events |

The failure modes below assume agents can edit this repository and create
proposals, but cannot be trusted to remember operational rules without
deterministic enforcement.

## Top 5 Failure Modes

### 1. Logged Gate Advance Without State Movement

**Scenario:** A gate agent records an `advance` decision but the proposal status
does not move. The next agent sees inconsistent evidence and either repeats work
or advances from a false premise.

**Why it matters:** This is the canonical self-hosting hazard: the platform
records that it approved its own change, but the state machine did not actually
advance.

**Existing controls:**

- `roadmap_proposal.gate_decision_log` is the durable gate verdict table.
- `trg_apply_gate_advance` runs `fn_apply_gate_advance()` after gate-decision
  insert.
- `trg_guard_gate_advance` blocks status updates that lack gate evidence.
- `docs/operations/p611-gate-advance-reconciler.md` documents the historical
  stranded-advance incident and the trigger/reconciler design.

**Mitigations before next cycle:**

- Prefer `mcp_proposal action=gate_decision` for advances because it writes the
  decision and lets the trigger apply status in one transaction.
- Treat direct `prop_transition` as an expert-only fallback.
- Run a pre-cycle query for recent `gate_decision_log.decision='advance'` rows
  where `proposal.status` still equals `from_state`.

**Monitoring signals:**

- Count of stranded advances older than 60 seconds.
- Gate decision rows whose `to_state` differs from the actual proposal status.
- Repeated gate decisions for the same proposal/state pair.

### 2. Dispatch or Claim Storm From Self-Authored Work

**Scenario:** A platform change creates duplicate work offers, repeatedly fails
to dispatch, or lets one agency claim unbounded work. Agents then spend capacity
repairing symptoms caused by their own scheduler.

**Why it matters:** A self-hosting platform can amplify a bad orchestration
change into a fleet-wide spawn storm.

**Existing controls:**

- `postWorkOffer` now refuses terminal `COMPLETE` proposals before dispatch
  insert.
- `OrchestratorOfferDispatcher` marks no-eligible-agency offers failed and
  records `failure_class='no_eligible_agency'`.
- `proposal_role_pause` backs off repeated no-eligible-agency failures.
- P433/P440 design notes define dispatch hardening and terminal retry
  semantics.

**Mitigations before next cycle:**

- Keep duplicate-offer constraints and active-dispatch predicates under
  database tests, not only unit tests.
- For every orchestration change, require a targeted check for terminal
  proposal refusal and no-eligible-agency pause behavior.
- Promote matchmaker-only claim design through P2996 before expanding fleet
  concurrency.

**Monitoring signals:**

- Active `squad_dispatch` rows grouped by proposal, role, and state.
- Number of `no_eligible_agency` failures in the last hour.
- Proposal-role pause rows created or extended in the last hour.
- Agent runs spawned per proposal per hour.

### 3. Capability or Trust Drift Routes Work To The Wrong Agency

**Scenario:** Registry rows, provider rows, host policy, route policy, or
capability metadata diverge. The orchestrator or A2A host believes an agency is
eligible when the liaison cannot actually run it, or routes sensitive work to an
identity with insufficient authority.

**Why it matters:** In self-hosting, a bad routing change can give an agent the
ability to edit the trust system that should constrain it.

**Existing controls:**

- `scripts/start-a2a-host.ts` now requires a matching `roadmap.agency` row and
  an active non-retired `provider_registry` row before loading an agency.
- `resolveAgency` filters registry-only identities and checks capability
  matches before returning a candidate.
- P2997 and P2998 now track Proof/Stake identity and signed delegation-chain
  extensions.

**Mitigations before next cycle:**

- Treat registry-only identities as non-bootable in every dispatch path.
- Require capability matching to use one canonical shape; support legacy
  `string[]` only through normalization.
- Before trust-model work, snapshot active `agent_registry`, `roadmap.agency`,
  `provider_registry`, route policy, and ACL rows.

**Monitoring signals:**

- A2A host boot failures by identity.
- Provider rows with `status='retired'` but active agency/registry rows.
- Capability mismatch escalations.
- Work offers whose role has no active provider advertising the required jobs.

### 4. Runtime Substrate Poisoning While Agents Continue To Mutate State

**Scenario:** MCP, board, state feed, or a long-running DB pool becomes stale or
poisoned. Agents keep acting through partial truth, stale projections, or opaque
transport errors.

**Why it matters:** A self-hosting system must not let agents keep rewriting the
platform when the control plane cannot prove what state it is in.

**Existing controls:**

- Long-running services must call `setPoolLifecycleMode("long-running")`.
- Pool-poisoning incidents are documented in
  `docs/audit/p1123-pool-end-callers.md` and
  `docs/operations/troubleshooting/board-stale.md`.
- MCP runtime reliability is tracked by the P446 design note.

**Mitigations before next cycle:**

- Run MCP `/health` and, where available, smoke tests before dispatching
  self-evolution work.
- Treat `pool_poisoned`, transport closure, or DB reachability errors as a
  cycle stop condition until an operator verifies recovery.
- Keep runtime service liveness separate from throughput proof; a service can
  be up while no offers complete.

**Monitoring signals:**

- `pool_poisoned` events in `control_feed` or lifecycle logs.
- MCP health DB status and request latency.
- Work offers posted vs completed in a fixed time window.
- Agent runs stuck in `running` beyond expected lease/heartbeat windows.

### 5. Merge or Deployment Changes Break The Platform That Must Verify Them

**Scenario:** A worktree merge changes schema, MCP tools, runtime scripts, or
service topology. The merge succeeds mechanically but breaks the deployed
runtime, leaving agents unable to validate or repair the change.

**Why it matters:** Self-evolution changes the verifier and the verified system
at the same time. A bad merge can remove the recovery path.

**Existing controls:**

- `worktree_merge_log` records merge attempts, conflicts, and commit SHAs.
- `docs/features/auto-merge-worktree.md` defines conflict handling and merge
  audit behavior.
- `docs/architecture/state-machine-current.md` now documents the live workflow
  schema and source-of-truth split.

**Mitigations before next cycle:**

- Require a pre-merge runtime compatibility check for schema, MCP handlers, and
  systemd unit assumptions.
- For proposal lifecycle or orchestration changes, run targeted tests against
  dispatch, capability matching, terminal proposal refusal, and gate-decision
  paths before merge.
- Keep rollback instructions and last-known-good service revisions explicit in
  the gate decision or merge discussion.

**Monitoring signals:**

- `worktree_merge_log.status='conflict'` or repeated failed merge attempts.
- MCP tool-list differences before and after deployment.
- Schema-drift reports involving proposal, dispatch, gate, or registry tables.
- Post-merge drop in completed offers or increase in failed agent runs.

## Pre-Cycle Checklist

Run this checklist before allowing agents to modify orchestration, trust,
proposal lifecycle, MCP, or service supervision code:

1. Confirm `HEAD` is aligned to the intended main ref and the worktree diff is
   understood.
2. Confirm MCP health and database reachability.
3. Query stranded gate advances and repeated gate decisions.
4. Query active dispatches, failed dispatches, and proposal-role pauses.
5. Query active agencies across `agent_registry`, `roadmap.agency`, and
   `provider_registry`.
6. Run targeted tests for the surfaces being changed.
7. Record the verification evidence on the owning proposal before merge.

## Stop Conditions

Pause the self-evolution cycle and require operator review when any of these are
true:

- A gate advance is logged but the proposal did not move.
- MCP health cannot prove DB reachability.
- A runtime service is up but no work offers complete during the expected
  throughput window.
- Capability mismatch or no-eligible-agency failures repeat for the same role.
- A merge touches schema or runtime supervision without matching verification.

