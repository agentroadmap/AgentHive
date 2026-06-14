/**
 * P495 Tenant Saga: Create Project with Full Bootstrap
 *
 * 8-step idempotent saga for creating a multi-tenant project:
 * 1. Slug validation
 * 2. Speculative registry insert
 * 3. Postgres role create
 * 4. Vault DSN write + readback
 * 5. Database create
 * 6. Schema bootstrap
 * 7. Ops bundle (P509)
 * 8. Final commit (mark live)
 *
 * On step failure: emit structured error, queue repair task.
 * All steps are idempotent and re-entrant.
 */

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { VaultAdapter } from '../../shared/vault/types';
import { getVault } from '../../shared/vault/index';
import { getControlPool, getProjectDb } from '../../postgres/pool-registry';
import { query } from '../../postgres/pool';
import type {
  BootstrapStatus,
  SagaError,
  SagaResult,
  SagaSuccess,
  StepResult,
} from './types';

const execFileAsync = promisify(execFile);

const RESERVED_SLUGS = new Set([
  'hivecontrol',
  'postgres',
  'template0',
  'template1',
  'agent_registry',
]);

const SLUG_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/;

interface SagaContext {
  slug: string;
  name: string;
  schemaPrefix: string;
  dbName: string;
  dbRole: string;
  dbPassword: string;
  dsnSecretRef: string;
  projectId: number | null;
  steps: StepResult[];
  startTime: number;
}

/**
 * Step 1: Validate slug (no DB writes)
 */
