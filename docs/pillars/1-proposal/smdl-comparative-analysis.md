# SMDL Comparative Analysis — P374 AC-3

**Author:** P374 architect pass  
**Date:** 2026-05-26

---

## Scope

SMDL v1 (AgentHive DB-only, P825) vs. five alternatives: BPMN 2.0, CUE, Dhall, XState,
AWS Step Functions ASL.

Evaluation dimensions:
1. **Expressiveness** — can it model AgentHive's workflows without painful workarounds?
2. **Portability** — format independence, runtime independence
3. **Tooling ecosystem** — editors, validators, visualizers, SDKs
4. **Agent-native fit** — usable by AI agents with minimal scaffolding
5. **DB backing** — can definitions live in Postgres and be hot-reloaded?

Scoring: ✅ strong | ⚠️ partial / workaround needed | ❌ absent

---

## Comparison Matrix

| Dimension | **SMDL v1** | BPMN 2.0 | CUE | Dhall | XState | AWS ASL |
|---|---|---|---|---|---|---|
| **Format** | YAML | XML | CUE lang | Dhall lang | JSON/TS | JSON |
| **Agent-editable** | ✅ simple YAML | ❌ complex XML | ⚠️ CUE syntax steep | ⚠️ Dhall novel | ⚠️ JS-only | ⚠️ nested JSON |
| **Linear stages** | ✅ | ✅ | ⚠️ no built-in | ⚠️ no built-in | ✅ | ✅ |
| **Role-based gates** | ✅ | ✅ via Lanes | ❌ | ❌ | ⚠️ manual | ❌ |
| **Quorum rules** | ✅ | ⚠️ custom ext | ❌ | ❌ | ⚠️ custom | ❌ |
| **Timeouts** | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Parallel stages** | ❌ | ✅ (AND-split) | ❌ | ❌ | ✅ (parallel) | ✅ (Parallel) |
| **Nested states** | ❌ | ✅ sub-processes | ❌ | ❌ | ✅ compound | ❌ |
| **Side-effect actions** | ❌ | ✅ service tasks | ❌ | ❌ | ✅ actions | ✅ states |
| **DB-backed hot reload** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ (S3) |
| **JSON Schema validation** | ✅ | ✅ (XSD) | ✅ built-in | ✅ typed | ✅ | ✅ |
| **Mermaid/visual export** | ✅ (AC-4) | ✅ BPMN tools | ❌ | ❌ | ✅ XState viz | ❌ |
| **Multi-agent dispatch** | ⚠️ AC-6 adds | ✅ multi-instance | ❌ | ❌ | ✅ actors | ⚠️ Map state |
| **Weighted scoring** | ⚠️ AC-5 adds | ❌ | ❌ | ❌ | ❌ | ❌ |
| **AI-native maturity model** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Portability (no vendor lock)** | ✅ | ✅ | ✅ | ✅ | ⚠️ JS runtime | ❌ AWS only |

---

## Per-Alternative Analysis

### BPMN 2.0

**Strengths over SMDL:**
- Industry standard with 15+ years of tooling (Camunda, Activiti, Flowable)
- Native AND-splits and AND-joins for parallel execution
- Sub-processes model nested states natively
- Service tasks model side-effects (HTTP calls, message sends)
- Swimlane notation maps naturally to roles

**Weaknesses vs SMDL:**
- XML format is hostile to AI agents and humans alike; 100-line workflows become
  1000-line XML documents
- No concept of "maturity" or "proposal" — concepts must be bolted on
- DB-backed hot reload requires a custom BPMN engine deployment (Camunda/Flowable)
- No weighted scoring primitive; must be implemented as a custom gateway evaluator
- Overkill for the 5–7 stage workflows that cover 95% of AgentHive use cases

**Verdict:** Adopt selectively for BPMN export/import compatibility (bridge adapter),
not as the primary format.

---

### CUE

**Strengths over SMDL:**
- Strong type system with constraints (values within ranges, enum enforcement)
- `cue vet` validates instances against schemas deterministically
- Unification semantics catch contradictions across large configuration files
- No Turing-completeness — safe to evaluate in untrusted contexts

**Weaknesses vs SMDL:**
- Not a workflow language; stages, transitions, roles require entirely custom schemas
- No execution semantics — CUE validates, it does not run
- Steep learning curve for AI agents that must generate valid CUE
- No visualization ecosystem; would need a separate converter step

**Verdict:** CUE is a strong *validation layer* that could be layered on top of SMDL
(validate SMDL YAML against a CUE schema before DB insert). Not a replacement.

