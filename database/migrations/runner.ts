import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { Pool, PoolClient } from "pg";
import process from "process";

interface MigrationRecord {
  id: number;
  filename: string;
  checksum_sha256: string;
  applied_at: string | null;
  status: string;
}

interface MigrationFile {
  filename: string;
  path: string;
  checksum: string;
}

const MIGRATION_PATTERN = /^[0-9]{3}-[a-z0-9-]+\.sql$/;
const ADVISORY_LOCK_ID = hashtext("agenthive-migration-runner");
const DDL_DIR = join(process.cwd(), "database", "ddl");
const ROLLBACK_DIR = join(DDL_DIR, "rollback");

// Simple hash function matching PostgreSQL hashtext behavior
function hashtext(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0) & 0x7fffffff; // PostgreSQL returns signed 32-bit
}

function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

function extractEnvGate(filePath: string): string | null {
  const content = readFileSync(filePath, "utf-8");
  const match = content.match(/--\s*env:\s*(dev|staging|prod)/i);
  return match ? match[1].toLowerCase() : null;
}

async function acquireAdvisoryLock(client: PoolClient): Promise<boolean> {
  try {
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [ADVISORY_LOCK_ID]
    );
    return true;
  } catch {
    return false;
  }
}

async function discoverMigrations(): Promise<MigrationFile[]> {
  try {
    const files = readdirSync(DDL_DIR).filter((f) =>
      MIGRATION_PATTERN.test(f)
    );
    return files
      .map((filename) => ({
        filename,
        path: join(DDL_DIR, filename),
        checksum: computeChecksum(join(DDL_DIR, filename)),
      }))
      .sort((a, b) => a.filename.localeCompare(b.filename));
  } catch {
    return [];
  }
}

async function getAppliedMigrations(client: PoolClient): Promise<Map<string, MigrationRecord>> {
  const result = await client.query(
    "SELECT id, filename, checksum_sha256, applied_at, status FROM roadmap.migration_history ORDER BY filename"
  );
  const map = new Map<string, MigrationRecord>();
  for (const row of result.rows) {
    map.set(row.filename, row);
  }
  return map;
}

async function validateMigrations(
  discovered: MigrationFile[],
  applied: Map<string, MigrationRecord>,
  env: string
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];

  for (const file of discovered) {
    const envGate = extractEnvGate(file.path);
    if (envGate && envGate !== env) {
      issues.push(
        `SKIP: ${file.filename} restricted to env=${envGate}, current=${env}`
      );
      continue;
    }

    const applied_record = applied.get(file.filename);
    if (applied_record) {
      if (applied_record.checksum_sha256 !== file.checksum) {
        issues.push(
          `CHECKSUM DRIFT: ${file.filename} (applied=${applied_record.checksum_sha256.substring(0, 8)}, current=${file.checksum.substring(0, 8)})`
        );
        return { valid: false, issues };
      }
    }
  }

  // Check for missing files (in history but not on disk)
  for (const [filename, _] of applied) {
    if (!discovered.find((f) => f.filename === filename)) {
      issues.push(`MISSING: ${filename} (in history but not on disk)`);
    }
  }

  return { valid: issues.length === 0, issues };
}

async function applyMigration(
  client: PoolClient,
  file: MigrationFile,
  appliedBy: string,
  env: string
): Promise<{ success: boolean; runtimeSeconds: number }> {
  const startTime = Date.now();
  try {
    const sql = readFileSync(file.path, "utf-8");
    await client.query("BEGIN");
    await client.query(sql);

    const rollbackFile = `${file.filename
      .split("-")
      .slice(1)
      .join("-")}`;
    const rollbackPath = join(ROLLBACK_DIR, rollbackFile);

    await client.query(
      `INSERT INTO roadmap.migration_history
       (filename, checksum_sha256, applied_at, applied_by, environment, status, runtime_seconds)
       VALUES ($1, $2, NOW(), $3, $4, 'applied', $5)`,
      [
        file.filename,
        file.checksum,
        appliedBy,
        env,
        Math.floor((Date.now() - startTime) / 1000),
      ]
    );
    await client.query("COMMIT");
    return {
      success: true,
      runtimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    return { success: false, runtimeSeconds: Math.floor((Date.now() - startTime) / 1000) };
  }
}

async function rollbackMigration(
  client: PoolClient,
  filename: string,
  token: string
): Promise<boolean> {
  try {
    // Verify token matches first 8 chars of checksum
    const record = await client.query(
      "SELECT checksum_sha256 FROM roadmap.migration_history WHERE filename = $1",
      [filename]
    );
    if (!record.rows.length) {
      console.error(`Migration ${filename} not found in history`);
      return false;
    }

    const checksum = record.rows[0].checksum_sha256;
    if (!token.startsWith(checksum.substring(0, 8))) {
      console.error("Invalid rollback token");
      return false;
    }

    const rollbackFile = `${filename.split("-").slice(1).join("-")}`;
    const rollbackPath = join(ROLLBACK_DIR, rollbackFile);

    try {
      const sql = readFileSync(rollbackPath, "utf-8");
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "UPDATE roadmap.migration_history SET status = 'rolled_back' WHERE filename = $1",
        [filename]
      );
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`Rollback failed for ${filename}:`, err);
      return false;
    }
  } catch (err) {
    console.error("Rollback error:", err);
    return false;
  }
}

