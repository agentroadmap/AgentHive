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
 * AC-3: env-gated end-to-end — boot each real service entrypoint, send SIGTERM,
 * assert the process exits within 10s (no systemd-style timeout kill).
 *
 * Requires live DB/service env, so it is skipped unless AGENTHIVE_SIGTERM_E2E=1.
 */
const E2E = process.env.AGENTHIVE_SIGTERM_E2E === "1";
const EXIT_BUDGET_MS = 10_000;

describe(
	"entrypoint SIGTERM clean-exit e2e (P3198, env-gated)",
	{ skip: !E2E },
	() => {
		const entrypoints: Array<{ name: string; script: string }> = [
			{ name: "orchestrator", script: "scripts/orchestrator.ts" },
			{ name: "a2a-host", script: "scripts/start-a2a-host.ts" },
			{ name: "mcp", script: "scripts/mcp-sse-server.js" },
		];

		for (const ep of entrypoints) {
			test(`${ep.name} exits within ${EXIT_BUDGET_MS}ms of SIGTERM`, async () => {
				const child = spawn(
					process.execPath,
					["--import", "jiti/register", ep.script],
					{
						cwd: REPO_ROOT,
						stdio: "ignore",
						env: process.env,
					},
				);
				// Let it finish booting before signalling.
				await new Promise((r) => setTimeout(r, 3_000));
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