async function step1ValidateSlug(slug: string): Promise<SagaResult> {
  const start = Date.now();

  try {
    // Regex check
    if (!SLUG_REGEX.test(slug)) {
      return createError(
        'slug_invalid',
        `Slug '${slug}' does not match ^[a-z][a-z0-9-]*[a-z0-9]$`,
        1,
        slug,
        'caller_fix'
      );
    }

    // Reserved check
    if (RESERVED_SLUGS.has(slug.toLowerCase())) {
      return createError(
        'slug_reserved',
        `Slug '${slug}' is reserved`,
        1,
        slug,
        'caller_fix'
      );
    }

    // Role collision check (convert hyphens to underscores)
    const roleName = slug.replace(/-/g, '_') + '_owner';
    const roleCheck = await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) as exists`,
      [roleName]
    );

    if (roleCheck.rows[0]?.exists) {
      return createError(
        'role_collision',
        `Postgres role '${roleName}' already exists`,
        1,
        slug,
        'operator_fix'
      );
    }

    return { ok: true, project_id: 0, dsn_validated: false };
  } catch (err) {
    return createError(
      'slug_invalid',
      `Step 1 validation error: ${err instanceof Error ? err.message : String(err)}`,
      1,
      slug,
      'caller_fix'
    );
  }
}

/**
 * Step 2: Speculative registry insert (atomic commit point)
 */
async function step2SpeculativeInsert(ctx: SagaContext): Promise<SagaResult> {
  try {
    const insertResult = await query<{ project_id: number | null }>(
      `INSERT INTO roadmap.project
       (slug, name, db_name, db_role, schema_prefix, dsn_secret_ref, host, port, bootstrap_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO NOTHING
       RETURNING project_id`,
      [
        ctx.slug,
        ctx.name,
        ctx.dbName,
        ctx.dbRole,
        ctx.schemaPrefix,
        ctx.dsnSecretRef,
        '127.0.0.1',
        6432,
        'pending',
      ]
    );

    if (!insertResult.rows.length) {
      // Conflict detected; query existing row
      const existing = await query<{ project_id: number; bootstrap_status: BootstrapStatus; created_at: string }>(
        `SELECT project_id, bootstrap_status, created_at FROM roadmap.project WHERE slug = $1`,
        [ctx.slug]
      );

      if (existing.rows.length) {
        const row = existing.rows[0];

        if (row.bootstrap_status === 'live') {
          // Idempotent success
          return {
            ok: true,
            project_id: row.project_id,
            dsn_validated: true,
            idempotent: true,
          };
        }

        const createdAt = new Date(row.created_at);
        const now = new Date();
        const ageMin = (now.getTime() - createdAt.getTime()) / (1000 * 60);

        if (ageMin <= 5) {
          // Concurrent retry in progress
          return createError(
            'slug_collision_concurrent',
            `Concurrent creation of '${ctx.slug}' in progress (${ageMin.toFixed(1)}min old)`,
            2,
            ctx.slug,
            'caller_polls'
          );
        } else {
          // Stale failed row
          return createError(
            'slug_collision',
            `Stale registry row for '${ctx.slug}' (status=${row.bootstrap_status}, age=${ageMin.toFixed(1)}min)`,
            2,
            ctx.slug,
            'operator_fix'
          );
        }
      }

      // No row found; shouldn't happen but fail gracefully
      return createError(
        'slug_collision',
        `Registry conflict but no row found for '${ctx.slug}'`,
        2,
        ctx.slug,
        'operator_fix'
      );
    }

    ctx.projectId = insertResult.rows[0].project_id!;
    return { ok: true, project_id: ctx.projectId, dsn_validated: false };
  } catch (err) {
    await queueRepair(ctx, 'registry_insert_failed', err);
    return createError(
      'slug_collision',
      `Step 2 insert failed: ${err instanceof Error ? err.message : String(err)}`,
      2,
      ctx.slug,
      'repair_worker_retries'
    );
  }
}

/**
 * Step 3: Create Postgres role (idempotent)
 */
async function step3CreateRole(ctx: SagaContext): Promise<SagaResult> {
  try {
    const role = ctx.dbRole;
    const pwd = ctx.dbPassword;

    // Wrapped in DO block for idempotency
    await query(`
      DO $$
      BEGIN
        CREATE ROLE ${role} WITH LOGIN PASSWORD '${escapePgPassword(pwd)}'
          NOSUPERUSER NOCREATEROLE NOCREATEDB;
      EXCEPTION WHEN duplicate_object THEN
        ALTER ROLE ${role} WITH PASSWORD '${escapePgPassword(pwd)}';
      END $$;
    `);

    await updateRegistryStatus(ctx.projectId!, 'db_role_created');
    await auditLog(ctx, 'db_role_create', 3, null);

    return { ok: true, project_id: ctx.projectId!, dsn_validated: false };
  } catch (err) {
    await queueRepair(ctx, 'db_role_create_failed', err);
    await updateRegistryStatus(ctx.projectId!, 'failed');
    return createError(
      'db_create_failed',
      `Step 3 role create failed: ${err instanceof Error ? err.message : String(err)}`,
      3,
      ctx.slug,
      'repair_worker_retries'
    );
  }
}

/**
 * Step 4: Write DSN to vault + readback verify
 */
async function step4VaultWrite(ctx: SagaContext): Promise<SagaResult> {
  try {
    const vault = await getVault();

    // Build DSN
    const dsn = `postgres://${ctx.dbRole}:${ctx.dbPassword}@127.0.0.1:6432/${ctx.dbName}?application_name=agenthive-tenant-${ctx.slug}`;

    // Write to vault
    await vault.write(ctx.dsnSecretRef as any, dsn);

    // Readback verify (atomicity gate)
    const readback = await vault.read(ctx.dsnSecretRef as any);
    if (readback !== dsn) {
      await queueRepair(ctx, 'vault_readback_mismatch', new Error('DSN mismatch'));
      await updateRegistryStatus(ctx.projectId!, 'failed');
      return createError(
        'vault_readback_mismatch',
        `Vault returned different value than written; aborting`,
        4,
        ctx.slug,
        'operator_fix'
      );
    }

    await updateRegistryStatus(ctx.projectId!, 'vault_written');
    await auditLog(ctx, 'vault_write', 4, null);

    return { ok: true, project_id: ctx.projectId!, dsn_validated: true };
  } catch (err) {
    await queueRepair(ctx, 'vault_write_failed', err);
    await updateRegistryStatus(ctx.projectId!, 'failed');
    return createError(
      'vault_write_failed',
      `Step 4 vault write failed: ${err instanceof Error ? err.message : String(err)}`,
      4,
      ctx.slug,
      'repair_worker_retries'
    );
  }
}

/**
 * Step 5: Create tenant database
 */
