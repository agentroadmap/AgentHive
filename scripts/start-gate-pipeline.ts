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
import { spawnAgent, resolveActiveRouteProvider } from "../src/core/orchestration/agent-spawner.ts";
import { OfferProvider } from "../src/core/pipeline/offer-provider.ts";
import { PipelineCron } from "../src/core/pipeline/pipeline-cron.ts";
import { reapStaleRows } from "../src/core/pipeline/reap-stale-rows.ts";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";
import { loadStateNames } from "../src/core/workflow/state-names.ts";

const executorMode = process.env.AGENTHIVE_GATE_EXECUTOR ?? "cubic";
const useOfferDispatch = process.env.AGENTHIVE_USE_OFFER_DISPATCH === "1";

const agentIdentity = process.env.AGENTHIVE_AGENT_IDENTITY ?? hostname();

type SpawnRequestBase = {
	worktree: string;
	task: string;
	proposalId: number | string;
	stage: string;
	model?: string;
	timeoutMs?: number;
};

const resolveSpawnArgs = async (request: SpawnRequestBase) => {
	const identityPrefix = agentIdentity.split("/")[0];
	const provider = identityPrefix || (await resolveActiveRouteProvider()) || undefined;
	return {
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
		provider: provider as any,
	};
};

// For PipelineCron.spawnAgentFn — expects Promise<SpawnAgentResult> (normalizes exitCode)
const pipelineSpawnAdapter =
	executorMode === "spawn" || useOfferDispatch
		? async (request: SpawnRequestBase) => {
				const result = await spawnAgent(await resolveSpawnArgs(request));
				return {
					...result,
					exitCode: result.exitCode ?? 1,
				};
			}
		: undefined;

const cron = new PipelineCron({
	...(pipelineSpawnAdapter ? { spawnAgentFn: pipelineSpawnAdapter } : {}),
	useOfferDispatch,
});

// P281: When offer dispatch is enabled, start OfferProvider so this process
// both emits offers (via PipelineCron) and claims/executes them.
// OfferProvider uses spawnAgent directly (returns SpawnHandle) — no spawnFn override needed.
const offerProvider = useOfferDispatch
	? new OfferProvider({
			agentIdentity,
			connectListener: async () => getPool().connect(),
			leaseTtlSeconds: Number(process.env.AGENTHIVE_LEASE_TTL_SECONDS ?? "30"),
			renewIntervalMs: Number(process.env.AGENTHIVE_RENEW_INTERVAL_MS ?? "10000"),
			pollIntervalMs: Number(process.env.AGENTHIVE_OFFER_POLL_MS ?? "15000"),
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

	// Load state-names registry from DB (includes NOTIFY listener for live reloads)
	try {
		await loadStateNames(pool);
		console.log("[GatePipeline] State-names registry loaded from database");
	} catch (error) {
		console.error("[GatePipeline] Failed to load state-names registry:", error);
		// Non-fatal; continue without the registry
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
			// Wait for in-flight claims to finish before closing the pool
			await offerProvider.waitForIdle(90_000);
			console.log("[GatePipeline] OfferProvider stopped and drained");
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
