/**
 * Context resolver for the hive CLI.
 * Resolution order: explicit flag → HIVE_* env → .hive/config.json → control-plane default.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";

export interface HiveContext {
  project: string | null;
  agency: string | null;
  host: string;
  mcp_url: string;
  db_host: string;
  db_port: number;
  resolved_at: string;
}

/** Alias for HiveContext — used by handler files that import CliContext. */
export type CliContext = HiveContext;

export interface ContextFlags {
  project?: string;
  agency?: string;
  host?: string;
  mcpUrl?: string;
}

interface HiveConfig {
  project?: string;
  agency?: string;
  mcp_url?: string;
  db_host?: string;
  db_port?: number;
}

async function loadLocalConfig(cwd: string): Promise<HiveConfig> {
  try {
    const raw = await readFile(join(cwd, ".hive", "config.json"), "utf-8");
    return JSON.parse(raw) as HiveConfig;
  } catch {
    return {};
  }
}

export async function resolveContext(flags: ContextFlags = {}, cwd = process.cwd()): Promise<HiveContext> {
  const local = await loadLocalConfig(cwd);

  const project =
    flags.project ??
    process.env.HIVE_PROJECT ??
    local.project ??
    null;

  const agency =
    flags.agency ??
    process.env.HIVE_AGENCY ??
    local.agency ??
    null;

  const host =
    flags.host ??
    process.env.AGENTHIVE_HOST ??
    hostname();

  const mcp_url =
    flags.mcpUrl ??
    process.env.HIVE_MCP_URL ??
    local.mcp_url ??
    "http://127.0.0.1:6421/sse";

  const db_host = local.db_host ?? process.env.PGHOST ?? "127.0.0.1";
  const db_port = local.db_port ?? Number(process.env.PGPORT ?? 5432);

  return {
    project,
    agency,
    host,
    mcp_url,
    db_host,
    db_port,
    resolved_at: new Date().toISOString(),
  };
}
