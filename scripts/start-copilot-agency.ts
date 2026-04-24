/**
 * Copilot Agency — OfferProvider for the GitHub Copilot CLI.
 *
 * Registers as "copilot/agency-gary" in agent_registry and listens on the
 * work_offers Postgres channel. When the orchestrator or gate-pipeline posts
 * a job, this process races to claim it and spawns:
 *
 *   copilot -p "<task>" --yolo --model <model>
 *
 * The binary path comes from model_routes.cli_path (DB), so no path is
 * hardcoded here or in the service unit.
 *
 * Usage:
 *   node --import jiti/register scripts/start-copilot-agency.ts
 */

import { hostname } from "node:os";
import { spawnAgent, resolveActiveRouteProvider } from "../src/core/orchestration/agent-spawner.ts";
import { OfferProvider } from "../src/core/pipeline/offer-provider.ts";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";

const agentIdentity =
	process.env.AGENTHIVE_AGENT_IDENTITY ?? `copilot/agency-${hostname()}`;

const offerProvider = new OfferProvider({
	agentIdentity,
	leaseTtlSeconds: Number(process.env.AGENTHIVE_LEASE_TTL_SECONDS ?? "60"),
	renewIntervalMs: Number(process.env.AGENTHIVE_RENEW_INTERVAL_MS ?? "15000"),
	pollIntervalMs: Number(process.env.AGENTHIVE_OFFER_POLL_MS ?? "20000"),
	maxConcurrent: Number(process.env.AGENTHIVE_MAX_CONCURRENT ?? "2"),
	connectListener: async () => getPool().connect(),
	spawnFn: async (req) => {
		// Extract provider prefix from identity (e.g. "copilot/agency-gary" → "copilot")
		// Falls back to active DB route if identity prefix is not a known provider.
		const identityPrefix = agentIdentity.split("/")[0];
		const provider = identityPrefix || (await resolveActiveRouteProvider()) || "copilot";
		return spawnAgent({
			worktree: req.worktree,
			task: req.task,
			proposalId: typeof req.proposalId === "number" ? req.proposalId : undefined,
			stage: req.stage,
			model: req.model,
			timeoutMs: req.timeoutMs,
			agentLabel: req.agentLabel,
			provider: provider as any,
		});
	},
});

async function main() {
	console.log(`[CopilotAgency] Starting as ${agentIdentity} ...`);

	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[CopilotAgency] Database connection verified");

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, async () => {
			console.log(`[CopilotAgency] ${sig} — draining in-flight claims...`);
			await offerProvider.stop();
			await offerProvider.waitForIdle(30_000);
			await closePool();
			process.exit(0);
		});
	}

	await offerProvider.run();
	console.log(`[CopilotAgency] ${agentIdentity} listening for work offers`);
}

main().catch((err) => {
	console.error("[CopilotAgency] Fatal:", err);
	process.exit(1);
});
