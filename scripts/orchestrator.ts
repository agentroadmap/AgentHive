#!/usr/bin/env node
/**
 * AgentHive Orchestrator — systemd entrypoint shim.
 *
 * P902-A / P903 phase 4: this file is intentionally thin. The lifecycle and
 * dispatch logic live in src/core/orchestration/orchestrator.ts (Orchestrator
 * class) and src/core/orchestration/legacy-dispatch.ts (the helpers being
 * progressively pulled into class methods by P902-D). This shim only does:
 *   - boot-time DB load (loadStateNames so the workflow registry is hot)
 *   - signal wiring (SIGTERM/SIGINT → orchestrator.stop() → closePool)
 *   - process-level fatal error logging
 *
 * No SQL, no LISTEN, no setInterval, no spawnAgent calls — those live behind
 * the Orchestrator class API per CONVENTIONS.md §6.0b (single decision loop).
 */

import { getPool } from "../src/infra/postgres/pool.ts";
import { Orchestrator } from "../src/core/orchestration/orchestrator.ts";
import { terminateLiveChildren } from "../src/core/orchestration/agent-spawner.ts";
import { loadStateNames } from "../src/core/workflow/state-names.ts";

const logger = {
	log: (...args: unknown[]) => console.log("[Orchestrator]", ...args),
	warn: (...args: unknown[]) => console.warn("[Orchestrator]", ...args),
	error: (...args: unknown[]) => console.error("[Orchestrator]", ...args),
};

const orchestrator = new Orchestrator();
let stopping = false;

async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	logger.log(
		`Received ${signal}, draining ${orchestrator.inFlightCount()} in-flight dispatch(es)…`,
	);
	try {
		await orchestrator.stop();
	} catch (err) {
		logger.warn(
			`orchestrator.stop failed: ${err instanceof Error ? err.message : err}`,
		);
	}
	try {
		// Mirror legacy main(): signal long-lived child spawns explicitly so
		// systemd's TimeoutStopSec doesn't escalate to SIGKILL on the parent
		// before children finish. terminateLiveChildren is a no-op when none.
		await terminateLiveChildren({ graceMs: 5_000 });
	} catch (err) {
		logger.warn(
			`terminateLiveChildren failed: ${err instanceof Error ? err.message : err}`,
		);
	}
	try {
		await orchestrator.closePoolWithFallback();
	} finally {
		process.exit(0);
	}
}

process.on("SIGTERM", () => {
	void shutdown("SIGTERM").catch((err) => {
		logger.error("Shutdown failed:", err);
		process.exit(1);
	});
});
process.on("SIGINT", () => {
	void shutdown("SIGINT").catch((err) => {
		logger.error("Shutdown failed:", err);
		process.exit(1);
	});
});

async function main(): Promise<void> {
	logger.log("Starting Orchestrator (shim → class entrypoint)…");

	// Load workflow state-names registry from DB before LISTEN so the
	// orchestrator's poll/notify handlers see a populated registry. This
	// preserves the legacy main() boot order. Non-fatal if it fails — the
	// dispatch path falls back to canonical literals.
	try {
		await loadStateNames(getPool());
		logger.log("State-names registry loaded from database");
	} catch (err) {
		logger.error("Failed to load state-names registry:", err);
	}

	await orchestrator.start();
	logger.log("Orchestrator running.");
}

main().catch((err) => {
	logger.error("Fatal error:", err);
	process.exit(1);
});
