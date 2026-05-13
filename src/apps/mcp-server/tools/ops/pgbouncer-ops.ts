/**
 * P499: PgBouncer MCP operator tools
 * Connects to the PgBouncer admin console (database "pgbouncer") to expose
 * stats, pool state, and reload operations via mcp_ops.
 */

import { Client } from "pg";

export interface PgBouncerPoolRow {
  database: string;
  user: string;
  cl_active: number;
  cl_waiting: number;
  sv_active: number;
  sv_idle: number;
  sv_used: number;
  sv_tested: number;
  sv_login: number;
  maxwait: number;
  pool_mode: string;
}

export interface PgBouncerStatRow {
  database: string;
  total_xact_count: number;
  total_query_count: number;
  total_received: number;
  total_sent: number;
  total_xact_time: number;
  total_query_time: number;
  total_wait_time: number;
  avg_xact_count: number;
  avg_query_count: number;
  avg_recv: number;
  avg_sent: number;
  avg_xact_time: number;
  avg_query_time: number;
  avg_wait_time: number;
}

export interface PgBouncerStatsResult {
  pools: PgBouncerPoolRow[];
  stats: PgBouncerStatRow[];
  captured_at: string;
}

export interface PgBouncerPingResult {
  ok: boolean;
  latency_ms: number;
  host: string;
  port: number;
}

export interface PgBouncerReloadResult {
  ok: boolean;
  message: string;
}

function adminClientConfig() {
  return {
    host: process.env.PGBOUNCER_HOST ?? "127.0.0.1",
    port: Number(process.env.PGBOUNCER_PORT ?? process.env.AGENTHIVE_PG_PORT ?? 6432),
    database: "pgbouncer",
    user: process.env.PGBOUNCER_ADMIN_USER ?? process.env.PGUSER ?? "agenthive",
    // Password sourced from ~/.pgpass — never inline credentials
    connectionTimeoutMillis: 5000,
  };
}

async function withAdminClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(adminClientConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export class PgBouncerOpsHandler {
  async pgbouncerStats(): Promise<PgBouncerStatsResult> {
    return withAdminClient(async (client) => {
      const [pools, stats] = await Promise.all([
        client.query<PgBouncerPoolRow>("SHOW POOLS"),
        client.query<PgBouncerStatRow>("SHOW STATS"),
      ]);
      return {
        pools: pools.rows,
        stats: stats.rows,
        captured_at: new Date().toISOString(),
      };
    });
  }

  async pgbouncerPing(): Promise<PgBouncerPingResult> {
    const cfg = adminClientConfig();
    const start = Date.now();
    try {
      await withAdminClient(async (client) => {
        await client.query("SHOW VERSION");
      });
      return {
        ok: true,
        latency_ms: Date.now() - start,
        host: cfg.host,
        port: cfg.port,
      };
    } catch (err) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        host: cfg.host,
        port: cfg.port,
      };
    }
  }

  async pgbouncerReload(): Promise<PgBouncerReloadResult> {
    try {
      await withAdminClient(async (client) => {
        await client.query("RELOAD");
      });
      return { ok: true, message: "PgBouncer config reloaded." };
    } catch (err) {
      return {
        ok: false,
        message: `RELOAD failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
