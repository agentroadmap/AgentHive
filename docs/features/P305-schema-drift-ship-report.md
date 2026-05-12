# P305 — Schema Drift Ship Report

**Proposal:** P305 — DDL baseline does not match live schema  
**Resolved via:** P436 (Schema Reconciliation for Control Plane, under parent P429)  
**Date:** 2026-05-11  
**Status:** COMPLETE

---

## Purpose

This document is the agent onboarding reference for the schema drift that existed between `roadmap-baseline-2026-04-13.sql` and the live database. It records the final verified state of all five reported column discrepancies and provides a map of the v4 delta layer so future agents start with correct assumptions.

---

## 1. Column Discrepancy Outcomes

All five discrepancies reported in P305 were reconciled. Verified against `roadmap-baseline-2026-04-13.sql` on 2026-05-05:

| Table | Column | Reported Drift | Actual Baseline State | Outcome |
|-------|--------|---------------|-----------------------|---------|
| `cubics` | `cubic_id` | UUID in DDL vs TEXT live | `cubic_id text DEFAULT (gen_random_uuid())::text NOT NULL` (line 1435) | Resolved — baseline matches live |
| `proposal_lease` | `claimed_at` / `leased_at` | `leased_at` in DDL | `claimed_at timestamp with time zone DEFAULT now() NOT NULL` (line 2484) | Resolved — baseline uses `claimed_at` |
| `proposal` | `type` / `proposal_type` | `proposal_type` in DDL | COMMENT confirms column is `type` (line 2189) | Resolved — baseline uses `type` |
| `model_routes` | `is_enabled` / `is_active` | `is_active` in DDL | Table not in baseline; defined in `v4/005_add_cost_per_million_columns.sql` with `is_enabled` | N/A in baseline; correct in migration |
| `workflow_stages` | `template_id` / `workflow_id` | `workflow_id` in DDL | `template_id bigint NOT NULL` (line 3832) | Resolved — baseline uses `template_id` |

---

## 2. Canonical Schema File Map

New agents should use **this layer cake** to understand the live schema:

```
database/ddl/roadmap-baseline-2026-04-13.sql   ← full snapshot (2026-04-13)
database/ddl/v4/002_host_spawn_policy.sql       ┐
database/ddl/v4/004_spawn_policy_default_deny_anthropic.sql
database/ddl/v4/005_add_cost_per_million_columns.sql   ← adds model_routes.is_enabled
database/ddl/v4/006_backfill_cost_per_million_prices.sql
database/ddl/v4/007_cubic_acquire.sql
database/ddl/v4/008_agent_comm_protocol.sql
database/ddl/v4/009_agent_self_registration.sql
database/ddl/v4/010_multi_project_architecture.sql
database/ddl/v4/011-discord-bridge-mapping.sql
database/ddl/v4/044 … 056+                     ┘  ← incremental deltas
database/ddl/hivecentral/000-roles.sql          ┐
database/ddl/hivecentral/001-core.sql … 015+    ┘  ← hiveCentral control-plane
```

**Retired filenames** (do not reference):
- `database/ddl/roadmap-ddl-v2.sql` — does not exist on disk
- `database/ddl/roadmap-ddl-v2-additions.sql` — does not exist on disk

---

## 3. Post-Baseline Delta Notes

Migrations `v4/002` through `v4/010` were applied before 2026-04-13 but are not folded into the baseline snapshot — they exist as an ordered delta layer. When reasoning about a table's current shape, check the baseline first, then apply deltas in numeric order.

Key structural changes introduced in v4:
- `v4/005` — adds `model_routes` table with `is_enabled` (not `is_active`)
- `v4/009` — agent self-registration schema
- `v4/010` — multi-project architecture columns

---

## 4. CONVENTIONS.md Change

CONVENTIONS.md §6.1 previously listed retired filenames as canonical references. This has been corrected to point to:
- `database/ddl/roadmap-baseline-2026-04-13.sql`
- `database/ddl/v4/`
- `database/ddl/hivecentral/`

`docs/reference/schema-migration-guide.md` has been updated with the same correction.

---

## 5. References

- [P436](https://gitlab.local) — Schema Reconciliation for Control Plane (parent: P429)
- `database/ddl/roadmap-baseline-2026-04-13.sql`
- `database/ddl/v4/`
- `CONVENTIONS.md §6.1`
- `docs/reference/schema-migration-guide.md`
