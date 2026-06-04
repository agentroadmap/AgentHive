/**
 * P435 — Control Panel Observability: Operator Control API
 *
 * Source of truth: control_audit schema (migration 150-p435-control-feed.sql)
 *
 * Provides:
 *   - FeedEvent type (P435 causal event schema)
 *   - listActiveDispatches(projectId?) — active dispatches, optionally scoped
 *   - listAgencies(status?) — agencies with optional status filter
 *   - listWorkers(agencyId?, dispatchId?) — workers filtered by agency/dispatch
 *   - stop(scopeType, scopeId, reason, actor) — unified stop dispatching to operator-stop-controls
 *   - getFeedEvents(filters) — query feed_event table
 *   - replayChain(dispatchId) — full causal replay via v_feed_replay
 *
 * All write operations log to control_audit.operator_action_log (via operator-stop-controls).
 * Dispatch-scope stop additionally writes one summary feed_event row (AC-5).
 *
 * Migration boundary: 150-p435-control-feed.sql
 * Required capabilities: operator-controls, observability
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";
import {
  cancelDispatch,
  cancelProposalWork,
  suspendAgency,
  resumeAgency,
  drainHost,
  resumeHost,
  terminateWorker,
  suspendProviderRoute,
  resumeProviderRoute,
  type QueryFn,
  type StopResult,
} from "./operator-stop-controls.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ScopeType =
  | "dispatch"
  | "proposal"
  | "agency"
  | "host"
  | "worker"
  | "provider_route";

export type EventClass =
  | "dispatch_assigned"
  | "dispatch_claimed"
  | "dispatch_renewed"
  | "dispatch_completed"
  | "dispatch_failed"
  | "dispatch_cancelled"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "operator_stop"
  | "operator_suspend"
  | "operator_drain"
  | "operator_terminate"
  | "operator_resume"
  | "route_suspended"
  | "route_resumed";

/** P435 feed event schema (AC-3). All fields optional except id/event_class/emitted_at. */
export interface FeedEvent {
  id: bigint;
  emitted_at: Date;
  event_class: EventClass;
  recommended_stop_scope: ScopeType | null;
  // Causal chain (AC-4)
  project_id: bigint | null;
  proposal_id: bigint | null;
  dispatch_id: bigint | null;
  claim_id: bigint | null;
  run_id: bigint | null;
  // Context
  agency_id: string | null;
  worker_id: string | null;
  host: string | null;
  route: string | null;
  model: string | null;
  budget_scope: string | null;
  detail: Record<string, unknown> | null;
}

export interface FeedReplayRow extends FeedEvent {
  // Dispatch
  dispatch_status: string | null;
  offer_status: string | null;
  assigned_at: Date | null;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  renew_count: number | null;
  reissue_count: number | null;
  // Proposal
  proposal_display_id: string | null;
  proposal_title: string | null;
  // Run
  run_stage: string | null;
  model_used: string | null;
  run_status: string | null;
  run_started_at: Date | null;
  run_completed_at: Date | null;
  run_cost_usd: number | null;
  // Route
  route_provider: string | null;
  agent_provider: string | null;
  route_enabled: boolean | null;
  route_priority: number | null;
  // Budget
  budget_period: string | null;
  budget_max_cents: number | null;
}

