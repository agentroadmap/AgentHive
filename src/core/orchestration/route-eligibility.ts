/**
 * P747 Umbrella D: Multi-Dimensional Route Eligibility
 *
 * Consolidated route selection enforcing five independent filter dimensions:
 * 1. Host policy (hivecentral.host_model_policy)
 * 2. Project policy (roadmap.project_route_policy)
 * 3. Agency policy (roadmap.agency_route_policy)
 * 4. Role/task-category (requires spawn_workers for architecture/review)
 * 5. Token budget (roadmap_efficiency.route_token_budget with lazy hourly reset)
 *
 * P928: Shared canonical route-eligibility helper.
 * Extracted from agent-spawner.ts:723-742 for reuse by both resolveActiveRouteProvider
 * and resolveAgencyCurrentRoute. Single source of truth for host-policy filtering +
 * priority/cost ordering.
 *
 * P1006: Extended with capability-aware routing via model_capability_profile.
 */

import { query } from "../../infra/postgres/pool.ts";

export interface ActiveRouteRow {
  id: number;
  agent_provider: string;
  route_provider: string;
  model_name: string;
  plan_type: string | null;
  cli_path: string | null;
  base_url: string | null;
  priority: number;
  cost_per_million_input: number | null;
  can_spawn_workers?: boolean;
  is_enabled?: boolean;
  cooldown_until?: string | null;
  fallback_route_id?: number | null;
}

/**
 * AC-13: Elimination trace for route resolution diagnostics.
 * Each eliminated route is logged with reason_code and optional deny_reason.
 */
export interface EliminatedRoute {
  route_id: number;
  reason_code:
    | 'host_policy_denied'
    | 'project_policy_denied'
    | 'agency_policy_denied'
    | 'role_ineligible'
    | 'token_budget_exceeded'
    | 'cooldown_active'
    | 'disabled'
    | 'not_found';
  deny_reason?: string;
}

/**
 * AC-13: Extended resolver return signature with elimination trace.
 */
export interface RouteResolutionResult {
  selected: ActiveRouteRow | null;
  eliminated: EliminatedRoute[];
}

/**
 * AC-15: Queue context assembled pre-route-resolution.
 * All fields must be provided before selectActiveRouteRow() is called.
 * Early exit if projectId or roleId is null (HOLD signal per AC-1).
 */
export interface QueueContext {
  projectId: bigint | null;
  agencyId: string;
  hostId: string;
  roleId: string;
  proposalId: bigint;
  routeProvider?: string; // Provider preference (may be overridden by policies)
  workClaimId?: bigint; // For audit trail recording
}

/**
 * P1006: Offer requirements for capability-aware routing.
 * When provided, selectActiveRouteRow will filter model candidates by capability scores,
 * tool/vision support, cost tier, and context window.
 */
export interface OfferRequirements {
  min_reasoning_score?: number;
  min_code_quality_score?: number;
  min_instruction_following_score?: number;
  min_context_window_k?: number;
  requires_tool_use?: boolean;
  requires_vision?: boolean;
  max_cost_tier?: number;
  task_category?: string;
}

/**
 * P747 AC-1: Early exit condition check.
 * Returns true if projectId or roleId is null (HOLD signal).
 */
function shouldEarlyExit(ctx: QueueContext): boolean {
  return ctx.projectId === null || !ctx.roleId;
}

/**
 * P747 AC-2: Host policy filter.
 * Reads hivecentral.host_model_policy and eliminates routes with is_allowed=false.
 * Returns list of eliminated route IDs with reason_code 'host_policy_denied'.
 */
