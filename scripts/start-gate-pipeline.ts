/**
 * Startup script for PipelineCron gate worker.
 *
 * Initializes the PipelineCron class to process legacy transition_queue entries
 * automatically via pg_notify and polling fallback.
 */
import { spawnAgent } from "../src/core/orchestration/agent-spawner.ts";
import { PipelineCron } from "../src/core/pipeline/pipeline-cron.ts";
import { reapStaleRows } from "../src/core/pipeline/reap-stale-rows.ts";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";

const executorMode = process.env.AGENTHIVE_GATE_EXECUTOR ?? "cubic";
const spawnAdapter =
	executorMode === "spawn"
		? async (request: {
				worktree: string;
				task: string;
				proposalId: number | string;
				stage: string;
				model?: string;
				timeoutMs?: number;
			}) =>
				spawnAgent({
					worktree: request.worktree,
					task: request.task,
					proposalId:
						typeof request.proposalId === "number"
							? request.proposalId
							: Number.isFinite(Number(request.proposalId))
								? Number(request.proposalId)
								: undefined,
					stage: request.stage,
					model: request.model,
					timeoutMs: request.timeoutMs,
				})
		: undefined;
const cron = new PipelineCron(
	spawnAdapter ? { spawnAgentFn: spawnAdapter } : {},
);

async function main() {
	console.log(
		`[GatePipeline] Starting PipelineCron gate worker (${executorMode} executor)...`,
	);

	// Initialize the postgres pool to verify connectivity
	let pool: ReturnType<typeof getPool>;
	try {
		pool = getPool();
		await pool.query("SELECT 1");
		console.log("[GatePipeline] Database connection verified");
	} catch (err) {
		console.error("[GatePipeline] Failed to connect to database:", err);
		process.exit(1);
	}

	// P269: reap stale rows left by any prior abrupt stop, BEFORE LISTEN.
	await reapStaleRows(
		pool,
		{
			log: (m) => console.log(m),
			warn: (m) => console.warn(m),
		},
		"GatePipeline.Reaper",
	);

	// Start the cron worker
	await cron.run();
	console.log("[GatePipeline] PipelineCron started successfully");
}

async function shutdown(signal: string) {
	console.log(`[GatePipeline] ${signal} received, shutting down gracefully...`);
	try {
		await cron.stop();
		console.log("[GatePipeline] PipelineCron stopped");
	} catch (err) {
		console.error("[GatePipeline] Error stopping PipelineCron:", err);
	}
	try {
		await closePool();
		console.log("[GatePipeline] Database pool closed");
	} catch (err) {
		console.error("[GatePipeline] Error closing pool:", err);
	}
	process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
	console.error("[GatePipeline] Uncaught exception:", err);
	process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	console.error("[GatePipeline] Unhandled rejection:", reason);
});

main().catch((err) => {
	console.error("[GatePipeline] Fatal error:", err);
	process.exit(1);
});