export interface ActiveDispatch {
  id: number;
  proposal_id: number;
  project_id: number | null;
  proposal_display_id: string | null;
  proposal_title: string | null;
  agent_identity: string;
  agency_identity: string | null;
  worker_identity: string | null;
  squad_name: string;
  dispatch_role: string;
  dispatch_status: string;
  offer_status: string;
  assigned_at: Date;
  claimed_at: Date | null;
  claim_expires_at: Date | null;
  renew_count: number;
  reissue_count: number;
  max_reissues: number;
  required_capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface WorkerRow {
  agent_identity: string;
  agency_identity: string | null;
  status: string;
  host: string | null;
  last_heartbeat_at: Date | null;
  current_task: string | null;
  active_model: string | null;
  dispatch_id: number | null;
  proposal_id: number | null;
}

export interface StopOptions {
  scopeType: ScopeType;
  scopeId: string;
  reason?: string;
  actor: string;
  queryFn?: QueryFn;
}

export interface FeedEventFilters {
  projectId?: number;
  proposalId?: number;
  dispatchId?: number;
  eventClass?: EventClass;
  since?: Date;
  limit?: number;
  queryFn?: QueryFn;
}

// ─── List queries ─────────────────────────────────────────────────────────────

/**
 * List active (non-terminal) dispatches, optionally filtered by project.
 * AC-1: list_active_dispatches(project_id?)
 */
export async function listActiveDispatches(
  projectId?: number,
  queryFn?: QueryFn,
): Promise<ActiveDispatch[]> {
  const q = queryFn ?? defaultQuery;
  const TERMINAL = "('completed','failed','cancelled')";
  const { rows } = projectId != null
    ? await q(
        `SELECT d.id,
                d.proposal_id,
                d.project_id,
                p.display_id AS proposal_display_id,
                p.title      AS proposal_title,
                d.agent_identity,
                d.agency_identity,
                d.worker_identity,
                d.squad_name,
                d.dispatch_role,
                d.dispatch_status,
                d.offer_status,
                d.assigned_at,
                d.claimed_at,
                d.claim_expires_at,
                d.renew_count,
                d.reissue_count,
                d.max_reissues,
                d.required_capabilities,
                d.metadata
           FROM roadmap_workforce.squad_dispatch d
           LEFT JOIN roadmap_proposal.proposal p ON p.id = d.proposal_id
          WHERE d.project_id = $1
            AND d.dispatch_status NOT IN ${TERMINAL}
          ORDER BY d.assigned_at DESC NULLS LAST`,
        [projectId],
      )
    : await q(
        `SELECT d.id,
                d.proposal_id,
                d.project_id,
                p.display_id AS proposal_display_id,
                p.title      AS proposal_title,
                d.agent_identity,
                d.agency_identity,
                d.worker_identity,
                d.squad_name,
                d.dispatch_role,
                d.dispatch_status,
                d.offer_status,
                d.assigned_at,
                d.claimed_at,
                d.claim_expires_at,
                d.renew_count,
                d.reissue_count,
                d.max_reissues,
                d.required_capabilities,
                d.metadata
           FROM roadmap_workforce.squad_dispatch d
           LEFT JOIN roadmap_proposal.proposal p ON p.id = d.proposal_id
          WHERE d.dispatch_status NOT IN ${TERMINAL}
          ORDER BY d.assigned_at DESC NULLS LAST`,
      );
  return rows as ActiveDispatch[];
}

/**
 * List agencies, optionally filtered by status.
 * AC-1: list_agencies(status?)
 */
export async function listAgencies(
  status?: string,
  queryFn?: QueryFn,
): Promise<Array<Record<string, unknown>>> {
  const q = queryFn ?? defaultQuery;
  const { rows } = await q(
    `SELECT agency_id,
            agency_identity,
            status,
            squad_name,
            project_id,
            capabilities,
            concurrency_limit,
            active_claim_count,
            last_seen_at
       FROM roadmap_workforce.provider_registry
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY status, agency_id`,
    [status ?? null],
  );
  return rows as Array<Record<string, unknown>>;
}

/**
 * List active workers, optionally filtered by agency or dispatch.
 * AC-1: list_workers(agency_id?, dispatch_id?)
 */
export async function listWorkers(opts: {
  agencyId?: string;
  dispatchId?: number;
  queryFn?: QueryFn;
}): Promise<WorkerRow[]> {
  const q = opts.queryFn ?? defaultQuery;
  const { rows } = await q(
    `SELECT h.agent_identity,
            r.agency_identity,
            h.status,
            h.current_task,
            h.active_model,
            h.last_heartbeat_at,
            (h.metadata->>'host')          AS host,
            sd.id::int                     AS dispatch_id,
            sd.proposal_id::int            AS proposal_id
       FROM roadmap_workforce.agent_health h
       JOIN roadmap_workforce.agent_registry r
         ON r.agent_identity = h.agent_identity
       LEFT JOIN roadmap_workforce.squad_dispatch sd
         ON sd.worker_identity = h.agent_identity
        AND sd.dispatch_status NOT IN ('completed','failed','cancelled')
      WHERE ($1::text  IS NULL OR r.agency_identity = $1)
        AND ($2::bigint IS NULL OR sd.id = $2)
        AND h.status IN ('healthy','stale')
      ORDER BY h.last_heartbeat_at DESC NULLS LAST`,
    [opts.agencyId ?? null, opts.dispatchId ?? null],
  );
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    agent_identity: r.agent_identity as string,
    agency_identity: r.agency_identity as string | null,
    status: r.status as string,
    host: r.host as string | null,
    last_heartbeat_at: r.last_heartbeat_at as Date | null,
    current_task: r.current_task as string | null,
    active_model: r.active_model as string | null,
    dispatch_id: r.dispatch_id as number | null,
    proposal_id: r.proposal_id as number | null,
  }));
}

// ─── Unified stop verb (AC-1 + AC-5) ─────────────────────────────────────────

/**
 * Unified stop — dispatches to the appropriate operator-stop-controls verb.
 *
 * scope_type = 'dispatch': cancels the dispatch AND terminates all workers
 *   via DB fn_stop_dispatch (which writes ONE summary audit row, AC-5).
 * All other scopes: delegate to the appropriate existing verb.
 *
 * All writes land in control_audit.operator_action_log (via operator-stop-controls).
 */