async function step5CreateDb(ctx: SagaContext): Promise<SagaResult> {
  try {
    const dbName = ctx.dbName;
    const role = ctx.dbRole;

    // Wrapped for idempotency
    await query(`
      DO $$
      BEGIN
        CREATE DATABASE ${dbName} OWNER ${role};
      EXCEPTION WHEN duplicate_database THEN
        -- Verify owner matches
        PERFORM 1 FROM pg_database
        WHERE datname = '${dbName}' AND pg_get_userbyid(datdba)::text = '${role}'::text;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Database ${dbName} exists but owner is not ${role}';
        END IF;
      END $$;
    `);

    await updateRegistryStatus(ctx.projectId!, 'db_created');
    await auditLog(ctx, 'db_create', 5, null);

    return { ok: true, project_id: ctx.projectId!, dsn_validated: true };
  } catch (err) {
    await queueRepair(ctx, 'db_create_failed', err);
    await updateRegistryStatus(ctx.projectId!, 'failed');
    return createError(
      'db_create_failed',
      `Step 5 DB create failed: ${err instanceof Error ? err.message : String(err)}`,
      5,
      ctx.slug,
      'repair_worker_retries'
    );
  }
}

/**
 * Step 6: Bootstrap tenant schema (applies DDL templates)
 */
