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
import { setPoolLifecycleMode } from "../src/infra/postgres/pool.ts";
import { startPoolWatchdog } from "../src/infra/postgres/pool-watchdog.ts";

// P1123: declare long-running mode so stray pool.end() calls cannot poison this
// service. Graceful shutdown drops back to "one-shot" before the final closePool.
setPoolLifecycleMode("long-running");

const watchdog = startPoolWatchdog("agenthive-orchestrator");
const orchestrator = new Orchestrator();

async function main() {
	console.log("[orchestrator-shim] starting");
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

	// Graceful shutdown — drop the long-running guard so closePool actually fires.
	await orchestrator.stop();
	await watchdog.stop();
	setPoolLifecycleMode("one-shot");
	await orchestrator.closePoolWithFallback();
	console.log("[orchestrator-shim] stopped");
}

main().catch((err) => {
	console.error("[orchestrator-shim] fatal:", err);
	process.exit(1);
});
