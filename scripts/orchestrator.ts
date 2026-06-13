/**
 * AgentHive Orchestrator — Thin systemd shim (P902-A8)
 *
 * Delegates all lifecycle and dispatch logic to src/core/orchestration/orchestrator.ts::Orchestrator.
 * This shim is responsible only for:
 *   - Instantiating the Orchestrator class
 *   - Registering signal handlers for graceful shutdown
 *   - Managing process lifecycle
 *
 * All dispatch logic, timers, notification handlers, and maintenance tasks live in the
 * Orchestrator class. This keeps the systemd entrypoint minimal and testable.
 */

import { Orchestrator } from "../src/core/orchestration/orchestrator.ts";
import { reapOrphanScratch } from "../src/core/orchestration/scratch.ts";
import {
	closePool,
	getPool,
	setPoolLifecycleMode,
} from "../src/infra/postgres/pool.ts";
import { startPoolWatchdog } from "../src/infra/postgres/pool-watchdog.ts";
import { initConfig } from "../src/shared/runtime/config.ts";
import { armHardExit } from "../src/shared/runtime/graceful-exit.ts";

// P1123: declare long-running mode so stray pool.end() calls cannot poison this
// service. Graceful shutdown drops back to "one-shot" before the final closePool.
setPoolLifecycleMode("long-running");

const watchdog = startPoolWatchdog("agenthive-orchestrator");
const orchestrator = new Orchestrator();

async function main() {
	console.log("[orchestrator-shim] starting");

	// P404: reap scratch dirs left by any prior process epoch (dry-run logs first).
	await reapOrphanScratch({ dryRun: true }).catch((e: unknown) =>
		console.warn(
			`[scratch-reaper] dry-run scan failed: ${e instanceof Error ? e.message : e}`,
		),
	);
	await reapOrphanScratch({ dryRun: false }).catch((e: unknown) =>
		console.warn(
			`[scratch-reaper] boot reap failed: ${e instanceof Error ? e.message : e}`,
		),
	);

	// Initialize the global config resolver with the DB pool so runtime_flag
	// hot-reload (ORCHESTRATOR_MAX_INFLIGHT_OFFERS etc.) works without restart.
	await initConfig({ pool: getPool() });

	await orchestrator.start();
	console.log("[orchestrator-shim] running");

	// Wait for termination signals
	await new Promise<void>((resolve) => {
		process.once("SIGTERM", () => {
			console.log("[orchestrator-shim] SIGTERM received");
			resolve();
		});
		process.once("SIGINT", () => {
			console.log("[orchestrator-shim] SIGINT received");
			resolve();
		});
	});

	// P3198: arm a failsafe so a hung drain step (or leftover pg LISTEN client /
	// un-unref'd interval keeping the loop alive after stop) cannot wedge systemd
	// stop into a timeout-kill. unref'd, so it never delays a clean exit.
	armHardExit("orchestrator-shim");

	// Graceful shutdown — drop the long-running guard so closePool actually fires.
	// P266 in-flight dispatch tracking runs inside orchestrator.stop() before we exit.
	await orchestrator.stop();
	await watchdog.stop();
	setPoolLifecycleMode("one-shot");
	await closePool();
	console.log("[orchestrator-shim] stopped");

	// Even after a clean drain, shared pool keep-alives / leftover handles can hold
	// the event loop open. Exit explicitly so systemd stop completes without a kill.
	process.exit(0);
}

main().catch((err) => {
	console.error("[orchestrator-shim] fatal:", err);
	process.exit(1);
});
