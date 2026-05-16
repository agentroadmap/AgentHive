#!/usr/bin/env -S bun run
/**
 * Migration linter — runs each .sql file inside a SAVEPOINT and ROLLBACKs.
 *
 * Catches fabrication patterns that have hit P1017 build agents in the wild:
 *   - non-existent columns (assigned_agency, host_id)
 *   - non-existent CHECK constraint values (agent_type='user')
 *   - schema-qualified references in the wrong schema (roadmap.squad_dispatch)
 *   - forward-references to types created later in the same file
 *   - JSDoc-style /** comments at top-level (psql rejects)
 *
 * Usage:
 *   bun scripts/lint-migrations.ts <file1.sql> [<file2.sql> ...]
 *   bun scripts/lint-migrations.ts --changed   # diff vs main, all touched migrations
 *
 * Exit codes:
 *   0  all files lint clean
 *   1  one or more files failed
 *   2  argument or DB connection error
 *
 * Required env: any standard PG* connection vars OR ~/.pgpass entry.
 * The connection user must have permission to BEGIN/ROLLBACK on the target DB.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

function discoverChangedMigrations(): string[] {
  try {
    const out = execSync("git diff --name-only --diff-filter=AM main...HEAD -- 'scripts/migrations/*.sql'", {
      cwd: resolve(import.meta.dir, ".."),
      encoding: "utf8",
    });
    const fromBranch = out.trim().split("\n").filter(Boolean);
    const staged = execSync("git diff --name-only --cached --diff-filter=AM -- 'scripts/migrations/*.sql'", {
      cwd: resolve(import.meta.dir, ".."),
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    const dirty = execSync("git diff --name-only --diff-filter=AM -- 'scripts/migrations/*.sql'", {
      cwd: resolve(import.meta.dir, ".."),
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    return [...new Set([...fromBranch, ...staged, ...dirty])];
  } catch {
    return [];
  }
}

async function lintOne(client: Client, file: string): Promise<{ ok: boolean; message: string }> {
  if (!existsSync(file)) {
    return { ok: false, message: `file not found: ${file}` };
  }
  const rawSql = readFileSync(file, "utf8");

  // Cheap surface check: top-level JSDoc comment blocks are a recurring P1105 bug.
  if (/^\s*\/\*\*/.test(rawSql)) {
    return {
      ok: false,
      message: "top-level JSDoc /** comment block — psql rejects. Use `--` line comments or `/* ... */` (no leading asterisk on the opener).",
    };
  }

  // Strip embedded transaction control so our outer BEGIN/ROLLBACK wraps the
  // whole script regardless of whether the migration manages its own txn.
  // Without this, a migration's COMMIT terminates our linting txn early and
  // leaves us unable to roll back.
  const sql = rawSql
    .split("\n")
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;?\s*(--.*)?$/i.test(line))
    .join("\n");

  // Lint by running the SQL inside one outer transaction we always ROLLBACK.
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("ROLLBACK");
    return { ok: true, message: "" };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch { /* ignore */ }
    const msg = (err as Error).message;
    return { ok: false, message: msg };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let files: string[] = [];
  if (argv.includes("--changed")) {
    files = discoverChangedMigrations();
    if (files.length === 0) {
      console.log(`${YELLOW}no changed migrations to lint${RESET}`);
      process.exit(0);
    }
  } else if (argv.length > 0) {
    files = argv.filter((a) => !a.startsWith("--"));
  } else {
    console.error(`usage: bun scripts/lint-migrations.ts <file.sql> [<file.sql> ...] | --changed`);
    process.exit(2);
  }

  const client = new Client({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "admin",
    database: process.env.PGDATABASE ?? "agenthive",
    application_name: "lint-migrations",
  });
  try {
    await client.connect();
  } catch (err) {
    console.error(`${RED}DB connect failed:${RESET} ${(err as Error).message}`);
    process.exit(2);
  }

  let failures = 0;
  for (const f of files) {
    const r = await lintOne(client, f);
    if (r.ok) {
      console.log(`${GREEN}✓${RESET} ${f}`);
    } else {
      console.log(`${RED}✗${RESET} ${f}`);
      console.log(`  ${RED}${r.message}${RESET}`);
      failures++;
    }
  }

  await client.end();

  if (failures > 0) {
    console.log(`\n${RED}${failures} file(s) failed${RESET}`);
    process.exit(1);
  }
  console.log(`\n${GREEN}all ${files.length} file(s) lint clean${RESET}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`${RED}fatal:${RESET}`, err);
  process.exit(2);
});
