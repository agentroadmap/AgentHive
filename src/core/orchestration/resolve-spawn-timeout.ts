/**
 * V3-C8 (P1440) AC-3: Spawn Timeout Resolution
 *
 * Implements the documented cascade for determining spawn timeout:
 *   1. Environment override: AGENTHIVE_SPAWN_TIMEOUT_MS
 *   2. Database/route budget: model_routes row timeout column (if exists)
 *   3. Role-based default: roleTimeoutMs(role)
 *   4. System default: 1_200_000ms (20 minutes)
 *
 * Each layer is consulted in order; first non-null value wins.
 * This allows operator to:
 *   - Tune globally via env var
 *   - Per-route tune via DB column
 *   - Per-role tune via roleTimeoutMs defaults
 */

import { query } from "../../infra/postgres/pool.ts";

/**
 * Role-based timeout defaults.
 * These are fallback values when no env or DB override is present.
 *
 * Historical context (P463/P472):
 *   - 600s default was fine for gate adjudication (read + write decision)
 *   - but killed developers mid-flight; real implementation work needs 30-60 min
 */
function roleTimeoutMs(role: string | undefined | null): number {
  const r = (role ?? "").toLowerCase();
  if (r.includes("developer")) return 3_600_000; // 60 min
  if (r.includes("e2e")) return 1_800_000; // 30 min
  if (
    r.includes("architect") ||
    r.includes("researcher") ||
    r.includes("enhancer")
  ) {
    return 1_500_000; // 25 min
  }
  return 600_000; // 10 min — gates, reviews, default
}

const DEFAULT_SPAWN_TIMEOUT_MS = 1_200_000; // 20 min system default
let routeTimeoutColumnExists: boolean | undefined;

/**
 * Check if the route_timeout_ms column exists in model_routes.
 * Cached per process.
 */
async function checkRouteTimeoutColumnExists(): Promise<boolean> {
  if (routeTimeoutColumnExists !== undefined) {
    return routeTimeoutColumnExists;
  }

  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='roadmap' AND table_name='model_routes'
        AND column_name='route_timeout_ms'
    ) AS exists`,
  );

  routeTimeoutColumnExists = rows[0]?.exists ?? false;
  return routeTimeoutColumnExists;
}

/**
 * Query the database for a route's timeout override.
 * Returns null if the column doesn't exist, the route doesn't exist, or no override is set.
 */
async function queryRouteTimeout(
  routeId: bigint | null | undefined,
): Promise<number | null> {
  if (!routeId) return null;

  const columnExists = await checkRouteTimeoutColumnExists();
  if (!columnExists) return null;

  const { rows } = await query<{ route_timeout_ms: number | null }>(
    `SELECT route_timeout_ms FROM roadmap.model_routes WHERE id = $1`,
    [routeId],
  );

  return rows[0]?.route_timeout_ms ?? null;
}

export interface ResolveSpawnTimeoutOpts {
  /** Role name (developer, reviewer, gate-review, architect, etc.) */
  role?: string;
  /** Provider name (claude, codex, gemini, etc.) */
  provider?: string;
  /** Stage name (DRAFT, REVIEW, DEVELOP, MERGE, COMPLETE) */
  stage?: string;
  /** Model route ID for DB lookup. */
  routeId?: bigint | null;
}

/**
 * Resolve spawn timeout in priority order:
 *   1. AGENTHIVE_SPAWN_TIMEOUT_MS env var (hard override)
 *   2. model_routes.route_timeout_ms (per-route DB column, if exists)
 *   3. roleTimeoutMs(role) (role-based default)
 *   4. DEFAULT_SPAWN_TIMEOUT_MS (20 min system default)
 *
 * @param opts Timeout resolution context
 * @returns Timeout in milliseconds
 */
export async function resolveSpawnTimeout(
  opts: ResolveSpawnTimeoutOpts = {},
): Promise<number> {
  // Layer 1: Environment override (highest priority)
  const envOverride = process.env.AGENTHIVE_SPAWN_TIMEOUT_MS;
  if (envOverride) {
    const parsed = Number(envOverride);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Layer 2: Database/route budget (if route ID provided and column exists)
  if (opts.routeId) {
    const routeTimeout = await queryRouteTimeout(opts.routeId);
    if (routeTimeout !== null && routeTimeout > 0) {
      return routeTimeout;
    }
  }

  // Layer 3: Role-based default
  const roleDefault = roleTimeoutMs(opts.role);
  if (roleDefault > 0) {
    return roleDefault;
  }

  // Layer 4: System default
  return DEFAULT_SPAWN_TIMEOUT_MS;
}

/**
 * Synchronous version for use in synchronous contexts (e.g., spawn request assembly).
 * Skips Layer 2 (DB query), uses Layers 1, 3, 4 only.
 */
export function resolveSpawnTimeoutSync(
  opts: ResolveSpawnTimeoutOpts = {},
): number {
  // Layer 1: Environment override
  const envOverride = process.env.AGENTHIVE_SPAWN_TIMEOUT_MS;
  if (envOverride) {
    const parsed = Number(envOverride);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Layer 3: Role-based default
  const roleDefault = roleTimeoutMs(opts.role);
  if (roleDefault > 0) {
    return roleDefault;
  }

  // Layer 4: System default
  return DEFAULT_SPAWN_TIMEOUT_MS;
}
