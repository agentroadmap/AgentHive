# P244 — transition_queue Collapse: Implicit Maturity Gating Implementation

> **Related:** P240 design spec — `docs/architecture/implicit-maturity-gating.md`
> **Supersedes:** P224 (lease-gated transition_queue model)

## Problem

The original gate model (P224) created a `transition_queue` row whenever a proposal needed to advance. This introduced a **parallel lifecycle**: both `proposal.status` and `transition_queue.status` had to stay in sync. P239-class bugs occurred when a queue row reached `completed` while the proposal was still in the wrong state, or when crashed workers left ghost rows that blocked the gate indefinitely.

## What P244 Changed

### Before (P224 model)

```
proposal.maturity = 'mature'
        │
        ▼
transition_queue row inserted (status='pending')
        │
   claimed_by agent holds queue row
        │
        ▼
queue row status='completed' → proposal.status updated
```

Gate truth lived in **two places**: the proposal row and the queue row. Divergence = false completion.

### After (P244 / P240 model)

```
proposal.maturity = 'mature'   ← sole gate-ready signal
        │
        ▼
v_mature_queue surfaces the proposal (view, not queue table)
        │
   gate scanner acquires proposal_lease atomically (FOR UPDATE SKIP LOCKED)
        │
        ▼
gate agent calls transitionProposal(reason='decision', notes=…)
proposal.status advances, proposal.maturity resets to 'new'
```

Gate truth lives in **one place**: `proposal.maturity + proposal.status`.

## Code Delta

### Gate Scanner (`src/core/proposal/gate-scanner-v2.ts`)

Reads from `roadmap_proposal.v_mature_queue` (derived view, not `transition_queue`). Uses `FOR UPDATE SKIP LOCKED` on `proposal_lease` rows to guarantee single-flight dispatch. No queue row is created; the dispatch lease IS the work token.

### Proposal Storage (`src/infra/postgres/proposal-storage-v2.ts`)

`transitionProposal()` enforces a gate guard on the four canonical gate transitions (D1–D4):

```
DRAFT→REVIEW, REVIEW→DEVELOP, DEVELOP→MERGE, MERGE→COMPLETE
```

These require `reason='decision'` and a non-empty `notes` string. Direct status writes without a decision record are rejected at the application layer, replacing the queue-row-as-proof pattern.

### pg_notify Events (`src/apps/dashboard-web/websocket-server.ts`)

The `transition_queued` channel was retired (P753). The dashboard and websocket server now listen to:

| Channel | Trigger |
| --- | --- |
| `proposal_maturity_changed` | `proposal.maturity` updated by any agent |
| `proposal_gate_ready` | maturity reached `mature` in a gateable state |
| `proposal_state_changed` | `proposal.status` advanced by a gate decision |

These three channels cover all gate lifecycle events without requiring a queue row.

### Dead Code Removed

| File / Pattern | Retired by |
| --- | --- |
| PipelineCron / gate-pipeline service | P754 A7 |
| transition_queue reaper (stale processing rows) | P753 |
| `transition_queued` pg_notify listener | P753 |
| Reading `queue.status === 'done'` as workflow truth | P244 |

## Database State

`transition_queue` is **not dropped** at P244 completion. It is preserved as a read-only operational log per the P244 migration plan:

- **P244 migration:** backfills existing `transition_queue` rows as audit history (already-released gate decisions).
- **v5:** table is eligible for DROP once the operational log retention window passes.

The `gate_lease` table described in the P244 DDL sketch maps directly to `proposal_lease` in the live schema. `proposal_lease` carries both work leases (agent claiming a proposal) and the gate dispatch lock that the scanner creates atomically. A separate `gate_lease` table was not materialized; the unified lease table is sufficient.

## Invariants After P244

These are in addition to the invariants stated in `implicit-maturity-gating.md`:

1. **No new `transition_queue` rows** are created by the orchestrator or gate scanner.
2. **Gate transitions require an explicit decision record** (`reason='decision'`, non-empty notes). The application layer rejects silent status writes for D1–D4.
3. **Gate scanning is single-flight**: `FOR UPDATE SKIP LOCKED` on `proposal_lease` prevents two orchestrator instances from dispatching the same gate.
4. **`transition_queue` is never read as workflow truth** — all such reads were deleted or converted to comments.

## Acceptance Criteria Status

| AC | Description | Status |
| --- | --- | --- |
| AC-1 | `proposal.maturity='mature'` is the only gate-ready signal | ✓ via `v_mature_queue` |
| AC-2 | Gate scanner reads from view, not queue table | ✓ `gate-scanner-v2.ts` |
| AC-3 | Gate transitions require `reason='decision'` + notes | ✓ `transitionProposal()` guard |
| AC-4 | No new `transition_queue` rows from lifecycle code | ✓ P753/P754 decommission |
| AC-5 | `transition_queued` pg_notify retired | ✓ `websocket-server.ts` |
| AC-6 | Historical `transition_queue` preserved as audit log | ✓ migration backfill |
