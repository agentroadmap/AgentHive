/**
 * Test helpers for P598 — template schema integration tests.
 * Uses namespace isolation: each test suite gets unique schema names.
 */
import { Pool } from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DDL_PATH = resolve(REPO_ROOT, 'database/ddl/hivecentral/004-template.sql');

function loadPassword(host: string, user: string): string | undefined {
  // Try ~/.pgpass first (libpq-style, most authoritative)
  try {
    const pgpass = readFileSync(resolve(process.env.HOME ?? '/root', '.pgpass'), 'utf8');
    for (const line of pgpass.split('\n')) {
      const parts = line.trim().split(':');
      if (parts.length < 5) continue;
      const [h, , , u, p] = parts;
      if ((h === '*' || h === host) && (u === '*' || u === user)) return p;
    }
  } catch {}
  // Fallback: DATABASE_URL in .env / .env.agent
  for (const f of ['.env', '.env.agent']) {
    const path = resolve(REPO_ROOT, f);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      const m = text.match(/DATABASE_URL=postgresql:\/\/[^:]+:([^@]+)@/);
      if (m) return decodeURIComponent(m[1]);
    } catch {}
  }
  return undefined;
}

export function createPool(): Pool {
  const host = process.env.PG_HOST ?? '127.0.0.1';
  const user = process.env.PG_USER ?? 'admin';
  return new Pool({
    host,
    port: Number(process.env.PG_PORT) || 5432,
    user,
    password: process.env.PGPASSWORD ?? loadPassword(host, user),
    database: process.env.PG_DATABASE ?? 'agenthive',
  });
}

/**
 * Rewrites schema references in DDL to namespaced equivalents.
 * `template` → `tmpl_{ns}`, `workflow_active` → `wact_{ns}`.
 */
export function substituteNamespace(sql: string, ns: string): string {
  const t = `tmpl_${ns}`;
  const w = `wact_${ns}`;
  return sql
    .replace(/\btemplate\./g, `${t}.`)
    .replace(/\bworkflow_active\./g, `${w}.`)
    .replace(/\bCREATE SCHEMA IF NOT EXISTS template\b/g, `CREATE SCHEMA IF NOT EXISTS ${t}`)
    .replace(/\bCREATE SCHEMA IF NOT EXISTS workflow_active\b/g, `CREATE SCHEMA IF NOT EXISTS ${w}`)
    .replace(/\bCOMMENT ON SCHEMA template\b/g, `COMMENT ON SCHEMA ${t}`)
    .replace(/\bIN SCHEMA template\b/g, `IN SCHEMA ${t}`)
    .replace(/\bON SCHEMA template\b/g, `ON SCHEMA ${t}`)
    .replace(/SET search_path = template,/g, `SET search_path = ${t},`)
    .replace(/SET search_path = template\b/g, `SET search_path = ${t}`)
    .replace(/schema_name = 'template'/g, `schema_name = '${t}'`)
    .replace(/schema_name = 'workflow_active'/g, `schema_name = '${w}'`);
}

export async function bootstrapTemplateNamespace(pool: Pool, ns: string): Promise<void> {
  const ddl = substituteNamespace(readFileSync(DDL_PATH, 'utf8'), ns);
  await pool.query(ddl);
}

export async function teardownTemplateNamespace(pool: Pool, ns: string): Promise<void> {
  await pool.query(`
    DROP SCHEMA IF EXISTS tmpl_${ns} CASCADE;
    DROP SCHEMA IF EXISTS wact_${ns} CASCADE;
  `);
}

/**
 * Create a workflow_active copy table in the namespaced schema
 * with a FK to the namespaced template table.
 */
export async function bootstrapWorkflowActiveNamespace(pool: Pool, ns: string): Promise<void> {
  const t = `tmpl_${ns}`;
  const w = `wact_${ns}`;
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS ${w};
    CREATE TABLE IF NOT EXISTS ${w}.workflow_template_copy (
      project_id    BIGINT      NOT NULL,
      template_id   TEXT        NOT NULL REFERENCES ${t}.workflow_template(template_id)
                                ON UPDATE RESTRICT ON DELETE RESTRICT,
      family        TEXT        NOT NULL,
      version       INT         NOT NULL,
      display_name  TEXT        NOT NULL,
      states        JSONB       NOT NULL,
      gates         JSONB       NOT NULL,
      pinned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      pinned_by_did TEXT        NOT NULL DEFAULT 'system:test',
      PRIMARY KEY (project_id, template_id)
    );
  `);
}

export const RFC5_STATES = JSON.stringify([
  { name: 'Draft',    order: 1 },
  { name: 'Review',   order: 2 },
  { name: 'Develop',  order: 3 },
  { name: 'Merge',    order: 4 },
  { name: 'Complete', order: 5 },
]);

export const RFC5_GATES = JSON.stringify([
  { from: 'Draft',   to: 'Review',   maturity_required: 'mature' },
  { from: 'Review',  to: 'Develop',  maturity_required: 'mature' },
  { from: 'Review',  to: 'Draft',    maturity_required: 'any'    },
  { from: 'Develop', to: 'Merge',    maturity_required: 'mature' },
  { from: 'Develop', to: 'Review',   maturity_required: 'any'    },
  { from: 'Merge',   to: 'Complete', maturity_required: 'mature' },
  { from: 'Merge',   to: 'Develop',  maturity_required: 'any'    },
]);
