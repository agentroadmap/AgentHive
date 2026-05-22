/**
 * P1365-AC7: MCP observability for capacity tracking
 * Actions: capacity_snapshot, capacity_clear
 */

import { Query } from '../../db';

export interface CapacitySnapshotRequest {
  provider?: string;
  model?: string;
}

export interface CapacitySnapshotRow {
  provider: string;
  model: string;
  agency_id: string;
  requests_remaining: number | null;
  tokens_remaining: number | null;
  requests_limit: number | null;
  tokens_limit: number | null;
  reset_at: string | null; // ISO 8601 timestamp
  last_sampled_at: string;
  burn_rate_per_sec: string | null; // numeric as string
  throttle_action: string;
  headroom_pct: number | null; // computed
}

export interface CapacitySnapshotResponse {
  rows: CapacitySnapshotRow[];
  timestamp: string;
}

export interface CapacityClearRequest {
  agency_id: string;
  provider: string;
  model: string;
}

export interface CapacityClearResponse {
  deleted_rows: number;
  timestamp: string;
}

export async function capacitySnapshot(
  query: Query,
  req: CapacitySnapshotRequest
): Promise<CapacitySnapshotResponse> {
  let sql = `
    SELECT
      provider, model, agency_id,
      requests_remaining, tokens_remaining,
      requests_limit, tokens_limit,
      reset_at, last_sampled_at,
      burn_rate_per_sec, throttle_action,
      CASE
        WHEN requests_limit > 0 AND tokens_limit > 0
        THEN LEAST(
          (requests_remaining::float / requests_limit) * 100,
          (tokens_remaining::float / tokens_limit) * 100
        )
        WHEN requests_limit > 0
        THEN (requests_remaining::float / requests_limit) * 100
        WHEN tokens_limit > 0
        THEN (tokens_remaining::float / tokens_limit) * 100
        ELSE NULL
      END AS headroom_pct
    FROM roadmap_workforce.agency_capacity
    WHERE 1=1
  `;

  const params: any[] = [];

  if (req.provider) {
    params.push(req.provider);
    sql += ` AND provider = $${params.length}`;
  }

  if (req.model) {
    params.push(req.model);
    sql += ` AND model = $${params.length}`;
  }

  sql += ` ORDER BY provider, model, agency_id`;

  const result = await query(sql, params);

  return {
    rows: result.rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      agency_id: row.agency_id,
      requests_remaining: row.requests_remaining,
      tokens_remaining: row.tokens_remaining,
      requests_limit: row.requests_limit,
      tokens_limit: row.tokens_limit,
      reset_at: row.reset_at ? new Date(row.reset_at).toISOString() : null,
      last_sampled_at: new Date(row.last_sampled_at).toISOString(),
      burn_rate_per_sec: row.burn_rate_per_sec?.toString() || null,
      throttle_action: row.throttle_action,
      headroom_pct: row.headroom_pct ? parseFloat(row.headroom_pct.toFixed(2)) : null,
    })),
    timestamp: new Date().toISOString(),
  };
}

export async function capacityClear(
  query: Query,
  req: CapacityClearRequest
): Promise<CapacityClearResponse> {
  const sql = `
    DELETE FROM roadmap_workforce.agency_capacity
    WHERE provider = $1 AND model = $2 AND agency_id = $3
  `;

  const result = await query(sql, [req.provider, req.model, req.agency_id]);

  return {
    deleted_rows: result.rowCount || 0,
    timestamp: new Date().toISOString(),
  };
}
