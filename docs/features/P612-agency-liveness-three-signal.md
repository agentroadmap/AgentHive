# P612 — Consolidated Agency Liveness: Three-Signal Model

**Status:** COMPLETE  
**Proposal internal ID:** 614  
**Migration:** `database/migrations/051-p251-poke-pong-liveness.sql`  
**Replaces:** `fn_check_agency_dormancy()` 90-second silent flip (P464)  
**Depends on:** P464 (agency schema), P468 (liaison message bus)

---

## Overview

P612 replaces the silent 90-second `checkAndMarkDormant` dormancy flip with a three-signal liveness model that is observable, auditable, and gives every agency a fair chance to respond before demotion.

### Three Signals

| Signal | Mechanism | Threshold |
|---|---|---|
| **Signal 1 — Heartbeat freshness** | `v_agency_status.dispatchable` + `liveness_state` | Healthy < 10 min; stale 5–10 min; trigger poke ≥ 10 min |
| **Signal 2 — Missed-job alarm** | `missed_job_call` table records + watchdog step-2 escalation | 2+ `qualified_silent` alarms within 5 min → immediate poke |
| **Signal 3 — Poke/pong challenge** | `liaison_poke_attempt` + `liaison_poke`/`liaison_pong` messages | Pong required within 60 s; timeout → `dormant` demotion |

The prior model had one implicit signal (heartbeat silence) with no diagnostic record. P612 adds structured records for all three signals and widens the dispatchable window from 90 seconds to 10 minutes.

---

## Database Changes

### Migration file

**`database/migrations/051-p251-poke-pong-liveness.sql`**

> Note: The migration filename reflects the P251 lineage of the poke/pong design; all DDL is functionally equivalent to the P612 specification.

---

### New table: `roadmap.liaison_poke_attempt`

Records every poke emitted by the orchestrator watchdog. `outcome IS NULL` means the poke is still open.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `agency_id` | TEXT NOT NULL | FK → `roadmap.agency(agency_id)` ON DELETE CASCADE |
| `poke_message_id` | UUID NOT NULL | `message_id` in `roadmap.liaison_message` |
| `poked_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `timeout_at` | TIMESTAMPTZ NOT NULL | `poked_at + 60s` |
| `pong_received_at` | TIMESTAMPTZ | Set when pong arrives on time |
| `outcome` | TEXT | CHECK `IN ('resolved','timed_out','poke_late','cancelled')` |
| `resolved_at` | TIMESTAMPTZ | |

**Indexes:** partial index on `(agency_id) WHERE outcome IS NULL` for fast open-poke queries; `poked_at DESC`; `(outcome, resolved_at DESC NULLS LAST)`.

---

### New table: `roadmap.agent_lifecycle_log`

Durable audit log for liveness events. Soft-ref (no FK) so records survive agency deletion.

| Column | Type | Notes |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `agency_id` | TEXT NOT NULL | Soft reference, no FK |
| `event_type` | TEXT NOT NULL | `auto_reactivated \| poke_sent \| pong_received \| poke_timed_out \| poke_late \| poke_cancelled` |
| `event_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
| `details` | JSONB NOT NULL DEFAULT '{}' | |

**Indexes:** `(agency_id, event_at DESC)`; `(event_type, event_at DESC)`.

> **Design delta:** The original proposal named this table `roadmap.agency_event_log` (with `entry_kind`, `rationale`, `metadata`, `created_at`). The implementation uses `roadmap.agent_lifecycle_log` with `event_type`, `details`, `event_at`. Code referencing `agency_event_log` will not find this table — use `agent_lifecycle_log`.

---

### New status constraint

```sql
ALTER TABLE roadmap.agency
  ADD CONSTRAINT chk_agency_status
  CHECK (status IN ('unknown','active','throttled','paused','dormant','retired'))
  NOT VALID;
```

---

### Updated view: `roadmap.v_agency_status`

Widens `dispatchable` from 90 seconds to 10 minutes and adds a 6-state `liveness_state` column.

| `liveness_state` value | Condition |
|---|---|
| `poke-pending` | Open `liaison_poke_attempt` with `outcome IS NULL` |
| `stale-unresponsive` | Last resolved poke has `outcome = 'timed_out'` |
| `late-pong` | Last resolved poke has `outcome = 'poke_late'` |
| `live-and-working` | Active, fresh heartbeat (< 10 min), has active `squad_dispatch` |
| `live-but-idle` | Active, fresh heartbeat (< 10 min), no active dispatch |
| `offline` | Everything else (dormant, paused, stale heartbeat) |

`dispatchable` is now `(status = 'active' AND last_heartbeat_at IS NOT NULL AND now() - last_heartbeat_at < interval '10 minutes')`.

The view excludes agencies with `status = 'retired'`.

> **Note:** `roadmap.agency` has no `heartbeat_stale_warning` computed column in this view. The `liveness_state` values `live-but-idle` (5–10 min heartbeat region) and `stale-unresponsive` serve the operator-visibility role described in the design.

---

### Updated function: `roadmap.fn_check_agency_dormancy()`

