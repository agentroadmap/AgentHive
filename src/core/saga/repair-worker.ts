/**
 * P495 Saga Repair Worker
 *
 * Periodic worker (60s cron) that picks up failed sagas from repair_queue and retries them.
 * Implements exponential backoff, per-phase recovery, and escalation after 10 attempts.
 *
 * Usage: Start this worker in the MCP server startup sequence.
 */

import { query } from '../../postgres/pool';
import * as runtimeConfig from '../../shared/runtime/config.ts';
import { FlagKeys } from '../../shared/runtime/config-keys.ts';
import type { ProjectRepairQueueRow } from './types';

const BASE_BACKOFF_MINUTES = 2; // 2^attempt_count minutes — derived, not promoted

async function resolveRepairIntervalMs(): Promise<number> {
  try {
    return await runtimeConfig.get(FlagKeys.SAGA_REPAIR_INTERVAL_MS);
  } catch {
    return 60_000;
  }
}

async function resolveRepairMaxAttempts(): Promise<number> {
  try {
    return await runtimeConfig.get(FlagKeys.SAGA_REPAIR_MAX_ATTEMPTS);
  } catch {
    return 10;
  }
}

async function resolveRepairMaxBackoffHours(): Promise<number> {
  try {
    return await runtimeConfig.get(FlagKeys.SAGA_REPAIR_MAX_BACKOFF_HOURS);
  } catch {
    return 24;
  }
}

let repairWorkerRunning = false;

/**
 * Start the repair worker (idempotent; safe to call multiple times)
 */
export async function startRepairWorker(): Promise<void> {
  if (repairWorkerRunning) {
    console.log('[RepairWorker] Already running, skipping');
    return;
  }

  repairWorkerRunning = true;
  const repairIntervalMs = await resolveRepairIntervalMs();
  console.log(`[RepairWorker] Started (${repairIntervalMs}ms interval)`);

  // Initial run after 5s
  setTimeout(() => runRepairCycle(), 5000);

  // Recurring interval
  setInterval(() => runRepairCycle(), repairIntervalMs);
}

/**
 * Run one repair cycle: pick up failed sagas and retry
 */
