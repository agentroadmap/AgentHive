/**
 * budget-reserve-gate.ts
 * Dispatch gate logic for budget reserve allocation and cross-project deadlock prevention.
 * Integrates P897 reserve mechanism with orchestrator dispatch decisions.
 *
 * Key responsibilities:
 * - Query reserve/ordinary spend status via SQL functions (fn_get_budget_reserve_status)
 * - Route dispatch costs to correct budget share (reserve vs ordinary)
 * - Log reserve consumption to governance.decision
 * - Emit depletion alarms at 80% and 100% utilization
 */

import { PoolClient } from 'pg';

/**
 * BudgetReserveStatus: Current spend position for a budget
 */
export interface BudgetReserveStatus {
  /** Total spent from ordinary share */
  ordinarySpent: number;
  /** Ceiling for ordinary share */
  ordinaryCap: number;
  /** Total spent from reserve share */
  reserveSpent: number;
  /** Ceiling for reserve share */
  reserveCap: number;
  /** Utilization of ordinary share as percentage */
  utilizationOrdinaryPct: number;
  /** Utilization of reserve share as percentage */
  utilizationReservePct: number;
}

/**
 * DispatchGateDecision: Decision outcome for a dispatch cost allocation
 */
export interface DispatchGateDecision {
  /** Where to route the cost: 'reserve' | 'ordinary' | 'blocked' */
  share: 'reserve' | 'ordinary' | 'blocked';
  /** Human-readable reason for the decision */
  reason: string;
  /** Remaining capacity in ordinary pool after this dispatch */
  ordinaryRemaining: number;
  /** Remaining capacity in reserve pool after this dispatch */
  reserveRemaining: number;
}

/**
 * ReserveDraw: Metadata for a reserve consumption event
 */
export interface ReserveDraw {
  proposalId: string;
  proposalDisplayId: string;
  costUsd: number;
  crossProjectDependencyEdgeId?: string;
  actorDid?: string;
}

/**
 * getBudgetReserveStatus
 * Queries current spend status for a budget ID.
 * Calls fn_get_budget_reserve_status SQL function and parses numeric results.
 *
 * @param client - Postgres client or pool
 * @param projectSchema - Schema name (e.g. 'agenthive')
 * @param budgetId - Budget ID to query
 * @returns Promise<BudgetReserveStatus>
 */
export async function getBudgetReserveStatus(
  client: PoolClient | any,
  projectSchema: string,
  budgetId: number,
): Promise<BudgetReserveStatus> {
  const query = `
    SELECT
      ordinary_spent,
      ordinary_cap,
      reserve_spent,
      reserve_cap,
      utilization_ordinary_pct,
      utilization_reserve_pct
    FROM ${projectSchema}.fn_get_budget_reserve_status($1)
  `;

  try {
    const result = await client.query(query, [budgetId]);
    if (result.rows.length === 0) {
      throw new Error(`Budget ${budgetId} not found`);
    }

    const row = result.rows[0];
    return {
      ordinarySpent: parseFloat(row.ordinary_spent),
      ordinaryCap: parseFloat(row.ordinary_cap),
      reserveSpent: parseFloat(row.reserve_spent),
      reserveCap: parseFloat(row.reserve_cap),
      utilizationOrdinaryPct: parseFloat(row.utilization_ordinary_pct),
      utilizationReservePct: parseFloat(row.utilization_reserve_pct),
    };
  } catch (error) {
    throw new Error(
      `Failed to get budget reserve status for budget ${budgetId}: ${(error as Error).message}`,
    );
  }
}

/**
 * decideDispatchBudgetShare
 * Routes a dispatch cost to the appropriate budget share (reserve, ordinary, or blocked).
 * Calls fn_decide_budget_share SQL function.
 *
 * @param client - Postgres client or pool
 * @param projectSchema - Schema name (e.g. 'agenthive')
 * @param proposalId - Proposal ID being dispatched
 * @param budgetId - Budget ID to draw from
 * @param costEstimate - Estimated cost in USD
 * @returns Promise<DispatchGateDecision>
 */
export async function decideDispatchBudgetShare(
  client: PoolClient | any,
  projectSchema: string,
  proposalId: number,
  budgetId: number,
  costEstimate: number,
): Promise<DispatchGateDecision> {
  const query = `
    SELECT
      share,
      reason,
      ordinary_remaining,
      reserve_remaining
    FROM ${projectSchema}.fn_decide_budget_share($1, $2, $3)
  `;

  try {
    const result = await client.query(query, [proposalId, budgetId, costEstimate]);
    if (result.rows.length === 0) {
      throw new Error(`Decision query returned no rows`);
    }

    const row = result.rows[0];
    return {
      share: row.share as 'reserve' | 'ordinary' | 'blocked',
      reason: row.reason,
      ordinaryRemaining: parseFloat(row.ordinary_remaining),
      reserveRemaining: parseFloat(row.reserve_remaining),
    };
  } catch (error) {
    throw new Error(
      `Failed to decide budget share for proposal ${proposalId}: ${(error as Error).message}`,
    );
  }
}

