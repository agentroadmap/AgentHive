/**
 * P442 — Operator Stop and Cancel Controls
 *
 * Source of truth: agenthive DB, schemas roadmap_workforce / control_audit.
 * Migration boundary: 072-p442-operator-stop-controls.sql
 * Required capabilities: operator-controls, workflow
 *
 * Verbs:
 *   cancelDispatch(dispatchId, actor, reason?)
 *     → dispatch_status=cancelled; future claim attempts skip this row.
 *       Returns 'ok' | 'noop' (already terminal) | 'error' (not found).
 *       Idempotent: calling twice on a cancelled dispatch returns 'noop'.
 *
 *   cancelProposalWork(proposalId, actor, reason?)
 *     → cancels every non-terminal dispatch for the proposal.
 *
 *   suspendAgency(agencyIdentity, actor, reason?)
 *     → agent_registry.status=suspended. New claims raise AgencySuspendedError.
 *       Existing running claims continue (no SIGTERM). Reversible.
 *
 *   resumeAgency(agencyIdentity, actor, reason?)
 *     → restores suspended agency to active.
 *
 *   drainHost(host, allowGraceSeconds, actor, reason?)
 *     → inserts/upserts host_drain row. No new claims accepted while draining.
 *       Reversible via resumeHost.
 *
 *   resumeHost(host, actor, reason?)
 *     → deletes host_drain row, lifting the drain window immediately.
 *
 *   terminateWorker(workerIdentity, signal?, actor?, reason?)
 *     → marks active dispatch as 'failed' + writes termination metadata.
 *       OS-level signal delivery is the caller's responsibility (e.g. kill -SIGTERM pid).
 *       Returns 'ok' if a dispatch was found, 'noop' if none were active.
 *
 *   suspendProviderRoute(routeId, actor, reason?)
 *     → sets model_routes.is_enabled=false. Reversible.
 *
 *   resumeProviderRoute(routeId, actor, reason?)
 *     → re-enables a suspended route.
 *
 * All functions are injectable (optional queryFn) for unit tests.
 * All functions write an audit row to control_audit.operator_action_log.
 *
 * Error types:
 *   AgencySuspendedError — thrown by fn_claim_work_offer when agency is suspended.
 *   HostDrainingError    — thrown by fn_claim_work_offer when host is draining.
 *   These are raised by the DB function; the helpers below surface them as typed
 *   errors for offer-provider code that wraps fn_claim_work_offer calls.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export type StopResult = "ok" | "noop" | "error";

export interface CancelDispatchOptions {
  dispatchId: number;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface CancelProposalWorkOptions {
  proposalId: number;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface CancelProposalWorkResult {
  cancelledCount: number;
  noopCount: number;
}

export interface SuspendAgencyOptions {
  agencyIdentity: string;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface ResumeAgencyOptions {
  agencyIdentity: string;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface DrainHostOptions {
  host: string;
  allowGraceSeconds: number;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface ResumeHostOptions {
  host: string;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface TerminateWorkerOptions {
  workerIdentity: string;
  signal?: string;
  actor?: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface SuspendProviderRouteOptions {
  routeId: number;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface ResumeProviderRouteOptions {
  routeId: number;
  actor: string;
  reason?: string;
  queryFn?: QueryFn;
}

export interface ClaimWorkOfferOptions {
  agentIdentity: string;
  requiredCapabilities?: Record<string, unknown>;
  leaseTtlSeconds?: number;
  serviceHost?: string;
  queryFn?: QueryFn;
}

export interface ClaimRow {
  dispatch_id: bigint;
  proposal_id: bigint;
  squad_name: string;
  dispatch_role: string;
  claim_token: string;
  claim_expires_at: Date;
  offer_version: number;
  metadata: Record<string, unknown> | null;
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class AgencySuspendedError extends Error {
  readonly code = "AGENCY_SUSPENDED" as const;
  readonly agentIdentity: string;
  constructor(agentIdentity: string, detail?: string) {
    super(`AGENCY_SUSPENDED: agent '${agentIdentity}' cannot claim work${detail ? ` — ${detail}` : ""}`);
    this.agentIdentity = agentIdentity;
  }
}

export class HostDrainingError extends Error {
  readonly code = "HOST_DRAINING" as const;
  readonly host: string;
  constructor(host: string, detail?: string) {
    super(`HOST_DRAINING: host '${host}' is in active drain window${detail ? ` — ${detail}` : ""}`);
    this.host = host;
  }
}

export class DispatchCancelledError extends Error {
  readonly code = "DISPATCH_CANCELLED" as const;
  readonly dispatchId: number;
  constructor(dispatchId: number) {
    super(`DISPATCH_CANCELLED: dispatch ${dispatchId} has been cancelled`);
    this.dispatchId = dispatchId;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isAgencySuspendedMessage(msg: string): boolean {
  return msg.includes("agency_suspended:");
}

function isHostDrainingMessage(msg: string): boolean {
  return msg.includes("host_draining:");
}

// ─── Operator verbs ───────────────────────────────────────────────────────────

/**
 * Cancel a single dispatch by ID.
 *
 * Idempotent: dispatches already in a terminal state (cancelled/completed/failed)
 * return 'noop'. Dispatch not found returns 'error'.
 *
 * State transition: any non-terminal → dispatch_status=cancelled, offer_status=failed.
 * Side-effect: releases associated proposal_lease if still open.
 * Audit: always writes to control_audit.operator_action_log.
 */