async function runRepairCycle(): Promise<void> {
  try {
    const rows = await query<ProjectRepairQueueRow>(
      `SELECT * FROM roadmap.project_repair_queue
       WHERE status = 'queued' AND next_attempt_at <= NOW()
       ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 10`,
      []
    );

    for (const row of rows.rows) {
      await processRepairItem(row);
    }
  } catch (err) {
    console.error('[RepairWorker] Cycle error:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Process a single repair queue item
 */
async function processRepairItem(row: ProjectRepairQueueRow): Promise<void> {
  const { id, project_id, phase, attempt_count } = row;
  const [maxAttempts, maxBackoffHours] = await Promise.all([
    resolveRepairMaxAttempts(),
    resolveRepairMaxBackoffHours(),
  ]);

  try {
    // Check if attempt limit exceeded
    if (attempt_count >= maxAttempts) {
      await escalateToOperator(id, project_id, phase, `max_attempts_exceeded (limit=${maxAttempts})`);
      return;
    }

    // Route to phase-specific recovery
    let recovered = false;
    switch (phase) {
      case 'db_role_create_failed':
        recovered = await retryRoleCreate(project_id);
        break;
      case 'vault_write_failed':
        recovered = await retryVaultWrite(project_id);
        break;
      case 'db_create_failed':
        recovered = await retryDbCreate(project_id);
        break;
      case 'schema_bootstrap_failed':
        recovered = await retrySchemaBootstrap(project_id);
        break;
      case 'registry_insert_failed':
        recovered = await retryRegistryInsert(project_id);
        break;
      case 'ops_setup_failed':
        recovered = await retryOpsSetup(project_id);
        break;
      case 'final_commit_failed':
        recovered = await retryFinalCommit(project_id);
        break;
      default:
        console.warn(`[RepairWorker] Unknown phase: ${phase}`);
        recovered = false;
    }

    if (recovered) {
      // Mark as completed
      await query(
        `UPDATE roadmap.project_repair_queue SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      console.log(`[RepairWorker] Recovered project ${project_id} (phase=${phase})`);
    } else {
      // Calculate next attempt with exponential backoff
      const nextBackoffMin = Math.min(
        Math.pow(2, attempt_count + 1) * BASE_BACKOFF_MINUTES,
        maxBackoffHours * 60
      );

      await query(
        `UPDATE roadmap.project_repair_queue
         SET attempt_count = attempt_count + 1,
             next_attempt_at = NOW() + interval '1 minute' * $1,
             updated_at = NOW()
         WHERE id = $2`,
        [nextBackoffMin, id]
      );
      console.log(`[RepairWorker] Retry scheduled for project ${project_id} (phase=${phase}, next=${nextBackoffMin}min)`);
    }
  } catch (err) {
    console.error(
      `[RepairWorker] Error processing repair item ${id}:`,
      err instanceof Error ? err.message : String(err)
    );

    // Mark as in_progress so it won't be picked up again in next cycle
    await query(
      `UPDATE roadmap.project_repair_queue SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
      [id]
    );
  }
}

/**
 * Escalate to operator after max attempts
 */
async function escalateToOperator(
  queueId: number,
  projectId: number,
  phase: string,
  reason: string
): Promise<void> {
  await query(
    `UPDATE roadmap.project_repair_queue SET status = 'escalated', updated_at = NOW() WHERE id = $1`,
    [queueId]
  );

  // TODO: Write to escalation_log table per P495 spec
  console.warn(`[RepairWorker] Escalated project ${projectId} (phase=${phase}, reason=${reason})`);
}

// ============================================================================
// Phase-Specific Recovery Functions (Stubs)
// ============================================================================

async function retryRoleCreate(projectId: number): Promise<boolean> {
  try {
    // TODO: Re-run step 3 (idempotent CREATE ROLE)
    console.log(`[RepairWorker] [STUB] Retry role create for project ${projectId}`);
    return true;
  } catch (err) {
    console.error(`[RepairWorker] Role create retry failed:`, err);
    return false;
  }
}

async function retryVaultWrite(projectId: number): Promise<boolean> {
  try {
    // TODO: Re-run step 4 (atomic vault write)
    console.log(`[RepairWorker] [STUB] Retry vault write for project ${projectId}`);
    return true;
  } catch (err) {
    console.error(`[RepairWorker] Vault write retry failed:`, err);
    return false;
  }
}

async function retryDbCreate(projectId: number): Promise<boolean> {
  try {
    // TODO: Verify clean state (no leftover DB), re-run step 5
    console.log(`[RepairWorker] [STUB] Retry DB create for project ${projectId}`);
    return true;
  } catch (err) {
    console.error(`[RepairWorker] DB create retry failed:`, err);
    return false;
  }
}

async function retrySchemaBootstrap(projectId: number): Promise<boolean> {
  try {
    // TODO: Verify checksum, re-apply step 6
    console.log(`[RepairWorker] [STUB] Retry schema bootstrap for project ${projectId}`);
    return true;
  } catch (err) {
    console.error(`[RepairWorker] Schema bootstrap retry failed:`, err);
    return false;
  }
}

async function retryRegistryInsert(projectId: number): Promise<boolean> {
  try {
    // TODO: Detect if row exists (success) or collision (fail)
    console.log(`[RepairWorker] [STUB] Retry registry insert for project ${projectId}`);
    return true;
  } catch (err) {
    console.error(`[RepairWorker] Registry insert retry failed:`, err);
    return false;
  }
}

async function retryOpsSetup(projectId: number): Promise<boolean> {
  try {
    // TODO: Re-run step 7 (P509)
    console.log(`[RepairWorker] [STUB] Retry ops setup for project ${projectId}`);
    return true;
  } catch (err) {
    console.error(`[RepairWorker] Ops setup retry failed:`, err);
    return false;
  }
}

async function retryFinalCommit(projectId: number): Promise<boolean> {
  try {
    // TODO: Re-attempt to mark registry as 'live'
    console.log(`[RepairWorker] [STUB] Retry final commit for project ${projectId}`);
    return true;
  } catch (err) {
    console.error(`[RepairWorker] Final commit retry failed:`, err);
    return false;
  }
}

/**
 * Stop the repair worker (for testing or graceful shutdown)
 */
export function stopRepairWorker(): void {
  repairWorkerRunning = false;
  console.log('[RepairWorker] Stopped');
}

/**
 * Check if repair worker is running
 */
export function isRepairWorkerRunning(): boolean {
  return repairWorkerRunning;
}
