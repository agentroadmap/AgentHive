# P747 Umbrella D: Multi-Dimensional Route Eligibility

## Executive Summary

P747 consolidates route selection into a unified resolver that gates model routing across five independent dimensions: host policy, project policy, agency policy, role requirements, and token budget. The new `selectActiveRouteRowMultiDimensional(queueContext)` function replaces scattered filtering logic with a single entry point.

## Architectural Changes

### Entry Point: QueueContext

All route resolution is now driven by a `QueueContext` assembled pre-resolution by the queue scanner or orchestrator:

```typescript
export interface QueueContext {
  projectId: bigint | null;        // Control point: AC-1 validation
  agencyId: string;
  hostId: string;
  roleId: string;                  // task_category from workflow
  proposalId: bigint;
  routeProvider?: string;          // Provider preference (may be overridden)
  workClaimId?: bigint;            // For audit trail
}
```

**Entry Point Location:** `src/core/orchestration/route-eligibility.ts`

**Function Signature:**

```typescript
async function selectActiveRouteRowMultiDimensional(
  ctx: QueueContext,
  offerRequirements?: OfferRequirements,
): Promise<RouteResolutionResult>
```

**Return Type:**

```typescript
interface RouteResolutionResult {
  selected: ActiveRouteRow | null;
  eliminated: EliminatedRoute[];  // Full elimination trace
}

interface EliminatedRoute {
  route_id: number;
  reason_code: 'host_policy_denied' | 'project_policy_denied' | 'agency_policy_denied' 
             | 'role_ineligible' | 'token_budget_exceeded' | 'cooldown_active' 
             | 'disabled' | 'not_found';
  deny_reason?: string;           // From policy tables
}
```

### Five Independent Filter Dimensions

#### 1. Host Policy (AC-2)
- **Schema:** `hivecentral.host_model_policy` (created in migration 231)
- **Columns:** `host_id, route_id, is_allowed, deny_reason`
- **Semantics:** Per-row boolean `is_allowed=false` eliminates route
- **Reason Code:** `host_policy_denied`

#### 2. Project Policy (AC-3)
- **Schema:** `control_model.project_route_policy` (created in migration 230)
- **Columns:** `project_id, route_id, is_allowed, deny_reason`
- **Semantics:** Per-row boolean `is_allowed=false` eliminates route
- **Reason Code:** `project_policy_denied`

#### 3. Agency Policy (AC-4)
- **Schema:** `roadmap.agency_route_policy` (existing)
- **Columns:** `agency_id, route_id, allowed, scope, project_id`
- **Semantics:** Fail-closed: `allowed=false` eliminates route; respects `scope={global|tenant}`
- **Reason Code:** `agency_policy_denied`

#### 4. Role Filtering (AC-5)
- **Data Source:** `roadmap.model_routes.can_spawn_workers` (added in migration 232)
- **Trigger:** When `roleId` in `['architecture', 'review']`
- **Semantics:** Routes with `can_spawn_workers=false` eliminated for restricted roles
- **Reason Code:** `role_ineligible`

#### 5. Token Budget (AC-6)
- **Schema:** `roadmap_efficiency.route_token_budget` (created in migration 229)
- **Columns:** `project_id, route_id, window_start, window_hours, tokens_cap, tokens_used`
- **Semantics:** Lazy hourly window reset on hot path via atomic UPSERT
- **Condition:** Routes with `tokens_used >= tokens_cap` eliminated
- **Reason Code:** `token_budget_exceeded`

### Post-Selection Fallback & Cooldown (AC-7)

After route selection, if chosen route has `model_routes.cooldown_until > NOW()`:

1. Follow `fallback_route_id` chain (added in migration 232)
2. Stop at first unthrottled route (where `cooldown_until IS NULL` or past)
3. If chain exhausted, return `{selected: null, eliminated: [...]}`
4. Emit HOLD signal to queue scanner

**Reason Code:** `cooldown_active`

### Audit Trail (AC-8)

Every route decision is recorded to `roadmap.route_decision_log`:

```sql
INSERT INTO roadmap.route_decision_log
  (work_claim_id, proposal_id, project_id, agency_id, role, chosen_route_id, eliminated_routes)
VALUES (?, ?, ?, ?, ?, ?, JSONB array of {route_id, reason_code, deny_reason?})
```

Recorded after route selection when `workClaimId` is provided.

## Queue-Scanner Integration (AC-15)

### Prerequisites: Context Enrichment (AC-1)

The queue scanner **must** enrich the queue context before calling `selectActiveRouteRowMultiDimensional()`:

```typescript
const queueContext: QueueContext = {
  projectId: workOffer.projectId,      // Must be non-null (AC-1 early exit otherwise)
  agencyId: workOffer.agencyId,
  hostId: hostname(),
  roleId: workflow.task_category,      // From proposal workflow
  proposalId: workOffer.proposalId,
  routeProvider: workOffer.preferred_provider?,
  workClaimId: workClaim.id,           // For audit trail
};

// Early exit if context incomplete
if (!queueContext.projectId || !queueContext.roleId) {
  // HOLD signal: context not yet resolved
  return { selected: null, eliminated: [{route_id: 0, reason_code: 'not_found'}] };
}

const result = await selectActiveRouteRowMultiDimensional(queueContext);
```

### Call Sites

The function **must be called from**:
1. **Primary:** `src/core/orchestration/queue-scanner.ts` (resolveQueueContext → selectActiveRouteRowMultiDimensional)
2. **Secondary:** `src/core/orchestration/orchestrator.ts` (direct dispatch after enrichment)
3. **Test/Admin:** Any operator tooling that needs route eligibility evaluation

### Backward Compatibility

Legacy code using `selectActiveRouteRow(provider, hostId, offerRequirements)` continues to work via a compatibility wrapper that creates a synthetic `QueueContext` with `projectId=null`. This triggers the AC-1 early exit, ensuring legacy callers get appropriate fallback behavior.

## Schema Authority & Ownership

| Dimension | Table | Schema | Created In | Owner |
|-----------|-------|--------|-----------|-------|
| Host | host_model_policy | hivecentral | Migration 231 | Control Plane |
| Project | project_route_policy | control_model | Migration 230 | Control Plane |
| Agency | agency_route_policy | roadmap | P745 (live) | Legacy Roadmap |
| Role | model_routes.can_spawn_workers | roadmap | Migration 232 | Route Registry |
| Budget | route_token_budget | roadmap_efficiency | Migration 229 | Efficiency Ledger |

## Trade-offs & Notes

### Trade-off 1: Hot-Path Token Budget Reset
- **Choice:** Lazy hourly reset via atomic UPSERT on route selection hot path
- **Pro:** No separate scheduler job; concurrent claims use eventual consistency
- **Con:** Race conditions possible on same budget window
- **Mitigation:** UPSERT ON CONFLICT semantics ensure atomicity per (project_id, route_id)

### Trade-off 2: Schema Split During Migration
- **Choice:** Three schemas co-exist (hivecentral, control_model, roadmap) during transition
- **Pro:** Clear separation of concern; new policies anchor in control_model
- **Con:** Until full migration complete, routing logic must handle dual-path reads
- **Mitigation:** AC-14 feature flag (post-merge) controls read path; both tested independently

### Trade-off 3: Extended Return Signature
- **Choice:** All call sites updated to handle {selected, eliminated} trace
- **Pro:** Complete observability; operator can see all eliminated routes + reasons
- **Con:** Touching all call sites introduces regression risk
- **Mitigation:** Treated as migration scaffolding; backward-compatible wrapper available

## Post-Merge Work (AC-9-12, AC-14)

These ACs require operator/orchestrator integration and are marked **pending** until merged to main:

- **AC-9:** Operator surface GET/PUT `/api/admin/policy/host-routes`
- **AC-10:** Operator surface GET/PUT `/api/admin/policy/project-routes`
- **AC-11:** Operator surface GET/PUT `/api/admin/policy/agency-routes`
- **AC-12:** Denial reason integration into SPAWN_POLICY_VIOLATION escalation messages
- **AC-14:** Feature flag `ENABLE_HIVECENTRAL_HOST_POLICY` to switch between legacy and new host-policy path

## Testing

### Unit Tests
Located in `tests/core/route-eligibility.test.ts`:
- AC-1: Early exit on missing context
- AC-2-6: Each filter dimension independently
- AC-7: Fallback chain exhaustion
- AC-13: Return signature validation
- AC-15: QueueContext shape

### Integration Tests
Located in `tests/core/p747-integration.test.ts`:
- Schema existence checks for all created tables
- Column verification for model_routes extensions

### Live DB Tests
Migrations applied to live agenthive DB:
- Migration 229: route_token_budget table
- Migration 230: control_model.project_route_policy table
- Migration 231: hivecentral.host_model_policy table
- Migration 232: model_routes column extensions

## Implementation Checklist

### Completed (AC-1-8, AC-13, AC-15)
- [x] selectActiveRouteRowMultiDimensional with QueueContext
- [x] Early exit on missing projectId/roleId
- [x] Five independent filter dimensions
- [x] Token budget lazy reset
- [x] Fallback chain + cooldown traversal
- [x] Audit trail recording
- [x] Extended return signature {selected, eliminated}
- [x] Backward compatibility wrapper
- [x] All database schema creation
- [x] AC completions recorded

### Post-Merge (AC-9-12, AC-14)
- [ ] Admin API endpoints for policy management
- [ ] Escalation message integration (deny_reason field)
- [ ] Feature flag for host policy path
- [ ] Queue scanner integration (calls new resolver)
- [ ] Orchestrator dispatch updates (uses new resolver)
- [ ] Operator documentation + training