export async function cancelDispatch(opts: CancelDispatchOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT roadmap_workforce.fn_cancel_dispatch($1, $2, $3) AS result`,
    [opts.dispatchId, opts.actor, opts.reason ?? null],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "error" }).result as StopResult;
}

/**
 * Cancel all non-terminal dispatches for a proposal.
 *
 * Internally calls fn_cancel_dispatch for each qualifying row (SKIP LOCKED
 * so concurrent cancellations don't block each other).
 * Audit: one summary row + one per-dispatch row.
 */
export async function cancelProposalWork(
  opts: CancelProposalWorkOptions,
): Promise<CancelProposalWorkResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT cancelled_count, noop_count
       FROM roadmap_workforce.fn_cancel_proposal_work($1, $2, $3)`,
    [opts.proposalId, opts.actor, opts.reason ?? null],
  );
  const row = (result.rows[0] as { cancelled_count: number; noop_count: number }) ?? {
    cancelled_count: 0,
    noop_count: 0,
  };
  return { cancelledCount: Number(row.cancelled_count), noopCount: Number(row.noop_count) };
}

/**
 * Suspend an agency.
 *
 * State transition: agent_registry.status → 'suspended'.
 * Effect: new claim attempts by this agency or its workers raise AgencySuspendedError.
 * Existing running claims continue to completion — no SIGTERM is sent.
 * Reversible via resumeAgency.
 */
export async function suspendAgency(opts: SuspendAgencyOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT roadmap_workforce.fn_suspend_agency($1, $2, $3) AS result`,
    [opts.agencyIdentity, opts.actor, opts.reason ?? null],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "error" }).result as StopResult;
}

/**
 * Resume a suspended agency. Reverses suspendAgency.
 */
export async function resumeAgency(opts: ResumeAgencyOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT roadmap_workforce.fn_resume_agency($1, $2, $3) AS result`,
    [opts.agencyIdentity, opts.actor, opts.reason ?? null],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "noop" }).result as StopResult;
}

/**
 * Put a host into drain mode.
 *
 * State transition: control_runtime.host_drain row is inserted/upserted.
 * Effect: fn_claim_work_offer raises HostDrainingError for allowGraceSeconds.
 * Existing work on the host continues to completion.
 * Reversible via resumeHost (or wait for drain_until to expire).
 */
export async function drainHost(opts: DrainHostOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT control_runtime.fn_drain_host($1, $2, $3, $4) AS result`,
    [opts.host, opts.allowGraceSeconds, opts.actor, opts.reason ?? null],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "error" }).result as StopResult;
}

/**
 * Lift a host drain window immediately. Reverses drainHost.
 */
export async function resumeHost(opts: ResumeHostOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT control_runtime.fn_resume_host($1, $2, $3) AS result`,
    [opts.host, opts.actor, opts.reason ?? null],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "noop" }).result as StopResult;
}

/**
 * Terminate a worker.
 *
 * DB side: marks the worker's active dispatch as 'failed' and writes
 * termination metadata (signal, actor, reason, timestamp).
 * OS side: signal delivery is the caller's responsibility. The DB cannot
 * guarantee POSIX signal delivery or handle kernel OOM kills.
 *
 * Returns 'ok' if an active dispatch was found, 'noop' if none were active.
 * Not reversible (dispatch moves to 'failed').
 */