---

### Dhall

**Strengths over SMDL:**
- Total (non-Turing-complete) language prevents infinite loops in config evaluation
- Strong types with imports — large workflow families can share typed base definitions
- Dhall → JSON/YAML projection useful for portability

**Weaknesses vs SMDL:**
- Even steeper learning curve than CUE; essentially a typed functional language
- No workflow semantics; same "build everything from scratch" problem as CUE
- AI agents trained on YAML/JSON produce invalid Dhall; generation quality is poor
- No community tools for workflow visualization or DB loading

**Verdict:** Dhall is excellent for infrastructure config (Kubernetes, Terraform); not
appropriate for agent-native workflow definitions. Rejected.

---

### XState (v5)

**Strengths over SMDL:**
- First-class parallel states (type: 'parallel'), history states, final states
- Actor model aligns well with agent identity
- XState DevTools visualizer is best-in-class
- `@xstate/store` and `createMachine()` are battle-tested
- JSON machine definition (`fromJson()`) is importable from non-JS contexts

**Weaknesses vs SMDL:**
- JavaScript/TypeScript runtime dependency — no native Postgres materialization
- Role-based access control is not a built-in concept; must build on top of guards
- Quorum rules require custom guard functions
- No DB-backed hot reload; machines are recompiled on code change
- AWS CloudEvents / external trigger integration requires custom adapters
- Agent-generated XState JSON frequently violates guard function constraints
  (functions cannot be serialized across process boundaries)

**Verdict:** XState's statechart semantics (parallel, history, actors) are the right
**conceptual model** for SMDL v3. For v2 parallel stage support, adopt XState JSON
as the internal representation after SMDL parse but before DB materialization. The DB
continues to be the source of truth; XState serialization is a compilation target.

---

### AWS Step Functions ASL

**Strengths over SMDL:**
- Native Parallel and Map states for concurrent execution
- Retry and Catch blocks are first-class state machine constructs
- Serverless integration (Lambda, SQS, SNS, DynamoDB) built in
- AWS Console provides a visual state machine editor
- 99.99% SLA; managed execution runtime

**Weaknesses vs SMDL:**
- AWS vendor lock-in; self-hosted AgentHive cannot use Step Functions runtime
- JSON format is difficult for agents to generate correctly (deeply nested)
- No concept of roles, quorum, or maturity — agent workflow governance requires
  building a separate layer on top
- No weighted scoring or multi-agent dispatch primitives
- Hot reload requires redeploy to AWS (Terraform/CDK cycle)
- Cost at scale (per-state-transition pricing) is non-trivial

**Verdict:** Rejected for AgentHive core. Could serve as an *export target* if AgentHive
workflows need to run on AWS-backed infrastructure in the future.

---

## Strategic Recommendation

SMDL is the **right choice** for AgentHive's core use case given:

1. **DB-backed hot reload** — no other alternative provides this natively
2. **Maturity model** — new/active/mature/obsolete is unique to agent-native workflows
3. **AI-editable YAML** — agents generate valid SMDL reliably; XML/CUE/Dhall generation quality is poor
4. **Quorum and weighted scoring** (post-AC-5) — no alternative has quorum primitives

**Recommended roadmap:**

| Version | Key additions from comparison |
|---|---|
| v1 (current) | Linear stages, quorum, roles, timeouts, DB-backed |
| v1.5 (AC-5, AC-6) | Weighted scoring, multi-agent dispatch |
| v2 | Transition side-effect actions, attribute-predicate guards, CUE validation layer, XState JSON as internal IR |
| v3 | Parallel stages (fork/join), nested sub-workflows, history states — adopt XState semantics |

**Selective integration:**
- **CUE** → use as a validation linter on SMDL load (before DB insert)
- **BPMN** → export bridge for enterprise stakeholders who need diagram interchange
- **XState** → adopt as internal IR for v3 parallel state semantics

---

## File pointers

| Document | Location |
|---|---|
| SMDL v1 spec | `docs/pillars/1-proposal/state-machine-definition-language.md` |
| Expressiveness gap matrix | `docs/pillars/1-proposal/smdl-expressiveness-audit.md` |
| Weighted scoring spec | `docs/pillars/1-proposal/smdl-weighted-scoring-spec.md` |
| Multi-agent coordination spec | `docs/pillars/1-proposal/smdl-multi-agent-coordination-spec.md` |
| P825 migration guide | `docs/migration/p825-smdl-v2.md` |
