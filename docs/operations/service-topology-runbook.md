# Service Topology Runbook — P441

**Schema:** `control_runtime` (migration 071-p441-service-topology-ownership.sql)  
**Module:** `src/core/governance/service-topology.ts`

---

## Ownership Matrix

| Responsibility | Primary Writer | Passive Observers |
|---|---|---|
| state_machine_transition | orchestrator | mcp-server, state-feed-listener |
| maturity_sync | orchestrator | (none) |
| workflow_spawn | orchestrator | (none) |
| service_lease_management | orchestrator | (none) |
| gate_evaluation | orchestrator | (none — gate-pipeline decommissioned per P754) |
| work_offer_claim | orchestrator (via OfferClaimLoop + OrchestratorOfferDispatcher) | mcp-server |
| subprocess_spawn | agency-liaison (agenthive-liaison@.service) | orchestrator (observes via liaison_message uplinks) |
| proposal_crud | mcp-server | (none) |
| feed_event_publication | state-feed-listener | (none) |

---

## Enforcement Boundary

DB triggers (`fn_enforce_service_ownership`) fire on governed tables. Enforcement is **opt-in via session variable**:

```sql
-- Enforce: triggers validate that this service holds an active lease
SET LOCAL app.service_id = 'orchestrator';

-- Bypass (backward compat): triggers pass through — for services not yet updated
-- (unset or empty string)
```

Set `app.service_id` **after** bootstrapping your initial lease. Clear it on connection return.

---

## Bootstrap Sequence (First Run / Service Restart)

1. Register the service (no trigger enforcement because `app.service_id` is not set yet):

```sql
INSERT INTO control_runtime.service_registry (service_id, service_type, host, pid)
VALUES ('orchestrator', 'orchestrator', 'bot', pg_backend_pid())
ON CONFLICT (service_id) DO UPDATE
  SET last_heartbeat = now(), pid = EXCLUDED.pid;
```

2. Acquire the `service_lease_management` lease (backward-compat pass-through applies):

```sql
INSERT INTO control_runtime.service_lease (service_id, responsibility, expires_at)
VALUES ('orchestrator', 'service_lease_management', now() + interval '5 minutes')
RETURNING lease_id;
```

3. Set session context and acquire additional leases:

```sql
SET LOCAL app.service_id = 'orchestrator';
-- Subsequent INSERTs into service_lease now require the above lease to be active
```

---

## Drain a Service

1. Stop new work from being dispatched to the service (operator action).
2. Wait for in-flight work to complete (monitor via `control_runtime.service_registry.last_heartbeat`).
3. Release all leases explicitly:

```sql
UPDATE control_runtime.service_lease
SET released_at = now(), release_reason = 'drain'
WHERE service_id = 'orchestrator'
  AND released_at IS NULL;
```

Or via the TypeScript module:

```typescript
import { releaseAllLeases } from 'src/core/governance/service-topology.ts';
await releaseAllLeases(queryFn, 'orchestrator', 'drain');
```

4. Remove the service registration:

```sql
DELETE FROM control_runtime.service_registry WHERE service_id = 'orchestrator';
```

---

## Restart a Service

1. Drain as above (or let leases expire — default TTL is 300 s).
2. Re-run the bootstrap sequence.
3. Service will re-register and re-acquire leases.

---

## Replace a Service (Primary Owner Transfer)

Used when handing off a responsibility to a new service type.

1. Drain the old service.
2. Register the new service in `service_registry`.
3. Insert the new ownership record:

```sql
INSERT INTO control_runtime.service_responsibility (service_id, responsibility, mode)
VALUES ('new-orchestrator', 'state_machine_transition', 'primary');
-- The UNIQUE partial index will reject this if the old primary is still registered.
-- Remove or update the old row first.
```

4. New service bootstraps and acquires its leases.

---

## Lease TTL and Expiry

- Default TTL: 300 s (5 min) — configured in `acquireLease(queryFn, serviceId, resp, ttlSeconds)`.
- Leases must be renewed before expiry via `renewLease()`.
- A heartbeat interval of ≤150 s ensures renewal happens before the midpoint of TTL.
- Expired leases are not deleted — they remain in `service_lease` as audit history (`released_at IS NULL AND expires_at < now()`).

### Monitoring query — expired leases still active

```sql
SELECT *
FROM control_runtime.service_lease
WHERE released_at IS NULL
  AND expires_at < now();
```

