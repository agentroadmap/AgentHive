# P396: Workforce & State Machine Visualization — Ship Report

**Proposal:** P396  
**Title:** Workforce & State Machine Visualization  
**Status:** COMPLETE  
**Ship Date:** 2026-05-09  
**Verified By:** ccs46ant-bot-docum-a (documenter)

---

## 1. Summary

P396 targets a real-time agency operational health dashboard — card-based visualization of
agency status, silence metrics, liaison protocol health, and open assistance requests. The
design specifies three database observability views (migration 068-p469), a React frontend
component (AgenciesPage.tsx), REST API routes, and a `tests/agency/` fixture suite covering
the full agency state machine lifecycle.

This report documents the current state of each deliverable as of 2026-05-09.

---

## 2. Distinction from P248

P248 (still DRAFT) renders proposal workflow stages as a database-driven Kanban board with
dwell-time analytics using React Flow + dagre directed-graph layout. P396 renders agency
**operational health** as a card list — a fundamentally different subject, data shape, and
rendering approach. No graph logic is shared between the two proposals. This distinction
holds and is architecturally sound.

---

## 3. Acceptance Criteria Verification

### 3.1 Database Observability Layer

The design references **migration 068-p469** creating three `CREATE OR REPLACE VIEW` objects
in the `roadmap` schema:

| View | Description |
|:-----|:------------|
| `roadmap.v_agency_dashboard` | Operational metrics: silence, in-flight claims, open assistance |
| `roadmap.v_liaison_protocol_health` | Protocol health: unacked, rejects, ping RTT, sequence |
| `roadmap.v_assistance_open` | Per-request open assistance list with age_minutes |

**Status: PARTIAL — Views exist in DB, migration file absent from repo.**

The file `scripts/migrations/068-p469-*.sql` does **not** exist in the repository.
The three views do exist as live objects in the `agenthive` database (confirmed in
`docs/hiveCentral/db-object-prune-review-2026-05-02.md`), but they were flagged as
**"Likely Safe Prune Candidates"** because:
- No code references found at time of review
- Superseded by explicit agency/session views in hiveCentral and current MCP handlers
- `assistance_request` table is empty and not part of the current hiveCentral roadmap

The migration source file gap means rollback procedure (`DROP VIEW IF EXISTS …`) cannot be
audited from repo history, and idempotency cannot be verified.

### 3.2 Frontend — AgenciesPage.tsx

**Status: NOT DELIVERED**

`src/apps/dashboard-web/components/AgenciesPage.tsx` was not created.
In `src/apps/dashboard-web/App.tsx` (lines 10, 255–259) the import and route are
commented out with `// TODO: Component not yet created`.

The following frontend requirements from the design remain unimplemented:
- React card list with status badges and alert detection
- Operator action buttons (pause / resume / drain / retire)
- 10-second polling against `/api/agencies`

### 3.3 Backend API Routes

**Status: NOT DELIVERED**

`src/apps/server/index.ts` has no `/api/agencies` routes. Neither `GET /api/agencies`
nor `POST /api/agencies/:id/:action` are present.

### 3.4 State Machine Lifecycle Fixtures — tests/agency/

**Status: PARTIAL — P594 suite present; liaison-message.test.ts absent**

The `tests/agency/` directory contains 10 test files, all scoped to **P594** (agency schema):

| File | Covers | P396 AC Mapping |
|:-----|:-------|:----------------|
| `schema.test.ts` | RLS, DELETE revoke, silence_seconds, advisory lock | AC-4, AC-15 |
| `functions.test.ts` | SECURITY DEFINER, dormancy sweep, restart-loop guard, claim/release atomicity | AC-2, AC-5, AC-7, AC-16 |
| `catalog.test.ts` | liaison_message_kind_catalog — 21 kinds, protocol_resync | AC-18, AC-19 |
| `migration.test.ts` | Idempotent migration, session seed, host seed, capacity seed | AC-8, AC-12, AC-13, AC-14 |
| `worktree-policy.test.ts` | Worktree isolation policy | — |
| `dr-reconcile.test.ts` | Disaster-recovery reconcile | — |
| `directive-proposal.test.ts` | Directive/proposal linkage | — |
| `backward-compat.test.ts` | Backward compatibility | — |
| `dispatch-identity.test.ts` | Dispatch identity resolution | — |
| `route-preflight.test.ts` | Route preflight checks | — |

**Missing:** `tests/agency/liaison-message.test.ts` — specified in the design's verification
plan — does **not** exist in the repository.

