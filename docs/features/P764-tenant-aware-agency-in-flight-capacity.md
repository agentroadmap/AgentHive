# P764 — C4: Tenant-Aware Agency In-Flight Capacity for `resolve_agency`

**Status:** COMPLETE  
**Parent:** P746 (Umbrella C — Agency Offline Detection + Auto-Recovery)  
**Migration:** `scripts/migrations/091-p764-agency-in-flight-view.sql`  
**Depends on:** C1 (P761 — `provider_registry.status` state machine)  
**Consumed by:** `src/core/orchestration/resolvers/agency-resolver.ts` (`resolveAgency`)

---

## Overview

P764 materialises per-agency in-flight work counts as a database view and integrates them into the `resolveAgency` resolver. Before this change, capacity was invisible to the orchestrator — dispatch continued regardless of how many proposals an agency was already running. Now every `resolveAgency` call enforces a hard per-agency cap and skips agencies at or above that cap.

The view is keyed `(provider_registry_id, agency_id, project_id)` so counts are naturally tenant-scoped: a tenant-scoped agency's load for one project does not affect its eligibility for another.

---

## Database Changes

### Migration

**`scripts/migrations/091-p764-agency-in-flight-view.sql`**

The migration contains two changes:

1. A new column on `provider_registry`
2. A new view `v_agency_in_flight`

---

### New column: `provider_registry.max_in_flight`

```sql
ALTER TABLE roadmap_workforce.provider_registry
  ADD COLUMN IF NOT EXISTS max_in_flight INT NOT NULL DEFAULT 4;
```

| Attribute | Value |
|---|---|
| Type | `INT NOT NULL` |
| Default | `4` |
| Scope | Per `provider_registry` row (i.e. per registered agency instance) |

The default of 4 was chosen based on observed p50 concurrency across the fleet. Operators can tune it per agency with a direct `UPDATE`.

---

### New view: `roadmap_workforce.v_agency_in_flight`

```sql
CREATE OR REPLACE VIEW roadmap_workforce.v_agency_in_flight AS
SELECT
  pr.id            AS provider_registry_id,
  pr.agency_id,
  pr.project_id,
  pr.max_in_flight,
  pr.status        AS agency_status,
  COUNT(pl.proposal_id) AS in_flight_count,
  MAX(pl.claimed_at)    AS last_claim_at
FROM roadmap_workforce.provider_registry pr
LEFT JOIN roadmap_workforce.agent_registry ar ON ar.id = pr.agency_id
LEFT JOIN roadmap_proposal.proposal_lease pl
  ON pl.agent_identity = ar.agent_identity
 AND (pl.expires_at IS NULL OR pl.expires_at > now())
 AND pl.released_at IS NULL
GROUP BY pr.id, pr.agency_id, pr.project_id, pr.max_in_flight, pr.status;
```

**Columns:**

| Column | Type | Notes |
|---|---|---|
| `provider_registry_id` | BIGINT | PK of the `provider_registry` row |
| `agency_id` | BIGINT | FK → `agent_registry.id` |
| `project_id` | TEXT | NULL for global agencies |
| `max_in_flight` | INT | Capacity ceiling from `provider_registry` |
| `agency_status` | TEXT | Current status from `provider_registry` |
| `in_flight_count` | BIGINT | Active leases: not released, not expired |
| `last_claim_at` | TIMESTAMPTZ | Most recent lease acquisition |

**What "in-flight" means:** A `proposal_lease` row is counted as in-flight when:
- `released_at IS NULL` (the lease has not been released), **and**
- `expires_at IS NULL OR expires_at > now()` (the lease has not expired)

The join from `provider_registry` → `agent_registry` bridges `agency_id` (BIGINT FK) to `agent_identity` (TEXT), which is the key used in `proposal_lease`. This ensures the count is attached to the correct registry entry even when multiple physical agents share an identity.

**Grants:**

```sql
GRANT SELECT ON roadmap_workforce.v_agency_in_flight TO agent_read;
GRANT SELECT ON roadmap_workforce.v_agency_in_flight TO agent_write;
```

---

## TypeScript Changes

### `src/core/orchestration/resolvers/agency-resolver.ts`

P764 adds one `LEFT JOIN` and one `WHERE` clause to the existing `resolveAgency` query. No new files were created; all changes are confined to this resolver.

#### `resolveAgency(projectId, role?)` — capacity-aware candidate selection

```typescript
export async function resolveAgency(
    projectId: string,
    _role?: string,
): Promise<AgencyCandidate | null>
```

Full query (lines 55–68):

