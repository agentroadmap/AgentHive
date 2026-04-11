/**
 * Startup script for PipelineCron gate worker.
 *
 * Initializes the PipelineCron class to process transition_queue entries
 * automatically via pg_notify and polling fallback.
 */
import { PipelineCron } from "../src/core/pipeline/pipeline-cron.ts";
import { getPool, closePool } from "../src/infra/postgres/pool.ts";

const cron = new PipelineCron();

async function main() {
	console.log("[GatePipeline] Starting PipelineCron gate worker...");

	// Initialize the postgres pool to verify connectivity
	try {
		const pool = getPool();
		await pool.query("SELECT 1");
		console.log("[GatePipeline] Database connection verified");
	} catch (err) {
		console.error("[GatePipeline] Failed to connect to database:", err);
		process.exit(1);
	}

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