The design's test invocation:

```
node --test tests/agency/schema.test.ts tests/agency/functions.test.ts \
     tests/agency/catalog.test.ts tests/agency/liaison-message.test.ts \
     tests/agency/migration.test.ts
```

Cannot run as written: `liaison-message.test.ts` is absent.

---

## 4. Key Files

| File | Status | Note |
|:-----|:-------|:-----|
| `scripts/migrations/068-p469-*.sql` | ABSENT | Views exist in DB without a versioned migration file |
| `src/apps/dashboard-web/components/AgenciesPage.tsx` | ABSENT | Commented TODO in App.tsx |
| `src/apps/server/index.ts` (agencies routes) | ABSENT | No `/api/agencies` endpoint added |
| `tests/agency/liaison-message.test.ts` | ABSENT | Specified in design verification plan |
| `tests/agency/schema.test.ts` | PRESENT | P594 AC-3, AC-4, AC-9, AC-10, AC-11 |
| `tests/agency/functions.test.ts` | PRESENT | P594 AC-2, AC-5, AC-7, AC-15, AC-16 |
| `tests/agency/catalog.test.ts` | PRESENT | P594 AC-18, AC-19 |
| `tests/agency/migration.test.ts` | PRESENT | P594 AC-8, AC-12, AC-13, AC-14, AC-17 |

---

## 5. Gap Inventory

| Gap | Severity | Description |
|:----|:---------|:------------|
| Migration 068-p469 absent from repo | High | Three views have no versioned migration file; rollback is manual DROP only |
| AgenciesPage.tsx not created | High | Dashboard frontend for agency health is entirely unimplemented |
| /api/agencies routes absent | High | No HTTP surface for frontend to poll |
| liaison-message.test.ts missing | Medium | Design's verification plan cannot execute as specified |
| Views flagged as prune candidates | Medium | The views may be removed in a future prune proposal, which would break the design intent |

---

## 6. What the P594 Test Suite Covers (State Machine Fixtures)

The existing `tests/agency/` suite does cover agency lifecycle events as mapped in the
P396 design, through P594's acceptance criteria:

| Lifecycle Event | Design Requirement | Coverage in P594 Suite |
|:----------------|:-------------------|:----------------------|
| Spawn | bootstrapNamespace + seedMinimalAgency | `functions.test.ts` before() block |
| Claim | claim_capacity SECURITY DEFINER (AC-2); is_dispatchable (AC-15) | `functions.test.ts` |
| Suspend | session_heartbeat no-op for paused sessions (AC-7) | `functions.test.ts` |
| Cancel | DELETE revoked from PUBLIC on lifecycle tables (AC-4) | `schema.test.ts` |
| Retry | mark_reconnecting → reconnect_grace_until → dormancy sweep | `functions.test.ts` AC-5 |
| Complete | release_capacity floors at 0, no underflow (AC-16) | `functions.test.ts` |
| Orphan cleanup | Dormancy sweep marks stale sessions dormant after 60 s (AC-5) | `functions.test.ts` |

All tests skip gracefully when `PGPASSWORD` is not set, allowing CI runs without DB credentials.

---

## 7. API Smoke Test Status

The design specifies:

> GET /api/agencies returns JSON array; POST /api/agencies/:id/pause+resume round-trips status.

**Cannot verify.** The routes do not exist in `src/apps/server/index.ts`.

---

## 8. Rollback Position

The design states: rollback = `DROP VIEW IF EXISTS roadmap.v_agency_dashboard, roadmap.v_liaison_protocol_health, roadmap.v_assistance_open;` — zero data loss.

This rollback is still valid, but the migration file to roll back does not exist in the
repo. The views are already identified as prune candidates and can be dropped through the
standard prune proposal workflow (no emergency action needed).

---

## 9. Conclusion

P396 is **PARTIALLY DELIVERED**. The agency state machine test infrastructure (10 files
from P594) and the underlying DB schema it tests are solid and production-grade. The three
observability views exist in the database.

The **visualization layer** — the entire reason for P396 — was not built:
- No AgenciesPage.tsx component
- No /api/agencies REST surface
- No liaison-message test file
- No versioned migration file for the views

The P594 test suite provides strong coverage of the agency *schema*, but the dashboard
*visualization* of that schema remains unimplemented. A follow-on proposal should be opened
to deliver the frontend card list, backend API routes, and the missing liaison-message test.

---

*Generated by ccs46ant-bot-docum-a (documenter) for P396 COMPLETE phase — 2026-05-09.*
