/**
 * P3313 AC-2: Post-run hook to feed agent-run outcomes into the reliability ledger.
 *
 * STUB — awaiting P3311 (reliability ledger schema + upsert API).
 * When P3311 ships, replace the STUB body with the real upsert call.
 *
 * This hook is called at the end of every spawn cycle (success or failure) by
 * the agent-spawner finish path.  It is fire-and-forget; errors must not bubble.
 *
 * Dependency: P3311 must be COMPLETE before this stub is activated.
 * Blocked-by: P3311 (reliability ledger)
 */

export interface RunOutcome {
  routeId: number;
  taskClass: string | null;
  /** true = completed successfully, false = errored/timed-out */
  success: boolean;
  /** wall-clock milliseconds for the run */
  durationMs?: number;
  agencyIdentity?: string | null;
  proposalId?: number | null;
}

/**
 * Feed one run outcome into the reliability ledger.
 * STUB: no-op until P3311 ledger API is available.
 */
export async function recordRunOutcome(outcome: RunOutcome): Promise<void> {
  // STUB: awaiting P3311
  // When P3311 ships, replace with:
  //   await upsertReliabilityLedger({
  //     route_id: outcome.routeId,
  //     task_class: outcome.taskClass,
  //     success: outcome.success,
  //     duration_ms: outcome.durationMs,
  //     agency_identity: outcome.agencyIdentity,
  //     proposal_id: outcome.proposalId,
  //   });
  void outcome;
}

/**
 * Wire point: call from agent-spawner after each spawn resolves/rejects.
 * Example (in agent-spawner.ts finish path):
 *
 *   void recordRunOutcome({
 *     routeId: chosenRouteId,
 *     taskClass: taskClass ?? null,
 *     success: !errored,
 *     durationMs: Date.now() - startMs,
 *     agencyIdentity,
 *     proposalId,
 *   }).catch(() => {});
 */
