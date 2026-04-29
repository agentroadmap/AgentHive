/**
 * AC-6: control_git.fn_worktree_policy
 *
 * Specificity order: (project+repo) > (project only) > (repo only) > global (NULL/NULL).
 * Returns NULL when no matching policy row exists.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from './helpers.js';
import type { Pool } from 'pg';

describe('P444: control_git.fn_worktree_policy', () => {
  let pool: Pool;

  // Use large sentinel IDs to avoid clashing with production rows
  const PROJECT_A = 88801n;
  const PROJECT_B = 88802n;
  const REPO_X    = 99901n;
  const REPO_Y    = 99902n;

  before(async () => {
    pool = createPool();
    // Seed policy rows in specificity order (most to least specific)
    await pool.query(`
      INSERT INTO control_git.worktree_policy (project_id, repo_id, worktree_root_pattern, description)
      VALUES
        ($1, $2, '/data/worktrees/proj-a-repo-x', 'project A + repo X (most specific)'),
        ($1, NULL, '/data/worktrees/proj-a-only',  'project A only'),
        (NULL, $2, '/data/worktrees/repo-x-only',  'repo X only'),
        (NULL, NULL, '/data/worktrees/global',      'global fallback')
      ON CONFLICT (project_id, repo_id) DO UPDATE SET
        worktree_root_pattern = EXCLUDED.worktree_root_pattern
    `, [PROJECT_A.toString(), REPO_X.toString()]);
  });

  after(async () => {
    await pool.query(`
      DELETE FROM control_git.worktree_policy
      WHERE (project_id = $1 OR project_id = $2 OR project_id IS NULL)
        AND (repo_id = $3 OR repo_id = $4 OR repo_id IS NULL)
    `, [PROJECT_A.toString(), PROJECT_B.toString(), REPO_X.toString(), REPO_Y.toString()]);
    await pool.end();
  });

  async function lookup(projectId: bigint | null, repoId: bigint | null): Promise<string | null> {
    const { rows } = await pool.query<{ worktree_root_pattern: string | null }>(
      `SELECT control_git.fn_worktree_policy($1, $2) AS worktree_root_pattern`,
      [projectId?.toString() ?? null, repoId?.toString() ?? null],
    );
    return rows[0]?.worktree_root_pattern ?? null;
  }

  it('(project+repo) match wins over less-specific rows', async () => {
    const result = await lookup(PROJECT_A, REPO_X);
    assert.equal(result, '/data/worktrees/proj-a-repo-x');
  });

  it('(project only) match returned when repo_id has no specific row', async () => {
    const result = await lookup(PROJECT_A, REPO_Y);
    assert.equal(result, '/data/worktrees/proj-a-only');
  });

  it('(repo only) match returned when project_id has no policy', async () => {
    const result = await lookup(PROJECT_B, REPO_X);
    assert.equal(result, '/data/worktrees/repo-x-only');
  });

  it('global (NULL/NULL) returned when no project or repo match', async () => {
    const result = await lookup(PROJECT_B, REPO_Y);
    assert.equal(result, '/data/worktrees/global');
  });

  it('returns NULL when no policy row matches at all', async () => {
    // Temporarily remove global row to test true-empty case
    await pool.query(
      `DELETE FROM control_git.worktree_policy WHERE project_id IS NULL AND repo_id IS NULL`,
    );
    const result = await lookup(PROJECT_B, REPO_Y);
    assert.equal(result, null);
    // Re-insert global row for other tests in this run
    await pool.query(`
      INSERT INTO control_git.worktree_policy (project_id, repo_id, worktree_root_pattern, description)
      VALUES (NULL, NULL, '/data/worktrees/global', 'global fallback')
      ON CONFLICT (project_id, repo_id) DO UPDATE SET worktree_root_pattern = EXCLUDED.worktree_root_pattern
    `);
  });

  it('NULL projectId with known repoId returns repo-only row', async () => {
    const result = await lookup(null, REPO_X);
    assert.equal(result, '/data/worktrees/repo-x-only');
  });

  it('known projectId with NULL repoId returns project-only row', async () => {
    const result = await lookup(PROJECT_A, null);
    assert.equal(result, '/data/worktrees/proj-a-only');
  });
});