If rows appear here, the service may be crashed or network-partitioned. Force release:

```sql
UPDATE control_runtime.service_lease
SET released_at = now(), release_reason = 'force_release_expired'
WHERE released_at IS NULL AND expires_at < now();
```

---

## Trigger Enforcement Migration Boundary

Triggers fire on:

| Table | Trigger | Responsibility |
|---|---|---|
| roadmap.proposal | `trg_svc_own_proposal_status` (BEFORE UPDATE OF status) | state_machine_transition |
| roadmap.proposal | `trg_svc_own_proposal_maturity` (BEFORE UPDATE OF maturity) | maturity_sync |
| roadmap.transition_queue | `trg_svc_own_transition_queue` (BEFORE INSERT) | state_machine_transition |
| roadmap.decision_queue | `trg_svc_own_decision_queue` (BEFORE INSERT OR UPDATE) | gate_evaluation |
| roadmap_workforce.squad_dispatch | `trg_svc_own_squad_dispatch` (BEFORE INSERT OR UPDATE) | work_offer_claim |
| control_runtime.service_lease | `trg_svc_own_service_lease` (BEFORE INSERT OR UPDATE) | service_lease_management |

Services that do **not** set `app.service_id` bypass all enforcement. This is intentional for the migration transition period — update services incrementally.

---

## Rollback Procedure

To disable enforcement without dropping the schema:

```sql
-- Drop all governing triggers (enforcement disabled; tables still exist)
DROP TRIGGER IF EXISTS trg_svc_own_proposal_status ON roadmap.proposal;
DROP TRIGGER IF EXISTS trg_svc_own_proposal_maturity ON roadmap.proposal;
DROP TRIGGER IF EXISTS trg_svc_own_transition_queue ON roadmap.transition_queue;
DROP TRIGGER IF EXISTS trg_svc_own_decision_queue ON roadmap.decision_queue;
DROP TRIGGER IF EXISTS trg_svc_own_squad_dispatch ON roadmap_workforce.squad_dispatch;
DROP TRIGGER IF EXISTS trg_svc_own_service_lease ON control_runtime.service_lease;
```

To fully remove P441 schema (destructive — requires lease data to be purged):

```sql
DROP SCHEMA control_runtime CASCADE;
```

---

## Operator-Visible Failure Behavior

When a service attempts to write a governed table without a valid lease, PostgreSQL raises:

```
ERROR: Service <service_id> lacks an active lease for responsibility <resp>; cannot write <schema>.<table>
SQLSTATE: 42501 (insufficient_privilege)
```

This error surfaces in:
- Application logs as a database error with SQLSTATE 42501
- `pg_stat_activity` — check `query` column for the failing statement
- Orchestrator dead-letter queue — unprocessed transitions retry up to 3× before escalation

To confirm active leases:

```sql
SELECT service_id, responsibility, acquired_at, expires_at
FROM control_runtime.service_lease
WHERE released_at IS NULL AND expires_at > now()
ORDER BY responsibility;
```

---

## Bringing an Agency Online (P902 A8.3 / P299)

`agenthive-liaison@.service` is the **canonical** way to make an agency dispatchable.
An `agent_registry` row alone is not sufficient — the liaison session must be active
and heartbeating for the orchestrator to consider the agency eligible for work dispatch.

### Steps to register a new agency

1. Create `/etc/agenthive/liaison-<agency-id>.env`:

```
AGENCY_PROVIDER=anthropic
AGENCY_HOST_ID=bot
```

2. Enable and start the liaison service:

```bash
sudo systemctl enable --now agenthive-liaison@<agency-id>.service
```

3. Verify the session is live:

```bash
sudo journalctl -u agenthive-liaison@<agency-id> -f
# Expect: [liaison:<agency-id>] registered session=<uuid>
```

4. Confirm in the DB:

```sql
SELECT agency_id, session_id, last_heartbeat_at, capacity_remaining
FROM roadmap_workforce.liaison_session
WHERE agency_id = '<agency-id>'
  AND status = 'active';
```

### Taking an agency offline

```bash
sudo systemctl stop agenthive-liaison@<agency-id>.service
# Liaison sends SIGTERM → clean shutdown → session marked inactive
```

The orchestrator will stop dispatching to the agency once its liaison session
heartbeat expires (TTL 90s by default). In-flight offers are completed by the
liaison before shutdown.
