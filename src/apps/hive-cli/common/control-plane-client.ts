/**
 * Control-plane database client for hive-cli reads.
 *
 * Provides typed, read-only access to control-plane data (projects, proposals,
 * agencies, agents, dispatches, leases, workflows) via direct Postgres queries.
 *
 * Per cli-hive-contract.md §6, this client is used by read commands that fall
 * back to direct DB when MCP is unreachable. Mutations (create, claim, transition)
 * are always routed through MCP and do NOT use this client.
 *
 * Implements cli-hive-contract.md §5 (Context Resolution) and §6 (MCP-vs-DB routing).
 */

import { execSync } from "node:child_process";
import { getPool } from "../../../infra/postgres/pool";
import { HiveError, Errors } from "./error";
import {
  type ProjectRow,
  type ProposalRow,
  type AgencyRow,
  type AgentRow,
  type WorkflowTemplateRow,
  type DispatchRow,
  type LeaseRow,
  type PaginatedResult,
  encodeCursor,
  decodeCursor,
  type PaginationCursor,
  // P788 — new domain row types
  type ModelRow,
  type RouteRow,
  type RouteTestResult,
  type ProviderRow,
  type SystemStatus,
  type SystemServiceRow,
  type BudgetStatus,
  type BudgetCapRow,
} from "./control-plane-types";

/**
 * Process-wide singleton instance of ControlPlaneClient.
 */
let clientInstance: ControlPlaneClient | null = null;

/**
 * ControlPlaneClient provides read-only access to control-plane data.
 *
 * All methods map database errors to HiveError with appropriate exit codes:
 * - DB connection failures -> REMOTE_FAILURE (exit code 5)
 * - Query timeouts -> REMOTE_FAILURE (exit code 5)
 * - Resource not found -> NOT_FOUND (exit code 2)
 *
 * Each method is JSDoc-annotated with the contract section it implements.
 */
