> **Type:** design note
> **MCP-tracked:** P374
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P374

# SMDL Review And Expansion

This note is the current architecture baseline for the State Machine Definition Language in AgentHive. It documents what the existing SMDL runtime can already express, where it still relies on workarounds, where the model stops short of real AgentHive workflow needs, and which extensions should be treated as the next coherent expansion set.

## Current Baseline

The live code path already supports YAML-defined workflows, validation, Postgres materialization, runtime state-name loading, and Mermaid conversion:

- `src/core/workflow/smdl-loader.ts`
- `src/core/workflow/smdl-to-template.ts`
- `src/core/workflow/smdl-to-mermaid.ts`
- `src/apps/mcp-server/tools/workflow/smdl-mcp.ts`

This means SMDL is already more than a draft DSL. It is a real configuration surface for workflow templates. The gap is not "can SMDL exist," but "can SMDL express the workflows AgentHive actually wants without leaking policy back into TypeScript and SQL."

## Phase 1: Expressiveness Audit

Severity scale used below:

- `low`: awkward but workable
- `medium`: repeated workaround or policy leakage
- `high`: core workflow need cannot be modeled directly

| Workflow | Can Express | Requires Workaround | Cannot Express | Severity |
| --- | --- | --- | --- | --- |
| RFC 5-stage | ordered stages, explicit transitions, role allowlists, quorum counts, AC gating, auto-transition labels | maturity is still dual-tracked outside SMDL, gate personas are partly externalized in DB/runtime, split/hold semantics depend on surrounding proposal logic | advisory review semantics, per-gate evidence contracts, state history, inherited child workflow spawning | `medium` |
| Incident response | simple triage/deploy/closed paths, timeout fields, explicit terminal stages | escalation paths, retry policy, dispatch ownership, and operational side effects still need external code/DB hooks | nested sub-incidents, parallel containment/remediation tracks, compensating rollback semantics | `high` |
| Code review | reviewer roles, approval transitions, iteration loops, quorum and timeout hints | reviewer assignment, branch/CI coupling, and check provenance live outside SMDL | parallel review lanes with join conditions, blocking check aggregation, historical resume markers | `high` |

### Audit Notes

SMDL v1 is strongest when the workflow is a linear or lightly branching pipeline with explicit human-readable rules. It becomes progressively weaker when workflow semantics depend on:

- parallel branches that must later re-join
- state history or resume semantics
- dynamic dispatch to multiple agents
- weighted decision logic instead of binary pass/fail
- side effects that must be part of the workflow contract rather than hidden in handlers

The main architectural leak today is that AgentHive policy is split between SMDL, workflow tables, gate-role tables, and proposal orchestration code. That is survivable for RFC workflows, but it is the limiting factor for incident response and richer code-review automation.

## Phase 2: Efficiency Analysis

No fresh runtime benchmark was run as part of this P374 execution pass. The analysis here is based on the current implementation shape.

### Observed cost centers

1. YAML parse and validation are cheap relative to DB writes. The current validator is structural and in-process.
2. DB materialization is row-oriented. `workflowLoad()` upserts the template, then stages, then transitions, then roles in separate loops.
3. Transition evaluation latency is dominated by proposal/gate SQL, not by in-memory SMDL inspection.
4. Gate dispatch latency is dominated by `pg_notify` wakeup paths, offer claiming, and downstream agent spawn, not by the diagram or parser code.
5. Agent-context memory footprint is low for current workflows because templates are small and stage maps are compact.

### Bottleneck ranking

| Area | Likely bottleneck | Why |
| --- | --- | --- |
| Parse + validate | low | YAML size is small; validation is shallow |
| Materialization | medium | multiple sequential round trips per workflow load |
| Transition evaluation | medium | gate/proposal SQL joins and orchestration checks dominate |
| Gate dispatch | high | database notify, offer claim, spawn, and reconciler hops dominate |
| In-memory footprint | low | workflow templates are tiny compared with agent context |

### Efficiency recommendation

If performance work is pursued, optimize in this order:

1. batch materialization writes
2. cache normalized workflow graphs after load
3. reduce gate-dispatch DB chatter before touching YAML parsing

## Phase 3: Comparative Analysis