export async function stop(opts: StopOptions): Promise<StopResult> {
  const q = opts.queryFn ?? defaultQuery;

  switch (opts.scopeType) {
    case "dispatch": {
      // Use fn_stop_dispatch: cancels + terminates workers + ONE summary event (AC-5)
      const result = await q(
        `SELECT control_audit.fn_stop_dispatch($1::bigint, $2, $3) AS result`,
        [opts.scopeId, opts.actor, opts.reason ?? null],
      );
      return ((result.rows[0] as { result: string }) ?? { result: "error" })
        .result as StopResult;
    }

    case "proposal": {
      const { cancelledCount } = await cancelProposalWork({
        proposalId: Number(opts.scopeId),
        actor: opts.actor,
        reason: opts.reason,
        queryFn: opts.queryFn,
      });
      return cancelledCount > 0 ? "ok" : "noop";
    }

    case "agency":
      return suspendAgency({
        agencyIdentity: opts.scopeId,
        actor: opts.actor,
        reason: opts.reason,
        queryFn: opts.queryFn,
      });

    case "host":
      return drainHost({
        host: opts.scopeId,
        allowGraceSeconds: 0,
        actor: opts.actor,
        reason: opts.reason,
        queryFn: opts.queryFn,
      });

    case "worker":
      return terminateWorker({
        workerIdentity: opts.scopeId,
        actor: opts.actor,
        reason: opts.reason,
        queryFn: opts.queryFn,
      });

    case "provider_route":
      return suspendProviderRoute({
        routeId: Number(opts.scopeId),
        actor: opts.actor,
        reason: opts.reason,
        queryFn: opts.queryFn,
      });

    default:
      return "error";
  }
}

// ─── Feed queries (AC-3, AC-6) ────────────────────────────────────────────────

/**
 * Query feed_event rows. Supports filtering by project, proposal, dispatch,
 * event_class, and time window.
 */
export async function getFeedEvents(filters: FeedEventFilters): Promise<FeedEvent[]> {
  const q = filters.queryFn ?? defaultQuery;
  const limit = Math.min(filters.limit ?? 200, 1000);
  const { rows } = await q(
    `SELECT id, emitted_at, event_class, recommended_stop_scope,
            project_id, proposal_id, dispatch_id, claim_id, run_id,
            agency_id, worker_id, host, route, model, budget_scope, detail
       FROM control_audit.feed_event
      WHERE ($1::bigint  IS NULL OR project_id  = $1)
        AND ($2::bigint  IS NULL OR proposal_id = $2)
        AND ($3::bigint  IS NULL OR dispatch_id = $3)
        AND ($4::text    IS NULL OR event_class = $4)
        AND ($5::timestamptz IS NULL OR emitted_at >= $5)
      ORDER BY emitted_at DESC
      LIMIT $6`,
    [
      filters.projectId ?? null,
      filters.proposalId ?? null,
      filters.dispatchId ?? null,
      filters.eventClass ?? null,
      filters.since ?? null,
      limit,
    ],
  );
  return rows as FeedEvent[];
}

/**
 * Replay the full causal chain for a dispatch.
 * Returns all feed events for this dispatch joined with context from
 * squad_dispatch, agent_runs, model_routes, and project_budget_cap.
 * Satisfies AC-6: correlates 5+ record types per row.
 */
export async function replayChain(
  dispatchId: number,
  queryFn?: QueryFn,
): Promise<FeedReplayRow[]> {
  const q = queryFn ?? defaultQuery;
  const { rows } = await q(
    `SELECT *
       FROM control_audit.v_feed_replay
      WHERE dispatch_id = $1
      ORDER BY emitted_at ASC`,
    [dispatchId],
  );
  return rows as FeedReplayRow[];
}

/**
 * Emit a feed event from application code (e.g. when a run starts/completes).
 */
export async function emitFeedEvent(
  event: Omit<FeedEvent, "id" | "emitted_at">,
  queryFn?: QueryFn,
): Promise<bigint> {
  const q = queryFn ?? defaultQuery;
  const result = await q(
    `SELECT control_audit.fn_emit_feed_event(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
     ) AS id`,
    [
      event.event_class,
      event.project_id ?? null,
      event.proposal_id ?? null,
      event.dispatch_id ?? null,
      event.claim_id ?? null,
      event.run_id ?? null,
      event.agency_id ?? null,
      event.worker_id ?? null,
      event.host ?? null,
      event.route ?? null,
      event.model ?? null,
      event.budget_scope ?? null,
      event.recommended_stop_scope ?? null,
      event.detail ? JSON.stringify(event.detail) : null,
    ],
  );
  return ((result.rows[0] as { id: bigint }) ?? { id: BigInt(0) }).id;
}