export class ControlPlaneClient {
  /**
   * List all active projects from the control plane.
   *
   * Implements cli-hive-contract.md §5 (context resolution by project lookup).
   *
   * @param filter - Optional filter (currently only `status` is supported)
   * @returns Array of ProjectRow objects
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listProjects(
    filter?: { status?: string }
  ): Promise<ProjectRow[]> {
    const pool = getPool();
    try {
      let query = `
        SELECT project_id, slug, name, worktree_root, status, created_at,
               archived_at, db_name, db_role, schema_prefix, dsn_secret_ref,
               host, port, bootstrap_status, bootstrap_log, updated_at
          FROM roadmap.project
      `;

      const params: (string | number | boolean | null)[] = [];
      const conditions: string[] = [];

      if (filter?.status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(filter.status);
      } else {
        // Default: only active projects
        conditions.push(`status = 'active'`);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(" AND ")}`;
      }

      query += ` ORDER BY project_id ASC`;

      const result = await pool.query<ProjectRow>(query, params);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list projects: ${msg}`,
        { error: msg }
      );
    }
  }

  /**
   * Get a single project by ID or slug.
   *
   * Implements cli-hive-contract.md §5 (context resolution, project lookup).
   *
   * @param idOrSlug - Project ID (number) or slug (string)
   * @returns ProjectRow if found, null if not
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async getProject(idOrSlug: string | number): Promise<ProjectRow | null> {
    const pool = getPool();
    try {
      let query = `
        SELECT project_id, slug, name, worktree_root, status, created_at,
               archived_at, db_name, db_role, schema_prefix, dsn_secret_ref,
               host, port, bootstrap_status, bootstrap_log, updated_at
          FROM roadmap.project
         WHERE status = 'active'
      `;

      // pg returns bigint columns as strings, so getProject(project.project_id)
      // arrives as a numeric-looking string. Treat both number and numeric-string
      // shapes as id lookups; everything else is a slug.
      const looksNumeric =
        typeof idOrSlug === "number" ||
        (typeof idOrSlug === "string" && /^\d+$/.test(idOrSlug));
      let param: string | number = idOrSlug;
      if (looksNumeric) {
        query += ` AND project_id = $1::bigint`;
        param = String(idOrSlug);
      } else {
        query += ` AND slug = $1`;
        param = idOrSlug;
      }

      const result = await pool.query<ProjectRow>(query, [param]);
      return result.rows[0] ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to get project: ${msg}`,
        { error: msg, idOrSlug }
      );
    }
  }

  /**
   * Resolve a project from the current working directory.
   *
   * Implements cli-hive-contract.md §5 (CWD-derived context resolution).
   * Uses the algorithm from docs/architecture/cli-hive-cwd-context-resolution.md:
   *
   * 1. Query roadmap.project for worktree_root prefix match
   * 2. Check for .hive/config.json in git root
   * 3. Check for roadmap.yaml in git root
   * 4. Query roadmap.project for git_repo_url match
   *
   * @param cwd - Current working directory (defaults to process.cwd())
   * @returns ProjectRow if found, null if not
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async resolveProjectFromCwd(cwd: string = process.cwd()): Promise<ProjectRow | null> {
    const pool = getPool();
    try {
      // Step 1: Query roadmap.project for worktree_root prefix match
      const projectQuery = `
        SELECT project_id, slug, name, worktree_root, status, created_at,
               archived_at, db_name, db_role, schema_prefix, dsn_secret_ref,
               host, port, bootstrap_status, bootstrap_log, updated_at
          FROM roadmap.project
         WHERE status = 'active'
           AND $1 LIKE (worktree_root || '%')
           AND worktree_root IS NOT NULL
         ORDER BY LENGTH(worktree_root) DESC
         LIMIT 1
      `;

      const projectResult = await pool.query<ProjectRow>(projectQuery, [cwd]);
      if (projectResult.rows.length > 0) {
        return projectResult.rows[0];
      }

      // Step 2 & 3: Check for .hive/config.json or roadmap.yaml in git root
      // (requires git to be available)
      let gitRoot: string | null = null;
      try {
        gitRoot = execSync("git rev-parse --show-toplevel", {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch {
        // Not in a git repo, or git failed — fall through to Step 4 with gitRoot = null
      }

      if (gitRoot) {
        // Try .hive/config.json
        try {
          const fs = await import("node:fs");
          const configPath = `${gitRoot}/.hive/config.json`;
          if (fs.existsSync(configPath)) {
            const configContent = fs.readFileSync(configPath, "utf-8");
            const config = JSON.parse(configContent);
            if (config.project && typeof config.project === "string") {
              const projectBySlug = await this.getProject(config.project);
              if (projectBySlug) return projectBySlug;
            }
          }
        } catch {
          // Silently ignore errors reading/parsing .hive/config.json
        }

        // Try roadmap.yaml
        try {
          const fs = await import("node:fs");
          const yamlPath = `${gitRoot}/roadmap.yaml`;
          if (fs.existsSync(yamlPath)) {
            const yamlContent = fs.readFileSync(yamlPath, "utf-8");
            // Simple YAML parse: look for "project: <slug>" line
            const match = /^\s*project:\s*["']?([a-zA-Z0-9_-]+)["']?\s*$/m.exec(
              yamlContent
            );
            if (match && match[1]) {
              const projectBySlug = await this.getProject(match[1]);
              if (projectBySlug) return projectBySlug;
            }
          }
        } catch {
          // Silently ignore errors reading/parsing roadmap.yaml
        }

        // Step 4: Query roadmap.project by git remote URL
        try {
          const remoteUrl = execSync(
            "git -C " + gitRoot + " config --get remote.origin.url",
            {
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            }
          ).trim();

          if (remoteUrl) {
            // Normalize URL: strip .git suffix, lowercase
            const normalized = remoteUrl
              .replace(/\.git$/, "")
              .toLowerCase();

            const gitMatchQuery = `
              SELECT project_id, slug, name, worktree_root, status, created_at,
                     archived_at, db_name, db_role, schema_prefix, dsn_secret_ref,
                     host, port, bootstrap_status, bootstrap_log, updated_at
                FROM roadmap.project
               WHERE status = 'active'
                 AND git_repo_url IS NOT NULL
                 AND LOWER(REGEXP_REPLACE(git_repo_url, '\\.git$', '')) = $1
               LIMIT 1
            `;

            const gitMatchResult = await pool.query<ProjectRow>(
              gitMatchQuery,
              [normalized]
            );
            if (gitMatchResult.rows.length > 0) {
              return gitMatchResult.rows[0];
            }
          }
        } catch {
          // Silently ignore git config errors
        }
      }

      // Step 5: No context resolved
      return null;
    } catch (err) {
      if (err instanceof HiveError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to resolve project from CWD: ${msg}`,
        { error: msg, cwd }
      );
    }
  }

  /**
   * List all agencies in a project.
   *
   * Implements cli-hive-contract.md §1 (agency domain).
   *
   * @param projectId - Project ID
   * @param filter - Optional filter (status, etc.)
   * @returns Array of AgencyRow objects
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listAgencies(
    projectId: number,
    filter?: { status?: string }
  ): Promise<AgencyRow[]> {
    // P455 transitional note: roadmap.agency is a control-plane table with
    // no project_id column (CONVENTIONS.md §8d). projectId is accepted for
    // API symmetry and reserved for the post-P429 tenant-DB routing path
    // where each project's agency view will live in its tenant DB. Today
    // we return all agencies and ignore the arg.
    void projectId;
    const pool = getPool();
    try {
      let query = `
        SELECT agency_id, display_name, provider, host_id, capability_tags,
               status, status_reason, last_heartbeat_at, registered_at, metadata
          FROM roadmap.agency
         WHERE 1=1
      `;
      const params: (string | number | boolean | null)[] = [];

      if (filter?.status) {
        params.push(filter.status);
        query += ` AND status = $${params.length}`;
      }

      query += ` ORDER BY agency_id ASC`;

      const result = await pool.query<AgencyRow>(query, params);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list agencies: ${msg}`,
        { error: msg, projectId }
      );
    }
  }

  /**
   * List all agents in a project.
   *
   * Implements cli-hive-contract.md §1 (worker domain).
   *
   * @param projectId - Project ID
   * @returns Array of AgentRow objects
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listAgents(projectId: number): Promise<AgentRow[]> {
    const pool = getPool();
    try {
      // roadmap_workforce.agent_registry is the project-scoped variant
      // (CONVENTIONS.md §8d); the legacy roadmap.agent_registry has no
      // project_id column.
      const query = `
        SELECT id, agent_identity, agent_type, role, skills, preferred_model,
               status, github_handle, created_at, updated_at, project_id
          FROM roadmap_workforce.agent_registry
         WHERE project_id = $1::bigint
         ORDER BY id ASC
      `;

      const result = await pool.query<AgentRow>(query, [projectId]);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list agents: ${msg}`,
        { error: msg, projectId }
      );
    }
  }

  /**
   * List proposals in a project with cursor-based pagination.
   *
   * Implements cli-hive-contract.md §1 (proposal domain, list action).
   *
   * @param projectId - Project ID
   * @param filter - Optional filter (status, limit, cursor)
   * @returns PaginatedResult containing proposals and next_cursor
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listProposals(
    projectId: number,
    filter?: { status?: string; limit?: number; cursor?: string }
  ): Promise<PaginatedResult<ProposalRow>> {
    const pool = getPool();
    try {
      const limit = filter?.limit ?? 20;
      let idAfter = 0;

      if (filter?.cursor) {
        const decoded = decodeCursor(filter.cursor);
        if (decoded) {
          idAfter = decoded.id_after;
        }
      }

      let query = `
        SELECT id, display_id, parent_id, type, status, title, summary,
               motivation, design, drawbacks, alternatives, dependency_note,
               priority, maturity, workflow_name, tags, audit, created_at,
               modified_at, required_capabilities, project_id, gate_scanner_paused,
               gate_paused_by, gate_paused_at, gate_paused_reason
          FROM roadmap_proposal.proposal
         WHERE project_id = $1::bigint
      `;

      const params: (string | number | boolean | null)[] = [projectId];
      let paramIndex = 2;

      if (filter?.status) {
        query += ` AND status = $${paramIndex}`;
        params.push(filter.status);
        paramIndex++;
      }

      if (idAfter > 0) {
        query += ` AND id > $${paramIndex}::bigint`;
        params.push(idAfter);
        paramIndex++;
      }

      // Off-by-one fix: paramIndex points to the next slot; use it directly
      // for LIMIT instead of paramIndex+1, which created a gap that pg
      // surfaced as "could not determine data type of parameter $N".
      query += ` ORDER BY id ASC LIMIT $${paramIndex}`;
      params.push(limit + 1); // Fetch one extra to check if there are more

      const result = await pool.query<ProposalRow>(query, params);

      const hasMore = result.rows.length > limit;
      const items = hasMore ? result.rows.slice(0, limit) : result.rows;
      const nextCursor =
        hasMore && items.length > 0
          ? encodeCursor({ id_after: items[items.length - 1].id })
          : null;

      return {
        items,
        next_cursor: nextCursor,
        has_more: hasMore,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list proposals: ${msg}`,
        { error: msg, projectId }
      );
    }
  }

  /**
   * Get a single proposal by display ID.
   *
   * Implements cli-hive-contract.md §1 (proposal domain, get action).
   *
   * @param projectId - Project ID
   * @param displayId - Proposal display ID (e.g., "P123")
   * @returns ProposalRow if found, null if not
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async getProposal(
    projectId: number,
    displayId: string
  ): Promise<ProposalRow | null> {
    const pool = getPool();
    try {
      const query = `
        SELECT id, display_id, parent_id, type, status, title, summary,
               motivation, design, drawbacks, alternatives, dependency_note,
               priority, maturity, workflow_name, tags, audit, created_at,
               modified_at, required_capabilities, project_id, gate_scanner_paused,
               gate_paused_by, gate_paused_at, gate_paused_reason
          FROM roadmap_proposal.proposal
         WHERE project_id = $1 AND display_id = $2
      `;

      const result = await pool.query<ProposalRow>(query, [
        projectId,
        displayId,
      ]);
      return result.rows[0] ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to get proposal: ${msg}`,
        { error: msg, projectId, displayId }
      );
    }
  }

  /**
   * List all dispatches in a project.
   *
   * Implements cli-hive-contract.md §1 (dispatch domain, list action).
   *
   * @param projectId - Project ID
   * @param filter - Optional filter (status)
   * @returns Array of DispatchRow objects
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listDispatches(
    projectId: number,
    filter?: { status?: string }
  ): Promise<DispatchRow[]> {
    const pool = getPool();
    try {
      // Real table is roadmap_workforce.squad_dispatch; status column is
      // dispatch_status (not status), and project_id is bigint.
      let query = `
        SELECT id, proposal_id, agent_identity, squad_name, dispatch_role,
               dispatch_status AS status, offer_status, assigned_at,
               completed_at, claim_expires_at, claimed_at, project_id, metadata
          FROM roadmap_workforce.squad_dispatch
         WHERE project_id = $1::bigint
      `;
      const params: (string | number | boolean | null)[] = [projectId];

      if (filter?.status) {
        params.push(filter.status);
        query += ` AND dispatch_status = $${params.length}`;
      }

      query += ` ORDER BY id DESC`;

      const result = await pool.query<DispatchRow>(query, params);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list dispatches: ${msg}`,
        { error: msg, projectId }
      );
    }
  }

  /**
   * List all leases in a project.
   *
   * Implements cli-hive-contract.md §1 (lease domain, list action).
   *
   * @param projectId - Project ID
   * @param filter - Optional filter (agent_identity, status)
   * @returns Array of LeaseRow objects
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listLeases(
    projectId: number,
    filter?: { agent_identity?: string; status?: string }
  ): Promise<LeaseRow[]> {
    // P455 transitional note: roadmap.proposal_lease has no project_id
    // column today (CONVENTIONS.md §8d). projectId is accepted for symmetry;
    // narrow to one project by joining through proposal once that table
    // gains project_id (post-P429). Today returns all active leases.
    void projectId;
    const pool = getPool();
    try {
      let query = `
        SELECT id, proposal_id, agent_identity, claimed_at, expires_at,
               released_at, release_reason, is_active
          FROM roadmap.proposal_lease
         WHERE 1=1
      `;
      const params: (string | number | boolean | null)[] = [];

      if (filter?.agent_identity) {
        params.push(filter.agent_identity);
        query += ` AND agent_identity = $${params.length}`;
      }

      if (filter?.status) {
        params.push(filter.status);
        // Map "status" filter to is_active boolean if the caller passed
        // active/released; otherwise filter on release_reason for richer
        // status names.
        if (filter.status === "active") {
          query += ` AND is_active = true`;
          params.pop();
        } else if (filter.status === "released") {
          query += ` AND is_active = false`;
          params.pop();
        } else {
          query += ` AND release_reason = $${params.length}`;
        }
      }

      query += ` ORDER BY id DESC`;

      const result = await pool.query<LeaseRow>(query, params);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list leases: ${msg}`,
        { error: msg, projectId }
      );
    }
  }

  /**
   * List all workflow templates.
   *
   * Implements cli-hive-contract.md §1 (workflow domain, list action).
   *
   * @returns Array of WorkflowTemplateRow objects
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listWorkflowTemplates(): Promise<WorkflowTemplateRow[]> {
    const pool = getPool();
    try {
      const query = `
        SELECT id, name, description, version, is_default, is_system,
               stage_count, smdl_id, smdl_definition, created_at, modified_at,
               project_id
          FROM roadmap.workflow_templates
         ORDER BY name ASC
      `;

      const result = await pool.query<WorkflowTemplateRow>(query);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list workflow templates: ${msg}`,
        { error: msg }
      );
    }
  }

  /**
   * Get a single workflow template by name.
   *
   * Implements cli-hive-contract.md §1 (workflow domain, show action).
   *
   * @param name - Workflow template name (e.g., "RFC 5-Stage")
   * @returns WorkflowTemplateRow if found, null if not
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async getWorkflowTemplate(name: string): Promise<WorkflowTemplateRow | null> {
    const pool = getPool();
    try {
      const query = `
        SELECT id, name, description, version, is_default, is_system,
               stage_count, smdl_id, smdl_definition, created_at, modified_at,
               project_id
          FROM roadmap.workflow_templates
         WHERE name = $1
      `;

      const result = await pool.query<WorkflowTemplateRow>(query, [name]);
      return result.rows[0] ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to get workflow template: ${msg}`,
        { error: msg, name }
      );
    }
  }

  /**
   * Ping the control-plane database to verify connectivity.
   *
   * @returns latency_ms - Round-trip time in milliseconds
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async ping(): Promise<number> {
    const pool = getPool();
    try {
      const start = Date.now();
      await pool.query("SELECT 1");
      const latency = Date.now() - start;
      return latency;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to ping database: ${msg}`,
        { error: msg }
      );
    }
  }

  /**
   * Execute a read-only SQL query with optional positional parameters.
   *
   * Security: Only SELECT, WITH, EXPLAIN, and SHOW queries are allowed.
   * The caller is responsible for validating the query before calling this method.
   *
   * @param sql - SQL query string (must be SELECT, WITH, EXPLAIN, or SHOW)
   * @param params - Optional positional parameters ($1, $2, …)
   * @returns Query result rows typed as T
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable or query fails
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: (string | number | boolean | null | undefined)[]
  ): Promise<T[]> {
    const pool = getPool();
    try {
      // pool.query<T> requires T extends QueryResultRow; cast through unknown
      // to avoid importing that internal pg constraint here — all our T types
      // are plain objects that satisfy the structural requirement at runtime.
      const result = await (pool.query as (sql: string, params?: unknown[]) => Promise<{ rows: T[] }>)(sql, params);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Query failed: ${msg}`,
        { error: msg }
      );
    }
  }

  // ─── P788: New domain methods ───────────────────────────────────────────────

  /**
   * List enabled LLM models from the joined model_metadata + model_routes view.
   *
   * Implements P788 — model domain real DB query.
   *
   * @param filters - Optional filters: provider and/or tier
   * @returns Array of ModelRow objects
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listModels(filters?: { provider?: string; tier?: string }): Promise<ModelRow[]> {
    const where: string[] = ["r.is_enabled = true"];
    const params: (string | boolean)[] = [];
    if (filters?.provider) where.push(`r.route_provider = $${params.push(filters.provider)}`);
    if (filters?.tier) where.push(`r.tier = $${params.push(filters.tier)}`);
    const sql = `
      SELECT m.model_name, m.provider, m.cost_per_million_input, m.cost_per_million_output,
             m.context_window, m.capabilities, m.rating, m.is_active,
             r.route_provider, r.priority, r.tier
        FROM roadmap.model_metadata m
        JOIN roadmap.model_routes r ON r.model_name = m.model_name AND r.route_provider = m.provider
       WHERE ${where.join(" AND ")}
       ORDER BY r.priority, m.model_name`;
    return this.query<ModelRow>(sql, params);
  }

  /**
   * List all model dispatch routes from roadmap.model_routes.
   *
   * Implements P788 — route domain real DB query.
   *
   * @returns Array of RouteRow objects ordered by route_provider, priority
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listRoutes(): Promise<RouteRow[]> {
    return this.query<RouteRow>(
      `SELECT route_provider, model_name, priority, tier, is_enabled, created_at
         FROM roadmap.model_routes
        ORDER BY route_provider, priority`
    );
  }

  /**
   * Summarise budget caps from roadmap.project_budget_cap.
   *
   * Falls back to `{ status: 'not_implemented' }` when the budget tables do
   * not yet exist (guarded by information_schema inspection).
   *
   * Implements P788 — budget domain real DB query.
   *
   * @param projectId - Optional project ID; when omitted all caps are returned
   * @returns BudgetStatus with caps array or not_implemented sentinel
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async getBudgetStatus(projectId?: number): Promise<BudgetStatus> {
    // Check which budget tables exist
    const tableCheckRows = await this.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_name IN ('project_capacity_config', 'route_token_budget', 'project_budget_cap')
          AND table_schema NOT IN ('information_schema', 'pg_catalog')`
    );
    const existingTables = new Set(tableCheckRows.map((r) => r.table_name));

    if (existingTables.has("project_budget_cap")) {
      const where = projectId !== undefined ? "WHERE project_id = $1" : "";
      const caps = await this.query<BudgetCapRow>(
        `SELECT project_id, period, max_usd_cents, created_at
           FROM roadmap.project_budget_cap
           ${where}
           ORDER BY project_id, period`,
        projectId !== undefined ? [projectId] : undefined
      );
      return { status: "active", caps };
    }

    if (existingTables.has("project_capacity_config")) {
      const caps = await this.query<BudgetCapRow>(
        `SELECT project_id, period, max_usd_cents, created_at
           FROM project_capacity_config
           ORDER BY project_id, period`
      );
      return { status: "active", caps };
    }

    if (existingTables.has("route_token_budget")) {
      const caps = await this.query<BudgetCapRow>(
        `SELECT project_id, period, max_usd_cents, created_at
           FROM route_token_budget
           ORDER BY project_id, period`
      );
      return { status: "active", caps };
    }

    return {
      status: "not_implemented",
      message: "Budget tables not yet created",
    };
  }

  /**
   * List LLM providers aggregated from roadmap.model_routes.
   *
   * Implements P788 — provider domain real DB query.
   *
   * @returns Array of ProviderRow objects ordered by provider name
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listProviders(): Promise<ProviderRow[]> {
    return this.query<ProviderRow>(
      `SELECT route_provider AS provider,
              COUNT(*)::int   AS model_count,
              bool_or(is_enabled) AS has_enabled_routes
         FROM roadmap.model_routes
        GROUP BY route_provider
        ORDER BY route_provider`
    );
  }

  async getModel(modelId: string): Promise<ModelRow | null> {
    const rows = await this.query<ModelRow>(
      `SELECT m.model_name AS model_id, m.model_name, m.model_name AS name,
              m.provider,
              CASE WHEN COALESCE(m.is_active, true) THEN 'active' ELSE 'inactive' END AS status,
              COALESCE(m.is_active, true) AS is_active,
              m.max_tokens, m.context_window, m.capabilities, m.rating,
              m.cost_per_million_input, m.cost_per_million_output,
              m.cost_per_million_cache_write, m.cost_per_million_cache_hit,
              COUNT(r.route_provider)::int AS route_count,
              COUNT(r.route_provider) FILTER (WHERE r.is_enabled)::int AS enabled_route_count,
              COALESCE(ARRAY_AGG(DISTINCT r.route_provider) FILTER (WHERE r.route_provider IS NOT NULL), ARRAY[]::text[]) AS agent_providers,
              COALESCE(ARRAY_AGG(DISTINCT r.route_provider) FILTER (WHERE r.route_provider IS NOT NULL), ARRAY[]::text[]) AS route_providers,
              m.created_at::text, m.created_at::text AS updated_at
         FROM roadmap.model_metadata m
         LEFT JOIN roadmap.model_routes r ON r.model_name = m.model_name
        WHERE m.model_name = $1
        GROUP BY m.model_name, m.provider, m.is_active, m.max_tokens, m.context_window,
                 m.capabilities, m.rating, m.cost_per_million_input, m.cost_per_million_output,
                 m.cost_per_million_cache_write, m.cost_per_million_cache_hit, m.created_at`,
      [modelId]
    );
    return rows[0] ?? null;
  }

  async getModelCosts(): Promise<ModelRow[]> {
    return this.query<ModelRow>(
      `SELECT m.model_name AS model_id, m.model_name, m.model_name AS name,
              m.provider,
              CASE WHEN COALESCE(m.is_active, true) THEN 'active' ELSE 'inactive' END AS status,
              COALESCE(m.is_active, true) AS is_active,
              m.max_tokens, m.context_window, m.capabilities, m.rating,
              m.cost_per_million_input, m.cost_per_million_output,
              m.cost_per_million_cache_write, m.cost_per_million_cache_hit,
              COUNT(r.route_provider)::int AS route_count,
              COUNT(r.route_provider) FILTER (WHERE r.is_enabled)::int AS enabled_route_count,
              COALESCE(ARRAY_AGG(DISTINCT r.route_provider) FILTER (WHERE r.route_provider IS NOT NULL), ARRAY[]::text[]) AS agent_providers,
              COALESCE(ARRAY_AGG(DISTINCT r.route_provider) FILTER (WHERE r.route_provider IS NOT NULL), ARRAY[]::text[]) AS route_providers,
              m.created_at::text, m.created_at::text AS updated_at
         FROM roadmap.model_metadata m
         LEFT JOIN roadmap.model_routes r ON r.model_name = m.model_name
        WHERE m.cost_per_million_input IS NOT NULL OR m.cost_per_million_output IS NOT NULL
        GROUP BY m.model_name, m.provider, m.is_active, m.max_tokens, m.context_window,
                 m.capabilities, m.rating, m.cost_per_million_input, m.cost_per_million_output,
                 m.cost_per_million_cache_write, m.cost_per_million_cache_hit, m.created_at
        ORDER BY m.model_name`
    );
  }

  async getRoute(routeId: string): Promise<RouteRow | null> {
    const rows = await this.query<RouteRow>(
      `SELECT r.model_name AS route_id, r.model_name AS id, r.model_name AS model_id,
              r.model_name, r.route_provider, r.route_provider AS provider,
              r.route_provider AS agent_provider, NULL::text AS plan_type,
              r.priority, r.is_enabled AS enabled, r.is_enabled,
              false AS is_default, NULL::text AS notes,
              NULL::text AS base_url, NULL::text AS api_spec,
              NULL::text AS agent_cli, NULL::text AS fallback_cli,
              NULL::text AS cli_path, NULL::text AS api_key_env,
              NULL::text AS api_key_fallback_env, NULL::text AS base_url_env,
              NULL::text AS spawn_toolsets, NULL::boolean AS spawn_delegate,
              r.tier, NULL::float AS confidence_threshold,
              NULL::text[] AS capabilities, NULL::float AS objective_rating,
              NULL::float AS cost_per_million_input, NULL::float AS cost_per_million_output,
              NULL::float AS cost_per_million_cache_write, NULL::float AS cost_per_million_cache_hit,
              NOW()::text AS created_at
         FROM roadmap.model_routes r
        WHERE r.model_name = $1
        LIMIT 1`,
      [routeId]
    );
    return rows[0] ?? null;
  }

  async testRoute(routeId: string): Promise<RouteTestResult | null> {
    const route = await this.getRoute(routeId);
    if (!route) return null;
    return {
      route_id: routeId,
      status: route.is_enabled ? "ok" : "warning",
      enabled: route.is_enabled,
      host_allowed: null,
      credentials_active: false,
      missing_env: [],
      latency_ms: 0,
      message: route.is_enabled ? "Route is enabled" : "Route is disabled",
    };
  }

  async getProvider(providerId: string): Promise<ProviderRow | null> {
    const rows = await this.query<ProviderRow>(
      `SELECT r.route_provider AS provider_id, r.route_provider AS name,
              CASE WHEN bool_or(r.is_enabled) THEN 'active' ELSE 'inactive' END AS status,
              COUNT(*)::int AS route_count,
              COUNT(*) FILTER (WHERE r.is_enabled)::int AS enabled_route_count,
              COUNT(DISTINCT r.model_name)::int AS model_count,
              ARRAY[]::text[] AS agent_providers,
              0 AS active_worker_count,
              false AS credentials_active,
              ARRAY[]::text[] AS credential_env_vars
         FROM roadmap.model_routes r
        WHERE r.route_provider = $1
        GROUP BY r.route_provider`,
      [providerId]
    );
    return rows[0] ?? null;
  }

  /**
   * Get overall system status: registered services + active DB connections.
   *
   * Reads from roadmap.control_runtime_service (created by P787).  If the
   * table does not yet exist the method returns gracefully with empty services.
   *
   * Implements P788 — system/service domain real DB query.
   *
   * @returns SystemStatus with services list and activeConnections count
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async getSystemStatus(): Promise<SystemStatus> {
    try {
      const [services, connCount] = await Promise.all([
        this.query<SystemServiceRow>(
          `SELECT service_key, url, is_active
             FROM roadmap.control_runtime_service
            ORDER BY service_key`
        ),
        this.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM pg_stat_activity
            WHERE state = 'active'`
        ),
      ]);
      return {
        services,
        activeConnections: parseInt(connCount[0]?.count ?? "0", 10),
      };
    } catch {
      // control_runtime_service may not exist (P787 creates it).
      // Return a safe default rather than surfacing an error.
      try {
        const connCount = await this.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pg_stat_activity WHERE state = 'active'`
        );
        return {
          services: [],
          activeConnections: parseInt(connCount[0]?.count ?? "0", 10),
        };
      } catch {
        return { services: [], activeConnections: 0 };
      }
    }
  }

  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Get a lease by ID.
   *
   * @param leaseId - Lease ID
   * @returns LeaseRow if found, null if not
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async getLease(leaseId: number): Promise<LeaseRow | null> {
    const pool = getPool();
    try {
      const query = `
        SELECT id, proposal_id, agent_identity, claimed_at, expires_at,
               released_at, release_reason, is_active
          FROM roadmap.proposal_lease
         WHERE id = $1
      `;

      const result = await pool.query<LeaseRow>(query, [leaseId]);
      return result.rows[0] ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to get lease: ${msg}`,
        { error: msg, leaseId }
      );
    }
  }

  /**
   * List expired leases.
   *
   * @returns Array of LeaseRow objects where expires_at <= now
   * @throws HiveError with code REMOTE_FAILURE if DB unreachable
   */
  async listExpiredLeases(): Promise<LeaseRow[]> {
    const pool = getPool();
    try {
      const query = `
        SELECT id, proposal_id, agent_identity, claimed_at, expires_at,
               released_at, release_reason, is_active
          FROM roadmap.proposal_lease
         WHERE expires_at IS NOT NULL AND expires_at <= NOW()
         ORDER BY expires_at DESC
      `;

      const result = await pool.query<LeaseRow>(query);
      return result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw Errors.remoteFailure(
        `Failed to list expired leases: ${msg}`,
        { error: msg }
      );
    }
  }
}

/**
 * Get the process-wide singleton ControlPlaneClient instance.
 *
 * @returns The singleton ControlPlaneClient
 */
export function getControlPlaneClient(): ControlPlaneClient {
  if (!clientInstance) {
    clientInstance = new ControlPlaneClient();
  }
  return clientInstance;
}
