/**
 * P523: MCP Operator Control Surface for Feature Flags
 * Provides CRUD and audit operations via MCP ops tool
 */

import { Pool } from "pg";

export interface FlagOperationResult {
  flag_name: string;
  old_value?: object;
  new_value?: object;
  audit_id?: string;
  error?: string;
}

export interface FlagGetResult {
  flag_name: string;
  display_name: string;
  enabled_default: boolean;
  per_tenant_override: object;
  rollout_percent: number;
  updated_at: string;
  updated_by: string;
  current_value?: { enabled: boolean; variant?: string; reason: string };
}

export interface FlagListResult {
  flags: Array<{
    flag_name: string;
    display_name: string;
    enabled_default: boolean;
    current_count_overrides: number;
    rollout_percent: number;
    updated_at: string;
  }>;
}

export interface AuditLogEntry {
  id: string;
  flag_name: string;
  action: string;
  old_value: object | null;
  new_value: object;
  reason: string;
  changed_by: string;
  changed_at: string;
  metadata?: object;
}

export interface FlagAuditResult {
  entries: AuditLogEntry[];
  total_count?: number;
}

export class FlagOpsHandler {
  constructor(private pool: Pool) {}

  /**
   * flag_get: Fetch single flag with current resolved value
   */
  async flagGet(
    flagName: string,
    projectSlug?: string
  ): Promise<FlagGetResult> {
    try {
      const result = await this.pool.query(
        `SELECT
          flag_name,
          display_name,
          enabled_default,
          per_tenant_override,
          rollout_percent,
          updated_at,
          updated_by
        FROM roadmap.feature_flag
        WHERE flag_name = $1 AND NOT is_archived`,
        [flagName]
      );

      if (result.rows.length === 0) {
        throw new Error(`Flag '${flagName}' not found`);
      }

      const row = result.rows[0];
      const overrideCount = projectSlug
        ? row.per_tenant_override[projectSlug]
          ? 1
          : 0
        : Object.keys(row.per_tenant_override).length;

      return {
        flag_name: row.flag_name,
        display_name: row.display_name,
        enabled_default: row.enabled_default,
        per_tenant_override: row.per_tenant_override,
        rollout_percent: row.rollout_percent,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      };
    } catch (err) {
      throw new Error(`flagGet error: ${err.message}`);
    }
  }

  /**
   * flag_set: Update flag state (audited)
   */
  async flagSet(
    flagName: string,
    enabled?: boolean,
    rolloutPercent?: number,
    variant?: string,
    reason: string = "operator update",
    requester: string = "system"
  ): Promise<FlagOperationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch current state for audit
      const currentResult = await client.query(
        `SELECT
          flag_name,
          enabled_default,
          rollout_percent,
          variant_values
        FROM roadmap.feature_flag
        WHERE flag_name = $1 AND NOT is_archived`,
        [flagName]
      );

      if (currentResult.rows.length === 0) {
        throw new Error(`Flag '${flagName}' not found`);
      }

      const current = currentResult.rows[0];
      const oldValue = {
        enabled_default: current.enabled_default,
        rollout_percent: current.rollout_percent,
        variant_values: current.variant_values,
      };

      // Update flag
      const updateParts: string[] = [];
      const updateValues: any[] = [flagName];
      let paramCount = 2;

      if (enabled !== undefined) {
        updateParts.push(`enabled_default = $${paramCount}`);
        updateValues.push(enabled);
        paramCount++;
      }

      if (rolloutPercent !== undefined) {
        if (rolloutPercent < 0 || rolloutPercent > 100) {
          throw new Error("rolloutPercent must be between 0 and 100");
        }
        updateParts.push(`rollout_percent = $${paramCount}`);
        updateValues.push(rolloutPercent);
        paramCount++;
      }

      if (variant !== undefined) {
        updateParts.push(`variant_values = $${paramCount}`);
        updateValues.push(JSON.stringify({ selected: variant }));
        paramCount++;
      }

      updateParts.push(`updated_at = NOW()`);
      updateParts.push(`updated_by = $${paramCount}`);
      updateValues.push(requester);

      await client.query(
        `UPDATE roadmap.feature_flag
        SET ${updateParts.join(", ")}
        WHERE flag_name = $1`,
        updateValues
      );