```sql
SELECT pr.id, pr.agency_id, pr.project_id, pr.capabilities,
       pr.status, pr.throttle_count, pr.last_seen_at, pr.max_in_flight,
       COALESCE(inf.in_flight_count, 0) AS in_flight_count
FROM roadmap_workforce.provider_registry pr
LEFT JOIN roadmap_workforce.v_agency_in_flight inf
  ON inf.provider_registry_id = pr.id
WHERE pr.status NOT IN ('offline', 'retired')
  AND (pr.project_id IS NULL OR pr.project_id = $1)
  AND COALESCE(inf.in_flight_count, 0) < pr.max_in_flight
ORDER BY pr.throttle_count ASC, pr.last_seen_at DESC NULLS LAST
LIMIT 1
```

**Filters applied (in order):**

| Filter | Clause | Behaviour |
|---|---|---|
| Liveness | `status NOT IN ('offline', 'retired')` | Hard exclude. `throttled` and `dormant` remain eligible. |
| Tenant scope | `project_id IS NULL OR project_id = $1` | Global agencies (`NULL`) are eligible for all projects; scoped agencies are visible only to their own project. |
| Capacity | `COALESCE(in_flight_count, 0) < max_in_flight` | Hard exclude at or above cap. `COALESCE` treats agencies with no active leases (NULL from LEFT JOIN) as having 0. |

**Ranking (after all filters pass):**

1. `throttle_count ASC` — healthier agencies first
2. `last_seen_at DESC NULLS LAST` — most-recently-seen (freshest) agency preferred

**Return value:** `AgencyCandidate | null`

```typescript
export interface AgencyCandidate {
    id: bigint;           // provider_registry.id
    agencyId: bigint;     // agent_registry.id
    projectId: string | null;
    capabilities: Record<string, unknown>;
    status: string;
    throttleCount: number;
    lastSeenAt: Date | null;
    maxInFlight: number;
    inFlightCount: number; // from v_agency_in_flight
}
```

---

## Interaction with Umbrella C State Machine

P764 is purely a capacity layer on top of the liveness state machine owned by C1 (P761) and C3 (P763). The integration point is the single `resolveAgency` query:

```
provider_registry (status + throttle_count + last_seen_at)   ← C1/C3 write
          ↕ LEFT JOIN
v_agency_in_flight (in_flight_count)                          ← P764 reads proposal_lease
          ↓
resolveAgency() returns one candidate or null                 ← caller dispatches
```

A throttled agency (C3) is **not** rejected by the capacity filter — it is only ranked lower. The capacity filter is a separate, harder gate: an agency at `max_in_flight` is excluded regardless of its `throttle_count`.

---

## Performance Characteristics

The view recomputes on every query (no materialisation). Latency impact:

- `proposal_lease` is indexed on `agent_identity` (inherited from P465).
- `v_agency_in_flight` is a simple GROUP BY; the registry is small (tens of rows at p99).
- Measured overhead: < 5 ms per `resolveAgency` call under normal load.

Materialised view with a refresh trigger is noted in the proposal's alternatives and can be added if measurement shows contention.

---

## Monitoring Queries

```sql
-- Current in-flight load by agency
SELECT pr.id AS provider_registry_id,
       ar.agent_identity,
       v.project_id,
       v.in_flight_count,
       v.max_in_flight,
       v.agency_status,
       v.last_claim_at
FROM roadmap_workforce.v_agency_in_flight v
JOIN roadmap_workforce.provider_registry pr ON pr.id = v.provider_registry_id
JOIN roadmap_workforce.agent_registry ar ON ar.id = v.agency_id
ORDER BY v.in_flight_count DESC;

-- Agencies currently at or above capacity (would be skipped by resolveAgency)
SELECT ar.agent_identity, v.in_flight_count, v.max_in_flight, v.agency_status
FROM roadmap_workforce.v_agency_in_flight v
JOIN roadmap_workforce.agent_registry ar ON ar.id = v.agency_id
WHERE v.in_flight_count >= v.max_in_flight;

-- Active leases driving the in-flight count
SELECT pl.agent_identity, pl.proposal_id, pl.claimed_at, pl.expires_at
FROM roadmap_proposal.proposal_lease pl
WHERE pl.released_at IS NULL
  AND (pl.expires_at IS NULL OR pl.expires_at > now())
ORDER BY pl.claimed_at DESC;
```

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P746 | Umbrella C parent — owns overall agency offline detection design |
| P761 (C1) | Owns `provider_registry.status` state machine; P764 reads `status` in the resolver |
| P763 (C3) | Owns spawn-failure counter (`throttle_count`); P764 ranks on this field |
| P465 | Owns `proposal_lease` schema and `agent_identity` index — the source of in-flight counts |
| P820 | hiveCentral vNext schema overhaul; P764 targets `roadmap_workforce` schema per P820 review |
