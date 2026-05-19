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
import {
	closePool,
	setPoolLifecycleMode,
	startPoolPoisonWatchdog,
} from "../src/infra/postgres/pool.ts";

const orchestrator = new Orchestrator();
setPoolLifecycleMode("long-running");
startPoolPoisonWatchdog("agenthive-orchestrator");

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

	// Graceful shutdown
	await orchestrator.stop();
	await closePool();
	console.log("[orchestrator-shim] stopped");
}

main().catch((err) => {
	console.error("[orchestrator-shim] fatal:", err);
	process.exit(1);
});
