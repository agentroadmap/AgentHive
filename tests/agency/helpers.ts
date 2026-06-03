/**
 * Shared test helpers for the tests/agency/ suite (P444 and related ACs).
 *
 * Mirrors the pattern in tests/p598/helpers.ts — reads ~/.pgpass for credentials,
 * falls back to DATABASE_URL in .env / .env.agent.
 */

import { Pool } from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadPassword(host: string, user: string): string | undefined {
  try {
    const pgpass = readFileSync(resolve(process.env.HOME ?? '/root', '.pgpass'), 'utf8');
    for (const line of pgpass.split('\n')) {
      const parts = line.trim().split(':');
      if (parts.length < 5) continue;
      const [h, , , u, p] = parts;
      if ((h === '*' || h === host) && (u === '*' || u === user)) return p;
    }
  } catch {}
  for (const f of ['.env', '.env.agent']) {
    const path = resolve(process.cwd(), f);
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

// Exported for dispatch-identity.test.ts which imports but delegates to its own setup.
export async function bootstrapNamespace(_pool: Pool, _ns: string): Promise<void> {}
export async function teardownNamespace(_pool: Pool, _ns: string): Promise<void> {}
