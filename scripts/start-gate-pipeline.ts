/**
 * Startup script for PipelineCron gate worker.
 *
 * Initializes the PipelineCron class to process legacy transition_queue entries
 * automatically via pg_notify and polling fallback.
 *
 * When AGENTHIVE_USE_OFFER_DISPATCH=1 the script also starts an OfferProvider
 * alongside PipelineCron so this process both emits offers and claims them.
 * In production you would typically run a separate offer-provider process per
 * worktree (one per agent), but running them together is fine for a single-agent
 * deployment.
 */
import { hostname } from "node:os";
import { spawnAgent } from "../src/core/orchestration/agent-spawner.ts";
import { OfferProvider } from "../src/core/pipeline/offer-provider.ts";
import { PipelineCron } from "../src/core/pipeline/pipeline-cron.ts";
import { reapStaleRows } from "../src/core/pipeline/reap-stale-rows.ts";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";

const executorMode = process.env.AGENTHIVE_GATE_EXECUTOR ?? "cubic";
const useOfferDispatch = process.env.AGENTHIVE_USE_OFFER_DISPATCH === "1";

// Shared spawn adapter — used by both PipelineCron (legacy) and OfferProvider.
const spawnAdapter =
	executorMode === "spawn" || useOfferDispatch
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

const cron = new PipelineCron({
	...(spawnAdapter ? { spawnAgentFn: spawnAdapter } : {}),
	useOfferDispatch,
});

// P281: When offer dispatch is enabled, start OfferProvider so this process
// both emits offers (via PipelineCron) and claims/executes them.
const agentIdentity =
	process.env.AGENTHIVE_AGENT_IDENTITY ?? hostname();
const offerProvider = useOfferDispatch
	? new OfferProvider({
			agentIdentity,
			spawnFn: spawnAdapter,
			connectListener: async () => getPool().connect(),
			leaseTtlSeconds: Number(process.env.AGENTHIVE_LEASE_TTL_SECONDS ?? "30"),
			renewIntervalMs: Number(process.env.AGENTHIVE_RENEW_INTERVAL_MS ?? "10000"),
			pollIntervalMs: Number(process.env.AGENTHIVE_OFFER_POLL_MS ?? "15000"),
			maxConcurrent: Number(process.env.AGENTHIVE_MAX_CONCURRENT ?? "10"),
		})
	: null;

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

	if (offerProvider) {
		await offerProvider.run();
		console.log(`[GatePipeline] OfferProvider started (identity: ${agentIdentity})`);
	}
}

async function shutdown(signal: string) {
	console.log(`[GatePipeline] ${signal} received, shutting down gracefully...`);
	try {
		await cron.stop();
		console.log("[GatePipeline] PipelineCron stopped");
	} catch (err) {
		console.error("[GatePipeline] Error stopping PipelineCron:", err);
	}
	if (offerProvider) {
		try {
			await offerProvider.stop();
			console.log("[GatePipeline] OfferProvider stopped");
		} catch (err) {
			console.error("[GatePipeline] Error stopping OfferProvider:", err);
		}
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