/**
 * logReserveDraw
 * Records a reserve draw event in governance.decision table.
 * Called after a dispatch has been routed to reserve share.
 *
 * @param client - Postgres client or pool
 * @param projectId - Project ID for governance context
 * @param proposalDisplayId - Display ID (e.g. 'P123')
 * @param costUsd - Cost of the dispatch
 * @param crossProjectDependencyEdgeId - Optional: edge ID from cross_project_dependency
 * @param actorDid - Optional: actor identifier; defaults to 'system'
 */
export async function logReserveDraw(
  client: PoolClient | any,
  projectId: number,
  proposalDisplayId: string,
  costUsd: number,
  crossProjectDependencyEdgeId?: string,
  actorDid: string = 'system',
): Promise<void> {
  const query = `
    INSERT INTO governance.decision (
      project_id,
      proposal_ref,
      stage,
      outcome,
      actor_did,
      rationale,
      metadata_jsonb,
      decided_at
    ) VALUES (
      $1,
      $2,
      'dispatch',
      'advance',
      $3,
      'Budget reserve draw for cross-project unblock',
      $4::jsonb,
      now()
    )
  `;

  const metadata = {
    decision_type: 'budget_reserve_draw',
    cost_usd: costUsd,
    cross_project_dependency_edge_id: crossProjectDependencyEdgeId,
  };

  try {
    await client.query(query, [
      projectId,
      proposalDisplayId,
      actorDid,
      JSON.stringify(metadata),
    ]);
  } catch (error) {
    throw new Error(`Failed to log reserve draw: ${(error as Error).message}`);
  }
}

/**
 * checkAndEmitReserveDepletionAlarm
 * Checks reserve utilization and emits governance.event warnings at thresholds.
 * 80% → 'unblock_reserve_warning'
 * 100% → 'unblock_reserve_critical'
 *
 * @param client - Postgres client or pool
 * @param projectId - Project ID
 * @param projectSchema - Schema name
 * @param budgetId - Budget ID to check
 */
export async function checkAndEmitReserveDepletionAlarm(
  client: PoolClient | any,
  projectId: number,
  projectSchema: string,
  budgetId: number,
): Promise<void> {
  // Get current reserve status
  const status = await getBudgetReserveStatus(client, projectSchema, budgetId);

  const reserveUtilization = status.utilizationReservePct;

  // Emit event if utilization crosses 80% or 100%
  if (reserveUtilization >= 80) {
    const eventType =
      reserveUtilization >= 100
        ? 'unblock_reserve_critical'
        : 'unblock_reserve_warning';

    const query = `
      INSERT INTO governance.event (
        project_id,
        event_type,
        actor_did,
        subject_ref,
        payload_jsonb,
        occurred_at
      ) VALUES (
        $1,
        $2,
        'system',
        'budget',
        $3::jsonb,
        now()
      )
    `;

    const payload = {
      budget_id: budgetId,
      utilization_pct: reserveUtilization,
      reserve_spent: status.reserveSpent,
      reserve_cap: status.reserveCap,
      threshold_triggered: reserveUtilization >= 100 ? 'critical' : 'warning',
    };

    try {
      await client.query(query, [projectId, eventType, JSON.stringify(payload)]);
    } catch (error) {
      // Log but don't throw — alarm emission failure shouldn't block dispatch
      console.warn(`Failed to emit reserve depletion alarm: ${error}`);
    }
  }
}

/**
 * initializeReserveForBudget
 * One-time helper to initialize a budget with reserve/ordinary shares.
 * Sets ordinary_share = 0.80 and unblock_reserve_share = 0.20 by default.
 *
 * @param client - Postgres client or pool
 * @param projectSchema - Schema name
 * @param budgetId - Budget ID to initialize
 * @param ordinaryShare - Optional: custom ordinary share (default 0.80)
 * @param reserveShare - Optional: custom reserve share (default 0.20)
 */
export async function initializeReserveForBudget(
  client: PoolClient | any,
  projectSchema: string,
  budgetId: number,
  ordinaryShare: number = 0.8,
  reserveShare: number = 0.2,
): Promise<void> {
  // Validate shares sum to <= 1.0
  if (ordinaryShare + reserveShare > 1.0) {
    throw new Error(
      `Share sum ${ordinaryShare + reserveShare} exceeds 1.0`,
    );
  }

  const query = `
    UPDATE ${projectSchema}.spBudget
    SET
      ordinary_share = $2,
      unblock_reserve_share = $3,
      updated_at = now()
    WHERE id = $1
  `;

  try {
    const result = await client.query(query, [
      budgetId,
      ordinaryShare,
      reserveShare,
    ]);
    if (result.rowCount === 0) {
      throw new Error(`Budget ${budgetId} not found`);
    }
  } catch (error) {
    throw new Error(
      `Failed to initialize reserve for budget ${budgetId}: ${(error as Error).message}`,
    );
  }
}
