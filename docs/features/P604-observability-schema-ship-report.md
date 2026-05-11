# P604: Observability Schema — Spans, Lifecycle Events, Routing, Explainability — Ship Report

**Phase:** COMPLETE  
**Date:** 2026-05-09  
**Documenter:** ccs46ant-bot-docum-a  
**Migration:** `scripts/migrations/060-p604-observability-schema.sql`

---

## 1. Summary

P604 establishes observability as a first-class bounded context in AgentHive — the substrate for
replaying autonomous behavior, generating training data, building dashboards, and answering
"why did the orchestrator pick agent X for proposal Y?" post-hoc.

Five tables are created in the `roadmap.*` schema (future home: `hiveCentral.observability`,
deferred to P429):

| Table | Purpose |
|---|---|
| `trace_span` | Parent/child span DAG for all orchestrator and agency operations |
| `agent_execution_span` | Per-spawn telemetry: model, route, tokens, cost, briefing linkage |
| `proposal_lifecycle_event` | Immutable audit log of every status/maturity transition (trigger-populated) |
| `model_routing_outcome` | Route-selection record with candidate list and selection reason |
| `decision_explainability` | Gate/assignment/budget/grant decisions with inputs, rules, outcome |

The application layer is `ObservabilityWriter` (`src/core/observability/observability-writer.ts`),
integrated into `agent-spawner.ts` and `scripts/orchestrator.ts`. All writes are error-isolated:
a DB failure during observability emits to stderr and never propagates to the caller.

---

## 2. Acceptance Criteria Verification

All 12 ACs pass (verified by `claude/agency-bot`).

| AC | Description | Status |
|----|-------------|--------|
| AC-1 | Orchestrator dispatch produces root `trace_span` (`operation='orch.dispatch'`); child spans share `trace_id` | PASS |
| AC-2 | Every agent spawn writes one `agent_execution_span` with agency_id, agent_id, model_name (TEXT), route_id (BIGINT FK), proposal_id, briefing_id, token counts, cost_usd; no `model_id` column | PASS |
| AC-3 | Every route selection writes `model_routing_outcome` with `candidate_routes` (scored) and non-empty `selection_reason` | PASS |
| AC-4 | Every gate-advance decision writes `decision_explainability` with inputs, rules_evaluated, outcome | PASS |
| AC-5 | Retention: DELETE rows older than 30 days from `trace_span` + `agent_execution_span`; `proposal_lifecycle_event`, `model_routing_outcome`, `decision_explainability` retained indefinitely | PASS |
| AC-6 | `ObservabilityWriter` is error-isolated — forced DB failure during span write logs to stderr, does not crash orchestrator/agency | PASS |
| AC-7 | `AGENTHIVE_TRACE_ID` injected into spawned agent env alongside `AGENTHIVE_BRIEFING_ID`; child spans share parent `trace_id` and carry non-null `parent_span_id` | PASS |
| AC-8 | Span attributes follow OTel semantic conventions; mock OTLP integration test validates span structure; no external Jaeger container required for CI | PASS |
| AC-9 | All five tables exist in `roadmap.*` under `agenthive@127.0.0.1:5432`, matching migration 060 DDL | PASS |
| AC-10 | `fn_proposal_lifecycle_event` + `trg_proposal_lifecycle_event` on `roadmap_proposal.proposal`; every status/maturity change writes one event row with `triggered_by_did` sourced from `app.agent_did` → `app.agent_identity` → `'system'` | PASS |
| AC-11 | `service_did` in `trace_span` enforced exclusively by DB CHECK `'^(agent|agency|operator):'`; no application-layer OR | PASS |
| AC-12 | `trace_span` is plain (unpartitioned); self-referential `parent_span_id` FK precludes range partitioning in PostgreSQL; retention by DELETE | PASS |

---

## 3. Key Files

| File | Role |
|---|---|
| `scripts/migrations/060-p604-observability-schema.sql` | Canonical DDL — 5 tables, trigger, 17 indexes, role grants |
| `scripts/migrations/059-p604-observability-schema.sql` | Earlier iteration (also P604-labeled); superseded by 060 |
| `src/core/observability/observability-writer.ts` | `ObservabilityWriter` class — all five write paths, error isolation |
| `src/core/orchestration/agent-spawner.ts` | Integration: span start/close, `writeAgentExecutionSpan`, `writeModelRoutingOutcome`, `buildSpawnProcessEnv` (AGENTHIVE_TRACE_ID injection) |
| `scripts/orchestrator.ts` | Integration: `orchWriter` + `gateWriter` instances; gate span + `writeDecisionExplainability` |
| `tests/unit/observability-writer.test.ts` | Unit tests — write paths, error isolation contract |
| `tests/integration/observability-otlp.test.ts` | Integration tests — SQL shape validation, mock OTLP export |
| `tests/unit/observability-trace-propagation.test.ts` | `AGENTHIVE_TRACE_ID` env propagation via `buildSpawnProcessEnv` |
| `tests/unit/observability-trigger.test.ts` | Trigger DDL validation against migration 060 file |

---

## 4. Schema Design Decisions

### trace_span — plain, not partitioned

Range partitioning was considered and explicitly rejected: the self-referential `parent_span_id`
FK cannot span partition boundaries in PostgreSQL. Retention is DELETE-based (`admin_write` role,
30-day window). Partitioning deferred; if volume demands it, the FK must be dropped first (see
P604 drawbacks in proposal design).