async function filterHostPolicy(
  hostId: string,
  candidateRouteIds: number[],
): Promise<Map<number, EliminatedRoute>> {
  const eliminated = new Map<number, EliminatedRoute>();

  if (!hostId || candidateRouteIds.length === 0) {
    return eliminated;
  }

  const sql = `
    SELECT hmp.route_id, hmp.is_allowed, hmp.deny_reason
    FROM hivecentral.host_model_policy hmp
    WHERE hmp.host_id = $1::text
      AND hmp.route_id = ANY($2::bigint[])
      AND hmp.is_allowed = false
  `;

  const { rows } = await query<{
    route_id: number;
    is_allowed: boolean;
    deny_reason?: string;
  }>(sql, [hostId, candidateRouteIds]);

  rows.forEach((row) => {
    eliminated.set(row.route_id, {
      route_id: row.route_id,
      reason_code: 'host_policy_denied',
      deny_reason: row.deny_reason || undefined,
    });
  });

  return eliminated;
}

/**
 * P747 AC-3: Project policy filter.
 * Reads roadmap.project_route_policy and eliminates routes with is_allowed=false.
 * Returns list of eliminated route IDs with reason_code 'project_policy_denied'.
 */
async function filterProjectPolicy(
  projectId: bigint | null,
  candidateRouteIds: number[],
): Promise<Map<number, EliminatedRoute>> {
  const eliminated = new Map<number, EliminatedRoute>();

  if (!projectId || candidateRouteIds.length === 0) {
    return eliminated;
  }

  const sql = `
    SELECT prp.route_id, prp.is_allowed, prp.deny_reason
    FROM roadmap.project_route_policy prp
    WHERE prp.project_id = $1::bigint
      AND prp.route_id = ANY($2::bigint[])
      AND prp.is_allowed = false
  `;

  const { rows } = await query<{
    route_id: number;
    is_allowed: boolean;
    deny_reason?: string;
  }>(sql, [projectId, candidateRouteIds]);

  rows.forEach((row) => {
    eliminated.set(row.route_id, {
      route_id: row.route_id,
      reason_code: 'project_policy_denied',
      deny_reason: row.deny_reason || undefined,
    });
  });

  return eliminated;
}

/**
 * P747 AC-4: Agency policy filter.
 * Reads roadmap.agency_route_policy and eliminates routes with allowed=false.
 * Respects scope={global|tenant} and filters by project_id for tenant scope.
 */
async function filterAgencyPolicy(
  agencyId: string,
  projectId: bigint | null,
  candidateRouteIds: number[],
): Promise<Map<number, EliminatedRoute>> {
  const eliminated = new Map<number, EliminatedRoute>();

  if (!agencyId || candidateRouteIds.length === 0) {
    return eliminated;
  }

  const sql = `
    SELECT arp.route_id
    FROM roadmap.agency_route_policy arp
    WHERE arp.agency_id = $1::text
      AND arp.route_id = ANY($2::bigint[])
      AND arp.allowed = false
      AND (arp.scope = 'global' OR (arp.scope = 'tenant' AND arp.project_id = $3::bigint))
  `;

  const { rows } = await query<{ route_id: number }>(sql, [
    agencyId,
    candidateRouteIds,
    projectId,
  ]);

  rows.forEach((row) => {
    eliminated.set(row.route_id, {
      route_id: row.route_id,
      reason_code: 'agency_policy_denied',
    });
  });

  return eliminated;
}

/**
 * P747 AC-5: Role filter.
 * When roleId resolves to task_category in ['architecture', 'review'],
 * eliminate routes with can_spawn_workers=false.
 */
function filterRolePolicy(
  roleId: string,
  candidateRoutes: ActiveRouteRow[],
): Map<number, EliminatedRoute> {
  const eliminated = new Map<number, EliminatedRoute>();

  // Architecture and review tasks require spawn_workers capability
  const restrictedRoles = ['architecture', 'review'];
  if (!restrictedRoles.includes(roleId)) {
    return eliminated;
  }

  candidateRoutes.forEach((route) => {
    if (route.can_spawn_workers === false) {
      eliminated.set(route.id, {
        route_id: route.id,
        reason_code: 'role_ineligible',
      });
    }
  });

  return eliminated;
}

