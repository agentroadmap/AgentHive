# 🗺️ AgentHive Roadmap

> Generated: 2026-06-16 | Source: Postgres `agenthive` (via MCP prop_list) | 763 proposals

> **Note:** The proposal tables below are stale (2026-04-05, 71 rows). The live count is 763. See **How to Regenerate** below to produce a current full listing.

## 📊 Live Status Summary (2026-06-16)

| Status | Count |
|--------|-------|
| ✅ COMPLETE | 596 |
| 🔀 MERGE | 1 |
| 🔨 DEVELOP | 86 |
| 🔍 REVIEW | 46 |
| 📝 DRAFT | 34 |
| **Total** | **763** |

## 🔄 How to Regenerate

Run the following query against the `agenthive` DB (via pgbouncer on port 6432) to regenerate the full proposal listing:

```sql
SELECT
  p.display_id AS "ID",
  p.title AS "Title",
  p.status AS "Status",
  p.maturity AS "Maturity",
  p.type AS "Type",
  COALESCE(ac_pass.cnt, 0) || '/' || COALESCE(ac_total.cnt, 0) AS "AC"
FROM roadmap.proposal p
LEFT JOIN (
  SELECT proposal_id, COUNT(*) AS cnt
  FROM roadmap.proposal_acceptance_criteria
  WHERE status = 'pass'
  GROUP BY proposal_id
) ac_pass ON ac_pass.proposal_id = p.id
LEFT JOIN (
  SELECT proposal_id, COUNT(*) AS cnt
  FROM roadmap.proposal_acceptance_criteria
  GROUP BY proposal_id
) ac_total ON ac_total.proposal_id = p.id
ORDER BY
  CASE p.status
    WHEN 'COMPLETE' THEN 1 WHEN 'MERGE' THEN 2 WHEN 'DEVELOP' THEN 3
    WHEN 'REVIEW' THEN 4 WHEN 'DRAFT' THEN 5 ELSE 6
  END,
  p.id::int;
```

Then update the header line with today's date and the row count, and replace the tables below.

---

## ⚠️ Stale Snapshot (2026-04-05, 71 proposals — for reference only)

## ✅ COMPLETE (1)
| ID | Title | AC |
|----|-------|----|
| P013 | RFC-20260401-MESSAGING | 0/5 |

## 🔍 REVIEW (1)
| ID | Title | AC |
|----|-------|----|
| P032 | Code Review: Security & Quality Issues Found | 0/5 |

## 🔨 DEVELOP (12)
| ID | Title | AC |
|----|-------|----|
| P066 | Maturity Lifecycle Tracking & Escalation | 0/5 |
| P067 | Domain-Oriented Proposal Routing | 0/5 |
| P068 | Federation & Cross-Instance Sync | 0/5 |
| P069 | Workflow Engine Schema Migration | 0/5 |
| P058 | Cross-Domain Semantic Index | 0/3 |
| P059 | MCP Tool Router — Dynamic Tool Exposure | 0/3 |
| P060 | Delegated Approvals — Lead Agent Auto-Approval | 0/3 |
| P061 | Recursive Auditing — Self-Correction System | 0/3 |
| P062 | State Integrity Guards — Divergence Detection & Prevention | 0/3 |
| P063 | Message System Flow Control — Rate Limits, Backpressure & Priority | 0/3 |
| P064 | 4-Layer Memory Architecture — Constitutional → Session | 0/3 |
| P065 | State Machine Definition Language (SMDL) v1.0 | 0/3 |