### model_name denormalised in agent_execution_span

`roadmap.model_metadata` has a composite UNIQUE on `(provider, model_name)`, not a standalone
unique on `model_name`. A direct FK is therefore impossible. `model_name TEXT` is stored
denormalised; `route_id BIGINT` (FK to `roadmap.model_routes.id`) is the authoritative route
identifier.

### agent_id — no FK by design

`agent_id BIGINT NOT NULL` references `roadmap.agent_runs.id` (per-execution instance) by value
only. No FK constraint is declared to avoid coupling to `agent_runs` schema evolution. This is
intentional; the comment in the DDL makes it explicit.

### service_did — DB CHECK as sole enforcement path

`trace_span_service_did_check` (`service_did ~ '^(agent|agency|operator):'`) is the only
enforcement point. No application-level assertion mirrors this; the constraint is the single
source of truth.

### Retention tiers

| Tier | Tables | Grant | Mechanism |
|---|---|---|---|
| Rolling 30-day | `trace_span`, `agent_execution_span` | DELETE → `admin_write` | Cron DELETE |
| Indefinite | `proposal_lifecycle_event`, `model_routing_outcome`, `decision_explainability` | No DELETE | Governance/audit |

### Trace context propagation

Before calling `spawnAgent()`, the orchestrator generates a `trace_id` UUID, writes the root
`trace_span` row, and injects `AGENTHIVE_TRACE_ID=<uuid>` into the child process environment
alongside `AGENTHIVE_BRIEFING_ID`. Child agents read this variable on startup and write child
spans sharing the same `trace_id`, with `parent_span_id` pointing to the parent span.

### Session DID for trigger

Before any `roadmap_proposal.proposal` UPDATE, callers set:
```sql
SET LOCAL app.agent_did = 'agent:<identity>';
```
The trigger falls back to `app.agent_identity`, then `'system'`, so `triggered_by_did` is
always non-null.

---

## 5. Indexes (17 explicit)

| Table | Index | Purpose |
|---|---|---|
| `trace_span` | `idx_trace_span_trace_id` | Primary trace lookup |
| | `idx_trace_span_started_at` | Time-range queries |
| | `idx_trace_span_parent_span_id` (partial, `IS NOT NULL`) | Subtree traversal |
| | `idx_trace_span_status_err` (partial, `!= 'ok'`) | Error filtering |
| `agent_execution_span` | `idx_aes_proposal`, `idx_aes_agency`, `idx_aes_route`, `idx_aes_project`, `idx_aes_briefing` | FK join performance |
| | `idx_aes_agent_id` | Per-agent cost queries (no FK, high cardinality) |
| `proposal_lifecycle_event` | `idx_ple_display_id`, `idx_ple_project`, `idx_ple_occurred_at` | Audit queries |
| `model_routing_outcome` | `idx_mro_trace_id`, `idx_mro_route` | Route attribution |
| `decision_explainability` | `idx_de_trace`, `idx_de_kind` | Replay and kind filtering |

---

## 6. Role Grants Summary

| Table | roadmap_agent | admin_write |
|---|---|---|
| `trace_span` | SELECT, INSERT, UPDATE(`ended_at`,`status`,`error_message`) | DELETE |
| `agent_execution_span` | SELECT, INSERT | DELETE |
| `proposal_lifecycle_event` | SELECT, INSERT + seq USAGE | — |
| `model_routing_outcome` | SELECT, INSERT + seq USAGE | — |
| `decision_explainability` | SELECT, INSERT + seq USAGE | — |

`admin_write` already owns DELETE on other telemetry tables (migration 022 §4); migration 060
extends it to the two rolling-retention tables.

---

## 7. Migration Note

Two files carry the P604 label:
- `059-p604-observability-schema.sql` — earlier iteration; no CHECK constraint on `service_did`,
  fewer indexes, no preflight guards, wrapped in `BEGIN/COMMIT`.
- `060-p604-observability-schema.sql` — **canonical**; adds `service_did` CHECK, UPDATE grant on
  `trace_span`, 17 explicit indexes, preflight DO block, and aligns all column comments with the
  final design (agent_id → `agent_runs.id`, not `agent_registry.id`).

Migration 058 is reserved for P495; migration 059 (the P611 gate-decision-auto-advance file)
is committed. Migration 060 checks FK target tables (model_routes, model_metadata, project,
spawn_briefing, roadmap_proposal.proposal) exist before running.

---

## 8. Risk Assessment

**Low.** The schema is additive — no existing tables altered. The trigger fires only on
`status`/`maturity` changes to `roadmap_proposal.proposal`, which is the most stable table in
the schema. Write amplification is measured-low at current agent volumes (<50 concurrent); the
proposal flags this for revisit at >500 concurrent spans/sec.

The only non-trivial failure mode is `ObservabilityWriter` silently dropping telemetry on DB
outage. This is intentional (error isolation; AC-6), and the open `trace_span` row with
`ended_at = NULL` survives a spawner crash and remains queryable as a partial record.

---

## 9. Recommendation

**Ship confirmed.** All 12 ACs pass. Schema is coherent, migration is self-guarded with
preflight checks, application integration is clean and error-isolated, and the full test suite
(unit + integration + trigger DDL validation + trace propagation) provides replay-safe coverage.
OTLP export is config-driven and non-blocking on CI.

---

*Generated by ccs46ant-bot-docum-a (documenter) for P604 COMPLETE phase.*
