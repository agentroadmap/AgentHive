# AgentHive Glossary

Shared vocabulary for agents, users, and contributors. Agents should call `get_definition(term)` via MCP before using any of these terms in proposals or decisions.

---

## Architecture

**AgentHive**
The agent-native control plane. Coordinates autonomous agent teams across product development — from proposal to shipped code — with minimum user supervision.

**Cubic**
An isolated execution environment for one phase of product development. Each cubic has specialized agents and a default model tier: Design (Opus) → Build (Sonnet) → Test → Ship (Haiku). Phase gates (G1–G4) separate cubics.

**DAG (Directed Acyclic Graph)**
The dependency graph across proposals. Nodes are proposals; edges are typed dependencies. The DAG determines execution order and unblocking signals.

**Digital Nervous System**
The architectural metaphor for AgentHive: Soul (shared Postgres state), Memory (vector + graph), Body (Git + filesystem). The soul coordinates, the memory learns, the body persists.

**MCP (Model Context Protocol)**
The interface layer that allows agents to safely call tools — filesystem, state, browser, messaging — without direct OS access. AgentHive exposes its control plane as MCP tools.

**SMDL (State Machine Definition Language)**
AgentHive's YAML DSL for defining configurable workflows. Encodes stages, transitions, roles, decision gates, dependencies, and maturity rules. Stored in Postgres and versioned in Git.

**Soul**
The Postgres-backed shared state layer. The authoritative source for proposal state, agent registry, team composition, budgets, and decision outcomes. Survives process restarts; in-memory stores do not.

**Worktree**
An isolated Git working tree provisioned for a single agent. Each agent gets its own branch, directory, and identity. Prevents concurrent file conflicts between agents working on the same repository.

---

## Proposal Lifecycle

**Proposal (RFC)**
The primary unit of work. Moves through a defined workflow (default: Draft → Review → Develop → Merge → Complete). Contains: summary, motivation, acceptance criteria, dependencies, and decision history.

**Proposal Type**
The classification that determines which workflow template applies to a proposal. Type is not decorative metadata; it is the workflow-selection key used by MCP and the control plane.

**Stage**
A named phase within a proposal's workflow. The current authoritative RFC-style flow is `Draft`, `Review`, `Develop`, `Merge`, `Complete`.

**Maturity**
The lifecycle state of a proposal *within* a stage. Four values:

| Value | Meaning |
|---|---|
| `new` | Just entered this stage; no agent has claimed it |
| `active` | A working agent holds the lease and is executing |
| `mature` | The work in the current stage is ready for gate evaluation |
| `obsolete` | Superseded by architecture change, branch revision, or scope pivot — regardless of stage |

In the current authoritative model, a working agent may self-claim `mature` to request gate evaluation; advancement still requires the gate decision record.

**Obsolete**
A cross-cutting lifecycle event. A proposal becomes obsolete when it is superseded — by a competing implementation, an architecture change, or a strategic pivot — regardless of its current stage or maturity. Not the same as rejected (which is a gate outcome) or discarded (which is explicit abandonment).

**Decision Gate (D1–D4)**
The evaluator that runs after a working agent signals readiness. Produces exactly one of four outcomes:

| Outcome | Meaning | Effect |
|---|---|---|
| `mature` | Work is complete; advance | Proposal transitions to next stage |
| `revise` | Work needs rework; go back | Proposal remains in the same stage for revision or split |
| `depend` | Advance conditionally; blocked by external dependency | Proposal carries dependency into next stage (see: Blocking Dependency) |
| `discard` | Abandoned or fatally flawed | Proposal is discarded or rejected from the active flow |

Gates are configurable: `auto`, `ai`, or `user`. Default model is `auto`, which escalates to `user` when cost or impact thresholds are exceeded.

**Gate Evaluator**
The actor that runs a Decision Gate. Three modes:

| Mode | Description |
|---|---|
| `auto` | System evaluates based on AC completion, quorum, and thresholds; escalates to `user` if configured thresholds are exceeded |
| `ai` | A designated AI agent evaluates (e.g., Skeptic, PM agent) |
| `user` | A USER must explicitly approve before the gate resolves |

**Autopilot**
A workflow-level setting (`autopilot: true`) that defaults all gates to `auto`. Designed for teams that have built confidence in agent capabilities. Individual gates can still be overridden.

**USER**
The human or organizational principal that owns the system. The `user` gate evaluator mode requires USER approval before a proposal advances. Preferred term over "human" — the USER may delegate or may eventually be a trusted agent with elevated clearance.

**Impact Score**
A 1–100 rating of a proposal's blast radius if it fails or is wrong. Used in gate escalation thresholds alongside `cost_usd`. Conservative defaults (impact ≥ 20, cost ≥ $0.50) ensure the system starts in high-supervision mode; the USER raises thresholds as confidence builds. MERGE gates default to `OR` logic (either condition alone triggers escalation) because merges are consequential even when cheap.

---

## Dependencies

**Dependency**
A typed relationship between two proposals where one requires an output or completion signal from another. Carried forward into the next stage rather than causing a wait state.

**Blocking Dependency**
A dependency that prevents the Decision Gate from approving advance. The gate evaluator will not issue `mature` until the referenced proposal emits the required readiness signal. Can be descriptive (natural language, unresolved) or a hard reference (resolved to a specific proposal ID). An AI agent resolves descriptive dependencies to hard references opportunistically during gate evaluation; hard references avoid re-investigation if the work was already researched.
```yaml
type: gates
description: "requires auth module to be stable"   # always kept for context
ref: RFC-042                                         # resolved hard reference
stage: DEVELOP
maturity: mature
resolved: true
resolution_confidence: 0.91
```

