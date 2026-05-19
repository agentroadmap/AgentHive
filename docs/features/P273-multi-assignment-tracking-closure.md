# P273 Closure Note — Multi-Assignment Tracking for Agents

**Status:** COMPLETE (absorbed — no schema shipped)
**Date:** 2026-05-09
**Proposal:** P273 — Multi-assignment tracking for agents on multiple proposals
**Absorbed by:** P433 (Dispatch and Agency Hardening) under parent P429

---

## What Was Proposed

A new table `roadmap_workforce.agent_active_assignment` with columns `(agent_identity, proposal_id, cubic_id, started_at)` and PRIMARY KEY `(agent_identity, proposal_id)`. Views `v_capable_agents` and `v_proposal_activity` were to be updated to read from it, with backfill from a `proposal_lease` snapshot.

## Why It Was Rejected (18 gate cycles)

SKEPTIC-ALPHA live-verified on 2026-04-21 that `hermes/agency-xiaomi` held **10 simultaneous active leases** (P231, P228, P273, P236, P180, P296, P241, P276, P303, P210). Multi-assignment was already working in production.

The gate review identified four compounding problems:

| Issue | Detail |
|-------|--------|
| **Pure duplication** | `agent_active_assignment` is a strict subset of `proposal_lease`. The lease table already carries `(agent_identity, proposal_id)` with UNIQUE on `(proposal_id, released_at)` — released rows are NULLed, so active leases are deduped naturally. |
| **No cubic semantics** | `cubic_id` was added to the design but had no FK, no definition, and no migration SQL to back it. |
| **Self-contradiction** | The summary, design, and alternatives sections each described an incompatible position. RFC text never converged across cycles. |
| **Real gap was a write bug** | The actual missing piece was that `agent_health` rows for `hermes/agency-xiaomi` were not being written — a bug in the health-write path, not a schema gap requiring a new table. |

## How It Was Resolved

P273 was absorbed into **P433 — Dispatch and Agency Hardening** (parent: P429), which codified the stable agency / ephemeral worker model:

- **Agencies** are stable, long-lived identities (one row in `roadmap.agency`).
- **Workers** are ephemeral, created per-dispatch with a FK to `dispatch_id` and `agency_id`.
- Workers *are* the multi-assignment carrier: one agency can have many concurrent workers, each tied to a distinct dispatch.
- `proposal_lease` remains the per-`(agent, proposal)` tracker for leasing semantics.
- No separate `agent_active_assignment` table is needed or desired.

## Canonical Query Patterns

### Active leases for an agent identity

```sql
SELECT proposal_id, leased_at
FROM   roadmap.proposal_lease
WHERE  agent_identity = 'hermes/agency-xiaomi'
  AND  released_at IS NULL
ORDER  BY leased_at DESC;
```

### Active workers for an agency

```sql
SELECT w.id, w.dispatch_id, sd.proposal_id, sd.dispatch_role
FROM   roadmap.worker w
JOIN   roadmap.squad_dispatch sd ON sd.id = w.dispatch_id
WHERE  w.agency_id = <agency_id>
  AND  sd.dispatch_status IN ('assigned', 'active');
```

### Reverse lookup: proposals currently held by any agent

`v_proposal_activity` already LEFT JOINs `proposal_lease` — no new view needed.

## What NOT to Build

- Do **not** create `roadmap_workforce.agent_active_assignment` or any table that duplicates `proposal_lease` columns.
- Do **not** add a `current_proposal` column to `agent_registry` — it cannot represent the multi-lease reality.
- Do **not** back-solve multi-assignment with a snapshot backfill; the live lease table already reflects the true state.

## Follow-ups

| # | Item | Owner |
|---|------|-------|
| 1 | `agent_health` write bug for long-running agencies (hermes/agency-xiaomi row missing) | P433 / agency hardening |
| 2 | `cubic_id` linkage on `proposal_lease` if needed | File new proposal after P433 defines cubic lifecycle |
| 3 | `v_proposal_activity` correctness audit against new worker/agency model | P433 |