/**
 * P747 AC-6: Token budget lazy-recomputation.
 * If budget window has expired (window_start + window_hours * interval < now()),
 * atomically reset tokens_used=0 and advance window_start.
 * Eliminate routes with tokens_used >= tokens_cap.
 */
async function filterTokenBudget(
  projectId: bigint | null,
  candidateRouteIds: number[],
): Promise<Map<number, EliminatedRoute>> {
  const eliminated = new Map<number, EliminatedRoute>();

  if (!projectId || candidateRouteIds.length === 0) {
    return eliminated;
  }

  // AC-6: Lazy reset: if window has expired, reset on hot path
  const resetSql = `
    INSERT INTO roadmap_efficiency.route_token_budget (project_id, route_id, window_start, window_hours, tokens_cap, tokens_used)
    SELECT project_id, route_id, NOW(), window_hours, tokens_cap, 0
    FROM roadmap_efficiency.route_token_budget
    WHERE project_id = $1::bigint
      AND route_id = ANY($2::bigint[])
      AND (window_start + (window_hours || ' hours')::interval) < NOW()
    ON CONFLICT (project_id, route_id) DO UPDATE
    SET window_start = NOW(), tokens_used = 0
    WHERE (excluded.window_start + (excluded.window_hours || ' hours')::interval) < NOW()
  `;

  await query(resetSql, [projectId, candidateRouteIds]).catch((err) => {
    console.error('[filterTokenBudget] reset error:', err.message);
  });

  // Now check which routes exceed their budget
  const checkSql = `
    SELECT rtb.route_id
    FROM roadmap_efficiency.route_token_budget rtb
    WHERE rtb.project_id = $1::bigint
      AND rtb.route_id = ANY($2::bigint[])
      AND rtb.tokens_used >= rtb.tokens_cap
  `;

  const { rows } = await query<{ route_id: number }>(checkSql, [
    projectId,
    candidateRouteIds,
  ]);

  rows.forEach((row) => {
    eliminated.set(row.route_id, {
      route_id: row.route_id,
      reason_code: 'token_budget_exceeded',
    });
  });

  return eliminated;
}

/**
 * P747 AC-7: Fallback chain + cooldown handling.
 * After route selection, if chosen route has cooldown_until > NOW(),
 * follow fallback_route_id chain until finding unthrottled route.
 * If entire chain exhausted, return null with HOLD signal.
 */
async function applyFallbackChain(
  selectedRoute: ActiveRouteRow | null,
): Promise<ActiveRouteRow | null> {
  if (!selectedRoute) {
    return null;
  }

  // Check if selected route is in cooldown
  if (!selectedRoute.cooldown_until || new Date(selectedRoute.cooldown_until) <= new Date()) {
    return selectedRoute; // Not throttled, use as-is
  }

  // Route is throttled; follow fallback chain
  let current = selectedRoute;
  const visited = new Set<number>();

  while (current && current.fallback_route_id && !visited.has(current.fallback_route_id)) {
    visited.add(current.id);
    const nextId = current.fallback_route_id;

    const sql = `
      SELECT id, agent_provider, route_provider, model_name, plan_type, cli_path, base_url,
             priority, cost_per_million_input, can_spawn_workers, is_enabled, cooldown_until, fallback_route_id
      FROM roadmap.model_routes
      WHERE id = $1::bigint
    `;

    const { rows } = await query<ActiveRouteRow>(sql, [nextId]);
    if (rows.length === 0) {
      break; // End of chain
    }

    current = rows[0];

    // Check if this route in chain is unthrottled
    if (!current.cooldown_until || new Date(current.cooldown_until) <= new Date()) {
      return current; // Found unthrottled fallback
    }
  }

  // Entire chain exhausted or circular reference
  return null;
}

/**
 * P747 AC-8: Record route decision to audit trail.
 */
