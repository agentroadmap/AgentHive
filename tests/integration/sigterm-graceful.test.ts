/**
 * P3842: SIGTERM graceful-shutdown regression suite.
 *
 * Spawns each long-running service, sends SIGTERM, and asserts the process
 * exits within 5 seconds — preventing regression of the P3198 hang fix.
 *
 * Skip logic (AC-4): if the entry-point script does not exist (clean checkout
 * before `npm ci`) or if the process exits before we can send SIGTERM (no DB /
 * no infrastructure), the test is skipped with a warning rather than failing.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, "../..");

// How long we give the process to stabilise before sending SIGTERM.
const STARTUP_SETTLE_MS = 1_500;
// Max time from SIGTERM to process exit.
const SIGTERM_EXIT_BUDGET_MS = 5_000;

interface ServiceSpec {
  label: string;
  /** Path relative to REPO_ROOT */
  script: string;
  /** Command and args to spawn (first element is the executable) */
  argv: string[];
  /** Extra env vars for this service */
  env?: Record<string, string>;
}

const SERVICES: ServiceSpec[] = [
  {
    label: "orchestrator",
    script: "scripts/orchestrator.ts",
    argv: ["node", "--import", "jiti/register", "scripts/orchestrator.ts"],
  },
  {
    label: "mcp-server",
    script: "scripts/mcp-sse-server.js",
    argv: ["node", "--import", "jiti/register", "scripts/mcp-sse-server.js"],
    env: { MCP_PORT: "16431", MCP_HOST: "127.0.0.1" },
  },
  {
    label: "board-tui",
    script: "scripts/roadmap-board.ts",
    argv: ["node", "--import", "jiti/register", "scripts/roadmap-board.ts"],
  },
];

/**
 * Spawn a service, wait STARTUP_SETTLE_MS, send SIGTERM, assert it exits
 * within SIGTERM_EXIT_BUDGET_MS.
 *
 * Returns "skipped" when the process exits before we send SIGTERM (startup
 * failure — no DB, no infrastructure), so the outer test can skip gracefully.
 */
async function assertSigtermExit(spec: ServiceSpec): Promise<"ok" | "skipped"> {
  const scriptPath = join(REPO_ROOT, spec.script);
  if (!existsSync(scriptPath)) {
    console.warn(`[sigterm-test] SKIP ${spec.label}: script not found at ${scriptPath}`);
    return "skipped";
  }

  const [exe, ...args] = spec.argv;
  const child = spawn(exe, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      // Suppress interactive TTY UI rendering during the test
      TERM: "dumb",
      ...spec.env,
    },
    stdio: "pipe",
  });

  let exitedEarly = false;

  // Track early exit so we can skip instead of fail.
  const earlyExitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exitedEarly = true;
      resolve();
    });
  });

  // Give the process a moment to settle (or crash out if no DB/infra).
  await Promise.race([
    earlyExitPromise,
    new Promise<void>((r) => setTimeout(r, STARTUP_SETTLE_MS)),
  ]);

  if (exitedEarly) {
    console.warn(
      `[sigterm-test] SKIP ${spec.label}: process exited during startup window — ` +
        "no DB / infrastructure available in this environment",
    );
    return "skipped";
  }

  // Process is alive — send SIGTERM and measure time to exit.
  const sigtermAt = Date.now();

  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });

  child.kill("SIGTERM");

  const exitCode = await Promise.race([
    exitPromise,
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), SIGTERM_EXIT_BUDGET_MS)),
  ]);

  if (exitCode === "timeout") {
    // Force-kill so CI doesn't leak the process.
    child.kill("SIGKILL");
    await exitPromise;
    assert.fail(
      `${spec.label} did not exit within ${SIGTERM_EXIT_BUDGET_MS}ms of SIGTERM — P3198 regression`,
    );
  }

  const elapsed = Date.now() - sigtermAt;
  console.log(`[sigterm-test] ${spec.label} exited (code=${exitCode}) in ${elapsed}ms`);
  return "ok";
}

describe("P3842: SIGTERM graceful shutdown", () => {
  for (const spec of SERVICES) {
    it(`${spec.label} exits within ${SIGTERM_EXIT_BUDGET_MS}ms of SIGTERM`, async (t) => {
      const result = await assertSigtermExit(spec);
      if (result === "skipped") {
        t.skip("service unavailable in this environment — skipped per AC-4");
      }
    });
  }
});
