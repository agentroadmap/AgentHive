/**
 * Test suite for P516: Per-project git repository configuration
 * Tests cover: project registry resolution, worktree validation, health checks
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

describe('P516: Per-project git repository configuration', () => {
  let testProjectId: bigint;
  let testWorktreeDir: string;

  before(async () => {
    // Create a temporary worktree directory for testing
    testWorktreeDir = await mkdtemp(join('/tmp', 'p516-test-'));
    console.log(`Test worktree created: ${testWorktreeDir}`);

    // AC-2: Insert test project into registry with repository config
    // This validates that the schema migration adds the required columns
    const { createTenantPool } = await import('../postgres/pool-registry.ts');
    const pool = createTenantPool('agenthive');

    // Insert test project
    const insertResult = await pool.query(
      `INSERT INTO roadmap.project (slug, project_id, git_repo_url, git_default_branch, worktree_root)
       VALUES ($1, DEFAULT, $2, $3, $4)
       RETURNING project_id`,
      ['test-p516', 'git@gitlab.local:tenants/test-p516.git', 'main', testWorktreeDir],
    );

    testProjectId = insertResult.rows[0].project_id as bigint;
    console.log(`Test project inserted with id: ${testProjectId}`);
  });

  after(async () => {
    // Clean up test project from registry
    const { createTenantPool } = await import('../postgres/pool-registry.ts');
    const pool = createTenantPool('agenthive');

    await pool.query(
      'DELETE FROM roadmap.project WHERE slug = $1',
      ['test-p516'],
    );

    // Clean up temporary directory
    await rm(testWorktreeDir, { recursive: true, force: true });
    console.log(`Test project and worktree cleaned up`);
  });

  it('AC-2: Registry UPDATE succeeds and SELECT returns updated row', async () => {
    const { createTenantPool } = await import('../postgres/pool-registry.ts');
    const pool = createTenantPool('agenthive');

    // Update git_repo_url
    const updateResult = await pool.query(
      `UPDATE roadmap.project
       SET git_repo_url = $1
       WHERE slug = $2
       RETURNING git_repo_url, git_default_branch`,
      ['git@gitlab.local:tenants/test-p516-updated.git', 'test-p516'],
    );

    assert.equal(updateResult.rows.length, 1);
    assert.equal(updateResult.rows[0].git_repo_url, 'git@gitlab.local:tenants/test-p516-updated.git');
    assert.equal(updateResult.rows[0].git_default_branch, 'main');

    // Verify SELECT returns the updated value
    const selectResult = await pool.query(
      'SELECT git_repo_url, git_default_branch FROM roadmap.project WHERE slug = $1',
      ['test-p516'],
    );

    assert.equal(selectResult.rows.length, 1);
    assert.equal(selectResult.rows[0].git_repo_url, 'git@gitlab.local:tenants/test-p516-updated.git');
  });

  it('AC-3: getProjectRepoConfig resolves project by slug', async () => {
    const { getProjectRepoConfig } = await import('../postgres/project-config.ts');

    const config = await getProjectRepoConfig('test-p516');

    assert.equal(config.slug, 'test-p516');
    assert.equal(config.project_id, testProjectId);
    assert.equal(config.git_repo_url, 'git@gitlab.local:tenants/test-p516-updated.git');
    assert.equal(config.git_default_branch, 'main');
    assert.equal(config.worktree_root, testWorktreeDir);
  });

  it('AC-3: getProjectRepoConfig resolves project by numeric project_id', async () => {
    const { getProjectRepoConfig } = await import('../postgres/project-config.ts');

    const config = await getProjectRepoConfig(testProjectId.toString());

    assert.equal(config.slug, 'test-p516');
    assert.equal(config.project_id, testProjectId);
  });

  it('AC-3: getProjectRepoConfig throws ProjectNotFound for non-existent project', async () => {
    const { getProjectRepoConfig, ProjectNotFound } = await import('../postgres/project-config.ts');

    await assert.rejects(
      () => getProjectRepoConfig('nonexistent-project'),
      ProjectNotFound,
    );
  });

  it('AC-7: validateProjectWorktree accepts valid worktree', async () => {
    // Create a .git file to simulate a valid git worktree
    const fs = await import('fs/promises');
    await fs.writeFile(join(testWorktreeDir, '.git'), 'gitdir: ../\.git/worktrees/test-p516\n');

    const { validateProjectWorktree } = await import('../postgres/project-config.ts');
    const result = await validateProjectWorktree('test-p516');

    assert.equal(result.status, 'ok');
    assert.equal(result.is_valid_git_worktree, true);
    assert.equal(result.worktree_exists, true);
  });

  it('AC-7: validateProjectWorktree rejects non-existent worktree', async () => {
    const { createTenantPool } = await import('../postgres/pool-registry.ts');
    const pool = createTenantPool('agenthive');

    // Insert project with non-existent worktree
    await pool.query(
      `INSERT INTO roadmap.project (slug, project_id, git_repo_url, git_default_branch, worktree_root)
       VALUES ($1, DEFAULT, $2, $3, $4)`,
      ['test-nonexistent', 'git@test', 'main', '/nonexistent/path/to/worktree'],
    );

    const { validateProjectWorktree } = await import('../postgres/project-config.ts');
    const result = await validateProjectWorktree('test-nonexistent');

    assert.equal(result.status, 'error');
    assert.equal(result.is_valid_git_worktree, false);
    assert.equal(result.worktree_exists, false);

    // Cleanup
    await pool.query('DELETE FROM roadmap.project WHERE slug = $1', ['test-nonexistent']);
  });

  it('AC-7: validateProjectWorktree rejects directory without .git', async () => {
    const { createTenantPool } = await import('../postgres/pool-registry.ts');
    const pool = createTenantPool('agenthive');
    const fs = await import('fs/promises');

    // Create a temporary directory without .git
    const emptyDir = await mkdtemp(join('/tmp', 'p516-empty-'));

    // Insert project pointing to the empty directory
    await pool.query(
      `INSERT INTO roadmap.project (slug, project_id, git_repo_url, git_default_branch, worktree_root)
       VALUES ($1, DEFAULT, $2, $3, $4)`,
      ['test-empty-dir', 'git@test', 'main', emptyDir],
    );

    const { validateProjectWorktree } = await import('../postgres/project-config.ts');
    const result = await validateProjectWorktree('test-empty-dir');

    assert.equal(result.status, 'error');
    assert.equal(result.is_valid_git_worktree, false);
    assert.equal(result.worktree_exists, true);

    // Cleanup
    await pool.query('DELETE FROM roadmap.project WHERE slug = $1', ['test-empty-dir']);
    await rm(emptyDir, { recursive: true, force: true });
  });

  it('AC-8: validateProjectSetup returns ok for valid setup', async () => {
    const fs = await import('fs/promises');
    await fs.writeFile(join(testWorktreeDir, '.git'), 'gitdir: ../\.git/worktrees/test-p516\n');

    const { validateProjectSetup } = await import('../postgres/project-config.ts');
    const result = await validateProjectSetup('test-p516');

    assert.equal(result.status, 'ok');
    assert.equal(result.messages.length > 0, true);
    assert.ok(result.messages.some((m: string) => m.includes('✓')));
  });

  it('AC-8: validateProjectSetup returns error with details for invalid setup', async () => {
    const { createTenantPool } = await import('../postgres/pool-registry.ts');
    const pool = createTenantPool('agenthive');

    // Insert invalid project
    await pool.query(
      `INSERT INTO roadmap.project (slug, project_id, git_repo_url, git_default_branch, worktree_root)
       VALUES ($1, DEFAULT, $2, $3, $4)`,
      ['test-invalid', null, 'main', '/invalid/path'],
    );

    const { validateProjectSetup } = await import('../postgres/project-config.ts');
    const result = await validateProjectSetup('test-invalid');

    assert.equal(result.status, 'error');
    assert.ok(result.messages.some((m: string) => m.includes('✗')));

    // Cleanup
    await pool.query('DELETE FROM roadmap.project WHERE slug = $1', ['test-invalid']);
  });
});
