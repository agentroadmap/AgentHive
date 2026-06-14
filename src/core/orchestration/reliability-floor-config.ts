/**
 * P3313 AC-3: DB-backed reliability floor config.
 *
 * Replaces the hardcoded reliabilityFloor() heuristic in match-work-to-route.ts
 * with DB-backed per-task-class minimums (roadmap_workforce.reliability_floor).
 *
 * Read path: matchWorkToRoute consults getReliabilityFloor(task_class) before
 * filtering candidates. The caller caches the result for the duration of a
 * dispatch cycle to avoid per-candidate round-trips.
 */

import { query as _poolQuery } from "../../infra/postgres/pool.ts";
import { enqueueNotification as _enqueueNotif } from "../notifications/enqueue.ts";

// Test injection hooks.
let _query: typeof _poolQuery = _poolQuery;
let _notify: typeof _enqueueNotif = _enqueueNotif;
export function _setQueryForTest(fn: typeof _poolQuery): void { _query = fn; }
export function _setNotifyForTest(fn: typeof _enqueueNotif): void { _notify = fn; }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FloorEntry {
  task_class: string;
  min_score: number;
}

// ---------------------------------------------------------------------------
// Read: floor lookup with fallback
// ---------------------------------------------------------------------------

/** In-process cache: invalidated every 60 s to pick up operator updates. */
let _cache: Map<string, number> | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 60_000;

export async function loadFloorCache(): Promise<Map<string, number>> {
  if (_cache && Date.now() < _cacheExpiry) return _cache;

  const { rows } = await _query<{ task_class: string; min_score: string }>(
    `SELECT task_class, min_score FROM roadmap_workforce.reliability_floor`,
    [],
  );

  const m = new Map<string, number>();
  for (const r of rows) m.set(r.task_class, parseFloat(r.min_score));
  _cache = m;
  _cacheExpiry = Date.now() + CACHE_TTL_MS;
  return m;
}

/**
 * Return the reliability floor for task_class, falling back to a heuristic
 * when the table has no row for that class.
 * Fallback: unknown classes get 0.50 (mid-tier bar).
 */
export async function getReliabilityFloor(taskClass: string): Promise<number> {
  const floors = await loadFloorCache();
  return floors.get(taskClass) ?? 0.50;
}

/** Synchronous variant for tests — pass a pre-loaded map. */
export function getReliabilityFloorSync(
  taskClass: string,
  floors: Map<string, number>,
): number {
  return floors.get(taskClass) ?? 0.50;
}

// ---------------------------------------------------------------------------
// Alert: emit when a downshift attempt crosses the floor
// ---------------------------------------------------------------------------

/**
 * AC-3: emit a WARN notification when a locked task_class has no eligible route
 * above its floor. Never silent — the operator must see this.
 */
export async function alertFloorViolation(opts: {
  taskClass: string;
  floor: number;
  bestReliability: number;
  proposalId?: number | null;
}): Promise<void> {
  const { taskClass, floor, bestReliability, proposalId } = opts;
  const body =
    `reliability_floor_violation: task_class=${taskClass} requires floor≥${floor.toFixed(2)} ` +
    `but best available route scored ${bestReliability.toFixed(3)}` +
    (proposalId ? ` (proposal_id=${proposalId})` : "") +
    `. Downshift BLOCKED. Route locked class to no_eligible_route.`;

  try {
    await _notify({ severity: "WARN", kind: "floor_violation", body });
  } catch (err) {
    console.error("[P3313] floor_violation alert failed (non-blocking):", err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------
// Write: operator pin/ban override (AC-5)
// ---------------------------------------------------------------------------

export interface RouteClassOverride {
  task_class: string;
  route_id: number;
  action: "pin" | "ban";
  reason?: string;
  created_by: string;
  expires_at?: Date | null;
}

export async function upsertRouteClassOverride(o: RouteClassOverride): Promise<void> {
  await _query(
    `INSERT INTO roadmap_workforce.route_class_override
       (task_class, route_id, action, reason, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (task_class, route_id)
     DO UPDATE SET action=$3, reason=$4, created_by=$5, expires_at=$6, created_at=now()`,
    [o.task_class, o.route_id, o.action, o.reason ?? null, o.created_by, o.expires_at ?? null],
  );
}

export async function deleteRouteClassOverride(taskClass: string, routeId: number): Promise<void> {
  await _query(
    `DELETE FROM roadmap_workforce.route_class_override WHERE task_class=$1 AND route_id=$2`,
    [taskClass, routeId],
  );
}

export async function getActiveOverrides(taskClass: string): Promise<Array<{ route_id: number; action: "pin" | "ban" }>> {
  const { rows } = await _query<{ route_id: number; action: string }>(
    `SELECT route_id, action FROM roadmap_workforce.route_class_override
     WHERE task_class = $1
       AND (expires_at IS NULL OR expires_at > now())`,
    [taskClass],
  );
  return rows.map((r) => ({ route_id: r.route_id, action: r.action as "pin" | "ban" }));
}
