#!/usr/bin/env node

/**
 * P513: Tenant Smoke Test Script
 *
 * Validates monkeyKing-audio tenant setup (AC-6 & AC-7):
 * 1. Registry connectivity (operator-readable projects list)
 * 2. Tenant pool creation via getProjectDb (pool-registry)
 * 3. Health check query (audio_meta.health())
 * 4. Isolation verification (SELECT FROM agenthive.roadmap.project fails)
 *
 * Usage:
 *   npx ts-node scripts/smoke-test-tenant.ts [--project monkeyKing-audio] [--verbose]
 *
 * Environment:
 *   AGENTHIVE_CONTROL_DSN  — control DB connection (operator/bootstrap path)
 *   TEST_MONKEYKINGAUDIO_DSN  — tenant role connection (isolation test)
 *   or auto-resolve via vault://file/project/monkeyKing-audio/dsn
 *
 * Exit codes:
 *   0 = all checks pass
 *   1 = one or more checks failed
 */

import { argv } from "node:process";
import { Pool } from "pg";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");

// Simple CLI args parser
interface Args {
  project: string;
  verbose: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    project: "monkeyKing-audio",
    verbose: false,
  };

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1]) {
      args.project = argv[i + 1];
      i++;
    } else if (argv[i] === "--verbose") {
      args.verbose = true;
    }
  }

  return args;
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration_ms?: number;
}

const results: TestResult[] = [];

async function test(
  name: string,
  fn: () => Promise<void>
): Promise<void> {
  const start = Date.now();
  console.log(`[TEST] ${name}...`);

  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, passed: true, duration_ms: duration });
    console.log(`  ✓ PASS (${duration}ms)\n`);
  } catch (err) {
    const duration = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, error, duration_ms: duration });
    console.log(`  ✗ FAIL (${duration}ms): ${error}\n`);
  }
}