async function recordRouteDecision(
  ctx: QueueContext,
  selected: ActiveRouteRow | null,
  eliminated: EliminatedRoute[],
): Promise<void> {
  if (!ctx.workClaimId) {
    return; // No work claim to audit against
  }

  const sql = `
    INSERT INTO roadmap.route_decision_log
      (work_claim_id, proposal_id, project_id, agency_id, role, chosen_route_id, eliminated_routes, selection_timestamp)
    VALUES ($1::bigint, $2::bigint, $3::bigint, $4::text, $5::text, $6::bigint, $7::jsonb, NOW())
    ON CONFLICT DO NOTHING
  `;

  const eliminatedJson = JSON.stringify(eliminated);

  try {
    await query(sql, [
      ctx.workClaimId,
      ctx.proposalId,
      ctx.projectId,
      ctx.agencyId,
      ctx.roleId,
      selected?.id || null,
      eliminatedJson,
    ]);
  } catch (err) {
    console.error('[recordRouteDecision] audit insert error:', err);
  }
}

/**
 * P747: Comprehensive route eligibility resolver.
 * Single entry point for multi-dimensional route selection.
 *
 * AC-1: Early exit if projectId or roleId is null (HOLD signal).
 * AC-2-5: Apply all five independent filters.
 * AC-6: Token budget lazy reset.
 * AC-7: Fallback chain + cooldown.
 * AC-8: Audit trail recording.
 * AC-13: Return extended signature with elimination trace.
 * AC-15: QueueContext is required and documented.
 *
 * Returns {selected: route | null, eliminated: [...]} trace.
 */
export async function selectActiveRouteRowMultiDimensional(
  ctx: QueueContext,
  offerRequirements?: OfferRequirements,
): Promise<RouteResolutionResult> {
  const eliminated: EliminatedRoute[] = [];

  // AC-1: Early exit if required context missing
  if (shouldEarlyExit(ctx)) {
    // HOLD signal: missing projectId or roleId
    return {
      selected: null,
      eliminated: [
        {
          route_id: 0,
          reason_code: 'not_found',
          deny_reason: `missing context: projectId=${ctx.projectId}, roleId=${ctx.roleId}`,
        },
      ],
    };
  }

  // Build capability filter SQL (P1006)
  let capabilityFilter = "";
  const queryParams: (string | number | boolean)[] = [ctx.routeProvider || "", ctx.hostId];

  if (offerRequirements?.task_category && ["architecture", "review"].includes(offerRequirements.task_category)) {
    capabilityFilter += ` AND mr.can_spawn_workers = true`;
  }

  if ((offerRequirements?.min_reasoning_score ?? 0) > 0) {
    queryParams.push(offerRequirements.min_reasoning_score);
    capabilityFilter += ` AND mcp.reasoning_score >= $${queryParams.length}`;
  }

  if ((offerRequirements?.min_context_window_k ?? 0) > 0) {
    queryParams.push(offerRequirements.min_context_window_k);
    capabilityFilter += ` AND mcp.context_window_k >= $${queryParams.length}`;
  }

  // Get all candidate routes (before filtering)
  const candidateSql = `
    SELECT mr.id, mr.agent_provider, mr.route_provider, mr.model_name, mr.plan_type,
           mr.cli_path, mr.base_url, mr.priority, mr.cost_per_million_input,
           mr.can_spawn_workers, mr.is_enabled, mr.cooldown_until, mr.fallback_route_id
    FROM roadmap.model_routes mr
    WHERE mr.is_enabled = true
      AND mr.route_provider = $1::text
      AND mr.host_id = $2::text
    ORDER BY mr.priority ASC, COALESCE(mr.cost_per_million_input, 0) ASC
  `;

  const { rows: candidates } = await query<ActiveRouteRow>(candidateSql, queryParams);

  if (candidates.length === 0) {
    return { selected: null, eliminated };
  }

  const candidateIds = candidates.map((r) => r.id);

  // AC-2: Host policy filter
  const hostPolicyEliminated = await filterHostPolicy(ctx.hostId, candidateIds);
  hostPolicyEliminated.forEach((e) => eliminated.push(e));

  // AC-3: Project policy filter
  const projectPolicyEliminated = await filterProjectPolicy(ctx.projectId, candidateIds);
  projectPolicyEliminated.forEach((e) => eliminated.push(e));

  // AC-4: Agency policy filter
  const agencyPolicyEliminated = await filterAgencyPolicy(ctx.agencyId, ctx.projectId, candidateIds);
  agencyPolicyEliminated.forEach((e) => eliminated.push(e));

  // AC-5: Role filter
  const remaining = candidates.filter((r) => !hostPolicyEliminated.has(r.id) && !projectPolicyEliminated.has(r.id) && !agencyPolicyEliminated.has(r.id));
  const roleEliminated = filterRolePolicy(ctx.roleId, remaining);
  roleEliminated.forEach((e) => eliminated.push(e));

  // AC-6: Token budget filter
  const remainingAfterRole = remaining.filter((r) => !roleEliminated.has(r.id));
  const budgetEliminated = await filterTokenBudget(ctx.projectId, remainingAfterRole.map((r) => r.id));
  budgetEliminated.forEach((e) => eliminated.push(e));

  // Select the first remaining route
  const eligible = remainingAfterRole.filter((r) => !budgetEliminated.has(r.id));
  let selected = eligible.length > 0 ? eligible[0] : null;

  // AC-7: Fallback chain + cooldown handling
  selected = await applyFallbackChain(selected);

  if (!selected) {
    // Add cooldown elimination if fallback exhausted
    if (eligible.length > 0 && eligible[0].cooldown_until) {
      eliminated.push({
        route_id: eligible[0].id,
        reason_code: 'cooldown_active',
      });
    }
  }

  // AC-8: Record audit trail
  await recordRouteDecision(ctx, selected, eliminated);

  return { selected, eliminated };
}

