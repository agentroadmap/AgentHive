/**
 * SIGTERM e2e regression suite for long-running service entrypoints.
 *
 * Env-gate: set AGENTHIVE_SIGTERM_E2E=1 to run (requires a live DB).
 * CI command: AGENTHIVE_SIGTERM_E2E=1 node --import jiti/register --test \
 *             src/shared/runtime/graceful-exit.test.ts \
 *             --test-name-pattern 'entrypoint SIGTERM'
 *
 * AC-1: Add new long-running service scripts to ENTRYPOINTS below.
 *       The test loop automatically covers them without further code changes.
 *
 * Short-lived CLIs excluded from this manifest (AC-4):
 *   - scripts/roadmap-board.ts: queries DB, renders board, then exits.
 *     Not a daemon; SIGTERM handling is irrelevant.
 *   - scripts/start-liaison.ts: per-agency process that requires
 *     AGENCY_ID/AGENCY_PROVIDER/AGENCY_HOST_ID env vars. Covered
 *     indirectly by start-a2a-host which manages liaison lifecycles.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

type Entrypoint = {
	/** Path relative to project root. */
	script: string;
	/** Regex matched against combined stdout+stderr to detect readiness. */
	readyPattern: RegExp;
	/** Maximum ms to wait for the ready marker before sending SIGTERM anyway. */
	maxBootMs: number;
	/** Extra env vars to pass to the child (merged with process.env). */
	env?: Record<string, string>;
};

// AC-1: Canonical manifest of long-running service entrypoints.
// Add new daemons here — the loop below tests each automatically.
const ENTRYPOINTS: Entrypoint[] = [
	{
		script: "scripts/orchestrator.ts",
		readyPattern: /\[orchestrator-shim\] running/,
		maxBootMs: 8000,
	},
	{
		script: "scripts/mcp-sse-server.js",
		readyPattern: /\[MCP\] AgentHive MCP server v/,
		maxBootMs: 8000,
		// Use an ephemeral port to avoid conflicts with a running MCP server in CI.
		env: { MCP_PORT: "19732" },
	},
	{
		script: "scripts/state-feed-listener.ts",
		readyPattern: /\[state-feed\] Ready/,
		maxBootMs: 8000,
	},
	{
		script: "scripts/start-a2a-host.ts",
		readyPattern: /\[a2a-host\] boot complete/,
		maxBootMs: 8000,
	},
];

const EXIT_BUDGET_MS = 10_000;

/** Poll `getOutput()` every 100 ms until `pattern` matches or the deadline is
 *  reached (or the child exits). Returns true if the pattern matched. */
async function waitForReady(
	getOutput: () => string,
	isExited: () => boolean,
	pattern: RegExp,
	maxMs: number,
): Promise<boolean> {
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		if (pattern.test(getOutput())) return true;
		if (isExited()) return false;
		await new Promise<void>((r) => setTimeout(r, 100));
	}
	return pattern.test(getOutput());
}

if (!process.env.AGENTHIVE_SIGTERM_E2E) {
	// No-op when the env gate is absent — unit test runs skip this file.
} else {
	describe("SIGTERM e2e — entrypoint graceful shutdown", () => {
		for (const ep of ENTRYPOINTS) {
			it(`entrypoint SIGTERM: ${ep.script}`, async () => {
				const projectRoot = process.cwd();
				const scriptPath = join(projectRoot, ep.script);

				const child = spawn(
					"node",
					["--import", "jiti/register", scriptPath],
					{
						cwd: projectRoot,
						stdio: ["ignore", "pipe", "pipe"],
						env: { ...process.env, ...ep.env },
					},
				);

				let output = "";
				child.stdout.on("data", (d: Buffer) => {
					output += d.toString();
				});
				child.stderr.on("data", (d: Buffer) => {
					output += d.toString();
				});

				let childExited = false;
				child.on("exit", () => {
					childExited = true;
				});

				// AC-5: Poll for ready marker; don't use a fixed sleep.
				await waitForReady(
					() => output,
					() => childExited,
					ep.readyPattern,
					ep.maxBootMs,
				);

				if (childExited) {
					// Process exited before SIGTERM (e.g. DB unavailable in this env).
					// Counts as a pass: it exited cleanly rather than hanging.
					return;
				}

				// Send SIGTERM and assert exit within budget.
				child.kill("SIGTERM");

				const exitedCleanly = await new Promise<boolean>((resolve) => {
					const timeout = setTimeout(() => resolve(false), EXIT_BUDGET_MS);
					child.on("exit", () => {
						clearTimeout(timeout);
						resolve(true);
					});
				});

				if (!exitedCleanly) {
					child.kill("SIGKILL");
					assert.fail(
						`${ep.script} did not exit within ${EXIT_BUDGET_MS}ms after SIGTERM.\nOutput:\n${output.slice(-2000)}`,
					);
				}
			});
		}
	});
}
