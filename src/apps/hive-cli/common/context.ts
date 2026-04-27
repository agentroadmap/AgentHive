/**
 * Context resolver per cli-hive-contract.md §5.
 *
 * Implements the precedence hierarchy:
 * 1. Explicit flags (--project, --agency, --host)
 * 2. Environment variables (HIVE_PROJECT, HIVE_AGENCY, HIVE_HOST)
 * 3. CWD-derived (git worktree, .hive/config.json, roadmap.yaml, git remote)
 * 4. Control-plane default (user's primary project/agency)
 * 5. Fail-fast if unresolved
 */

import { HiveError } from "./error";

export interface ResolvedContext {
  project: string;
  agency?: string;
  host?: string;
  mcp_url?: string;
  db_host?: string;
  db_port?: number;
  resolved_at: string;
}

/**
 * Resolve the CLI context from flags, environment, CWD, and control plane.
 *
 * For Round 2, the CWD-derived branch (step 3) is stubbed with a TODO.
 * Control-plane integration is handled by the Backend Architect.
 */
export async function resolveContext(
  flags: {
    project?: string;
    agency?: string;
    host?: string;
  },
  env: Record<string, string | undefined> = process.env
): Promise<ResolvedContext> {
  // Step 1: Explicit flags (highest precedence)
  if (flags.project) {
    return {
      project: flags.project,
      agency: flags.agency,
      host: flags.host,
      resolved_at: new Date().toISOString(),
    };
  }

  // Step 2: Environment variables
  const envProject = env.HIVE_PROJECT;
  const envAgency = env.HIVE_AGENCY;
  const envHost = env.HIVE_HOST;

  if (envProject) {
    return {
      project: envProject,
      agency: envAgency || flags.agency,
      host: envHost || flags.host,
      resolved_at: new Date().toISOString(),
    };
  }

  // Step 3: CWD-derived (git worktree, .hive/config.json, roadmap.yaml, git remote)
  // TODO (Backend Architect): Implement CWD resolution per contract §5.
  // - Check if $PWD is under a git worktree registered in control_runtime.cubic
  // - If found, use cubic.agency_id and cubic.proposal_id to resolve agency and project
  // - If not, check for .hive/config.json in repo root with project and agency hints
  // - If not, check for roadmap.yaml in repo root for project and mcp.url hints
  // - If not, consult control_project.project_registry to match git_remote_url
  // - Return resolved context or undefined to fall back to step 4
  // See contract §5 "CWD-derived" section for full algorithm.
  const cwdResolved = await cwdDerivedContext();
  if (cwdResolved) {
    return {
      ...cwdResolved,
      agency: cwdResolved.agency || flags.agency,
      host: cwdResolved.host || flags.host,
      resolved_at: new Date().toISOString(),
    };
  }

  // Step 4: Control-plane default
  // TODO (Backend Architect): Query control_identity.human_user for default_project_id and default_agency_id
  // This requires control-plane client setup. For now, we fail-fast.

  // Step 5: Fail-fast if unresolved
  throw new HiveError(
    "NOT_FOUND",
    "Cannot resolve project/agency context.",
    {
      hint: "Set `--project`, `HIVE_PROJECT` env, `.hive/config.json`, or register default in control plane. See `hive help context`.",
      detail: {
        provided_flags: {
          project: flags.project ? "yes" : "no",
          agency: flags.agency ? "yes" : "no",
          host: flags.host ? "yes" : "no",
        },
        env_vars: {
          HIVE_PROJECT: envProject ? "set" : "unset",
          HIVE_AGENCY: envAgency ? "set" : "unset",
          HIVE_HOST: envHost ? "set" : "unset",
        },
      },
    }
  );
}

/**
 * Stub for CWD-derived context resolution.
 *
 * TODO (Backend Architect): Implement full algorithm per contract §5.
 * For now, returns undefined to allow fallback.
 */
async function cwdDerivedContext(): Promise<ResolvedContext | undefined> {
  // TODO: Implement CWD walk-up, git worktree detection, file reading
  // Returning undefined for now to enable fallback to step 4
  return undefined;
}

/**
 * Check if context is sufficient for a command (either has project or is a global command).
 *
 * Global commands (help, version, completion, init) don't require project context.
 */
export function isGlobalCommand(command: string): boolean {
  const globalCommands = ["help", "version", "completion", "init"];
  return globalCommands.includes(command);
}