      // Audit log
      const auditResult = await client.query(
        `INSERT INTO roadmap.feature_flag_audit
        (flag_name, action, old_value, new_value, reason, changed_by, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        [
          flagName,
          "set",
          JSON.stringify(oldValue),
          JSON.stringify({
            enabled_default: enabled ?? current.enabled_default,
            rollout_percent: rolloutPercent ?? current.rollout_percent,
            variant_values: variant
              ? JSON.stringify({ selected: variant })
              : current.variant_values,
          }),
          reason,
          requester,
          JSON.stringify({ proposal: "P523" }),
        ]
      );

      await client.query("COMMIT");

      return {
        flag_name: flagName,
        old_value: oldValue,
        audit_id: auditResult.rows[0].id,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`flagSet error: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * flag_override: Set per-tenant override (audited)
   */
  async flagOverride(
    flagName: string,
    projectSlug: string,
    override: { enabled: boolean; variant?: string },
    reason: string = "operator override",
    requester: string = "system"
  ): Promise<FlagOperationResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Fetch current state
      const currentResult = await client.query(
        `SELECT per_tenant_override FROM roadmap.feature_flag
        WHERE flag_name = $1 AND NOT is_archived`,
        [flagName]
      );

      if (currentResult.rows.length === 0) {
        throw new Error(`Flag '${flagName}' not found`);
      }

      const current = currentResult.rows[0];
      const oldOverride = current.per_tenant_override[projectSlug] || null;

      // Merge override into per_tenant_override JSONB
      const newOverrides = {
        ...current.per_tenant_override,
        [projectSlug]: override,
      };

      // Update flag
      await client.query(
        `UPDATE roadmap.feature_flag
        SET per_tenant_override = $1, updated_at = NOW(), updated_by = $2
        WHERE flag_name = $3`,
        [JSON.stringify(newOverrides), requester, flagName]
      );

      // Audit log
      const auditResult = await client.query(
        `INSERT INTO roadmap.feature_flag_audit
        (flag_name, action, old_value, new_value, reason, changed_by, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        [
          flagName,
          "override",
          JSON.stringify({ project_slug: projectSlug, override: oldOverride }),
          JSON.stringify({
            project_slug: projectSlug,
            override: override,
          }),
          reason,
          requester,
          JSON.stringify({ proposal: "P523" }),
        ]
      );

      await client.query("COMMIT");

      return {
        flag_name: flagName,
        old_value: oldOverride,
        audit_id: auditResult.rows[0].id,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`flagOverride error: ${err.message}`);
    } finally {
      client.release();
    }
  }

  /**
   * flag_list: List all active flags
   */
  async flagList(includeArchived: boolean = false): Promise<FlagListResult> {
    try {
      const whereClause = includeArchived ? "" : "WHERE NOT is_archived";
      const result = await this.pool.query(
        `SELECT
          flag_name,
          display_name,
          enabled_default,
          per_tenant_override,
          rollout_percent,
          updated_at
        FROM roadmap.feature_flag
        ${whereClause}
        ORDER BY flag_name ASC`
      );

      return {
        flags: result.rows.map((row) => ({
          flag_name: row.flag_name,
          display_name: row.display_name,
          enabled_default: row.enabled_default,
          current_count_overrides: Object.keys(row.per_tenant_override).length,
          rollout_percent: row.rollout_percent,
          updated_at: row.updated_at,
        })),
      };
    } catch (err) {
      throw new Error(`flagList error: ${err.message}`);
    }
  }

  /**
   * flag_audit: Query audit log
   */
  async flagAudit(
    flagName?: string,
    changedBy?: string,
    changedSince?: string,
    limit: number = 50
  ): Promise<FlagAuditResult> {
    try {
      const filters: string[] = [];
      const params: any[] = [];
      let paramCount = 1;

      if (flagName) {
        filters.push(`flag_name = $${paramCount}`);
        params.push(flagName);
        paramCount++;
      }

      if (changedBy) {
        filters.push(`changed_by = $${paramCount}`);
        params.push(changedBy);
        paramCount++;
      }

      if (changedSince) {
        filters.push(`changed_at >= $${paramCount}`);
        params.push(changedSince);
        paramCount++;
      }

      const whereClause =
        filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

      const result = await this.pool.query(
        `SELECT
          id,
          flag_name,
          action,
          old_value,
          new_value,
          reason,
          changed_by,
          changed_at,
          metadata
        FROM roadmap.feature_flag_audit
        ${whereClause}
        ORDER BY changed_at DESC
        LIMIT $${paramCount}`,
        [...params, limit]
      );

      return {
        entries: result.rows.map((row) => ({
          id: row.id,
          flag_name: row.flag_name,
          action: row.action,
          old_value: row.old_value,
          new_value: row.new_value,
          reason: row.reason,
          changed_by: row.changed_by,
          changed_at: row.changed_at,
          metadata: row.metadata,
        })),
        total_count: result.rows.length,
      };
    } catch (err) {
      throw new Error(`flagAudit error: ${err.message}`);
    }
  }
}
