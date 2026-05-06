// src/apps/mcp-server/tools/backup/pg-handlers.ts
//
// P895 — Backup MCP tool handlers for agentHive2.
//
// Provides four actions:
//   - takeBackup: Initiate per-project or full DB backup
//   - verifyBackup: Check verification status
//   - listBackups: List backups with optional filters
//   - getBackupPolicy: Retrieve per-project backup policy

import { Database } from 'better-sqlite3';

interface TakeBackupArgs {
  project_id?: number | null;
  kind?: 'full' | 'schema';
}

interface VerifyBackupArgs {
  backup_id: string;
}

interface ListBackupsArgs {
  project_id?: number;
  verified_only?: boolean;
  limit?: number;
  offset?: number;
}

interface GetBackupPolicyArgs {
  project_id: number;
}

interface BackupRow {
  backup_id: string;
  project_id: number | null;
  taken_at: string;
  backup_kind: string;
  storage_uri: string;
  size_bytes: number | null;
  retention_until: string;
  verified_at: string | null;
  verification_note: string | null;
  created_at: string;
}

interface BackupPolicyRow {
  project_id: number;
  schedule_cron: string;
  retention_days_daily: number;
  retention_weeks_weekly: number;
  retention_months_monthly: number;
  target_uri_prefix: string;
  backup_kind: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export class PgBackupHandlers {
  constructor(private db: Database) {}

  takeBackup(args: TakeBackupArgs): { backup_id: string } {
    const projectId = args.project_id ?? null;
    const kind = args.kind ?? 'schema';

    if (kind !== 'full' && kind !== 'schema') {
      throw new Error('backup_kind must be "full" or "schema"');
    }

    if (kind === 'schema' && projectId === null) {
      throw new Error('project_id is required for schema backups');
    }

    // Lookup project slug for logging (optional)
    let projectSlug = '';
    if (projectId !== null) {
      const row = this.db
        .prepare('SELECT slug FROM core.project WHERE id = ?')
        .get(projectId) as { slug: string } | undefined;
      projectSlug = row?.slug ?? `project_${projectId}`;
    }

    // Generate backup_id
    const backupId = this.generateUuid();

    // Calculate retention_until: 14 days for daily, 12 weeks for weekly, 12 months for monthly
    // For now, assume all backups are daily and set to +14 days
    const now = new Date();
    const retentionUntil = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Insert audit row
    const stmt = this.db.prepare(
      `INSERT INTO core.tenant_backup
       (backup_id, project_id, taken_at, backup_kind, storage_uri, size_bytes, retention_until)
       VALUES (?, ?, datetime('now'), ?, ?, NULL, ?)`
    );

    const dumpPath = `/var/agenthive/backups/agentHive2-${kind}-${projectSlug}-${this.getTimestamp()}.dump`;
    stmt.run(backupId, projectId, kind, dumpPath, retentionUntil.toISOString());

    return { backup_id: backupId };
  }

  verifyBackup(args: VerifyBackupArgs): {
    backup_id: string;
    verified_at: string | null;
    verification_note: string | null;
    status: 'pending' | 'verified' | 'failed';
  } {
    const row = this.db
      .prepare(
        'SELECT backup_id, verified_at, verification_note FROM core.tenant_backup WHERE backup_id = ?'
      )
      .get(args.backup_id) as
      | { backup_id: string; verified_at: string | null; verification_note: string | null }
      | undefined;

    if (!row) {
      throw new Error(`Backup ${args.backup_id} not found`);
    }

    let status: 'pending' | 'verified' | 'failed' = 'pending';
    if (row.verified_at) {
      status = row.verification_note?.includes('failed') ? 'failed' : 'verified';
    }

    return {
      backup_id: row.backup_id,
      verified_at: row.verified_at,
      verification_note: row.verification_note,
      status,
    };
  }

  listBackups(args: ListBackupsArgs): {
    backups: BackupRow[];
    total: number;
  } {
    let query =
      'SELECT * FROM core.tenant_backup WHERE 1=1';
    const params: (string | number | null)[] = [];

    if (args.project_id !== undefined) {
      query += ' AND project_id = ?';
      params.push(args.project_id);
    }

    if (args.verified_only) {
      query += ' AND verified_at IS NOT NULL';
    }

    // Count total
    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as cnt');
    const countRow = this.db.prepare(countQuery).get(...params) as
      | { cnt: number }
      | undefined;
    const total = countRow?.cnt ?? 0;

    // Add ordering and pagination
    query += ' ORDER BY taken_at DESC';
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    query += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const backups = this.db.prepare(query).all(...params) as BackupRow[];

    return {
      backups,
      total,
    };
  }

  getBackupPolicy(args: GetBackupPolicyArgs): BackupPolicyRow {
    const row = this.db
      .prepare(
        'SELECT * FROM core.tenant_backup_policy WHERE project_id = ?'
      )
      .get(args.project_id) as BackupPolicyRow | undefined;

    if (!row) {
      throw new Error(`Backup policy for project ${args.project_id} not found`);
    }

    return row;
  }

  private generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private getTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] +
      '-' +
      new Date().toISOString().split('T')[1].split('.')[0].replace(/:/g, '');
  }
}
