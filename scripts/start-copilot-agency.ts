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
import {
	liaisonRegister,
	liaisonHeartbeat,
	endLiaisonSession,
} from "../src/infra/agency/liaison-service.ts";
import { checkAndMarkDormant } from "../src/infra/agency/liaison-service.ts";
import { loadStateNames } from "../src/core/workflow/state-names.ts";

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
		// pg returns bigint as a JS string; coerce so agent_runs.proposal_id
		// gets populated. Without this every dispatched run lands as NULL
		// proposal_id and breaks downstream filters.
		const proposalIdNum =
			req.proposalId === undefined || req.proposalId === null
				? undefined
				: typeof req.proposalId === "number"
					? req.proposalId
					: Number(req.proposalId);
		return spawnAgent({
			worktree: req.worktree,
			task: req.task,
			proposalId: Number.isFinite(proposalIdNum) ? proposalIdNum : undefined,
			stage: req.stage,
			model: req.model,
			timeoutMs: req.timeoutMs,
			agentLabel: req.agentLabel,
			provider: provider as any,
			// P466: forward warm-boot briefing id so the child can call
			// `briefing_load(<id>)` on boot and run with full context.
			briefingId: req.briefingId,
		});
	},
});

let sessionId: string | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;

async function main() {
	console.log(`[CopilotAgency] Starting as ${agentIdentity} ...`);

	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[CopilotAgency] Database connection verified");

	// Load the per-process StateNames registry. spawnAgent uses RfcStates
	// (e.g. RfcStates.COMPLETE) when assembling the proposal context package.
	// Without this, every spawn throws "[StateNames] Registry not loaded".
	try {
		await loadStateNames(pool);
		console.log("[CopilotAgency] State-names registry loaded from database");
	} catch (err) {
		console.error("[CopilotAgency] Failed to load state-names registry:", err);
		// Continue: spawnAgent's downstream calls will fail loudly, but the
		// agency stays up so the operator can fix the registry.
	}

	// Register agency with liaison service (P464)
	try {
		const { display_name } = parseAgentIdentity(agentIdentity);
		const { session_id } = await liaisonRegister({
			agency_id: agentIdentity,
			display_name,
			provider: "copilot",
			host_id: hostname(),
			capabilities: ["copilot", "agent-spawner"],
			metadata: { version: "1.0", pid: process.pid },
		});
		sessionId = session_id;
		console.log(`[CopilotAgency] Registered liaison session: ${sessionId}`);

		// Start heartbeat timer (every 30s)
		heartbeatTimer = setInterval(async () => {
			try {
				const result = await liaisonHeartbeat({
					session_id: sessionId!,
					status: "active",
				});
				if (!result.success) {
					console.warn(
						`[CopilotAgency] Heartbeat unsuccessful for session ${sessionId}`,
					);
				}
			} catch (err) {
				console.error("[CopilotAgency] Heartbeat error:", err);
			}
		}, 30_000);

		// Start dormancy sweep timer (every 60s) — mark agencies silent > 90s as dormant
		watchdogTimer = setInterval(async () => {
			try {
				const dormantCount = await checkAndMarkDormant();
				if (dormantCount > 0) {
					console.log(`[CopilotAgency] Dormancy sweep: ${dormantCount} marked dormant`);
				}
			} catch (err) {
				console.error("[CopilotAgency] Dormancy sweep error:", err);
			}
		}, 60_000);
	} catch (err) {
		console.error("[CopilotAgency] Failed to register liaison session:", err);
		// Continue anyway; legacy behavior is fallback
	}

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, async () => {
			console.log(`[CopilotAgency] ${sig} — draining in-flight claims...`);

			// Clear timers
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (watchdogTimer) clearInterval(watchdogTimer);

			// End liaison session
			if (sessionId) {
				try {
					await endLiaisonSession(sessionId, "operator");
				} catch (err) {
					console.error(
						`[CopilotAgency] Failed to end liaison session:`,
						err,
					);
				}
			}

			await offerProvider.stop();
			await offerProvider.waitForIdle(30_000);
			await closePool();
			process.exit(0);
		});
	}

	await offerProvider.run();
	console.log(`[CopilotAgency] ${agentIdentity} listening for work offers`);
}

/**
 * Parse agent identity "copilot/agency-gary" → { display_name: "agency-gary" }
 */
function parseAgentIdentity(identity: string): { display_name: string } {
	const parts = identity.split("/");
	return {
		display_name: parts[1] || identity,
	};
}

main().catch((err) => {
	console.error("[CopilotAgency] Fatal:", err);
	process.exit(1);
});
