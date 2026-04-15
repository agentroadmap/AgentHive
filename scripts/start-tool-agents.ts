#!/usr/bin/env npx tsx
/**
 * Tool Agents — long-running zero-cost process.
 *
 * Starts all registered tool agents (state-monitor, health-checker,
 * merge-executor, test-runner, cubic-cleaner, budget-enforcer) in a
 * single process. Each agent registers its event listeners and runs
 * its own event loop. Zero LLM calls, zero token cost.
 *
 * Usage:
 *   npx tsx scripts/start-tool-agents.ts
 *   roadmap tool-agents   (if registered as a roadmap command)
 */

import { basename } from "node:path";
import { getPool, query } from "../src/infra/postgres/pool.ts";
import {
	ToolAgentRegistry,
	getToolAgentRegistry,
} from "../src/core/tool-agents/registry.ts";
import { StateMonitor } from "../src/core/tool-agents/state-monitor.ts";
import { HealthChecker } from "../src/core/tool-agents/health-checker.ts";
import { MergeExecutor } from "../src/core/tool-agents/merge-executor.ts";
import { TestRunner } from "../src/core/tool-agents/test-runner.ts";
import { CubicCleaner } from "../src/core/tool-agents/cubic-cleaner.ts";
import { BudgetEnforcer } from "../src/core/tool-agents/budget-enforcer.ts";

const logger = console;
const POLL_INTERVAL_MS = 60_000; // 1 minute for cron-like agents

// ─── Event listeners ──────────────────────────────────────────────────────────

const NOTIFY_CHANNELS = [
	"proposal_maturity_changed",
	"spending_log_insert",
] as const;

let listenerClient: { query: (text: string) => Promise<unknown>; on: (event: string, handler: (msg: { channel: string; payload?: string }) => void) => void; removeListener: (event: string, handler: (msg: { channel: string; payload?: string }) => void) => void; release?: () => void } | null = null;

async function startNotificationListener(
	registry: ToolAgentRegistry,
): Promise<void> {
	const pool = getPool();
	listenerClient = await pool.connect();

	for (const channel of NOTIFY_CHANNELS) {
		await listenerClient.query(`LISTEN ${channel}`);
	}

	listenerClient.on(
		"notification",
		async (msg: { channel: string; payload?: string }) => {
			try {
				const data = msg.payload ? JSON.parse(msg.payload) : {};

				if (msg.channel === "proposal_maturity_changed") {
					const proposalId = data.proposal_id ?? data.id;
					if (proposalId) {
						const result = await registry.invoke(
							"tool/state-monitor",
							{
								type: "evaluate_acs",
								proposalId: Number(proposalId),
								payload: data,
							},
						);
						logger.log(
							`[ToolAgents] StateMonitor: ${result.output}`,
						);
					}
				}

				if (msg.channel === "spending_log_insert") {
					const agentIdentity = data.agent_identity;
					if (agentIdentity) {
						const result = await registry.invoke(
							"tool/budget-enforcer",
							{
								type: "check_budget",
								payload: { agentIdentity, ...data },
							},
						);
						logger.log(
							`[ToolAgents] BudgetEnforcer: ${result.output}`,
						);
					}
				}
			} catch (err) {
				const msg_ =
					err instanceof Error ? err.message : String(err);
				logger.error(
					`[ToolAgents] Notification handler error: ${msg_}`,
				);
			}
		},
	);

	logger.log(
		`[ToolAgents] Listening on: ${NOTIFY_CHANNELS.join(", ")}`,
	);
}

// ─── Cron loop ─────────────────────────────────────────────────────────────────

let cronTimer: ReturnType<typeof setInterval> | null = null;

async function runCronCycle(registry: ToolAgentRegistry): Promise<void> {
	// Health check
	try {
		const result = await registry.invoke("tool/health-checker", {
			type: "health_check",
			payload: {},
		});
		logger.log(`[ToolAgents] HealthChecker: ${result.output}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[ToolAgents] HealthChecker error: ${msg}`);
	}

	// Cubic cleanup
	try {
		const result = await registry.invoke("tool/cubic-cleaner", {
			type: "clean_cubics",
			payload: {},
		});
		logger.log(`[ToolAgents] CubicCleaner: ${result.output}`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[ToolAgents] CubicCleaner error: ${msg}`);
	}
}

function startCronLoop(registry: ToolAgentRegistry): void {
	cronTimer = setInterval(() => {
		void runCronCycle(registry);
	}, POLL_INTERVAL_MS);

	logger.log(
		`[ToolAgents] Cron loop started (every ${POLL_INTERVAL_MS}ms)`,
	);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	logger.log("[ToolAgents] Starting tool agents process...");

	const registry = getToolAgentRegistry();

	// Register handler classes
	registry.registerHandler("StateMonitor", StateMonitor);
	registry.registerHandler("HealthChecker", HealthChecker);
	registry.registerHandler("MergeExecutor", MergeExecutor);
	registry.registerHandler("TestRunner", TestRunner);
	registry.registerHandler("CubicCleaner", CubicCleaner);
	registry.registerHandler("BudgetEnforcer", BudgetEnforcer);

	// Load configs from DB
	await registry.load();

	// Start event listeners
	await startNotificationListener(registry);

	// Start cron loop
	startCronLoop(registry);

	// Run initial health check
	await runCronCycle(registry);

	logger.log(
		`[ToolAgents] Running. ${registry.list().length} agent(s) active: ${registry.list().join(", ")}`,
	);

	// Graceful shutdown
	const shutdown = async (signal: string): Promise<void> => {
		logger.log(`[ToolAgents] Received ${signal}, shutting down...`);

		if (cronTimer) {
			clearInterval(cronTimer);
			cronTimer = null;
		}

		if (listenerClient) {
			for (const channel of NOTIFY_CHANNELS) {
				await listenerClient.query(`UNLISTEN ${channel}`).catch(() => {});
			}
			listenerClient.release?.();
			listenerClient = null;
		}

		await registry.stopAll();
		logger.log("[ToolAgents] Shutdown complete.");
		process.exit(0);
	};

	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
}

main().catch((err) => {
	logger.error(`[ToolAgents] Fatal: ${err}`);
	process.exit(1);
});
