/**
 * P495 Tenant Saga Types
 *
 * Defines the saga step result, error codes, and recovery strategy enums.
 */

export type BootstrapStatus =
  | 'pending'
  | 'db_role_created'
  | 'db_created'
  | 'schema_loaded'
  | 'vault_written'
  | 'live'
  | 'failed'
  | 'ops_setup_failed';

export type ErrorCode =
  | 'slug_invalid'
  | 'slug_reserved'
  | 'role_collision'
  | 'slug_collision'
  | 'slug_collision_concurrent'
  | 'db_create_failed'
  | 'db_owner_mismatch'
  | 'vault_write_failed'
  | 'vault_readback_mismatch'
  | 'schema_bootstrap_failed'
  | 'ops_setup_failed'
  | 'partial_rollback_succeeded'
  | 'partial_rollback_failed_repair_queued';

export type RecoveryAction =
  | 'caller_fix'
  | 'operator_fix'
  | 'caller_polls'
  | 'repair_worker_retries';

export interface StepResult {
  step: number;
  status: 'success' | 'failure';
  phase: string;
  timestamp: string;
  duration_ms: number;
  error?: string;
}

export interface SagaError {
  error_code: ErrorCode;
  message: string;
  step: number;
  project_slug: string;
  recovery_action: RecoveryAction;
  timestamp: string;
}

export interface SagaSuccess {
  ok: true;
  project_id: number;
  dsn_validated: boolean;
  idempotent?: boolean;
}

export type SagaResult = SagaSuccess | SagaError;

export interface ProjectRegistryRow {
  project_id: number;
  slug: string;
  name: string;
  db_name: string;
  db_role: string;
  schema_prefix: string;
  dsn_secret_ref: string;
  host: string;
  port: number;
  bootstrap_status: BootstrapStatus;
  bootstrap_log: StepResult[];
  created_at: string;
  updated_at: string;
}

export interface ProjectRepairQueueRow {
  id: number;
  project_id: number;
  phase: string;
  failure_reason: string;
  attempt_count: number;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  status: 'queued' | 'in_progress' | 'completed' | 'escalated';
}

export interface AuditLogEntry {
  ts: string;
  component: string;
  project_slug: string;
  project_id: number;
  phase: string;
  attempt: number;
  error_detail: string | null;
  next_retry_at: string | null;
  duration_ms: number;
}