## 📝 DRAFT (35)
| ID | Title | AC |
|----|-------|----|
| P070 | Dependency-Gated State Transitions via Maturity | 0/9 |
| P071 | Typed Dependencies in SMDL | 0/8 |
| P001 | CHILD-RFCS-CREATED | 1/1 |
| P002 | Test-Team-Memory-Sprint | 0/0 |
| P003 | Retired secondary-database naming cleanup | 0/0 |
| P004 | Retired secondary-database naming cleanup | 0/0 |
| P005 | Agent-Profile-Upgrade — GitHub-Sync Personality Injection | 0/0 |
| P006 | Messaging-Synchronization | 0/0 |
| P007 | RFC-20260401-BUSINESS-DESIGN | 0/0 |
| P008 | RFC-20260401-BUSINESS-STRATEGY | 0/5 |
| P009 | RFC-20260401-CONFIG-REDESIGN | 0/5 |
| P010 | RFC-20260401-DATA-MODEL | 0/5 |
| P011 | RFC-20260401-MCP-TOOL-SPEC | 0/5 |
| P012 | RFC-20260401-MESSAGES-PULSE | 0/5 |
| P014 | RFC-20260401-MOBILE-ALERT | 0/5 |
| P015 | RFC-20260401-MOBILE-VISIONARY | 0/5 |
| P016 | RFC-20260401-PIPELINE-PREFLIGHT | 0/5 |
| P017 | RFC-20260401-PIPELINE-VERIFICATION | 0/5 |
| P018 | RFC-20260401-PRODUCT-STATEMACHINE | 0/5 |
| P019 | RFC-20260401-PRODUCT-TEMPLATE | 0/5 |
| P020 | RFC-20260401-SECURITY-CHILD-051 | 0/5 |
| P021 | RFC-20260401-SECURITY-CHILD-052 | 0/5 |
| P022 | RFC-20260401-SECURITY-CHILD-054 | 0/5 |
| P023 | RFC-20260401-SECURITY-CHILD-056 | 0/5 |
| P024 | RFC-20260401-SECURITY | 0/5 |
| P025 | RFC-20260401-SPENDING-VISIBILITY | 0/5 |
| P026 | RFC-20260401-TUI-COCKPIT | 0/5 |
| P027 | RFC-20260401-WORKFORCE-CORE | 0/5 |
| P028–P031 | Agent Memory Architecture: 4-Layer Memory System | 4×0/5 |
| P029 | Retire secondary-database subscription path | 0/5 |

## 🆕 PROPOSAL (22)
| ID | Title | AC |
|----|-------|----|
| P073 | Four-Module Domain Architecture | 0/0 |
| P072 | Agent Memory Lifecycle — Store, Refresh, Cleanup | 0/7 |
| SPRINT-20260405 | Sprint 2026-04-05: Proposal Batch Pipeline | 0/8 |
| P033 | Agent Registry and Discovery | 0/5 |
| P034 | Team Builder - Dynamic Skill Matching | 0/5 |
| P035 | Sandbox Provisioning and Isolation | 0/5 |
| P036 | Real-time Proposal Dashboard | 0/5 |
| P037 | Workload Balancer - Smart Task Routing | 0/5 |
| P050 | MCP Rate Limiting & Quotas | 0/5 |
| P051 | MCP Tool Discovery API | 0/5 |
| P052 | MCP Health Monitoring | 0/5 |
| P053 | MCP SSE Session Management | 0/5 |
| P054 | MCP Tool Testing Framework | 0/5 |
| P055 | MCP Logging & Observability | 0/5 |
| P056 | MCP Security Hardening | 0/5 |
| P057 | MCP Performance Benchmarking | 0/5 |
| P043 | Skill-Based Recruiting System | 0/0 |
| P044 | Economic Control Layer | 0/0 |
| P045 | Self-Healing DAG System | 0/0 |
| P046 | Hybrid Storage Adapter | 0/0 |
| P048 | MCP Tool Versioning | 0/5 |
| P049 | MCP Error Standardization | 0/5 |

---

**Stale snapshot stats (2026-04-05):** 71 total | 1 COMPLETE | 1 REVIEW | 12 DEVELOP | 35 DRAFT | 22 PROPOSAL

**Live stats (2026-06-16):** 763 total | 596 COMPLETE | 1 MERGE | 86 DEVELOP | 46 REVIEW | 34 DRAFT

**Note:** This file is generated from Postgres. Run the regeneration query above to refresh the full table.
