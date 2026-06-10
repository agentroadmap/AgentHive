/**
 * P516: Per-project git repository configuration and validation
 *
 * Provides resolution of project identities to git repository URLs,
 * default branches, and worktree roots. Acts as the bridge between
 * project registry (roadmap.project) and per-project code isolation.
 */

import { getProjectDb } from './pool-registry.ts';

// Error classes for project configuration
export class ProjectNotFound extends Error {
  constructor(identifier: string) {
    super(`Project not found: ${identifier}`);
    this.name = 'ProjectNotFound';
  }
}

export class ProjectRegistryQueryFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectRegistryQueryFailed';
  }
}

export interface ProjectRepoConfig {
  slug: string;
  project_id: bigint;
  git_repo_url: string | null;
  git_default_branch: string;
  worktree_root: string;
}

export interface ValidateWorktreeResult {
  status: 'ok' | 'error';
  details: string;
  is_valid_git_worktree: boolean;
  worktree_exists: boolean;
}

export interface ValidateSetupResult {
  status: 'ok' | 'error';
  messages: string[];
}

/**
 * Retrieve project repository configuration from registry
 * @param projectSlug - Project slug or numeric project_id (as string)
 * @returns Project configuration with repo URL, branch, and worktree path
 * @throws ProjectNotFound if project does not exist
 * @throws ProjectRegistryQueryFailed if database query fails
 */
export async function getProjectRepoConfig(
  projectSlug: string,
): Promise<ProjectRepoConfig> {
  try {
    const pool = await getProjectDb('agenthive');
    const result = await pool.query(
      `SELECT
        slug,
        project_id,
        git_repo_url,
        COALESCE(git_default_branch, 'main') as git_default_branch,
        worktree_root
      FROM roadmap.project
      WHERE slug = $1 OR project_id::text = $1
      LIMIT 1`,
      [projectSlug],
    );

    if (result.rows.length === 0) {
      throw new ProjectNotFound(projectSlug);
    }

    const row = result.rows[0];
    return {
      slug: row.slug as string,
      project_id: row.project_id as bigint,
      git_repo_url: row.git_repo_url as string | null,
      git_default_branch: row.git_default_branch as string,
      worktree_root: row.worktree_root as string,
    };
  } catch (error) {
    if (error instanceof ProjectNotFound) {
      throw error;
    }
    throw new ProjectRegistryQueryFailed(
      `Failed to query project registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Validate that a project's worktree directory exists and is valid
 * @param projectSlug - Project slug or numeric project_id
 * @returns Validation result with status and details
 */
export async function validateProjectWorktree(
  projectSlug: string,
): Promise<ValidateWorktreeResult> {
  try {
    const config = await getProjectRepoConfig(projectSlug);
    const fs = await import('fs');

    const worktreeExists = fs.existsSync(config.worktree_root);
    const gitExists = worktreeExists &&
      (fs.existsSync(`${config.worktree_root}/.git`) ||
        fs.existsSync(`${config.worktree_root}/.git`)); // check both file and dir

    if (!worktreeExists) {
      return {
        status: 'error',
        details: `Worktree directory does not exist: ${config.worktree_root}`,
        is_valid_git_worktree: false,
        worktree_exists: false,
      };
    }

    if (!gitExists) {
      return {
        status: 'error',
        details: `Directory exists but is not a git worktree: ${config.worktree_root}`,
        is_valid_git_worktree: false,
        worktree_exists: true,
      };
    }

    return {
      status: 'ok',
      details: `Worktree valid: ${config.worktree_root}`,
      is_valid_git_worktree: true,
      worktree_exists: true,
    };
  } catch (error) {
    return {
      status: 'error',
      details: error instanceof Error ? error.message : String(error),
      is_valid_git_worktree: false,
      worktree_exists: false,
    };
  }
}

/**
 * Comprehensive health check of project repository setup
 * @param projectSlug - Project slug or numeric project_id
 * @returns Health check result with all validation messages
 */
export async function validateProjectSetup(
  projectSlug: string,
): Promise<ValidateSetupResult> {
  const messages: string[] = [];

  try {
    const config = await getProjectRepoConfig(projectSlug);
    messages.push(`✓ Project registry entry found: ${config.slug} (id: ${config.project_id})`);

    if (!config.git_repo_url) {
      messages.push(`⚠ git_repo_url not set (required for push/pull)`);
    } else {
      messages.push(`✓ git_repo_url configured: ${config.git_repo_url}`);
    }

    messages.push(`✓ git_default_branch: ${config.git_default_branch}`);

    const worktreeCheck = await validateProjectWorktree(projectSlug);
    if (worktreeCheck.status === 'ok') {
      messages.push(`✓ Worktree valid: ${config.worktree_root}`);
    } else {
      messages.push(`✗ Worktree validation failed: ${worktreeCheck.details}`);
      return { status: 'error', messages };
    }

    return { status: 'ok', messages };
  } catch (error) {
    messages.push(`✗ Setup validation failed: ${error instanceof Error ? error.message : String(error)}`);
    return { status: 'error', messages };
  }
}