/**
 * P928/P1006 Backward-compatibility wrapper.
 * Legacy code continues to use selectActiveRouteRow(provider, hostId, offerRequirements)
 * This wraps it by creating a synthetic QueueContext.
 */
export async function selectActiveRouteRow(
  provider: string,
  hostId: string,
  offerRequirements?: OfferRequirements,
): Promise<ActiveRouteRow | null> {
  const ctx: QueueContext = {
    projectId: null, // Legacy mode: no project context
    agencyId: "legacy",
    hostId,
    roleId: "implementation", // Default to non-restricted role
    proposalId: BigInt(0),
    routeProvider: provider,
  };

  // Use legacy path: skip multi-dimensional filtering if projectId is null
  // AC-1 will trigger HOLD, so return null for backward compat
  if (!ctx.projectId) {
    // Legacy path: minimal filtering for backward compat
    return selectActiveRouteRowLegacy(provider, hostId, offerRequirements);
  }

  const result = await selectActiveRouteRowMultiDimensional(ctx, offerRequirements);
  return result.selected;
}

/**
 * P928: Legacy path (pre-P747) for backward compatibility.
 * Implements old host-policy-only filtering.
 */
async function selectActiveRouteRowLegacy(
  provider: string,
  hostId: string,
  offerRequirements?: OfferRequirements,
): Promise<ActiveRouteRow | null> {
  let capabilityFilter = "";
  const queryParams: (string | number)[] = [provider, hostId];

  if (offerRequirements) {
    if (
      offerRequirements.task_category &&
      ["architecture", "review", "testing", "implementation", "analysis"].includes(
        offerRequirements.task_category,
      )
    ) {
      capabilityFilter += ` AND mcp.can_spawn_workers = true`;
    }

    if (offerRequirements.task_category && ["architecture", "review"].includes(offerRequirements.task_category)) {
      capabilityFilter += ` AND mcp.reasoning_score >= 5`;
    }

    if ((offerRequirements.min_reasoning_score ?? 0) > 0) {
      queryParams.push(offerRequirements.min_reasoning_score);
      capabilityFilter += ` AND mcp.reasoning_score >= $${queryParams.length}`;
    }

    if ((offerRequirements.min_code_quality_score ?? 0) > 0) {
      queryParams.push(offerRequirements.min_code_quality_score);
      capabilityFilter += ` AND mcp.code_quality_score >= $${queryParams.length}`;
    }

    if ((offerRequirements.min_instruction_following_score ?? 0) > 0) {
      queryParams.push(offerRequirements.min_instruction_following_score);
      capabilityFilter += ` AND mcp.instruction_following_score >= $${queryParams.length}`;
    }

    if (offerRequirements.requires_tool_use) {
      capabilityFilter += ` AND mcp.supports_tool_use = true`;
    }

    if (offerRequirements.requires_vision) {
      capabilityFilter += ` AND mcp.supports_vision = true`;
    }

    if ((offerRequirements.min_context_window_k ?? 0) > 0) {
      queryParams.push(offerRequirements.min_context_window_k);
      capabilityFilter += ` AND mcp.context_window_k >= $${queryParams.length}`;
    }

    if ((offerRequirements.max_cost_tier ?? 3) < 3) {
      queryParams.push(offerRequirements.max_cost_tier);
      capabilityFilter += ` AND mcp.cost_tier <= $${queryParams.length}`;
    }
  }

  const sql = `SELECT mr.id, mr.agent_provider, mr.route_provider, mr.model_name, mr.plan_type,
            mr.cli_path, mr.base_url, mr.priority, mr.cost_per_million_input
       FROM roadmap.model_routes mr
       LEFT JOIN roadmap.host_model_policy hp ON hp.host_name = $2::text
       ${capabilityFilter.length > 0 ? `LEFT JOIN roadmap_workforce.model_capability_profile mcp ON mcp.provider = mr.route_provider AND mcp.model_name = mr.model_name` : ""}
      WHERE mr.is_enabled = true
        AND mr.agent_provider = $1
        AND (
          hp.host_name IS NULL  -- no policy row → allow any (legacy)
          OR (
            (
              coalesce(array_length(hp.allowed_providers, 1), 0) = 0
              OR mr.route_provider = ANY(hp.allowed_providers)
            )
            AND NOT (mr.route_provider = ANY(hp.forbidden_providers))
          )
        )
        ${capabilityFilter}
      ORDER BY mr.priority ASC, COALESCE(mr.cost_per_million_input, 0) ASC
      LIMIT 1`;

  const { rows } = await query<ActiveRouteRow>(sql, queryParams);

  if (rows.length === 0) {
    return null;
  }

  const picked = rows[0];

  const tierFilterQueryParams = [provider, hostId, picked.priority, picked.cost_per_million_input ?? 0];
  const tierSql = `SELECT mr.id
       FROM roadmap.model_routes mr
       LEFT JOIN roadmap.host_model_policy hp ON hp.host_name = $2::text
       ${capabilityFilter.length > 0 ? `LEFT JOIN roadmap_workforce.model_capability_profile mcp ON mcp.provider = mr.route_provider AND mcp.model_name = mr.model_name` : ""}
      WHERE mr.is_enabled = true
        AND mr.agent_provider = $1
        AND mr.priority = $3
        AND COALESCE(mr.cost_per_million_input, 0) = $4
        AND (
          hp.host_name IS NULL
          OR (
            (
              coalesce(array_length(hp.allowed_providers, 1), 0) = 0
              OR mr.route_provider = ANY(hp.allowed_providers)
            )
            AND NOT (mr.route_provider = ANY(hp.forbidden_providers))
          )
        )
        ${capabilityFilter}`;

  const { rows: tierRows } = await query<{ id: number }>(tierSql, tierFilterQueryParams);

  if (tierRows.length > 1) {
    console.warn(
      `[selectActiveRouteRow] AMBIGUOUS_PROVIDER_ROUTES provider=${provider} host=${hostId} matched=${tierRows.length} picked_route_id=${picked.id}`,
    );
  }

  return picked;
}
