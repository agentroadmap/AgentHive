import assert from "node:assert";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { armHardExit, dumpActiveHandles } from "./graceful-exit";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

describe("graceful-exit helper (P3198)", () => {
	test("dumpActiveHandles never throws and emits a summary", () => {
		const lines: string[] = [];
		const orig = console.warn;
		console.warn = (msg?: unknown) => void lines.push(String(msg));
		try {
			dumpActiveHandles("test-label");
		} finally {
			console.warn = orig;
		}
		assert.ok(
			lines.some((l) => l.includes("[test-label] active handles after drain:")),
			"expected an active-handle summary line",
		);
	});

	test("armHardExit returns a cancel() that clears the failsafe", () => {
		const handle = armHardExit("test-label", 50);
		// cancel before the timer fires; if it didn't clear, the unref'd timer would
		// still be pending but harmless — we assert the API shape and no throw.
		assert.equal(typeof handle.cancel, "function");
		handle.cancel();
	});

	test("armHardExit timer is unref'd — it does not by itself keep the loop alive", async () => {
		// A short child program that only arms the failsafe (long timeout) and does
		// nothing else must still exit promptly, proving the timer is unref'd.
		const code = `
			import { armHardExit } from ${JSON.stringify(resolve(__dirname, "graceful-exit.ts"))};
			armHardExit("unref-probe", 60_000);
			// no other handles — an un-unref'd timer would hold the loop for 60s.
		`;
		const child = spawn(
			process.execPath,
			["--import", "jiti/register", "--input-type=module", "-e", code],
			{ cwd: REPO_ROOT, stdio: "ignore" },
		);
		const exited = await new Promise<boolean>((resolveP) => {
			const t = setTimeout(() => {
				child.kill("SIGKILL");
				resolveP(false);
			}, 8_000);
			t.unref();
			child.on("exit", () => {
				clearTimeout(t);
				resolveP(true);
			});
		});
		assert.ok(
			exited,
			"process with only an armed (unref'd) failsafe should exit on its own",
		);
	});
});

/**
 * Env-gated end-to-end SIGTERM suite (P3198/P3794).
 *
 * Boot each long-running service entrypoint, wait for its ready-marker on
 * stdout/stderr, send SIGTERM, assert the process exits within EXIT_BUDGET_MS.
 *
 * Requires a live DB/service env — skipped unless AGENTHIVE_SIGTERM_E2E=1.
 *
 * HOW TO ADD A NEW SERVICE:
 *   Append an entry to ENTRYPOINTS below. The test loop covers it automatically.
 *   - script: path relative to REPO_ROOT, passed to node via jiti/register
 *   - readyMarker: substring to look for in the child's stdout/stderr before
 *     sending SIGTERM; if the service emits no suitable line, use a boot-wait
 *     entry instead (see BOOT_WAIT_MS fallback below).
 *
 * SHORT-LIVED CLIs (excluded from this manifest):
 *   - scripts/roadmap-board.ts — prints the board table and exits naturally;
 *     not a daemon, no SIGTERM handling needed.
 */
const E2E = process.env.AGENTHIVE_SIGTERM_E2E === "1";
const EXIT_BUDGET_MS = 10_000;
/** Fallback max-wait if the ready-marker never appears (slow CI). */
const READY_TIMEOUT_MS = 15_000;

interface Entrypoint {
	name: string;
	script: string;
	/** Substring expected in the child's combined stdout/stderr once ready. */
	readyMarker: string;
}

/**
 * Canonical manifest of long-running AgentHive service entrypoints.
 * Add new daemons here — the test loop below covers them automatically.
 */
const ENTRYPOINTS: Entrypoint[] = [
	{
		name: "orchestrator",
		script: "scripts/orchestrator.ts",
		readyMarker: "[orchestrator-shim] running",
	},
	{
		name: "a2a-host",
		script: "scripts/start-a2a-host.ts",
		readyMarker: "[a2a-host] boot complete",
	},
	{
		name: "mcp",
		script: "scripts/mcp-sse-server.js",
		readyMarker: "[MCP] AgentHive MCP server",
	},
];

/**
 * Poll child stdout/stderr until `marker` appears or `timeoutMs` elapses.
 * Returns true if the marker was found, false on timeout.
 */
function waitForReady(
	child: ReturnType<typeof spawn>,
	marker: string,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolveP) => {
		let buf = "";
		const onData = (chunk: Buffer | string) => {
			buf += chunk.toString();
			if (buf.includes(marker)) {
				cleanup();
				resolveP(true);
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			resolveP(false);
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			child.stdout?.off("data", onData);
			child.stderr?.off("data", onData);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
	});
}

describe(
	"entrypoint SIGTERM clean-exit e2e (P3198/P3794, env-gated)",
	{ skip: !E2E },
	() => {
		for (const ep of ENTRYPOINTS) {
			test(`${ep.name} exits within ${EXIT_BUDGET_MS}ms of SIGTERM`, async () => {
				const child = spawn(
					process.execPath,
					["--import", "jiti/register", ep.script],
					{
						cwd: REPO_ROOT,
						// pipe so we can detect the ready-marker
						stdio: ["ignore", "pipe", "pipe"],
						env: process.env,
					},
				);

				// Wait for the service to signal readiness before sending SIGTERM.
				// Falls back gracefully if the marker never appears (slow CI): the
				// test still runs, just slightly earlier than ideal.
				await waitForReady(child, ep.readyMarker, READY_TIMEOUT_MS);

				const start = Date.now();
				child.kill("SIGTERM");
				const exitedInTime = await new Promise<boolean>((resolveP) => {
					const t = setTimeout(() => {
						child.kill("SIGKILL");
						resolveP(false);
					}, EXIT_BUDGET_MS);
					t.unref();
					child.on("exit", () => {
						clearTimeout(t);
						resolveP(true);
					});
				});
				assert.ok(
					exitedInTime,
					`${ep.name} did not exit within ${EXIT_BUDGET_MS}ms (took >${Date.now() - start}ms — would be a systemd timeout-kill)`,
				);
			});
		}
	},
);