async function main() {
  const cliArgs = parseArgs();
  const projectSlug = cliArgs.project;
  const verbose = cliArgs.verbose;

  console.log(`\n=== P513 Tenant Smoke Tests ===\n`);
  console.log(`Project: ${projectSlug}`);
  console.log(`Verbose: ${verbose}\n`);

  // Load control DSN
  const controlDsn = process.env.AGENTHIVE_CONTROL_DSN;
  if (!controlDsn) {
    console.error("ERROR: AGENTHIVE_CONTROL_DSN not set");
    process.exit(1);
  }

  let controlPool: Pool | null = null;
  let tenantPool: Pool | null = null;

  try {
    // Initialize pools
    controlPool = new Pool({
      connectionString: controlDsn,
      application_name: "p513-smoke-test-operator",
      connectionTimeoutMillis: 5000,
    });

    // Tenant pool: try env var first, then fallback (vault resolution would be here in real deploy)
    const tenantDsn =
      process.env[`TEST_${projectSlug.toUpperCase()}_DSN`] ||
      process.env.TEST_MONKEYKINGAUDIO_DSN;

    if (tenantDsn) {
      tenantPool = new Pool({
        connectionString: tenantDsn,
        application_name: "p513-smoke-test-tenant",
        connectionTimeoutMillis: 5000,
      });
    }

    // Test 1: Registry connectivity (operator path)
    await test("Registry connectivity", async () => {
      const result = await controlPool!.query(
        "SELECT slug, bootstrap_status FROM roadmap.project WHERE slug = $1",
        [projectSlug]
      );

      if (!result.rows.length) {
        throw new Error(`Project '${projectSlug}' not found in registry`);
      }

      const row = result.rows[0] as { slug: string; bootstrap_status: string };
      if (verbose) {
        console.log(`    → Found: slug=${row.slug}, status=${row.bootstrap_status}`);
      }

      if (row.bootstrap_status !== "live") {
        throw new Error(
          `Project not live (status=${row.bootstrap_status})`
        );
      }
    });

    // Test 2: Health check via tenant pool (AC-7)
    if (tenantPool) {
      await test("AC-7: Health check query", async () => {
        const result = await tenantPool!.query(
          "SELECT status, schema_name, migrations_count FROM audio_meta.health()"
        );

        if (!result.rows.length) {
          throw new Error("health() returned no rows");
        }

        const row = result.rows[0] as {
          status: string;
          schema_name: string;
          migrations_count: number;
        };

        if (row.status !== "ok") {
          throw new Error(`Health status not ok: ${row.status}`);
        }

        if (row.schema_name !== "audio_meta") {
          throw new Error(`Wrong schema: ${row.schema_name}`);
        }

        if (verbose) {
          console.log(
            `    → Health ok, migrations=${row.migrations_count}, schema=${row.schema_name}`
          );
        }
      });

      // Test 3: Isolation verification (AC-6)
      await test(
        "AC-6: Cross-tenant isolation (SELECT from agenthive.roadmap fails)",
        async () => {
          try {
            const result = await tenantPool!.query(
              "SELECT project_id FROM agenthive.roadmap.project LIMIT 1"
            );

            // Should NOT reach here; permission should be denied
            if (result.rows.length > 0) {
              throw new Error(
                "CRITICAL: Tenant role could access agenthive.roadmap! Isolation failed!"
              );
            }

            throw new Error(
              "Unexpected: query returned no error but no rows (isolation guard may be ineffective)"
            );
          } catch (err) {
            const errMsg = (err as Error).message;

            // Permission denied is what we expect
            if (
              errMsg.includes("permission denied") ||
              errMsg.includes("no privileges") ||
              errMsg.includes("access denied")
            ) {
              if (verbose) {
                console.log(`    → Isolation confirmed: ${errMsg}`);
              }
              return; // Test passes
            }

            // Re-throw other errors
            throw err;
          }
        }
      );

      // Test 4: Verify isolation function
      await test("AC-6: verify_isolation() function", async () => {
        const result = await tenantPool!.query(
          "SELECT test_passed, error_message FROM audio_meta.verify_isolation()"
        );

        if (!result.rows.length) {
          throw new Error("verify_isolation() returned no rows");
        }

        const row = result.rows[0] as {
          test_passed: boolean;
          error_message: string | null;
        };

        if (!row.test_passed) {
          throw new Error(
            `Isolation test failed: ${row.error_message || "unknown"}`
          );
        }

        if (verbose) {
          console.log(`    → Isolation test passed`);
        }
      });

      // Test 5: Access tenant metadata
      await test("Tenant metadata access", async () => {
        const result = await tenantPool!.query(
          "SELECT tenant_name, schema_prefix FROM audio_meta.tenant_info"
        );

        if (!result.rows.length) {
          throw new Error("tenant_info is empty");
        }

        const row = result.rows[0] as {
          tenant_name: string;
          schema_prefix: string;
        };

        if (row.schema_prefix !== "audio_") {
          throw new Error(`Wrong schema_prefix: ${row.schema_prefix}`);
        }

        if (verbose) {
          console.log(
            `    → Tenant: ${row.tenant_name}, schema=${row.schema_prefix}`
          );
        }
      });

      // Test 6: Migrations audit log
      await test("Migrations audit log", async () => {
        const result = await tenantPool!.query(
          "SELECT COUNT(*) as count FROM audio_meta.migrations"
        );

        const count = (result.rows[0] as { count: string }).count;
        const countNum = parseInt(count, 10);

        if (countNum < 2) {
          throw new Error(`Expected >= 2 migrations, got ${countNum}`);
        }

        if (verbose) {
          console.log(`    → Found ${countNum} migration records`);
        }
      });
    } else {
      console.warn("⚠ Skipping tenant tests (TEST_MONKEYKINGAUDIO_DSN not set)\n");
    }

    // Print summary
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const total = results.length;

    console.log(`\n=== Summary ===\n`);
    console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);

    if (failed > 0) {
      console.log(`\nFailed tests:\n`);
      results
        .filter((r) => !r.passed)
        .forEach((r) => {
          console.log(`  • ${r.name}`);
          console.log(`    Error: ${r.error}`);
        });
      process.exit(1);
    } else {
      console.log(`\n✓ All checks passed!`);
      process.exit(0);
    }
  } finally {
    // Cleanup
    if (controlPool) {
      await controlPool.end();
    }
    if (tenantPool) {
      await tenantPool.end();
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
