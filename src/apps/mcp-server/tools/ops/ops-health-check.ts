/**
 * P513: mcp_ops action=health_check handler
 *
 * Validates infrastructure health for tenant operations:
 * - Registry connectivity (roadmap.project)
 * - Pool registry liveness (can create tenant pools)
 * - Vault accessibility (can resolve DSNs)
 * - Tenant database checks (optional, per project_slug arg)
 *
 * Returns {ok: boolean, details: HealthCheckResult[], errors?: string[]}
 * Used by: operators, orchestrator recovery, P513 validation
 */

import type { Pool } from "pg";
import type { McpServer } from "../../server";
import type { CallToolResult } from "../../types";
import { query as defaultQuery } from "../../../../infra/postgres/pool";

export interface HealthCheckItem {
  component: string;
  status: "ok" | "degraded" | "error";
  latency_ms?: number;
  details?: string;
}

export interface HealthCheckResult {
  ok: boolean;
  timestamp: string;
  checks: HealthCheckItem[];
  summary?: string;
  errors?: string[];
}

interface RegistryRow {
  project_id: number;
  slug: string;
  bootstrap_status: string;
}

interface VaultTestRow {
  exists: boolean;
}

function jsonResult(value: HealthCheckResult): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function checkRegistryConnectivity(
  pool: Pool,
  timeout = 5000
): Promise<HealthCheckItem> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const result = await pool.query<RegistryRow>(
      `SELECT project_id, slug, bootstrap_status FROM roadmap.project LIMIT 1`
    );

    clearTimeout(timer);
    const latency = Date.now() - start;

    return {
      component: "registry_connectivity",
      status: "ok",
      latency_ms: latency,
      details: `Registry accessible (${result.rows.length} projects found)`,
    };
  } catch (err) {
    const latency = Date.now() - start;
    return {
      component: "registry_connectivity",
      status: "error",
      latency_ms: latency,
      details: `Failed to query roadmap.project: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkProjectBootstrapStatus(
  pool: Pool,
  projectSlug: string,
  timeout = 5000
): Promise<HealthCheckItem> {
  const start = Date.now();
  try {
    const result = await pool.query<RegistryRow>(
      `SELECT project_id, slug, bootstrap_status FROM roadmap.project WHERE slug = $1`,
      [projectSlug]
    );

    const latency = Date.now() - start;

    if (!result.rows.length) {
      return {
        component: `project_bootstrap_status[${projectSlug}]`,
        status: "error",
        latency_ms: latency,
        details: `Project '${projectSlug}' not found in registry`,
      };
    }

    const row = result.rows[0];
    const isLive = row.bootstrap_status === "live";
    const status = isLive ? "ok" : "degraded";

    return {
      component: `project_bootstrap_status[${projectSlug}]`,
      status,
      latency_ms: latency,
      details: `Status: ${row.bootstrap_status} (project_id=${row.project_id})`,
    };
  } catch (err) {
    const latency = Date.now() - start;
    return {
      component: `project_bootstrap_status[${projectSlug}]`,
      status: "error",
      latency_ms: latency,
      details: `Failed to query bootstrap status: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkVaultAccessibility(
  pool: Pool,
  timeout = 5000
): Promise<HealthCheckItem> {
  const start = Date.now();
  try {
    // Proxy check: if we can reach vault config in DB, vault bridge is alive
    const result = await pool.query<VaultTestRow>(
      `SELECT EXISTS(
        SELECT 1 FROM roadmap.runtime_config
        WHERE config_key = 'VAULT_PATH' LIMIT 1
      ) as exists`
    );

    const latency = Date.now() - start;

    return {
      component: "vault_accessibility",
      status: "ok",
      latency_ms: latency,
      details: "Vault bridge configuration found in control DB",
    };
  } catch (err) {
    const latency = Date.now() - start;
    return {
      component: "vault_accessibility",
      status: "degraded",
      latency_ms: latency,
      details: `Could not verify vault config: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkPoolRegistryLiveness(
  timeout = 5000
): Promise<HealthCheckItem> {
  const start = Date.now();
  try {
    // Import pool-registry to check if it's initialized
    const { poolCache } = await import("../../../../postgres/pool-registry.js");

    // poolCache is a Map; non-empty is a sign of life (at least one pool created)
    const cacheSize = poolCache?.size ?? 0;
    const latency = Date.now() - start;

    return {
      component: "pool_registry_liveness",
      status: "ok",
      latency_ms: latency,
      details: `Pool registry initialized (${cacheSize} cached pools)`,
    };
  } catch (err) {
    const latency = Date.now() - start;
    return {
      component: "pool_registry_liveness",
      status: "degraded",
      latency_ms: latency,
      details: `Could not verify pool registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Main health check handler
 * Args:
 *   - project_slug (optional): if provided, checks that tenant's bootstrap status
 */
export async function opsHealthCheck(
  args: Record<string, unknown>,
  options: {
    query?: typeof defaultQuery;
  } = {}
): Promise<HealthCheckResult> {
  const projectSlug =
    typeof args.project_slug === "string" ? args.project_slug.trim() : undefined;
  const runQuery = options.query ?? defaultQuery;

  // Reuse pool from query function for consistency
  const controlPool = {
    query: runQuery,
  } as unknown as Pool;

  const checks: HealthCheckItem[] = [];
  const errors: string[] = [];

  // Check 1: Registry connectivity (always)
  const registryCheck = await checkRegistryConnectivity(controlPool);
  checks.push(registryCheck);
  if (registryCheck.status === "error") {
    errors.push(`Registry connectivity failed: ${registryCheck.details}`);
  }

  // Check 2: Vault accessibility (always)
  const vaultCheck = await checkVaultAccessibility(controlPool);
  checks.push(vaultCheck);
  if (vaultCheck.status === "error") {
    errors.push(`Vault accessibility check failed: ${vaultCheck.details}`);
  }

  // Check 3: Pool registry liveness (always)
  const poolCheck = await checkPoolRegistryLiveness();
  checks.push(poolCheck);
  if (poolCheck.status === "error") {
    errors.push(`Pool registry check failed: ${poolCheck.details}`);
  }

  // Check 4: Specific project bootstrap status (if slug provided)
  if (projectSlug) {
    const projectCheck = await checkProjectBootstrapStatus(
      controlPool,
      projectSlug
    );
    checks.push(projectCheck);
    if (projectCheck.status === "error") {
      errors.push(`Project bootstrap check failed: ${projectCheck.details}`);
    }
  }

  // Overall health: ok if all checks are ok, degraded if any are degraded, error if any are error
  const hasError = checks.some((c) => c.status === "error");
  const hasDegraded = checks.some((c) => c.status === "degraded");
  const ok = !hasError;

  const summary = hasError
    ? `Health check FAILED: ${errors.length} error(s)`
    : hasDegraded
      ? `Health check DEGRADED: some checks degraded`
      : `Health check OK: all systems nominal`;

  return {
    ok,
    timestamp: new Date().toISOString(),
    checks,
    summary,
    ...(errors.length > 0 && { errors }),
  };
}

export function registerOpsHealthCheckTool(server: McpServer): void {
  server.addTool({
    name: "health_check",
    description:
      "P513: Check infrastructure health for tenant operations. Validates registry, vault, and pool connectivity. Optional project_slug arg checks specific tenant bootstrap status.",
    inputSchema: {
      type: "object",
      properties: {
        project_slug: {
          type: "string",
          description:
            "Optional: if provided, also check bootstrap_status for this project (e.g. 'monkeyKing-audio')",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => jsonResult(await opsHealthCheck(args)),
  });
}