| System | Strengths | Weaknesses vs SMDL | Fit For AgentHive |
| --- | --- | --- | --- |
| BPMN 2.0 | rich workflow vocabulary, mature diagram ecosystem | XML-heavy, high ceremony, poor fit for hand-editing by agents | useful reference for semantics, not a good runtime authoring format |
| CUE | excellent validation and composition | no workflow-native semantics, would still need a state-machine layer | good validator companion, weak direct replacement |
| Dhall | total, safe, deterministic config | workflow semantics absent, unfamiliar toolchain burden | strong config discipline, low operational fit |
| XState | best-in-class statechart semantics, hierarchy, parallelism, actors | JS-centric, runtime embedding bias, weak DB-first posture | strongest semantic reference for SMDL v2 |
| AWS ASL | clear task orchestration vocabulary, retries, catches | cloud-locked, JSON-first, agent model mismatch | good execution-pattern reference, poor portability |

### Comparative conclusion

SMDL should stay YAML-first and DB-backed. The right move is not to replace it with a general config language. The right move is to borrow missing semantics selectively:

- from XState: parallel states, compound states, history, actor-style dispatch
- from ASL: retries, catches, timeout and compensation semantics
- from BPMN: explicit gateway vocabulary and visualization conventions
- from CUE/Dhall: optional stronger validation layer for authoring time

## Phase 4: Visualization Baseline

The visualization path now needs to be treated as a first-class architecture surface rather than a debug helper.

### Implemented in this pass

- richer Mermaid stage notes for quorum, AC, timeout, evaluator, weighted scoring, and coordination hints
- clickable stage anchors in generated Mermaid output
- structured visualization metadata returned from `workflow_visualize`

### Remaining visualization work

- dedicated dashboard state-machine tab
- Excalidraw export path
- click-through from rendered node to live stage/gate configuration in the web UI
- color and legend conventions aligned with workflow/gate status semantics

## Phase 5: Weighted Scoring Expansion

Binary gate results are too coarse for complex design and release gates. SMDL should support a weighted evaluator mode with explicit scoring criteria.

### Proposed shape

```yaml
stages:
  - name: REVIEW
    order: 2
    weighted_scoring:
      mode: weighted
      passing_score: 0.8
      criteria:
        - key: technical_fit
          weight: 0.35
        - key: delivery_risk
          weight: 0.25
        - key: testability
          weight: 0.20
        - key: docs_impact
          weight: 0.20
```

### Expansion rules

- weighted scoring is a gate-evaluator mode, not a replacement for transitions
- criteria should be explicit, stable, and auditable
- final gate verdict still collapses to advance, hold, or reject
- raw scores should persist for audit and later tuning

### Schema direction

- `weighted_gate_scores`
  - `proposal_id`
  - `stage`
  - `criterion_key`
  - `weight`
  - `score`
  - `rationale`
  - `evaluated_by`
  - `evaluated_at`

## Phase 6: Multi-Agent Coordination Expansion

Current SMDL v1 describes workflow state, but not coordinated multi-agent execution inside a state. That is the biggest limitation for real squad-style workflows.

### Proposed shape

```yaml
stages:
  - name: DEVELOP
    order: 3
    coordination:
      mode: parallel
      dispatch:
        - role: developer
          count: 2
          capabilities: [code, qa]
          mode: parallel
        - role: reviewer
          count: 1
          capabilities: [review]
          join: all
```

### Design intent

- coordination belongs on stages, not transitions
- SMDL should declare dispatch intent; orchestrator and liaison remain the execution machinery
- join conditions must be explicit (`all`, `any`, later `weighted`)
- this should integrate with the existing workforce model and the squad assembly direction claimed by P055, rather than inventing a parallel dispatch system

### Non-goals

- SMDL should not embed raw provider/model routing
- SMDL should not replace lease or offer tables
- SMDL should not own agent identity naming rules

## Recommended Next Steps

1. Treat `docs/pillars/1-proposal/state-machine-definition-language.md` as the user-facing spec and fold the older parallel DSL description into one source.
2. Add v2 semantics incrementally: weighted scoring first, coordination second, hierarchy/parallel-state semantics third.
3. Split implementation proposals for DB schema, gate evaluator changes, and dashboard integration instead of overloading the architecture baseline.

## Bottom Line

SMDL is already viable for configurable linear workflows. It is not yet expressive enough for full agent-native orchestration without policy leakage. The shortest path to a stronger SMDL is not a rewrite. It is a focused v2 that adds weighted evaluation, explicit coordination primitives, and better visualization while keeping the current YAML-plus-Postgres runtime model.
