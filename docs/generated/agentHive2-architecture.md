# agentHive2 Architecture Documentation

> **Auto-generated from MCP/Postgres proposal state. Do not hand-edit.**
> Source: `roadmap_proposal.v_doc_tree` joined with `roadmap_proposal.proposal_migration_map`
> Regenerate: `psql -h 127.0.0.1 -U admin -d agenthive -c "SELECT ... FROM roadmap_proposal.v_doc_tree ORDER BY display_path;"`

---

## Grand Picture

### P1013 — agentHive2 Grand Picture — Product Vision, Operating Model, and System Boundaries

**Status:** DRAFT | **Corpus coverage:** 16 legacy proposals (1 delivered, 15 retained)

Defines the top-level product vision for agentHive2: an autonomous, AI-agent-native product development platform that uses its own completed components to build, enhance, and refactor its next generation. This proposal is the documentation root for the entire agentHive2 proposal stack.

---

## Pillars

### P1014 — Pillar 1: Control Plane — hiveCentral, Tenant Lifecycle, Multi-Project Management

**Status:** DRAFT | **Corpus coverage:** 40 legacy proposals (16 delivered, 0 retained)

The Control Plane pillar owns the hiveCentral database, tenant project lifecycle, project registry, and all cross-project shared schema. It is the infrastructure backbone that all other pillars depend on.

---

### P1015 — Pillar 2: Proposal Engine — Lifecycle, Criteria, Leases, Mapping, and Documentation Projection

**Status:** DRAFT | **Corpus coverage:** 20 legacy proposals (8 delivered, 9 retained)

The Proposal Engine pillar owns the proposal lifecycle state machine, acceptance criteria, leases, dependencies, reviews, the legacy-to-agentHive2 mapping artifact, and documentation-shaped projection views. It is the source of truth for all work planning and documentation.

---

### P1016 — Pillar 3: Workforce and Agencies — Agent Registry, Self-Registration, Liaison Bootstrap, Tiered Identity

**Status:** DRAFT | **Corpus coverage:** 24 legacy proposals (17 delivered, 6 retained)

The Workforce and Agencies pillar owns agent registration, agency runtime contracts, liaison bootstrap, tiered agent identity, and the shared messaging gateway libraries used by every agency provider.

---

### P1017 — Pillar 4: Unified Messaging Infrastructure — Single Bus, Decoupled Presence, USER↔Agent

**Status:** DEVELOP | **Corpus coverage:** 23 legacy proposals (17 delivered, 6 retained)

The A2A Messaging pillar owns the foundational agent-to-agent communication fabric: the unified message envelope, single canonical bus, durable listener transport contract, decoupled presence path, and cross-host delivery.

#### Children

| Proposal | Title | Status |
|---|---|---|
| P1102 | P1017-A: Phase A — stop heartbeat pollution + archive historical rows | REVIEW |
| P1103 | P1017-B: Phase B — canonical message envelope + schema governance + infra | DRAFT |
| P1104 | P1017-C: Phase C — presence state machine (presence_state, fn_pulse, agency_presence_changed) | DRAFT |
| P1105 | P1017-D: Phase D — USER first-class identity + bearer-token authentication | DRAFT |
| P1106 | P1017-E: Phase E — dispatcher service stable + HMAC verifier + DLQ + cross-host security | DRAFT |
| P1107 | P1017-F: Phase F — transport contracts and binary regression guards | DRAFT |

---

### P1021 — Pillar 5: Execution and Orchestration — Orchestrator, Dispatch Loop, Work Offers, Gate Pipeline

**Status:** DRAFT | **Corpus coverage:** 24 legacy proposals (14 delivered, 9 retained)

The Execution and Orchestration pillar owns the Orchestrator class, dispatch loop, work-offer lifecycle, scanQueues, lease management, and gate pipeline. It is the engine that moves proposals through their lifecycle.

---

### P1022 — Pillar 6: Governance and Trust — Identity, Budget Wiring, Marketplace Admission Controls

**Status:** DRAFT | **Corpus coverage:** 13 legacy proposals (10 delivered, 3 retained)

Pillar 6 owns who can act, on what, with what budget, and under what market discipline. After P1018 wires the substrate, Pillar 6 becomes the place where the marketplace clearing rules live.

---

### P1023 — Pillar 7: Observability and Efficiency — Spans, Lifecycle Events, Backup, Partition Maintenance, Schema-Drift

**Status:** DRAFT | **Corpus coverage:** 8 legacy proposals (7 delivered, 1 retained)

The Observability and Efficiency pillar owns execution spans, lifecycle event logging, routing explainability, backup harness, partition maintenance, schema-drift monitoring, and cross-project dependency tracking.

---

### P1024 — Pillar 8: Web and Operator Experience — Dashboard, Operator CLI, TUI Board, Activity Feed, Discord Bridge

**Status:** DRAFT | **Corpus coverage:** 10 legacy proposals (0 delivered, 9 retained)

The Web and Operator Experience pillar owns the dashboard web portal, operator CLI (hive-cli), TUI board, activity feed, Discord routing bridge, and the operator-as-gate-agent proxy surface.

#### Children

| Proposal | Title | Status |
|---|---|---|
| P1067 | TUI Operator Shell — shared runtime, panel switcher, common LISTEN client | DRAFT |

---

## Corpus Inventory Summary

| Classification | Count |
|---|---|
| delivered_evidence | 412 |
| retained | 194 |
| obsolete | 137 |
| **Total mapped** | **743** |

Source: `SELECT classification, count(*) FROM roadmap_proposal.proposal_migration_map GROUP BY classification;`

---

## How to Regenerate

```sql
-- Full tree
SELECT depth, display_path, display_id, title, status,
       legacy_count, delivered_count, retained_count
FROM roadmap_proposal.v_doc_tree
ORDER BY display_path;

-- Summary views
SELECT * FROM roadmap_proposal.v_migration_classification_summary;
SELECT * FROM roadmap_proposal.v_migration_unresolved LIMIT 20;
SELECT * FROM roadmap_proposal.v_migration_delivered_evidence LIMIT 20;
```

_Generated by P999 (P995-C) — documentation-shaped projection demo. P995 root proposal._
