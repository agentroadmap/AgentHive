# Control Plane Design Notes

This folder holds design notes for the AgentHive control-plane architecture. The canonical lifecycle records live in MCP/Postgres (CONVENTIONS.md §0); these files are synced projections.

## Parent

- **P429** — AgentHive Control Plane: dedicated `agenthive_control` DB + per-project DBs on one Postgres instance (component)

## Companion Architecture Docs

- `../control-plane-multi-project-architecture.md` — boundary, entity model, dispatch flow, migration phases, non-negotiable invariants
- `../control-plane-ddl-sketch.md` — schema-qualified DDL for the 10 control schemas with constraints, indexes, views (1293 lines)
- `../provider-budget-context-plane.md` — token_plan / api_key_plan / subscription / local enforcement, model catalog vs route, seven-gate routing pipeline, credential vault, context policy hierarchy (649 lines)

## Children of P429

| MCP ID | Type | Title | Design Note |
| --- | --- | --- | --- |
| P430 | component | Control DB Boundary | `control-db-boundary.md` |
| P431 | feature | Control Database Bootstrap | `control-database-bootstrap.md` |
| P432 | feature | Project Domain Database Isolation | `project-database-isolation.md` |
| P433 | issue | Dispatch and Agency Hardening | `dispatch-agency-hardening.md` |
| P434 | feature | Provider Route and Budget Governance | `provider-route-budget-governance.md` |
| P435 | feature | Control Panel Observability | `control-panel-observability.md` |
| P436 | issue | Schema Reconciliation for Control Plane | `schema-reconciliation-control-plane.md` |
| P437 | issue | Dispatch Idempotency and Transition Leases | `dispatch-idempotency-transition-leases.md` |
| P438 | issue | Claim Policy Must Fail Closed | `claim-policy-fail-closed.md` |
| P439 | issue | State Machine Concurrency Ceilings | `state-machine-concurrency-ceilings.md` |
| P440 | issue | Dispatch Retry and Terminal Semantics | `dispatch-retry-terminal-semantics.md` |
| P441 | component | Service Topology Ownership | `service-topology-ownership.md` |
| P442 | feature | Operator Stop and Cancel Controls | `operator-stop-cancel-controls.md` |
| P443 | feature | State Feed Causal IDs | `state-feed-causal-ids.md` |
| P444 | issue | Host, Provider, and Route Separation | `host-provider-route-separation.md` |
| P445 | feature | State Machine Race Integration Tests | `state-machine-race-integration-tests.md` |
| P446 | issue | MCP Runtime Reliability | `mcp-runtime-reliability.md` |
| P447 | issue | Cubic Worktree Path Normalization | `cubic-worktree-path-normalization.md` |

## Dependency Skeleton

```
P429 (parent component)
├── P430 Boundary (component) ─────┐
│                                  │
├── P431 Bootstrap (feature) ◄─────┤
│   └── P436 Schema Reconciliation (issue) ◄─┤
│   └── P432 Project DB Isolation (feature)  │
│   └── P439 Concurrency Ceilings (issue)    │
│   └── P441 Service Topology (component)    │
│
├── P433 Dispatch Hardening (issue) ─────────┤
│   └── P437 Idempotency (issue) ◄───────────┤
│   │   └── P440 Retry/Terminal (issue) ◄─┐
│   │       └── P445 Race Tests (feature)│
│   └── P442 Stop/Cancel (feature)        │
│   └── P447 Cubic Paths (issue)          │
│                                          │
├── P434 Provider/Budget Governance ◄──────┤
│   └── P438 Fail-Closed Claims (issue) ◄──┤
│   │   └── P445 Race Tests (feature)      │
│   └── P444 Host/Provider/Route (issue)   │
│
├── P435 Control Panel Observability (feature) ◄┤
│   └── P441 Service Topology (component)        │
│   └── P442 Stop/Cancel (feature)               │
│   └── P443 Causal IDs (feature)                │
│
└── P446 MCP Runtime Reliability (issue) ◄──── (cross-cutting)
```

## Build Order Suggestion

1. **Foundation** — P430, P431 (boundary classification + control DB creation)
2. **Schema cleanup** — P436 (reconciliation), P446 (MCP reliability)
3. **Project isolation** — P432 (per-project DBs + PoolManager; extends the early multi-project design, now superseded by P429/P483)
4. **Dispatch hardening core** — P433, P437, P438, P439, P440 (dedupe, idempotency, fail-closed, ceilings, retry)
5. **Provider plane** — P434, P444 (provider accounts, routes, budgets, host separation)
6. **Service topology** — P441 (one owner per responsibility)
7. **Operator surface** — P443, P442, P435 (causal IDs → stop controls → control panels)
8. **Verification** — P445 (race integration tests), P447 (cubic path repair)

## Editing Discipline

- The MCP/Postgres row for each Pxxx is the lifecycle source of truth: status, maturity, AC, dependencies, reviews, discussions live there.
- These files capture the **design context** behind each proposal — narrative, rationale, sketches.
- Update both together when the design evolves: change the design note in this folder AND `prop_update` the MCP record.
- Do not rename these files when an MCP transition happens; the filename is stable, only the MCP `status`/`maturity` change.