async function dryRun(discovered: MigrationFile[], applied: Map<string, MigrationRecord>, env: string): Promise<void> {
  const { valid, issues } = await validateMigrations(discovered, applied, env);

  console.log("\n=== DRY RUN ===");
  console.log(`Environment: ${env}`);
  console.log(`Discovered: ${discovered.length} files`);
  console.log(`Applied: ${applied.size} migrations\n`);

  if (issues.length > 0) {
    console.log("Issues:");
    issues.forEach((issue) => console.log(`  - ${issue}`));
  }

  const newMigrations = discovered.filter((f) => !applied.has(f.filename));
  if (newMigrations.length > 0) {
    console.log("\nNew migrations to apply:");
    newMigrations.forEach((f) => {
      const envGate = extractEnvGate(f.path);
      const envStr = envGate ? ` [${envGate}]` : "";
      console.log(`  - ${f.filename}${envStr}`);
    });
  } else {
    console.log("\nNo new migrations.");
  }

  if (!valid) {
    console.log("\nValidation FAILED. Refusing to apply.");
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRunMode = args.includes("--dry-run");
  const confirmProd = args.includes("--confirm-prod");
  const rollbackCmd = args.find((a) => a.startsWith("rollback:"));
  const token = args.find((a) => a.startsWith("token:"))?.substring(6);

  const env = (process.env.AGENTHIVE_ENV || "dev").toLowerCase();

  if (env === "prod" && !confirmProd && !dryRunMode) {
    console.error("Production migrations require --confirm-prod flag");
    process.exit(1);
  }

  const pool = new Pool();
  const client = await pool.connect();

  try {
    // Acquire advisory lock
    const lockAcquired = await acquireAdvisoryLock(client);
    if (!lockAcquired) {
      console.error("Another migration runner is currently active. Exiting.");
      process.exit(1);
    }

    // Discover and validate
    const discovered = await discoverMigrations();
    const applied = await getAppliedMigrations(client);

    if (dryRunMode) {
      await dryRun(discovered, applied, env);
      return;
    }

    if (rollbackCmd) {
      const filename = rollbackCmd.substring(9);
      if (!token) {
        console.error("Rollback requires token parameter");
        process.exit(1);
      }
      const success = await rollbackMigration(client, filename, token);
      console.log(success ? `Rolled back ${filename}` : `Rollback failed`);
      process.exit(success ? 0 : 1);
    }

    // Validate before applying
    const { valid, issues } = await validateMigrations(discovered, applied, env);

    if (!valid) {
      console.error("Validation failed:");
      issues.forEach((issue) => console.error(`  - ${issue}`));
      process.exit(1);
    }

    issues.forEach((issue) => console.warn(`  Warning: ${issue}`));

    // Apply new migrations
    const newMigrations = discovered.filter((f) => !applied.has(f.filename));
    const appliedBy = process.env.USER || "system";

    console.log(`Applying ${newMigrations.length} new migration(s)...`);
    for (const file of newMigrations) {
      const envGate = extractEnvGate(file.path);
      if (envGate && envGate !== env) {
        console.log(`  SKIP: ${file.filename} (env=${envGate})`);
        continue;
      }

      console.log(`  Applying: ${file.filename}...`);
      const result = await applyMigration(client, file, appliedBy, env);
      if (result.success) {
        console.log(`    ✓ Applied in ${result.runtimeSeconds}s`);
      } else {
        console.error(`    ✗ Failed`);
        process.exit(1);
      }
    }

    console.log("Migration run completed successfully.");
  } catch (err) {
    console.error("Fatal error:", err);
    process.exit(1);
  } finally {
    await client.release();
    await pool.end();
  }
}

main();