**Input Dependency**
A soft dependency. The gate can approve advance; the working agent subscribes to the dependency's readiness signal and incorporates its output when it arrives. Also supports descriptive or hard-reference form.
```yaml
type: informs  # enriches, does not block
description: "design patterns from the messaging refactor"
ref: RFC-038
stage: REVIEW
resolved: true
```

**Dependency Resolution**
The process of upgrading a descriptive dependency to a hard reference. Performed by a research agent at gate evaluation time: searches `research_cache` and the proposal registry for a matching proposal. If confidence ≥ 0.8, the dependency is resolved in-place. If unresolved and `type: gates`, the gate evaluator decides: block advance or proceed with a warning. Hard references can always be re-evaluated if architecture changes.

**Readiness Signal**
An event emitted by a proposal when it reaches a specific stage and maturity. Consumed by dependent proposals. Signals the agent-to-agent communication protocol for coordination without direct coupling.

Examples: `design_ready`, `build_ready`, `deploy_ready`.

Implemented via Postgres `NOTIFY` on the `proposal_maturity_changed` channel.

---

## Agent Coordination

**Agent**
An autonomous process (typically a Claude Code session) that claims a proposal lease, executes work within a stage, and signals readiness for gate evaluation. Stateless per session; coordinates through the Soul (Postgres).

**Agent Lease**
A time-bounded claim on a proposal by an agent. Prevents two agents from working on the same proposal simultaneously. Transitions the proposal from `new` to `active`.

**Pulse**
A liveness signal emitted by agents at regular intervals. Missing pulses are advisory — they must not trigger automatic penalty or state change on their own.

**Agent Spawn**
The act of forking a new agent process into a worktree with a configured `CLAUDE.md` and MCP context. The spawner is responsible for model selection, budget allocation, and context assembly before invoking the agent.

**Context Assembly**
The process of constructing an agent's prompt before spawning: system prompt (role/persona) + proposal body + research memory hits + codebase snippets + budget remaining. Assembled by the `ContextAssembler` to fit within the model's token window.

**Research Memory**
A shared, Postgres-backed cache of research findings (web fetches, codebase scans, ADRs) indexed by embedding vector. Agents write findings after research; subsequent agents query before doing redundant work.

**Decision Queue**
The queue of pending gate evaluation requests. Working agents insert a request when they signal readiness; the gate evaluator (AI or USER) processes the queue and records outcomes.

**Transition Queue**
The queue of approved stage transitions waiting to execute. Populated by the Decision Gate after a `mature` outcome. Processed by the AutoTransitionEngine via Postgres LISTEN/NOTIFY and a 30-second poll fallback.

---

## Economics

**Budget Ledger**
Real-time per-proposal spend tracking. Records model used, tokens in/out, cost in USD, and budget remaining. The Gate Evaluator checks budget remaining before approving advance. Hard stop at 100% of allocated budget.

**Burn Rate**
Real-time USD spend velocity across the active agent workforce, measured per proposal and per stage.

**Token ROI**
The ratio of value delivered (merged code, shipped feature, resolved dependency) to the cost in tokens/USD consumed to produce it.

**Model Tier**
The default model assigned to each cubic phase. Design = Opus (reasoning-heavy), Build = Sonnet (generation), Test = cost-optimized, Ship = Haiku. Overridden dynamically by the Multi-LLM Router based on task complexity and remaining budget.

**Multi-LLM Router**
Routes sub-tasks to the appropriate model tier based on task type, complexity estimate, and cost budget. Selects model before the Agent Spawner invokes the API.

---

## Pipeline

**Pre-flight Check**
A local, low-cost verification (linting, security scan, type check) that must pass before a proposal advances from DEVELOP to MERGE. Automated; no agent or USER involvement required.

**Phase Gate (G1–G4)**
The four transition checkpoints between cubics: G1 = Design Review, G2 = Build Complete, G3 = Test Passed, G4 = Ship. Phase gates correspond to Decision Gates D1–D4 in the state machine.

**Promotion**
Moving a proposal artifact from a stage-local branch to the canonical branch (e.g., `main`). Triggered at the MERGE gate after all acceptance criteria pass.

**Circuit Breaker**
A USER-controlled pause that halts an agent or entire pipeline. Must not fire automatically from missed pulses alone. Designed for anomaly response, not normal flow.

**Acceptance Criteria (AC)**
Specific, measurable conditions that must be met before the Decision Gate evaluates a proposal. Authored during REVIEW; verified during DEVELOP and MERGE. Gates with `requires_ac: true` will not evaluate until all ACs are marked met.

---

## Messaging

**Agent-to-Agent Message**
A structured, Postgres-backed message between two agents. Used for transient coordination: handoff context, design discussion, escalation requests, conflict resolution. Not the same as a Readiness Signal (which is a lifecycle event).

**Channel**
A named message stream. Agents subscribe to channels relevant to their current task. Channel types: `group` (broadcast), `private` (1:1), `pulse` (liveness).

**Adversarial Review**
A review step where a Skeptic Agent actively attempts to find flaws, security risks, or inefficiencies in a proposal before the REVIEW gate approves advance.

---

## Governance

**Escalation**
The automatic routing of a decision to a higher-authority evaluator (higher-tier AI or USER) when: confidence is below threshold, cost/impact exceeds configured limits, or an agent signals uncertainty.

**Audit Trail**
The immutable log of all stage transitions, gate decisions, agent actions, and budget debits for a proposal. Stored in `proposal_audit_events`. Queryable via MCP.

**Veto Window**
A configurable time window (default: 0 in autopilot, 30 min in supervised mode) during which a USER can reject an approved gate decision before the transition executes. After the window, the transition proceeds automatically.
