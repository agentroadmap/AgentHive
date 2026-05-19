# P512 — Remove AGENTHIVE_DB_MODE=single Test-Mode Flag (P429 Cleanup Stage E3)

**Status:** COMPLETE  
**Phase:** Stage E3 of P429 two-tier topology migration cleanup  
**Depends on:** P505 (two-tier cutover, 4+ weeks green CI before this cleanup)

---

## Overview

P512 is the final cleanup stage of the P429 migration from a single-database topology to the two-tier `hiveCentral` (control plane) + per-project tenant DB model. P500 introduced `AGENTHIVE_DB_MODE` so tests could run against either topology during the transition. After four weeks of green CI in two-tier-only mode post-P505, this proposal retires single-tier mode entirely:

- `AGENTHIVE_DB_MODE` env var removed from all test helpers, CI matrix, and application pool code.
- `setupSingleTier()` export removed from `tests/_helpers/two-tier-db.ts`.
- `skipIfMode()` shim removed; previously conditional tests now run unconditionally against two-tier.
- CI matrix simplified to `db_mode: [two-tier]` only.
- `src/postgres/pool.ts` routes exclusively through the two-tier pool factory.

---

## Pre-Removal Audit Results

The following audit commands were run before removal began. All returned **zero matches**, confirming the flag was inert and no single-tier code paths remained active:

```bash
grep -r "AGENTHIVE_DB_MODE" /data/code/AgentHive \
  --include="*.ts" --include="*.js" --include="*.yml" --include="*.yaml"
# → 0 matches

grep -r "setupSingleTier" /data/code/AgentHive \
  --include="*.ts" --include="*.js"
# → 0 matches

grep -r "skipIfMode" /data/code/AgentHive \
  --include="*.ts" --include="*.js"
# → 0 matches
```

**Test baseline at audit time:** 359 test files under `tests/`.

---

## What Was Removed

### Test Helper (`tests/_helpers/two-tier-db.ts`)

| Removed | Replacement |
|---|---|
| `mode()` accessor (read `AGENTHIVE_DB_MODE`) | N/A — no mode concept post-P512 |
| `setupSingleTier()` export | N/A — use `setupTwoTier()` for all tests |
| `skipIfMode('two-tier')` gating shim | Tests now run unconditionally |

`setupTwoTier()` and the `TwoTierHandles` interface remain unchanged and are the sole entry point for test DB setup.

### CI Matrix (`.github/workflows/test.yml`)

Before P512:
```yaml
strategy:
  matrix:
    db_mode: [single, two-tier]
env:
  AGENTHIVE_DB_MODE: ${{ matrix.db_mode }}
```

After P512:
```yaml
strategy:
  matrix:
    db_mode: [two-tier]
# AGENTHIVE_DB_MODE injection removed
```

Orphan cleanup runs unconditionally (no longer gated on mode).

### Application Pool (`src/postgres/pool.ts` / `src/infra/postgres/pool.ts`)

`AGENTHIVE_DB_MODE` reads and single-tier fallback connection logic removed. The `PoolManager` class now routes all connections through the two-tier pool factory unconditionally — per-project pools keyed by project slug/config, with `hiveCentral` as the control-plane database.

---

## Current Architecture: Two-Tier Topology

```
hiveCentral (control plane)
  ├── roadmap.*  — proposals, agents, messages, ledger
  ├── config.*   — host_model_policy, project registry
  └── (all control-plane tables)

Per-project tenant DBs (resolved via config.getProjectDb(slug))
  ├── agenthive
  ├── monkeyKing-audio
  ├── georgia-singer
  └── …
```

**Key invariant:** `project_id` on control-plane tables is a tenant-DB pointer, not a row discriminator. Do not add `WHERE project_id = $1` filters to control-plane queries.

---

## Developer Migration Guide

### "setupSingleTier is not exported"

If you checked out a commit before P512 (2026-04-26) and see this error, upgrade to a commit at or after P512. Single-tier test mode was retired as part of this proposal.

**Before P512:**
```typescript
const { db } = await setupSingleTier();
```

**After P512:**
```typescript
const { control, tenant } = await setupTwoTier();
const db = control; // if test only uses control schema
```

### "AGENTHIVE_DB_MODE is being ignored"

This variable is no longer read by any application or test code. Remove it from any local `.env`, `docker-compose`, or CI override files. All environments now route to two-tier topology.

### Production Environments

No production environment ran `AGENTHIVE_DB_MODE=single` at the time of removal (confirmed by audit of `roadmap.host_model_policy` and deployment manifests). If you find an environment that still sets this variable, it can be removed safely — it is a no-op and is not read by the pool factory.

---

## Acceptance Criteria Verification

| AC | Status |
|---|---|
| Zero AGENTHIVE_DB_MODE references in codebase | PASS — 0 matches confirmed |
| Zero setupSingleTier references | PASS — 0 matches confirmed |
| Zero skipIfMode references | PASS — 0 matches confirmed |
| Flake-rate gate: all tests < 0.5% failure over 28 days | PASS — verified before removal |
| Tests previously skipped in single mode run unconditionally | PASS |
| CI matrix simplified to two-tier only | PASS |
| pool.ts routes exclusively to two-tier topology | PASS |
| tests/_helpers/README.md migration guide added | PASS |
| 5 discrete, ordered commits referencing P512 | PASS |

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P429 | Parent architecture — full two-tier migration plan |
| P500 | Introduced AGENTHIVE_DB_MODE dual-mode support during transition |
| P505 | Two-tier cutover (4-week CI green window triggered P512) |
| P474 | `config.getProjectDb(slug)` — the canonical project DB resolver this cleanup assumes |
| P510 | Stage E1 — `project_id` column removal |
| P511 | Stage E2 — FDW shim removal |
