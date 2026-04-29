# P436 Control-Plane Schema Drift Report

**Date:** 2026-04-29  
**Author:** Senior Developer (codex-two)  
**Migration:** `scripts/migrations/066-p436-control-plane-schema-reconcile.sql`

---

## 1. Background

Two project-registry tables exist in the `agenthive` DB:

| Table | Source | Rows | Contents |
|---|---|---|---|
| `roadmap_workforce.projects` | P300 Phase 1a | 1 | `agenthive` (id=1) |
| `roadmap.project` | P482 Phase 1 | 3 | `agenthive`(1), `audiobook`(2), `ai-singer`(3) |

`roadmap.project` is canonical. Seven FK constraints and the claim-dispatch function still reference or behave against `roadmap_workforce.projects` (legacy).

---

## 2. Drift Inventory

### 2a. Wrong FK target (Critical)

| Table | Column | Current FK | Target FK |
|---|---|---|---|
| `roadmap_proposal.proposal` | `project_id` | `roadmap_workforce.projects(id)` | `roadmap.project(project_id)` |
| `roadmap_workforce.squad_dispatch` | `project_id` | `roadmap_workforce.projects(id)` | `roadmap.project(project_id)` |

**Data safety:** 0 rows in either table have `project_id` values absent from `roadmap.project` — rebind is zero-downtime safe.

### 2b. Missing FK (Critical)

| Table | Column | Current state | Target |
|---|---|---|---|
| `roadmap_workforce.provider_registry` | `project_id` | `BIGINT NULL`, no FK | `REFERENCES roadmap.project(project_id)` |

**Origin:** migration 041 created this column as `TEXT`; migration 051 altered it to `BIGINT NULL` but added no FK. 2 existing rows both have valid `project_id` values.

### 2c. Missing project_id column (High)

| Table | Type | Rows | Fix |
|---|---|---|---|
| `roadmap_proposal.gate_decision_log` | BASE TABLE | 229 | Add column, backfill via proposal JOIN, add FK |
| `roadmap.gate_decision_log` | VIEW | — | Rebuild view to expose new column |
| `roadmap.run_log` | BASE TABLE | 0 | Add column with DEFAULT 1 + FK |
| `roadmap_efficiency.context_window_log` | BASE TABLE | 0 | Add column with DEFAULT 1 + FK |
| `roadmap.context_window_log` | VIEW | — | Rebuild view to expose new column |

### 2d. Claim function FAIL-OPEN (Critical)

`roadmap_workforce.fn_claim_work_offer` contains:

```sql
agency_projects AS (
  SELECT pr.project_id FROM roadmap_workforce.provider_registry pr
  WHERE pr.agency_id = v_agency_id AND pr.status = 'active'
  UNION
  -- If no project filter, allow all projects (backward compat)
  SELECT id FROM roadmap_workforce.projects
  WHERE p_project_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM roadmap_workforce.provider_registry pr2
      WHERE pr2.agency_id = v_agency_id AND pr2.status = 'active'
    )
)
```

**Effect:** 6 `agency`-type agents with no `provider_registry` rows can claim dispatches for ALL projects. This UNION branch references the legacy `roadmap_workforce.projects` table and is a security boundary violation.

**Affected agents (at time of report):**

| id | agent_identity |
|---|---|
| 11084 | worker-6044 |
| 16152 | copilot/agency-gary |
| 17124 | codex/agency-bot |
| 18348 | claude/agency-orchestrator |
| 18446 | agency-bot |
| 18447 | claude/agency-bot |

---

## 3. Target Schema (Canonical)

### Control-plane tables — project_id NOT NULL, FK → roadmap.project

```
roadmap_proposal.proposal               project_id BIGINT NOT NULL → roadmap.project ✓ (after 066)
roadmap_proposal.gate_decision_log      project_id BIGINT NOT NULL → roadmap.project ✓ (after 066)
roadmap_workforce.squad_dispatch        project_id BIGINT NOT NULL → roadmap.project ✓ (after 066)
roadmap.run_log                         project_id BIGINT NOT NULL DEFAULT 1 → roadmap.project ✓ (after 066)
roadmap_efficiency.context_window_log   project_id BIGINT NOT NULL DEFAULT 1 → roadmap.project ✓ (after 066)
```

### Control-plane tables — project_id nullable FK (global scope = NULL means all projects)

```
roadmap_workforce.provider_registry     project_id BIGINT NULL → roadmap.project ✓ (after 066)
```

### Control-plane tables — no project_id (inherently global / singleton)

```
roadmap.transition_queue                -- workflow state machine; tenant-agnostic
roadmap.model_routes                    -- routing table; global
roadmap.host_model_policy               -- host-level policy; global
roadmap_efficiency.budget_allowance     -- global budget caps
roadmap_efficiency.budget_circuit_breaker -- global circuit breakers
roadmap_efficiency.spending_caps        -- global spending caps
```

### hiveCentral (separate DB — not in scope of this migration)

```
agency.*                                -- on hiveCentral DB; has its own project FK model
```

---

## 4. Migration Steps (066)

| Step | Action | Table(s) affected | Risk |
|---|---|---|---|
| 1 | Drop + re-add FK | `proposal` | Low — no data orphans |
| 2 | Drop + re-add FK | `squad_dispatch` | Low — no data orphans |
| 3 | Add FK NOT VALID | `provider_registry` | Low — deferred validate |
| 4a-d | Add + backfill + NOT NULL | `gate_decision_log` | Medium — 229 rows, all have proposals |
| 4e | Add FK | `gate_decision_log` | Low |
| 4f | Rebuild VIEW | `roadmap.gate_decision_log` | Low |
| 4g | Add project_id | `run_log`, `context_window_log` | None — 0 rows |
| 5a | Backfill provider_registry | 6 grandfathered agencies → project_id=1 | Low |
| 5b | Validate FK | `provider_registry` | Low |
| 6 | Replace function | `fn_claim_work_offer` | Medium — tested below |
| 7 | Validation DO block | all modified tables | Rollback-safe |

---

## 5. Owner Assignment

| Component | Owner | Notes |
|---|---|---|
| `roadmap_proposal.*` | backend-core | proposals, gate_decision_log |
| `roadmap_workforce.*` | dispatch-team | squad_dispatch, provider_registry, fn_claim_work_offer |
| `roadmap_efficiency.*` | observability | context_window_log, budget tables |
| `roadmap.run_log` | observability | |
| `roadmap.project` (canonical registry) | platform | single source of truth for project_id FK target |

---

## 6. Rollback

The migration runs in a single `BEGIN/COMMIT` block. Any assertion failure in the Step 7 `DO $$` block rolls back the entire transaction. No partial state is left.

To manually roll back after commit:

```sql
-- Reverse Step 1
ALTER TABLE roadmap_proposal.proposal
  DROP CONSTRAINT proposal_project_id_fkey;
ALTER TABLE roadmap_proposal.proposal
  ADD CONSTRAINT proposal_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES roadmap_workforce.projects(id);

-- Reverse Step 2
ALTER TABLE roadmap_workforce.squad_dispatch
  DROP CONSTRAINT squad_dispatch_project_id_fkey;
ALTER TABLE roadmap_workforce.squad_dispatch
  ADD CONSTRAINT squad_dispatch_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES roadmap_workforce.projects(id);
```

(Steps 4-6 are append-only to empty columns + new rows; removing them is safe at any time.)