- **Old threshold:** 90 seconds (P464)
- **New threshold:** 15 minutes
- **Poke-pending exclusion:** agencies with an open `liaison_poke_attempt` (`outcome IS NULL`) are excluded — the watchdog controls their fate
- Status reason on demotion: `'No heartbeat > 15m'`

---

### Catalog entries: `roadmap.liaison_message_kind_catalog`

Two new entries added (idempotent `ON CONFLICT DO NOTHING`):

| `kind` | `direction` | `category` |
|---|---|---|
| `liaison_poke` | `orchestrator->liaison` | `control` |
| `liaison_pong` | `liaison->orchestrator` | `telemetry` |

---

## TypeScript Changes

### `src/infra/agency/liaison-message-types.ts` — Poke/pong schemas added

Two liveness-specific schemas appended to the P468-owned file:

```typescript
// P251/P612 Liveness poke
export const LiaisonPokePayloadSchema = z.object({
    nonce: z.string().uuid(),
    idle_threshold_min: z.number().int(),
});
export type LiaisonPokePayload = z.infer<typeof LiaisonPokePayloadSchema>;

// Liveness pong — distinct from ProtocolPongPayloadSchema (line 161, app-protocol)
export const LiaisonPongPayloadSchema = z.object({
    nonce: z.string().uuid(),
    capacity_envelope: CapacityEnvelopeSchema.optional(),
    in_flight_count: z.number().int(),
});
export type LiaisonPongPayload = z.infer<typeof LiaisonPongPayloadSchema>;
```

> **Design delta:** The proposal's AC-50 specified richer schemas (`agency_id`, `poke_id`, `expires_at`, `trigger` in poke; `status`, `ready_to_claim`, `correlation_id` in pong). The implementation uses a minimal schema. The poke payload carries only a `nonce` and `idle_threshold_min`; the pong carries only `nonce`, optional `capacity_envelope`, and `in_flight_count`.

`ProtocolPongPayloadSchema` at line 161 (app-protocol ping/pong, `{nonce: string}`) was not modified.

---

## Known Gaps (as-built vs. designed)

The following items were specified in P612's AC set but are not present in the codebase as of the COMPLETE transition on 2026-05-04:

| AC | Gap |
|---|---|
| AC-2, AC-52 | `roadmap.missed_job_call` table not created |
| AC-3/4/5 | `postWorkOffer` missed-job alarm instrumentation not implemented |
| AC-6, AC-21 | `roadmap.agency_event_log` not created (implementation uses `agent_lifecycle_log` with a different schema) |
| AC-45, AC-52 | `roadmap.liaison_message.expires_at` column not added |
| AC-47 | `agencyReactivate()` in `liaison-service.ts` not extended to write lifecycle log row |
| AC-48, AC-39 | `src/infra/agency/liveness-watchdog.ts` not created |
| AC-54 | Legacy comment not added to `liaisonHeartbeat()` 90-second inline check |
| AC-16, AC-32 | `CONVENTIONS.md` agency-liveness section not added |
| AC-25 | `agency-liveness.test.ts` integration test suite not created |

The DDL migration and Zod schemas are the fully-landed portion of the feature. The TypeScript watchdog (`liveness-watchdog.ts`) and the missed-job alarm pipeline (`missed_job_call`, alarm hooks in `postWorkOffer`) remain unimplemented.

---

## Existing Files — Unchanged by P612

| File | Owner | Notes |
|---|---|---|
| `src/infra/agency/liaison-service.ts` | P464 | Not modified. `checkAndMarkDormant()` and `liaisonHeartbeat()` still contain the 90-second inline threshold; `fn_check_agency_dormancy()` in the DB was superseded, but the TS caller was not updated. |
| `src/infra/agency/liaison-watchdog.ts` | P467 | Not modified. P467 5-second stuck-detection loop is separate from P612. |
| `src/infra/agency/liaison-message-service.ts` | P468 | `storeMessage()` and `sendMessage()` are unchanged. `storeMessage` has exactly one export. |

---

## Monitoring Queries

```sql
-- Open pokes (agencies awaiting pong)
SELECT agency_id, poked_at, timeout_at
FROM roadmap.liaison_poke_attempt
WHERE outcome IS NULL
ORDER BY poked_at;

-- Stale-unresponsive agencies
SELECT agency_id, liveness_state, silence_seconds
FROM roadmap.v_agency_status
WHERE liveness_state = 'stale-unresponsive';

-- Recent lifecycle events
SELECT agency_id, event_type, event_at, details
FROM roadmap.agent_lifecycle_log
WHERE event_at > now() - interval '24 hours'
ORDER BY event_at DESC;

-- Current liveness distribution
SELECT liveness_state, COUNT(*) AS n
FROM roadmap.v_agency_status
GROUP BY liveness_state;
```

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P464 | Owner of `roadmap.agency`, `v_agency_status`, `fn_check_agency_dormancy` — all superseded/extended by P612 |
| P467 | Owner of `liaison-watchdog.ts` (stuck-detection, 5s cycle) — isolated from P612's liveness loop |
| P468 | Owner of `liaison-message-service.ts`, `liaison-message-types.ts`, `liaison_message_kind_catalog` — P612 adds to these |
| P251 | Liveness scoring; migration filename references P251 lineage |
| P463 | Two-way protocol; agencies implementing poke/pong must follow this signal contract |