export async function terminateWorker(opts: TerminateWorkerOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT roadmap_workforce.fn_terminate_worker($1, $2, $3, $4) AS result`,
    [
      opts.workerIdentity,
      opts.signal ?? "SIGTERM",
      opts.actor ?? "operator",
      opts.reason ?? null,
    ],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "noop" }).result as StopResult;
}

/**
 * Suspend a provider route (model_routes.is_enabled → false).
 *
 * Effect: preClaimBudgetCheck (P434) will return ROUTE_POLICY_MISSING for
 * any claim attempt that would have used this route.
 * Reversible via resumeProviderRoute.
 */
export async function suspendProviderRoute(opts: SuspendProviderRouteOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT roadmap.fn_suspend_provider_route($1, $2, $3) AS result`,
    [opts.routeId, opts.actor, opts.reason ?? null],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "error" }).result as StopResult;
}

/**
 * Re-enable a suspended provider route. Reverses suspendProviderRoute.
 */
export async function resumeProviderRoute(opts: ResumeProviderRouteOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT roadmap.fn_resume_provider_route($1, $2, $3) AS result`,
    [opts.routeId, opts.actor, opts.reason ?? null],
  );
  return ((result.rows[0] as { result: string }) ?? { result: "noop" }).result as StopResult;
}

/**
 * Claim a work offer — wrapper around fn_claim_work_offer that translates
 * DB exception messages into typed TypeScript errors.
 *
 * Throws:
 *   AgencySuspendedError — if the agent or its parent agency is suspended.
 *   HostDrainingError    — if the service host is in an active drain window.
 * Returns:
 *   ClaimRow | null — null means no eligible offer was available (retry later).
 */
export async function claimWorkOffer(opts: ClaimWorkOfferOptions): Promise<ClaimRow | null> {
  const q = opts.queryFn ?? defaultQuery;

  let result: { rows: unknown[] };
  try {
    result = await q(
      `SELECT dispatch_id, proposal_id, squad_name, dispatch_role,
              claim_token, claim_expires_at, offer_version, metadata
         FROM roadmap_workforce.fn_claim_work_offer($1, $2::jsonb, $3, $4)`,
      [
        opts.agentIdentity,
        JSON.stringify(opts.requiredCapabilities ?? {}),
        opts.leaseTtlSeconds ?? 1320, // V3-C1 (P1433): lease floor >= spawn timeout (20min)
        opts.serviceHost ?? null,
      ],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isAgencySuspendedMessage(msg)) {
      throw new AgencySuspendedError(opts.agentIdentity, msg);
    }
    if (isHostDrainingMessage(msg)) {
      throw new HostDrainingError(opts.serviceHost ?? "unknown", msg);
    }
    throw err;
  }

  return (result.rows[0] as ClaimRow) ?? null;
}

// ─── Audit query helpers ──────────────────────────────────────────────────────

export interface ActionLogRow {
  id: bigint;
  actor: string;
  verb: string;
  scopeType: string;
  scopeId: string;
  reason: string | null;
  result: StopResult;
  detail: string | null;
  loggedAt: Date;
}

/**
 * Fetch recent operator action log entries for a given scope (e.g., a dispatch ID).
 */
export async function getActionLog(opts: {
  scopeType: string;
  scopeId: string;
  limit?: number;
  queryFn?: QueryFn;
}): Promise<ActionLogRow[]> {
  const q = opts.queryFn ?? defaultQuery;
  const result = await q(
    `SELECT id, actor, verb, scope_type, scope_id, reason, result, detail, logged_at
       FROM control_audit.operator_action_log
      WHERE scope_type = $1
        AND scope_id   = $2
      ORDER BY logged_at DESC
      LIMIT $3`,
    [opts.scopeType, opts.scopeId, opts.limit ?? 50],
  );
  return (result.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as bigint,
    actor: r.actor as string,
    verb: r.verb as string,
    scopeType: r.scope_type as string,
    scopeId: r.scope_id as string,
    reason: r.reason as string | null,
    result: r.result as StopResult,
    detail: r.detail as string | null,
    loggedAt: r.logged_at as Date,
  }));
}