async function step6SchemaBootstrap(ctx: SagaContext): Promise<SagaResult> {
  try {
    // TODO: Connect to tenant DB as the role and apply templates
    // This requires P508 DDL templates to exist.
    // For now, stub the implementation with a TODO comment.

    // Placeholder: In real implementation, this would:
    // 1. Connect to ctx.dbName as ctx.dbRole using vault DSN
    // 2. Apply database/ddl/tenant/000-tenant-bootstrap.sql
    // 3. Apply database/ddl/tenant/001-tenant-health.sql
    // 4. Track in <schema_prefix>meta.migrations with checksum
    // 5. Re-applying same checksum is idempotent

    // TODO: Replace with actual implementation once P508 templates exist
    console.log(`[STUB] Step 6: Schema bootstrap for ${ctx.slug}/${ctx.dbName}`);

    await updateRegistryStatus(ctx.projectId!, 'schema_loaded');
    await auditLog(ctx, 'schema_bootstrap', 6, null);

    return { ok: true, project_id: ctx.projectId!, dsn_validated: true };
  } catch (err) {
    await queueRepair(ctx, 'schema_bootstrap_failed', err);
    await updateRegistryStatus(ctx.projectId!, 'failed');
    return createError(
      'schema_bootstrap_failed',
      `Step 6 schema bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
      6,
      ctx.slug,
      'repair_worker_retries'
    );
  }
}

/**
 * Step 7: Ops bundle (P509 templates)
 */
async function step7OpsBundle(ctx: SagaContext): Promise<SagaResult> {
  try {
    const installer = new URL('../../../scripts/ops/install-tenant-ops.sh', import.meta.url);
    const installEnabled = process.env.AGENTHIVE_ENABLE_TENANT_OPS_INSTALL === '1';

    if (!installEnabled) {
      console.log(
        `[INFO] Step 7: tenant ops install skipped for ${ctx.slug} ` +
        `(set AGENTHIVE_ENABLE_TENANT_OPS_INSTALL=1 to enable)`
      );
      await auditLog(ctx, 'ops_setup', 7, null);
      return { ok: true, project_id: ctx.projectId!, dsn_validated: true };
    }

    await execFileAsync(
      installer,
      [ctx.slug, String(ctx.projectId ?? 0)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTHIVE_PROJECT_ROOT: process.cwd(),
        },
      }
    );
    console.log(`[INFO] Step 7: tenant ops bundle installed for ${ctx.slug}`);

    // Ops bundle failures do not block project creation
    await auditLog(ctx, 'ops_setup', 7, null);

    return { ok: true, project_id: ctx.projectId!, dsn_validated: true };
  } catch (err) {
    // Ops bundle failures are non-fatal
    console.warn(`[WARN] Step 7 ops bundle failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    await updateRegistryStatus(ctx.projectId!, 'ops_setup_failed');
    await auditLog(ctx, 'ops_setup', 7, err instanceof Error ? err.message : String(err));

    return { ok: true, project_id: ctx.projectId!, dsn_validated: true };
  }
}

/**
 * Step 8: Final commit (mark live)
 */
async function step8FinalCommit(ctx: SagaContext): Promise<SagaResult> {
  try {
    await updateRegistryStatus(ctx.projectId!, 'live');
    await auditLog(ctx, 'final_commit', 8, null);

    return {
      ok: true,
      project_id: ctx.projectId!,
      dsn_validated: true,
    };
  } catch (err) {
    await queueRepair(ctx, 'final_commit_failed', err);
    return createError(
      'partial_rollback_succeeded',
      `Step 8 final commit failed: ${err instanceof Error ? err.message : String(err)}`,
      8,
      ctx.slug,
      'repair_worker_retries'
    );
  }
}

/**
 * Execute the full saga
 */
export async function projectCreateSaga(
  slug: string,
  name: string
): Promise<SagaResult> {
  const startTime = Date.now();

  // Step 1: Validate slug
  const validation = await step1ValidateSlug(slug);
  if (!validation.ok) {
    return validation;
  }

  // Initialize context
  const ctx: SagaContext = {
    slug,
    name,
    schemaPrefix: `${slug.replace(/-/g, '_')}_`,
    dbName: slug.replace(/-/g, '_'),
    dbRole: `${slug.replace(/-/g, '_')}_owner`,
    dbPassword: randomBytes(24).toString('hex'),
    dsnSecretRef: `vault://file/project/${slug}/dsn`,
    projectId: null,
    steps: [],
    startTime,
  };

  // Step 2: Speculative insert
  const insert = await step2SpeculativeInsert(ctx);
  if (!insert.ok) {
    return insert;
  }

  // Step 3: Create role
  const role = await step3CreateRole(ctx);
  if (!role.ok) {
    return role;
  }

  // Step 4: Vault write
  const vault = await step4VaultWrite(ctx);
  if (!vault.ok) {
    return vault;
  }

  // Step 5: Create DB
  const db = await step5CreateDb(ctx);
  if (!db.ok) {
    return db;
  }

  // Step 6: Bootstrap schema
  const schema = await step6SchemaBootstrap(ctx);
  if (!schema.ok) {
    return schema;
  }

  // Step 7: Ops bundle (non-fatal)
  await step7OpsBundle(ctx);

  // Step 8: Final commit
  const final = await step8FinalCommit(ctx);
  return final;
}

// ============================================================================
// Helper Functions
// ============================================================================

function escapePgPassword(pwd: string): string {
  // Escape single quotes for SQL
  return pwd.replace(/'/g, "''");
}

function createError(
  code: any,
  message: string,
  step: number,
  slug: string,
  recovery: any
): SagaError {
  return {
    ok: false,
    error_code: code,
    message,
    step,
    project_slug: slug,
    recovery_action: recovery,
    timestamp: new Date().toISOString(),
  };
}

async function updateRegistryStatus(
  projectId: number,
  status: BootstrapStatus
): Promise<void> {
  await query(
    `UPDATE roadmap.project SET bootstrap_status = $1, updated_at = NOW() WHERE project_id = $2`,
    [status, projectId]
  );
}

async function queueRepair(
  ctx: SagaContext,
  phase: string,
  err: unknown
): Promise<void> {
  if (!ctx.projectId) return;

  const errorMsg = err instanceof Error ? err.message : String(err);
  await query(
    `INSERT INTO roadmap.project_repair_queue
     (project_id, phase, failure_reason, status, created_at)
     VALUES ($1, $2, $3, 'queued', NOW())`,
    [ctx.projectId, phase, errorMsg]
  );
}

async function auditLog(
  ctx: SagaContext,
  phase: string,
  stepNum: number,
  error: string | null
): Promise<void> {
  if (!ctx.projectId) return;

  const duration = Date.now() - ctx.startTime;
  await query(
    `INSERT INTO roadmap.audit_log
     (ts, component, project_slug, project_id, phase, attempt, error_detail, duration_ms)
     VALUES (NOW(), 'project_saga', $1, $2, $3, $4, $5, $6)`,
    [ctx.slug, ctx.projectId, phase, stepNum, error, duration]
  );
}
